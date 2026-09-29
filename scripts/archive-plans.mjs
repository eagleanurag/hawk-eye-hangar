#!/usr/bin/env node
/**
 * Phase 4/5/6 — archive-plans.mjs
 *
 * For every aircraft this script:
 *   1. Checks for a plan file already sitting in public/plans/<slug>/ (so a
 *      file added by hand later is picked up and validated automatically).
 *   2. Otherwise attempts every legitimate public download endpoint the source
 *      site exposes for that aircraft's digital good.
 *   3. Validates whatever it gets (ZIP central directory + CRC, PDF structure,
 *      DXF sections, SVG root) and records a SHA-256.
 *   4. Writes data/archive-manifest.json.
 *
 * ACCESS MODEL OF THE SOURCE SITE
 * -------------------------------
 * Parkjets delivers its plan files as Squarespace "digital goods" that are
 * released only to signed-in MemberSpace members. There is no public,
 * unauthenticated download URL. This script therefore reports those aircraft
 * as SOURCE_ONLY: the metadata, images and original filename are archived and
 * the detail page links to the original source page instead of presenting a
 * download button that would not work.
 *
 * It never attempts to bypass the membership gate.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, fetchURL, readJSON, writeJSON, ensureDir, log, sleep } from './lib.mjs';
import { validateFile, humanBytes } from './validate-files.mjs';

const DATA = path.join(ROOT, 'data', 'aircraft.json');
const RAW = path.join(ROOT, 'data', '_raw', 'collection.json');
const PLANS = path.join(ROOT, 'public', 'plans');
const ORIGIN = 'https://www.parkjets.com';
const PROBE_TIMEOUT = 25000;

/**
 * `--local-only` skips the network probe phase entirely.
 *
 * The default run re-probes every public endpoint for every aircraft, which is
 * the right thing when first surveying the source site but takes many minutes
 * and does not need repeating. When a maintainer drops plan files into
 * public/plans/<slug>/ by hand, this mode picks them up, validates and hashes
 * them, and carries every other entry forward from the previous manifest so no
 * recorded probe history is lost.
 */
const LOCAL_ONLY = process.argv.includes('--local-only');

const ARCHIVE_STATUS = {
  ARCHIVED: 'ARCHIVED',
  SOURCE_ONLY: 'SOURCE_ONLY',
  UNAVAILABLE: 'UNAVAILABLE',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
};

/** Every legitimate, unauthenticated endpoint the source exposes for a file. */
function candidateUrls(ac, dg) {
  const page = ac.sourceUrl;
  const slug = (ac.sourceSlug || ac.slug).replace(/[^a-z0-9-]+/gi, '');
  const out = [];
  if (dg?.urlId) {
    out.push({ url: `${page}.${dg.urlId}`, kind: 'squarespace-digital-good' });
    out.push({ url: `${ORIGIN}/free-plans/p/${slug}.${dg.urlId}`, kind: 'squarespace-digital-good' });
  }
  if (dg?.systemDataId) {
    out.push({ url: `${ORIGIN}/itm/${dg.systemDataId}`, kind: 'squarespace-itm' });
  }
  if (dg?.filename) {
    out.push({ url: `${page}?download=${encodeURIComponent(dg.filename)}`, kind: 'filename-query' });
  }
  out.push({ url: page, kind: 'source-page' });
  return out;
}

const PLACEHOLDER = /\.(png|jpg|jpeg|gif|svg)$/i;

async function tryDownload(url, referer) {
  const r = await fetchURL(url, {
    retries: 0,
    timeout: PROBE_TIMEOUT,
    cache: false,
    headers: { referer, accept: '*/*' },
  });
  const ct = (r.headers['content-type'] || '').split(';')[0].trim();
  if (r.status !== 200) return { ok: false, reason: `HTTP ${r.status}` };
  if (/^text\/html/.test(ct) || (r.buffer[0] === 0x3c && r.buffer[1] === 0x21)) {
    return { ok: false, reason: 'endpoint returned an HTML page, not a file' };
  }
  if (/^image\//.test(ct) || PLACEHOLDER.test(new URL(r.url, page0).pathname)) {
    return { ok: false, reason: `endpoint returned a placeholder image (${ct})` };
  }
  if (r.buffer.length < 512) return { ok: false, reason: `response too small (${r.buffer.length} B)` };
  return { ok: true, buffer: r.buffer, contentType: ct, finalUrl: r.url };
}

let page0 = 'https://www.parkjets.com/';

