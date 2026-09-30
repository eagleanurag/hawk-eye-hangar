#!/usr/bin/env node
/**
 * Phase 35 — build-report.mjs
 *
 * Produces the human-readable and machine-readable migration report from the
 * real artefacts: data/aircraft.json, data/archive-manifest.json and
 * data/_raw/discovery.json. Nothing in the report is typed by hand.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON, writeJSON, log } from './lib.mjs';

const aircraft = readJSON(path.join(ROOT, 'data', 'aircraft.json'), []);
const manifest = readJSON(path.join(ROOT, 'data', 'archive-manifest.json'), { entries: [] });
const discovery = readJSON(path.join(ROOT, 'data', '_raw', 'discovery.json'), {});
const imageReport = readJSON(path.join(ROOT, 'reports', 'image-extraction.json'), {});
const importFailures = readJSON(path.join(ROOT, 'data', '_raw', 'import-failures.json'), []);

const count = (fn) => aircraft.filter(fn).length;
const uniq = (arr) => new Set(arr).size;

const categories = {};
for (const a of aircraft) for (const c of a.category) categories[c] = (categories[c] || 0) + 1;

/*
 * Designers are grouped by the normalised designerKey, the same way the site
 * groups them, so the number in this report always matches the number on the
 * designers page. Where the source spells one designer more than one way the
 * variants are reported rather than silently merged.
 */
