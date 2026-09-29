#!/usr/bin/env node
/**
 * Phase 4/5 — extract-assets.mjs
 *
 * Downloads every aircraft gallery image from the Parkjets CDN and stores it
 * LOCALLY so the archive keeps working if parkjets.com disappears.
 *
 * Two derivatives are produced per image, straight from the CDN's own
 * resizer (no client-side image library, no quality loss beyond the CDN's
 * encoder):
 *     public/media/aircraft/<slug>/NN-400.webp    cards, gallery strip
 *     public/media/aircraft/<slug>/NN-1200.webp   detail page + lightbox
 *
 * Every byte is validated (magic-number sniff + declared length) before it is
 * recorded. Failures are collected and reported, never fatal.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, fetchURL, readJSON, writeJSON, ensureDir, sha256, log, sleep } from './lib.mjs';

const DATA = path.join(ROOT, 'data', 'aircraft.json');
const MEDIA = path.join(ROOT, 'public', 'media', 'aircraft');
const SIZES = [400, 1200];
const CONCURRENCY = 6;
const ALT_LIMIT = 160;

const MAGIC = [
  { sig: [0xff, 0xd8, 0xff], ext: 'jpg', mime: 'image/jpeg' },
  { sig: [0x89, 0x50, 0x4e, 0x47], ext: 'png', mime: 'image/png' },
];

function sniff(buf) {
  if (buf.length < 12) return null;
  // WebP: "RIFF"...."WEBP"
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return { ext: 'webp', mime: 'image/webp' };
  }
  for (const m of MAGIC) {
    if (m.sig.every((b, i) => buf[i] === b)) return { ext: m.ext, mime: m.mime };
  }
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return { ext: 'gif', mime: 'image/gif' };
  return null;
}

/** Squarespace image source URLs: append/replace ?format=NNNw */
function sizedUrl(url, width) {
  const [base, query = ''] = url.split('?');
  const params = new URLSearchParams(query);
  params.set('format', `${width}w`);
  return `${base}?${params.toString()}`;
}

async function downloadVariant(url, destNoExt, publicPath) {
  const r = await fetchURL(url, { retries: 3, delay: 0, timeout: 60000 });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  const kind = sniff(r.buffer);
  if (!kind) throw new Error(`not an image (${r.buffer.length} bytes)`);
  if (r.buffer.length < 200) throw new Error(`suspiciously small (${r.buffer.length} bytes)`);
  const dest = `${destNoExt}.${kind.ext}`;
  ensureDir(path.dirname(dest));
  fs.writeFileSync(dest, r.buffer);
  // `publicPath` is what the site will request; the file lives under public/.
  return { path: `${publicPath}.${kind.ext}`, bytes: r.buffer.length, ext: kind.ext, mime: kind.mime };
}

async function handleAircraft(ac, stats) {
  const dir = path.join(MEDIA, ac.slug);
  let n = 0;
  for (let i = 0; i < ac.images.length; i++) {
    const img = ac.images[i];
    // Idempotent: re-running after a successful pass is a no-op.
    if (img.full && img.card && fs.existsSync(path.join(ROOT, 'public', img.full.replace(/^\//, '')))) {
      n += 1;
      continue;
    }
    const sourceUrl = img.url || img.sourceUrl;
    if (!sourceUrl) {
      stats.failures.push({ aircraft: ac.slug, image: '(none)', reason: 'no source URL on this record' });
      ac.images[i] = { ...img, card: null, full: null, failed: true };
      continue;
    }
    n += 1;
    const base = path.join(dir, String(n).padStart(2, '0'));
    const publicBase = `/media/aircraft/${ac.slug}/${String(n).padStart(2, '0')}`;
    const record = {
      alt: (img.alt || `${ac.displayName} — photo ${n} of ${ac.images.length}`)
        .replace(/\s*[—–-]\s*Parkjets.*$/i, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, ALT_LIMIT),
      caption: img.caption || img.alt || '',
      width: img.width ?? null,
      height: img.height ?? null,
      sourceUrl,
      credit: 'Parkjets.com (original photographer / designer)',
    };
    try {
      for (const w of SIZES) {
        const out = await downloadVariant(sizedUrl(sourceUrl, w), `${base}-${w}`, `${publicBase}-${w}`);
        const sizeKey = w === 400 ? 'card' : 'full';
        record[sizeKey] = out.path;
        record[`${sizeKey}Bytes`] = out.bytes;
        stats.bytes += out.bytes;
        stats.files += 1;
      }
      // Skip the smallest derivative when the source is already tiny.
      if ((record.cardBytes ?? 0) < 1500 && record.card) {
        fs.rmSync(path.join(ROOT, 'public', record.card.replace(/^\//, '')), { force: true });
        record.card = record.full;
        delete record.cardBytes;
      }
      ac.images[i] = record;
      stats.ok += 1;
    } catch (e) {
      stats.failures.push({ aircraft: ac.slug, image: img.url, reason: e.message });
      ac.images[i] = { ...record, card: null, full: null, failed: true };
    }
    await sleep(25);
  }
  ac.images = ac.images.filter((im) => !im.failed);
  if (!ac.images.length) ac.review.push({ field: 'images', issue: 'all image downloads failed' });
}

async function pool(items, n, worker) {
  let i = 0;
  const runners = Array.from({ length: n }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      await worker(items[idx]);
    }
  });
  await Promise.all(runners);
}

async function main() {
  const aircraft = readJSON(DATA);
  if (!aircraft) throw new Error('data/aircraft.json missing — run `npm run import` first.');

  ensureDir(MEDIA);
  const total = aircraft.reduce((s, a) => s + a.images.length, 0);
  log(`→ archiving ${total} gallery images for ${aircraft.length} aircraft`);

  const stats = { ok: 0, bytes: 0, files: 0, failures: [] };
  let done = 0;
  await pool(aircraft, CONCURRENCY, async (ac) => {
    await handleAircraft(ac, stats);
    done += 1;
    if (done % 10 === 0) log(`   ${done}/${aircraft.length} aircraft (${stats.ok} images, ${(stats.bytes / 1048576).toFixed(1)} MB)`);
  });

  writeJSON(DATA, aircraft);
  writeJSON(path.join(ROOT, 'reports', 'image-extraction.json'), {
    generatedAt: new Date().toISOString(),
    totalReferenced: total,
    downloaded: stats.ok,
    files: stats.files,
    totalBytes: stats.bytes,
    failures: stats.failures,
  });

  const withImages = aircraft.filter((a) => a.images.length).length;
  log('');
  log(`✓ images downloaded : ${stats.ok}/${total}`);
  log(`✓ files written     : ${stats.files}`);
  log(`✓ total size        : ${(stats.bytes / 1048576).toFixed(1)} MB`);
  log(`✓ aircraft w/ images: ${withImages}/${aircraft.length}`);
  log(`✗ failures          : ${stats.failures.length}`);
  if (stats.failures.length) log('  (see reports/image-extraction.json)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
