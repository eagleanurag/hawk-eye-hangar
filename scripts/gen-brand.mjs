#!/usr/bin/env node
/**
 * Generates every shipped brand derivative from the three MASTER PNGs.
 *
 * The masters in public/brand/ are the artwork of record and are never modified
 * by this script:
 *
 *   hawkeye-hangar-logo.png            1402x1122  full lockup (crest + wordmark)
 *   hawkeye-hangar-hero.png            1536x1024  hero lockup
 *   hawkeye-hangar-favicon-source.png  1254x1254  aircraft + hangar mark, no wordmark
 *
 * Everything it writes is a derivative:
 *
 *   public/brand/hawkeye-hangar-logo.webp        1000x800   primary logo, web delivery
 *   public/brand/hawkeye-hangar-logo-nav.webp    500x400   compact navbar lockup
 *   public/brand/hawkeye-hangar-hero.webp       1200x800   hero, aspect preserved
 *   public/brand/hawkeye-hangar-hero-640.webp    640x427   hero, small-viewport srcset
 *   public/favicon-16x16.png                      16x16    transparent
 *   public/favicon-32x32.png                      32x32    transparent
 *   public/favicon-48x48.png                      48x48    transparent
 *   public/favicon.ico                       16/32/48      multi-size, transparent
 *   public/apple-touch-icon.png                 180x180    on the site dark ground
 *
 * Two rules this script enforces, both of which the artwork depends on:
 *
 *   1. ASPECT RATIO IS NEVER CHANGED. Derivatives are produced with a single-
 *      dimension resize, so the composition is scaled, never cropped or
 *      stretched. (An earlier hawkeye-hangar-hero.webp was a 1200x1200 square
 *      of the *favicon* artwork, which silently destroyed the 3:2 hero
 *      composition. Regenerating from the master at one dimension is what
 *      prevents that class of mistake.)
 *   2. TRANSPARENCY IS PRESERVED. The ICO directory PNGs and the small favicon
 *      PNGs keep their alpha channel. Only apple-touch-icon.png is composited,
 *      because iOS renders bare transparency as black and the mark is a dark
 *      hangar interior that needs a deliberate ground to read against.
 *
 * Requires sharp. It is a devDependency; CI does not run this script (the
 * generated files are committed), but running it locally must be reproducible.
 *
 * Run: node scripts/gen-brand.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { ROOT } from './lib.mjs';

const BRAND = path.join(ROOT, 'public', 'brand');
const OUT = path.join(ROOT, 'public');

/** The site ground colour, for the one asset that must not be transparent. */
const GROUND = '#0a1220';

const MASTER = {
  logo: path.join(BRAND, 'hawkeye-hangar-logo.png'),
  hero: path.join(BRAND, 'hawkeye-hangar-hero.png'),
  favicon: path.join(BRAND, 'hawkeye-hangar-favicon-source.png'),
};

for (const [k, p] of Object.entries(MASTER)) {
  if (!fs.existsSync(p)) {
    console.error(`✗ missing master asset for "${k}": ${p}`);
    process.exit(1);
  }
}

/* ------------------------------- ICO writer ------------------------------ */
/*
 * An ICO is a 6-byte header, a 16-byte directory entry per image, then the
 * image payloads. Every modern browser accepts PNG payloads, so the resized
 * PNGs are embedded verbatim rather than re-encoded to BMP.
 */
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

function makeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + 16 * images.length;
  images.forEach((img, i) => {
    const o = i * 16;
    dir[o] = img.size >= 256 ? 0 : img.size;
    dir[o + 1] = img.size >= 256 ? 0 : img.size;
    dir[o + 2] = 0;
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(img.buf.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += img.buf.length;
  });
  return Buffer.concat([header, dir, ...images.map((i) => i.buf)]);
}

/* --------------------------------- helpers -------------------------------- */

/** Tight bounding box of everything with alpha above `threshold`. */
async function alphaBounds(file, threshold = 8) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * info.channels + 3] > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** Transparent PNG of the artwork, scaled on ONE dimension only. */
function scaled(file, dimension, key) {
  return sharp(file)
    .resize(key === 'width' ? { width: dimension } : { height: dimension })
    .png({ compressionLevel: 9, effort: 10 });
}

/**
 * PNG of the artwork in a square canvas, letterboxed with `fit: 'contain'` so
 * the 5:4 mark is never cropped.
 *
 * `background` composites onto a solid ground (apple-touch-icon only).
 * Otherwise the canvas is padded with fully transparent pixels.
 *
 * The output is forced to 8-bit truecolour+alpha (PNG colour type 6). libvips
 * will otherwise pick a palette PNG for these small flat-ish icons, and a
 * palette PNG can carry transparency in a way that some favicon consumers
 * mishandle — so the alpha channel is made explicit rather than left to the
 * encoder's discretion.
 */