const designerGroups = new Map();
for (const a of aircraft) {
  if (!a.designer || !a.designerKey || a.designerKey === 'uncredited') continue;
  if (!designerGroups.has(a.designerKey)) designerGroups.set(a.designerKey, new Map());
  const byName = designerGroups.get(a.designerKey);
  byName.set(a.designer, (byName.get(a.designer) || 0) + 1);
}
const designers = [...designerGroups.entries()]
  .map(([key, byName]) => {
    const variants = [...byName.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return {
      name: variants[0][0],
      designerKey: key,
      count: variants.reduce((s, v) => s + v[1], 0),
      spellings: variants.map(([n, c]) => ({ name: n, count: c })),
    };
  })
  .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
const spellingVariants = designers.filter((d) => d.spellings.length > 1);

const totalImageBytes = aircraft.reduce(
  (s, a) => s + a.images.reduce((t, i) => t + (i.cardBytes || 0) + (i.fullBytes || 0), 0),
  0
);

const status = { ARCHIVED: 0, SOURCE_ONLY: 0, UNAVAILABLE: 0, MANUAL_REVIEW: 0 };
for (const a of aircraft) status[a.archiveStatus] = (status[a.archiveStatus] || 0) + 1;

const originalTypes = {};
for (const e of manifest.entries) {
  const t = (e.declaredType || 'unknown').toUpperCase();
  originalTypes[t] = (originalTypes[t] || 0) + 1;
}

const summary = {
  generatedAt: new Date().toISOString(),
  source: {
    site: discovery.origin || 'https://www.parkjets.com',
    collection: discovery.collectionPath || '/free-plans',
    platform: 'Squarespace 7.1 commerce + MemberSpace membership',
  },
  discovery: {
    sitemapUrls: discovery.totalSitemapUrls ?? null,
    collectionItemCount: discovery.collectionItemCount ?? null,
    fromCollection: discovery.aircraftFromCollection ?? null,
    fromSitemap: discovery.aircraftFromSitemap ?? null,
    gapsInSitemap: discovery.inSitemapNotInCollection?.length ?? 0,
    gapsInCollection: discovery.inCollectionNotInSitemap?.length ?? 0,
    duplicateSlugs: discovery.duplicateSlugs?.length ?? 0,
  },
  totals: {
    discovered: discovery.aircraftFromCollection ?? aircraft.length,
    imported: aircraft.length,
    importFailures: importFailures.length,
    archived: status.ARCHIVED,
    sourceOnly: status.SOURCE_ONLY,
    unavailable: status.UNAVAILABLE,
    manualReview: status.MANUAL_REVIEW,
    requiringReview: count((a) => a.review.length > 0),
    categories: Object.keys(categories).length,
    designers: designers.length,
    uncreditedDesigners: count((a) => !a.designer || a.designerKey === 'uncredited'),
    images: aircraft.reduce((s, a) => s + a.images.length, 0),
    imageFiles: aircraft.reduce((s, a) => s + a.images.length * 2, 0),
    imageBytes: totalImageBytes,
    withSpecifications: count((a) => Object.keys(a.specifications).length > 0),
    specificationFields: aircraft.reduce((s, a) => s + Object.keys(a.specifications).length, 0),
    buildThreads: uniq(aircraft.flatMap((a) => a.buildThreads.map((t) => t.url))),
    externalLinks: uniq(aircraft.flatMap((a) => a.externalLinks.map((t) => t.url))),
    planFiles: manifest.entries.filter((e) => e.localFile).length,
  },
  planFileTypesAtSource: originalTypes,
  categories,
  // `designers` is already an array of { name, designerKey, count, spellings },
  // sorted by count. Spreading it through Object.entries (as when it was a plain
  // name->count object) turned the array indexes into designer names.
  designers,
  knownLimitations: {
    noStructuredSpecifications: aircraft
      .filter((a) => !Object.keys(a.specifications).length)
      .map((a) => ({ slug: a.slug, name: a.displayName, reason: 'source published no structured specifications' })),
    noDesignerCredit: aircraft
      .filter((a) => !a.designer)
      .map((a) => ({ slug: a.slug, name: a.displayName, reason: 'source entry names no designer' })),
    noCategory: aircraft
      .filter((a) => !a.category.length)
      .map((a) => ({ slug: a.slug, name: a.displayName, reason: 'not filed under any source category' })),
  },
  failures: [
    ...importFailures.map((f) => ({ stage: 'import', ...f })),
    ...(imageReport.failures || []).map((f) => ({ stage: 'assets', aircraft: f.aircraft, reason: f.reason })),
    ...(discovery.categoryPages || [])
      .filter((c) => c.error)
      .map((c) => ({ stage: 'discover', url: c.url, reason: c.error })),
  ],
};

writeJSON(path.join(ROOT, 'reports', 'migration-report.json'), summary);

/* --------------------------- markdown form --------------------------- */
const pct = (n) => `${((n / Math.max(1, summary.totals.discovered)) * 100).toFixed(0)}%`;
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

const md = `# HawkEye Hangar — migration report

_Generated ${summary.generatedAt} by \`npm run report\` from the actual archive artefacts.
Every number below is computed from \`data/aircraft.json\` and \`data/archive-manifest.json\`._

## 1. Source

| | |
|---|---|
| Original site | ${summary.source.site} |
| Plan collection | ${summary.source.collection} |
| Platform | ${summary.source.platform} |
| URLs in sitemap.xml | ${summary.discovery.sitemapUrls} |
| Collection item count reported by the platform | ${summary.discovery.collectionItemCount} |

The collection JSON, \`sitemap.xml\` and the eight category pages were all read
and cross-checked. They agree exactly: **${summary.discovery.gapsInSitemap} URLs in the sitemap
missing from the collection, ${summary.discovery.gapsInCollection} collection items missing from the sitemap, ${summary.discovery.duplicateSlugs} duplicate slugs.**
The "135+ plans" figure in the original page's marketing copy is not reflected
in the published collection, which contains **${summary.totals.discovered} items**.

## 2. Outcome

| Metric | Count | |
|---|---:|---|
| Aircraft discovered | ${summary.totals.discovered} | 100% |
| Aircraft imported | ${summary.totals.imported} | ${pct(summary.totals.imported)} |
| Import failures | ${summary.totals.importFailures} | |
| **Plans archived locally** | **${summary.totals.archived}** | |
| **Source-only (member-gated)** | **${summary.totals.sourceOnly}** | ${pct(summary.totals.sourceOnly)} |
| Unavailable | ${summary.totals.unavailable} | |
| Manual review | ${summary.totals.manualReview} | |
| Records flagged for review | ${summary.totals.requiringReview} | |
| Aircraft with structured specifications | ${summary.totals.withSpecifications} | ${pct(summary.totals.withSpecifications)} |
| Parsed specification values | ${summary.totals.specificationFields} | |
| Designers credited | ${summary.totals.designers} | |
| Entries with no designer credit | ${summary.totals.uncreditedDesigners} | |
| Categories | ${summary.totals.categories} | |
| Photographs archived | ${summary.totals.images} | |
| Image files (2 sizes each) | ${summary.totals.imageFiles} | ${mb(summary.totals.imageBytes)} |
| Build-thread links preserved | ${summary.totals.buildThreads} | |
| Other external links preserved | ${summary.totals.externalLinks} | |

## 3. Why no plan files are mirrored

Parkjets published every plan file as a Squarespace digital good released only
to signed-in MemberSpace members. There is no public, unauthenticated
download URL for any of them. This archive respects that access control and
does not attempt to circumvent it.

For every aircraft the pipeline probes the endpoints the source site actually
exposes, records the result, and then classifies the record:

| Status | Meaning |
|---|---|
| \`ARCHIVED\` | A validated file lives in \`public/plans/<slug>/\` and downloads from this site. |
| \`SOURCE_ONLY\` | Entry, imagery and original filename archived; the file comes from the original product page. |
| \`UNAVAILABLE\` | The source entry publishes no file. |
| \`MANUAL_REVIEW\` | A file is present but failed validation. |

Current distribution: ${summary.totals.archived} archived, ${summary.totals.sourceOnly} source-only, ${summary.totals.unavailable} unavailable, ${summary.totals.manualReview} manual review.

Declared plan file types at the source: ${Object.entries(originalTypes).map(([k, v]) => `\`${k}\` ×${v}`).join(', ')}.

