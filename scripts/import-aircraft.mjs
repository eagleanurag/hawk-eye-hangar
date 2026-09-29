#!/usr/bin/env node
/**
 * Phase 2/3 — import-aircraft.mjs
 *
 * Imports the full Parkjets aircraft catalog into data/aircraft.json.
 *
 * For every aircraft it reads two public representations of the same page:
 *   {sourceUrl}?format=json-pretty   -> canonical record (title, categories,
 *                                       designer tag, description HTML,
 *                                       digital-good filename, SEO fields)
 *   {sourceUrl}                       -> rendered product gallery
 *                                       (data-image / dimensions / alt text)
 *
 * Failures are recorded, never fatal. A partial import is still written.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, fetchText, fetchJSON, readJSON, writeJSON, log, sleep } from './lib.mjs';
import {
  stripTags,
  splitSections,
  extractLinks,
  extractDesigner,
  extractSpecifications,
  isBoilerplate,
} from './parse-description.mjs';

const ORIGIN = 'https://www.parkjets.com';
const CONCURRENCY = 5;

const SECTION_FOR_SPECS = new Set([
  'SPECIFICATIONS',
  'WHAT YOU NEED TO BUILD THIS',
  'SUGGESTED SET UP',
  'SUGGESTED SET-UP',
  'SET UP',
  'SUGGESTED PARTS',
  'RECOMMENDED GEAR',
  'DESIGNER NOTES',
  'NOTES FROM THE DESIGNER',
  'NOTE FROM THE DESIGNER',
  'NOTE FROM DESIGNER',
  'NOTE FROM GGRN',
  'DESCRIPTION',
]);
const SECTION_FOR_NOTES = new Set([
  'NOTE FROM THE DESIGNER',
  'NOTES FROM THE DESIGNER',
  'NOTE FROM DESIGNER',
  'NOTE FROM GGRN',
  'DESIGNER NOTES',
  'DESCRIPTION',
]);
const SECTION_FOR_BUILD = new Set([
  'WHAT YOU NEED TO BUILD THIS',
  'SUGGESTED SET UP',
  'SUGGESTED SET-UP',
  'SET UP',
  'SUGGESTED PARTS',
  'RECOMMENDED GEAR',
]);
const SECTION_FOR_THREADS = new Set(['BUILD THREAD', 'BUILD THREADS', 'BUILD TREADS']);
const SECTION_FOR_KIT = new Set(['KIT AVAILABLE']);

function cleanTitle(title, slug) {
  if (!title) return slug;
  return title
    .replace(/\s*[—–-]\s*Free (PDF|ZIP)? ?Downloads?\s*$/i, '')
    .replace(/\s*Parkjet\s+Parkjet\s+Plans\s*$/i, '')
    .replace(/\s*Parkjet\s+Plans\s*$/i, '')
    .replace(/\s*Parkjet\s*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Designer strings that differ only by case/spacing are the same person. */
function designerKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[''`]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .trim();
}

function parseGallery(html) {
  const images = [];
  const seen = new Set();
  const re =
    /class="product-gallery-slides-item-image"[^>]*?data-image="([^"]+)"\s+data-image-dimensions="(\d+)x(\d+)"[^>]*?alt="([^"]*)"/gs;
  let m;
  while ((m = re.exec(html))) {
    const url = m[1].replace(/^https?:/, 'https:');
    if (seen.has(url)) continue;
    seen.add(url);
    images.push({
      url,
      width: Number(m[2]) || null,
      height: Number(m[3]) || null,
      alt: m[4] ? m[4].trim() : '',
    });
  }
  if (images.length) return images;

  // Fallback: any product-gallery image in the page, in document order.
  const re2 = /data-image="(https:\/\/images\.squarespace-cdn\.com\/[^"]+)"[^>]*?alt="([^"]*)"/gs;
  while ((m = re2.exec(html))) {
    const url = m[1];
    if (seen.has(url)) continue;
    seen.add(url);
    images.push({ url, width: null, height: null, alt: m[2] ? m[2].trim() : '' });
  }
  return images;
}

function parseExternalLinks(excerptHtml, sections) {
  const links = [];
  const seen = new Set();
  for (const { url, label } of extractLinks(excerptHtml)) {
    if (!/^https?:/i.test(url)) continue;
    const host = (() => {
      try {
        return new URL(url).hostname.replace(/^www\./, '');
      } catch {
        return '';
      }
    })();
    if (host.endsWith('parkjets.com') || host.endsWith('squarespace.com')) continue;
    const key = url;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ label: label || host, url, host });
  }
  return links;
}

function archiveStatusFor(item) {
  // Parkjets digital goods are delivered through MemberSpace membership.
  // No unauthenticated public download endpoint exists, so the plan file is
  // referenced from the original source page rather than redistributed.
  return {
    archiveStatus: 'SOURCE_ONLY',
    download: {
      type: 'source',
      file: null,
      sourceUrl: item.sourceUrl,
      originalFilename: item.digitalGood?.filename || null,
      format: item.digitalGood?.sourceType || null,
      status: 'Member-gated on parkjets.com — not publicly downloadable',
    },
  };
}

async function importOne(item, catById, prevImages = []) {
  const sourceUrl = item.sourceUrl;
  const rec = {
    id: item.id,
    slug: item.slug,
    name: cleanTitle(item.title, item.slug),
    originalTitle: item.title,
    category: item.categories || [],
    designer: '',
    description: '',
    designerNotes: '',
    specifications: {},
    specificationsExtra: [],
    buildRequirements: '',
    buildRequirementsLinks: [],
    externalLinks: [],
    images: [],
    sourceUrl,
    archiveStatus: 'SOURCE_ONLY',
    download: {},
    license: {
      status: 'Third-party design — attribution to original designer',
      notes:
        'Design and plan file remain the property of the original designer. Archived here for preservation and reference only.',
    },
    source: {
      parkjetsId: item.id,
      addedOn: null,
      updatedOn: null,
      priceCents: item.priceCents ?? null,
      seoTitle: item.seoTitle || null,
      seoDescription: item.seoDescription || null,
    },
    review: [],
  };

  // --- gallery (needs the rendered page) -----------------------------------
  try {
    const page = await fetchText(sourceUrl);
    rec.images = parseGallery(page.text);
  } catch (e) {
    rec.review.push({ field: 'images', issue: `gallery fetch failed: ${e.message}` });
  }

  // Preserve any images already downloaded by scripts/extract-assets.mjs, so a
  // re-import never orphans files that are already committed to the repo.
  if (prevImages.length && rec.images.length) {
    const bySource = new Map(prevImages.map((im) => [im.sourceUrl, im]));
    rec.images = rec.images.map((im) => {
      const prev = bySource.get(im.url);
      if (!prev) return im;
      return {
        ...im,
        alt: prev.alt || im.alt || '',
        caption: prev.caption ?? im.alt ?? '',
        card: prev.card,
        full: prev.full,
        cardBytes: prev.cardBytes,
        fullBytes: prev.fullBytes,
        credit: prev.credit,
      };
    });
  }

  // --- full record --------------------------------------------------------
  let full = item;
  try {
    const r = await fetchJSON(`${sourceUrl}?format=json-pretty`);
    if (r.json?.item) full = { ...item, ...r.json.item };
    else if (Array.isArray(r.json?.items) && r.json.items[0]) full = { ...item, ...r.json.items[0] };
  } catch (e) {
    rec.review.push({ field: 'record', issue: `json-pretty fetch failed: ${e.message}` });
  }

  const excerpt = full.excerpt || full.body || '';
  const sections = splitSections(excerpt);

  // Lead paragraph(s) = description, minus boilerplate.
  const lead = sections
    .filter((s) => !s.heading)
    .map((s) => s.text)
    .join('\n')
    .split('\n')
    .filter((l) => !isBoilerplate(l));
  rec.description = lead.join('\n').trim();

  const d = extractDesigner(
    rec.description,
    (full.designerTags || full.tags || []).find((t) => !/^decals$/i.test(t))
  );
  rec.designer = d.designer;
  rec.designerSource = d.source;
  if (!rec.designer) rec.review.push({ field: 'designer', issue: 'no designer credit found' });

  rec.category =
    (full.categoryIds || [])
      .map((c) => catById.get(c)?.name)
      .filter(Boolean)
      .sort() || rec.category;
  if (!rec.category.length) {
    rec.review.push({ field: 'category', issue: 'aircraft is not filed under any category' });
  }

  rec.source.addedOn = full.addedOn ? new Date(full.addedOn).toISOString() : null;
  rec.source.updatedOn = full.updatedOn ? new Date(full.updatedOn).toISOString() : null;
  rec.source.seoTitle = full.seoData?.seoTitle || null;
  rec.source.seoDescription = full.seoData?.seoDescription || null;
  if (!rec.source.addedOn) rec.review.push({ field: 'source', issue: 'no publish date on source' });

  const noteText = sections
    .filter((s) => SECTION_FOR_NOTES.has(s.heading))
    .map((s) => s.text)
    .join('\n\n')
    .trim();
  rec.designerNotes = noteText;

  const specSections = sections.filter((s) => s.heading === 'SPECIFICATIONS');
  const buildSections = sections.filter((s) => SECTION_FOR_BUILD.has(s.heading));

  // Canonical specifications are extracted from EVERY section, because many
  // designers wrote "Wingspan - 19.88"" inside their notes with no heading.
  // Only literally-written key/value pairs are promoted; nothing is inferred.
  const allText = sections.map((s) => s.text).join('\n');
  const { specifications, extra, unkeyedNotes } = extractSpecifications(allText);
  rec.specifications = specifications;
  rec.specificationsExtra = extra
    .filter((e) => !e.key || e.key.length <= 45)
    .slice(0, 40);
  rec.specificationsRaw = specSections
    .map((s) => s.text)
    .join('\n')
    .trim();
  rec.unkeyedSpecFragments = [...new Set(unkeyedNotes)].slice(0, 24);

  rec.buildRequirements = buildSections.map((s) => s.text).join('\n\n').trim();
  const buildLinks = [];
  for (const s of buildSections) {
    for (const l of extractLinks(s.html)) {
      if (/^https?:/i.test(l.url) && !/paypal/i.test(l.url)) buildLinks.push(l);
    }
  }
  rec.buildRequirementsLinks = buildLinks;

  rec.externalLinks = parseExternalLinks(excerpt, sections).filter(
    (l) => !buildLinks.some((b) => b.url === l.url)
  );
  rec.buildThreads = sections
    .filter((s) => SECTION_FOR_THREADS.has(s.heading))
    .flatMap((s) => extractLinks(s.html))
    .filter((l) => /^https?:/i.test(l.url));
  rec.kitAvailability = sections
    .filter((s) => SECTION_FOR_KIT.has(s.heading))
    .map((s) => s.text)
    .join('\n\n')
    .trim();

  Object.assign(rec, archiveStatusFor(full));

  if (!rec.images.length) {
    rec.review.push({ field: 'images', issue: 'no gallery images found on source page' });
  }
  if (!Object.keys(rec.specifications).length) {
    rec.review.push({ field: 'specifications', issue: 'no machine-readable specifications found' });
  }
  return rec;
}

async function pool(items, n, worker) {
  const out = new Array(items.length);
  let i = 0;
  const runners = Array.from({ length: n }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return out;
}

/** Post-processing: stable slugs, unambiguous names, designer grouping keys. */
function finalise(aircraft) {
  // 1. Stable, readable slugs. Squarespace auto-slugs (random hashes) are
  //    replaced; the original is always kept in `sourceSlug`.
  const used = new Set();
  for (const a of aircraft) {
    a.sourceSlug = a.slug;
    let base =
      /^[a-z0-9]{20,}$/.test(a.slug) || !/^[a-z0-9-]+$/.test(a.slug)
        ? a.name
            .toLowerCase()
            .normalize('NFKD')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
        : a.slug;
    if (!base) base = a.id;
    let slug = base;
    let n = 2;
    while (used.has(slug)) slug = `${base}-${n++}`;
    used.add(slug);
    a.slug = slug;
  }

  // 2. Designer grouping key (case/alias insensitive for filtering).
  for (const a of aircraft) {
    a.designerKey = designerKey(a.designer);
    if (!a.designerKey) a.designerKey = 'uncredited';
  }

  // 3. Parkjets used duplicate slugs for genuinely different designs that share
  //    a name (e.g. four F-14 Tomcats by four designers). Keep every design,
  //    but give each an unambiguous display name.
  const byName = new Map();
  for (const a of aircraft) {
    const k = a.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    (byName.get(k) || byName.set(k, []).get(k)).push(a);
  }
  for (const arr of byName.values()) {
    if (arr.length === 1) {
      arr[0].displayName = arr[0].name;
      continue;
    }
    for (const a of arr) {
      if (a.designer) a.displayName = `${a.name} — ${a.designer}`;
      else a.displayName = `${a.name} (${a.sourceSlug})`;
    }
    const seen = new Map();
    for (const a of arr) {
      const c = (seen.get(a.displayName) || 0) + 1;
      seen.set(a.displayName, c);
      if (c > 1) a.displayName = `${a.displayName} (${c})`;
    }
  }

  // 4. A one-line summary for cards and meta descriptions.
  for (const a of aircraft) {
    const s = (a.designerNotes || a.description || '').replace(/\s+/g, ' ').trim();
    a.summary = s.length <= 220 ? s : s.slice(0, s.lastIndexOf(' ', 210) > 80 ? s.lastIndexOf(' ', 210) : 220).trim() + '…';
  }
}

async function main() {
  const disc = readJSON(path.join(ROOT, 'data', '_raw', 'discovery.json'));
  if (!disc) throw new Error('Run `npm run discover` first (data/_raw/discovery.json missing).');

  const catById = new Map(disc.categories.map((c) => [c.id, c]));
  log(`→ importing ${disc.items.length} aircraft from ${disc.origin}`);

  const done = readJSON(path.join(ROOT, 'data', '_raw', 'imported.json'), {});
  const failures = [];
  let n = 0;

  const records = await pool(disc.items, CONCURRENCY, async (it) => {
    n += 1;
    if (n % 10 === 0) log(`   ${n}/${disc.items.length} …`);
    await sleep(120);
    try {
      const rec = await importOne(it, catById, done[it.slug]?.images || []);
      done[it.slug] = rec;
      return rec;
    } catch (e) {
      failures.push({ slug: it.slug, url: ORIGIN + it.fullUrl, reason: e.message });
      log(`   ✗ ${it.slug}: ${e.message}`);
      return null;
    }
  });

  const aircraft = records.filter(Boolean);
  finalise(aircraft);
  aircraft.sort((a, b) => a.displayName.localeCompare(b.displayName, 'en'));

  writeJSON(path.join(ROOT, 'data', 'aircraft.json'), aircraft);
  writeJSON(path.join(ROOT, 'data', '_raw', 'imported.json'), done);
  writeJSON(path.join(ROOT, 'data', '_raw', 'import-failures.json'), failures);

  const withSpecs = aircraft.filter((a) => Object.keys(a.specifications).length).length;
  const withImages = aircraft.filter((a) => a.images.length).length;
  const totalImages = aircraft.reduce((s, a) => s + a.images.length, 0);
  const review = aircraft.filter((a) => a.review.length);

  log('');
  log(`✓ aircraft records      : ${aircraft.length}`);
  log(`✓ with specifications   : ${withSpecs}`);
  log(`✓ with images           : ${withImages}`);
  log(`✓ total gallery images  : ${totalImages}`);
  log(`✓ needing manual review : ${review.length}`);
  log(`✓ hard failures         : ${failures.length}`);
  log('✓ wrote data/aircraft.json');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