/** Any file the maintainer dropped into public/plans/<slug>/ by hand. */
function findLocalPlan(ac, publishedFilename) {
  const dir = path.join(PLANS, ac.slug);
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => path.join(dir, e.name));
  const allowed = /\.(zip|pdf|dxf|svg|dwg|rar|7z|skp|blend|igs|step|stp)$/i;
  const candidates = files.filter((f) => allowed.test(f));
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // Several files in one aircraft directory. Selection must be deterministic
  // and evidence-based. A filename is never trusted on its own: the published
  // original filename is the authority, and a trailing "-22" in "F-22" is an
  // aircraft designation, NOT a browser duplicate marker.
  const normName = (n) =>
    String(n || '')
      .toLowerCase()
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-z0-9]+/g, '');
  const target = normName(publishedFilename);

  const scored = candidates
    .map((f) => {
      const name = path.basename(f);
      // "(1)" is an unambiguous browser re-download marker; a bare "-1" is not,
      // because designators legitimately end in numbers (F-22, B-52, X-29).
      const parenDup = /\(\d+\)(?=\.[^.]+$)/.test(name) ? 1 : 0;
      return {
        f,
        name,
        parenDup,
        matchesPublished: target ? (normName(name) === target ? 0 : 1) : 1,
        size: fs.statSync(f).size,
      };
    })
    .sort(
      (a, b) =>
        a.matchesPublished - b.matchesPublished ||
        a.parenDup - b.parenDup ||
        b.size - a.size ||
        a.name.localeCompare(b.name)
    );

  const distinct = new Set(scored.map((s) => hashOf(s.f)));
  if (distinct.size > 1) {
    log(
      `  ! ${ac.slug}: ${candidates.length} files with DIFFERENT content in ` +
        `${path.relative(ROOT, dir)} — chose "${scored[0].name}". Review this aircraft.`
    );
  } else if (scored.length > 1) {
    log(`  ${ac.slug}: ${scored.length} identical copies present — archived "${scored[0].name}".`);
  }
  return scored[0].f;
}