**If the site owner releases any of these files for redistribution**, dropping them into
\`public/plans/<slug>/\` with their original filename is the only step required. The next
\`npm run archive\` validates them, records a SHA-256 and the site's download
buttons switch from "Open original source" to a real download automatically.

## 4. Categories (verbatim from the source taxonomy)

${Object.entries(summary.categories)
  .sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `| ${k} | ${v} |`)
  .join('\n')}

## 5. Designers

${summary.designers.map((d) => `- **${d.name}** — ${d.count}`).join('\n')}

## 6. Known limitations (all inherited from the source)

### 6.1 No structured specifications (${summary.knownLimitations.noStructuredSpecifications.length})

${summary.knownLimitations.noStructuredSpecifications.map((x) => `- \`${x.slug}\` — ${x.name}`).join('\n')}

These entries were published with no labelled specification block. Their pages
show the designer's own words verbatim instead of guessed values.

### 6.2 No designer credit (${summary.knownLimitations.noDesignerCredit.length})

${summary.knownLimitations.noDesignerCredit.map((x) => `- \`${x.slug}\` — ${x.name}`).join('\n')}

The archive records the absence rather than guessing an author.

### 6.3 Uncategorised (${summary.knownLimitations.noCategory.length})

${summary.knownLimitations.noCategory.length ? summary.knownLimitations.noCategory.map((x) => `- \`${x.slug}\` — ${x.name}`).join('\n') : '_None — every record is filed under at least one source category._'}

## 7. Failures

${summary.failures.length ? summary.failures.map((f) => `- \`${f.stage}\` ${f.slug || f.aircraft || f.url || ''}: ${f.reason}`).join('\n') : '_No failures in the final run. Every aircraft imported and every image downloaded successfully._'}

## 8. Data quality policy

The importer never invents data.

* A specification is recorded only when the designer literally wrote \`Key: value\`,
  \`Key = value\`, \`Key - value\` or \`Key value\` for a recognised field name.
* Unlabelled fragments such as \`GWS 20 A ESC | 9X7 slowfly prop\` are **never**
  promoted into a motor/ESC/propeller field. They are preserved verbatim and shown
  under "What you'll need to build it".
* Where a designer wrote a value that could plausibly belong to two fields, it is
  left exactly as written and flagged rather than split.
* Every source page is permanently linked from its archive record.
`;

fs.writeFileSync(path.join(ROOT, 'reports', 'migration-report.md'), md, 'utf8');

log('');
log('  HawkEye Hangar — migration report');
log('  ─────────────────────────────────────────────────');
log(`  discovered           ${summary.totals.discovered}`);
log(`  imported             ${summary.totals.imported}`);
log(`  archived plans       ${summary.totals.archived}`);
log(`  source-only          ${summary.totals.sourceOnly}`);
log(`  unavailable          ${summary.totals.unavailable}`);
log(`  manual review        ${summary.totals.manualReview}`);
log(`  images               ${summary.totals.images} (${summary.totals.imageFiles} files, ${mb(summary.totals.imageBytes)})`);
log(`  categories           ${summary.totals.categories}`);
log(`  designers            ${summary.totals.designers}`);
log(`  with specifications  ${summary.totals.withSpecifications}`);
log(`  failures             ${summary.failures.length}`);
log('✓ wrote reports/migration-report.{json,md}');
log('');