async function square(file, size, { background } = {}) {
  const pad = { r: 0, g: 0, b: 0, alpha: 0 };
  const ground = background ?? pad;
  return sharp(file)
    .resize(size, size, { fit: 'contain', background: ground })
    // ensureAlpha puts every pixel on a 4-channel footing before encoding
    .ensureAlpha()
    .removeAlpha()
    .extend({ top: 0, bottom: 0, left: 0, right: 0, background: ground })
    .ensureAlpha()
    .png({ compressionLevel: 9, effort: 10, palette: false, colours: undefined })
    .toBuffer();
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

async function writeWebp(dest, pipeline, label) {
  const buf = await pipeline.toBuffer();
  fs.writeFileSync(dest, buf);
  const m = await sharp(buf).metadata();
  console.log(
    `  ✓ ${label.padEnd(34)} ${String(m.width + 'x' + m.height).padEnd(10)} ${kb(buf.length).padStart(10)}`
  );
}

/* ---------------------------------- main ---------------------------------- */

console.log('HawkEye Hangar — brand derivatives');

// Crop the favicon master to the artwork so the icon fills its square canvas.
const faviconBounds = await alphaBounds(MASTER.favicon);
const faviconTrimmed = await sharp(MASTER.favicon)
  .extract(faviconBounds)
  .png()
  .toBuffer();
const faviconTrimPath = path.join(BRAND, '.favicon-source-trimmed.png');
fs.writeFileSync(faviconTrimPath, faviconTrimmed);

console.log(`\n  favicon master artwork: ${faviconBounds.width}x${faviconBounds.height} (trimmed from 1254x1254)\n`);

try {
  // ---- primary logo -------------------------------------------------------
  // 1000px on the long edge. The full-res 1.35 MB PNG is never served to a
  // visitor; this derivative is what the site requests.
  await writeWebp(
    path.join(BRAND, 'hawkeye-hangar-logo.webp'),
    scaled(MASTER.logo, 1000, 'width').webp({ quality: 88, alphaQuality: 100, effort: 6 }),
    'brand/hawkeye-hangar-logo.webp'
  );

  // ---- navbar lockup ------------------------------------------------------
  // Displayed at 30-44px tall, so 500px on the long edge is already ~10x the
  // rendered size. Same aspect as the master, still transparent.
  await writeWebp(
    path.join(BRAND, 'hawkeye-hangar-logo-nav.webp'),
    scaled(MASTER.logo, 500, 'width').webp({ quality: 90, alphaQuality: 100, effort: 6 }),
    'brand/hawkeye-hangar-logo-nav.webp'
  );

  // ---- hero ---------------------------------------------------------------
  // ONE dimension only. The master is 1536x1024 (3:2), so a 1200px width gives
  // 1200x800 and the composition survives intact.
  await writeWebp(
    path.join(BRAND, 'hawkeye-hangar-hero.webp'),
    scaled(MASTER.hero, 1200, 'width').webp({ quality: 84, alphaQuality: 100, effort: 6 }),
    'brand/hawkeye-hangar-hero.webp'
  );

  // A smaller hero for the srcset, so a phone never downloads the 1200px file
  // for a ~320px slot.
  await writeWebp(
    path.join(BRAND, 'hawkeye-hangar-hero-640.webp'),
    scaled(MASTER.hero, 640, 'width').webp({ quality: 82, alphaQuality: 100, effort: 6 }),
    'brand/hawkeye-hangar-hero-640.webp'
  );

  // ---- favicons -----------------------------------------------------------
  for (const size of [16, 32, 48]) {
    const buf = await square(faviconTrimmed, size);
    const dest = path.join(OUT, `favicon-${size}x${size}.png`);
    fs.writeFileSync(dest, buf);
    console.log(`  ✓ ${`favicon-${size}x${size}.png`.padEnd(34)} ${`${size}x${size}`.padEnd(10)} ${kb(buf.length).padStart(10)}`);
  }

  const icoImages = [];
  for (const size of [16, 32, 48]) {
    icoImages.push({ size, buf: await square(faviconTrimmed, size) });
  }
  const ico = makeIco(icoImages);
  fs.writeFileSync(path.join(OUT, 'favicon.ico'), ico);
  console.log(`  ✓ ${'favicon.ico'.padEnd(34)} ${'16/32/48'.padEnd(10)} ${kb(ico.length).padStart(10)}   (multi-size, transparent)`);

  // apple-touch-icon is the one asset that gets a ground: iOS paints bare
  // transparency black, and this mark is a dark hangar interior. A dark
  // HawkEye-compatible ground is used deliberately. Never white.
  const apple = await square(faviconTrimmed, 180, { background: GROUND });
  fs.writeFileSync(path.join(OUT, 'apple-touch-icon.png'), apple);
  console.log(`  ✓ ${'apple-touch-icon.png'.padEnd(34)} ${'180x180'.padEnd(10)} ${kb(apple.length).padStart(10)}   (on ${GROUND})`);
} finally {
  fs.rmSync(faviconTrimPath, { force: true });
}

console.log('\nMasters left untouched:');
for (const [k, p] of Object.entries(MASTER)) {
  const m = await sharp(p).metadata();
  console.log(`  · ${path.basename(p).padEnd(34)} ${m.width}x${m.height}  alpha=${m.hasAlpha}`);
}