function hashOf(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function main() {
  const aircraft = readJSON(DATA);
  if (!aircraft) throw new Error('data/aircraft.json missing — run `npm run import` first.');
  const raw = readJSON(RAW, { items: [] });
  const dgBySlug = new Map((raw.items || []).map((i) => [i.urlId, (i.digitalGoods || [])[0] || null]));

  ensureDir(PLANS);
  const manifest = [];
  const stats = { archived: 0, sourceOnly: 0, unavailable: 0, manualReview: 0, localFound: 0, downloaded: 0 };

  // In offline mode the previous manifest is the source of truth for every
  // entry that has no new local file.
  const prevBySlug = LOCAL_ONLY
    ? new Map(
        (readJSON(path.join(ROOT, 'data', 'archive-manifest.json'), { entries: [] }).entries || []).map((e) => [
          e.slug,
          e,
        ])
      )
    : new Map();

  if (LOCAL_ONLY) {
    log(`offline mode: ${prevBySlug.size} existing manifest entries carried forward; no network probes`);
  }

  for (const ac of aircraft) {
    const dg = dgBySlug.get(ac.sourceSlug) || null;
    const entry = {
      aircraftId: ac.id,
      slug: ac.slug,
      name: ac.displayName,
      designer: ac.designer || null,
      sourceUrl: ac.sourceUrl,
      originalFilename: dg?.filename || null,
      declaredType: dg?.systemDataSourceType || null,
      localFile: null,
      bytes: null,
      sha256: null,
      fileType: null,
      archiveStatus: ARCHIVE_STATUS.SOURCE_ONLY,
      validation: { status: 'not-applicable' },
      attempts: [],
      notes: '',
      license: {
        status: 'third-party',
        notes:
          'Plan file is the intellectual property of the original designer. ' +
          'Redistribution rights are not asserted by this archive.',
      },
    };

    // 1) A file already archived locally wins.
    const local = findLocalPlan(ac, dg?.filename);
    if (local) {
      const v = validateFile(local);
      entry.localFile = path.relative(ROOT, local).split(path.sep).join('/');
      entry.publicPath = '/' + entry.localFile.replace(/^public\//, '');
      entry.bytes = v.bytes;
      entry.sha256 = v.sha256;
      entry.fileType = v.type;
      entry.archiveStatus = v.valid ? ARCHIVE_STATUS.ARCHIVED : ARCHIVE_STATUS.MANUAL_REVIEW;
      entry.validation = v.valid
        ? { status: 'passed', detail: summariseValidation(v) }
        : { status: 'failed', error: v.error };
      if (v.valid) stats.archived += 1;
      else stats.manualReview += 1;
      ac.download = {
        type: 'local',
        file: entry.publicPath,
        filename: path.basename(local),
        sourceUrl: ac.sourceUrl,
        status: 'Archived and validated',
        bytes: v.bytes,
        sha256: v.sha256,
        fileType: v.type,
      };
      ac.archiveStatus = entry.archiveStatus;
      manifest.push(entry);
      continue;
    }

    // 2) Offline mode: no local file, so carry the previous manifest entry
    //    forward untouched. The recorded probe history and the original
    //    filename must survive a drop-in ingest, not be reset to a guess.
    if (LOCAL_ONLY) {
      const prev = prevBySlug.get(ac.slug);
      if (prev) {
        manifest.push(prev);
        if (prev.archiveStatus === ARCHIVE_STATUS.ARCHIVED) stats.archived += 1;
        else if (prev.archiveStatus === ARCHIVE_STATUS.MANUAL_REVIEW) stats.manualReview += 1;
        else if (prev.archiveStatus === ARCHIVE_STATUS.UNAVAILABLE) stats.unavailable += 1;
        else stats.sourceOnly += 1;

        ac.archiveStatus = prev.archiveStatus;
        ac.download = prev.localFile
          ? {
              type: 'local',
              file: prev.publicPath,
              filename: path.basename(prev.localFile),
              sourceUrl: ac.sourceUrl,
              status: 'Archived and validated',
              bytes: prev.bytes,
              sha256: prev.sha256,
              fileType: prev.fileType,
            }
          : {
              type: 'source',
              file: null,
              sourceUrl: ac.sourceUrl,
              originalFilename: prev.originalFilename,
              format: prev.declaredType,
              status: prev.notes,
            };
        continue;
      }

      // No local file and no previous record: record it honestly, no probing.
      entry.archiveStatus = dg ? ARCHIVE_STATUS.SOURCE_ONLY : ARCHIVE_STATUS.UNAVAILABLE;
      entry.notes = dg
        ? 'No local file supplied yet. Awaiting a plan file dropped into public/plans/' +
          ac.slug +
          '/.'
        : 'Source page publishes no downloadable file for this entry.';
      stats[entry.archiveStatus === ARCHIVE_STATUS.UNAVAILABLE ? 'unavailable' : 'sourceOnly'] += 1;
      ac.archiveStatus = entry.archiveStatus;
      ac.download = {
        type: 'source',
        file: null,
        sourceUrl: ac.sourceUrl,
        originalFilename: dg?.filename || null,
        format: dg?.systemDataSourceType || null,
        status: entry.notes,
      };
      manifest.push(entry);
      continue;
    }

    // 3) Otherwise try the source site's own public endpoints, once.
    if (dg) {
      for (const c of candidateUrls(ac, dg)) {
        await sleep(150);
        try {
          const res = await tryDownload(c.url, ac.sourceUrl);
          entry.attempts.push({ url: c.url, kind: c.kind, result: res.ok ? 'file' : res.reason });
          if (res.ok) {
            const name = (dg.filename || path.basename(new URL(res.finalUrl).pathname) || `${ac.slug}.zip`)
              .replace(/[\\/:*?"<>|]/g, '_')
              .trim() || `${ac.slug}.zip`;
            const dest = path.join(PLANS, ac.slug, name);
            ensureDir(path.dirname(dest));
            fs.writeFileSync(dest, res.buffer);
            const v = validateFile(dest);
            entry.localFile = path.relative(ROOT, dest).split(path.sep).join('/');
            entry.publicPath = '/' + entry.localFile.replace(/^public\//, '');
            entry.bytes = v.bytes;
            entry.sha256 = v.sha256;
            entry.fileType = v.type;
            entry.archiveStatus = v.valid ? ARCHIVE_STATUS.ARCHIVED : ARCHIVE_STATUS.MANUAL_REVIEW;
            entry.validation = v.valid
              ? { status: 'passed', detail: summariseValidation(v) }
              : { status: 'failed', error: v.error };
            stats.downloaded += 1;
            break;
          }
        } catch (e) {
          entry.attempts.push({ url: c.url, kind: c.kind, result: `error: ${e.message}` });
        }
      }
    } else {
      entry.attempts.push({ result: 'no digital good published for this item' });
    }

    // 4) Classify.
    if (!entry.localFile) {
      if (dg) {
        entry.archiveStatus = ARCHIVE_STATUS.SOURCE_ONLY;
        entry.notes =
          'Plan file is released to signed-in Parkjets members only. No public ' +
          'download endpoint exists; the original product page is linked instead.';
        stats.sourceOnly += 1;
      } else {
        entry.archiveStatus = ARCHIVE_STATUS.UNAVAILABLE;
        entry.notes = 'Source page publishes no downloadable file for this entry.';
        stats.unavailable += 1;
      }
      ac.download = {
        type: 'source',
        file: null,
        sourceUrl: ac.sourceUrl,
        originalFilename: dg?.filename || null,
        format: dg?.systemDataSourceType || null,
        status: entry.notes,
      };
    } else {
      ac.download = {
        type: 'local',
        file: entry.publicPath,
        filename: path.basename(entry.localFile),
        sourceUrl: ac.sourceUrl,
        status:
          entry.validation.status === 'passed'
            ? `Archived locally (${humanBytes(entry.bytes)}, ${entry.fileType})`
            : `Archived but failed validation: ${entry.validation.error}`,
        bytes: entry.bytes,
        sha256: entry.sha256,
        fileType: entry.fileType,
      };
    }
    ac.archiveStatus = entry.archiveStatus;
    manifest.push(entry);
  }

  /*
   * `planStatus` is the vocabulary the migration/recovery evidence code reads
   * (DOWNLOADED / SOURCE_ONLY / FAILED), while `archiveStatus` is the one the
   * site renders. Both are written so a single manifest serves the website and
   * the recovery machinery, and so the two can never disagree.
   *
   * DOWNLOADED is only ever claimed for an entry that already passed real
   * validation above — the evidence collector re-verifies the bytes on disk
   * before it will count it, so this cannot become a false completion.
   */
  const PLAN_STATUS = {
    ARCHIVED: 'DOWNLOADED',
    MANUAL_REVIEW: 'FAILED',
    SOURCE_ONLY: 'SOURCE_ONLY',
    UNAVAILABLE: 'SOURCE_ONLY',
  };
  for (const e of manifest) {
    e.planStatus = PLAN_STATUS[e.archiveStatus] || 'PENDING';
    if (e.planStatus === 'DOWNLOADED' && !e.sha256) {
      // no digest means no proof of bytes — refuse to claim it
      e.planStatus = 'PENDING';
    }
  }

  writeJSON(path.join(ROOT, 'data', 'archive-manifest.json'), {
    generatedAt: new Date().toISOString(),
    source: {
      site: 'https://www.parkjets.com',
      collection: 'https://www.parkjets.com/free-plans',
      platform: 'Squarespace 7.1 commerce + MemberSpace membership',
    },
    accessModel:
      'Parkjets plan files are MemberSpace-gated digital goods. They are not publicly ' +
      'downloadable, so this archive preserves the catalogue metadata, imagery and ' +
      'original filenames, and links to the original product page for the file itself.',
    summary: {
      totalAircraft: manifest.length,
      archived: stats.archived,
      sourceOnly: stats.sourceOnly,
      unavailable: stats.unavailable,
      manualReview: stats.manualReview,
      newlyDownloadedThisRun: stats.downloaded,
    },
    entries: manifest,
  });
  writeJSON(DATA, aircraft);

  log('');
  log(`✓ manifest entries        : ${manifest.length}`);
  log(`✓ ARCHIVED (local file)   : ${stats.archived}`);
  log(`✓ SOURCE_ONLY (member)    : ${stats.sourceOnly}`);
  log(`✓ UNAVAILABLE             : ${stats.unavailable}`);
  log(`✓ MANUAL_REVIEW           : ${stats.manualReview}`);
  log('✓ wrote data/archive-manifest.json');
}

function summariseValidation(v) {
  const bits = [];
  if (v.type === 'ZIP') {
    bits.push(`${v.files} files`, `${humanBytes(v.uncompressedBytes)} uncompressed`);
    const byExt = Object.entries(v.byExtension || {});
    if (byExt.length) bits.push(`types: ${byExt.map(([e, n]) => `${n}×${e}`).join(', ')}`);
    if (v.nestedArchives?.length) bits.push(`nested: ${v.nestedArchives.join(', ')}`);
  }
  if (v.type === 'PDF') {
    bits.push(`PDF ${v.version}`, v.pages ? `${v.pages} pages` : 'page count unknown');
    if (v.encrypted) bits.push('ENCRYPTED');
  }
  if (v.type === 'DXF') bits.push(v.hasEntities ? 'entities present' : 'no ENTITIES section');
  return bits.join(' · ');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
