#!/usr/bin/env node
/**
 * Generates public/og-default.png — the default social preview image.
 *
 * Drawn procedurally with a dependency-free PNG encoder so the build stays
 * portable. Aircraft pages override this with their own photograph.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ROOT } from './lib.mjs';

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
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const encodePng = (w, h, rgba) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

const W = 1200;
const H = 630;
const px = Buffer.alloc(W * H * 4);

const clamp = (v) => Math.max(0, Math.min(1, v));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

const inPoly = (pts, x, y) => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

/** Delta-wing planform, unit space 0..1 x 0..1, pointing right. */
const PLAN = [
  [0.0, 0.5], [1.0, 0.24], [0.79, 0.5], [1.0, 0.76], [0.0, 0.62], [0.14, 0.54],
];
const TAIL_TOP = [[0.42, 0.47], [0.6, 0.12], [0.66, 0.15], [0.48, 0.48]];
const TAIL_BOT = [[0.42, 0.53], [0.6, 0.88], [0.66, 0.85], [0.48, 0.52]];

function planeAlpha(x, y, box) {
  const { x0, y0, w, h } = box;
  const u = (x - x0) / w;
  const v = (y - y0) / h;
  if (u < -0.05 || u > 1.05 || v < -0.2 || v > 1.2) return 0;
  if (inPoly(PLAN, u, v) || inPoly(TAIL_TOP, u, v) || inPoly(TAIL_BOT, u, v)) return 1;
  return 0;
}

// Aircraft silhouettes, back to front, at decreasing opacity.
const PLANES = [
  { x: 0.5, y: 0.16, w: 1.25, h: 0.26, a: 0.1 },
  { x: 0.34, y: 0.5, w: 0.86, h: 0.18, a: 0.2 },
  { x: 0.52, y: 0.63, w: 0.62, h: 0.13, a: 0.55 },
];

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const u = x / W;
    const v = y / H;

    // Base: navy → charcoal diagonal with a cyan bloom top-right.
    // NOTE: colour channels are kept normalised to 0..1 throughout.
    const bloom = Math.exp(-(((u - 0.82) ** 2) / 0.10 + ((v - 0.06) ** 2) / 0.16));
    let r = mix(5 / 255, 14 / 255, u * 0.5 + v * 0.5);
    let g = mix(8 / 255, 24 / 255, u * 0.5 + v * 0.5);
    let b = mix(15 / 255, 36 / 255, u * 0.5 + v * 0.5);
    r += bloom * (16 / 255);
    g += bloom * (60 / 255);
    b += bloom * (85 / 255);

    // Blueprint grid: fine 32px, coarse 160px, masked toward the top.
    const mask = clamp(1.15 - v * 1.15);
    const gx = Math.abs(((x % 32) + 32) % 32 - 0.5) < 0.6;
    const gy = Math.abs(((y % 32) + 32) % 32 - 0.5) < 0.6;
    const cx = Math.abs(((x % 160) + 160) % 160 - 0.5) < 0.9;
    const cy = Math.abs(((y % 160) + 160) % 160 - 0.9) < 0.9;
    if (gx || gy) {
      const k = (cx || cy ? 0.05 : 0.022) * mask;
      r += (0x4f / 255) * k;
      g += (0xd6 / 255) * k;
      b += k;
    }

    // Silhouettes.
    for (const p of PLANES) {
      const box = { x0: p.x * W - (p.w * W) / 2, y0: p.y * H - (p.h * H) / 2, w: p.w * W, h: p.h * H };
      const a = planeAlpha(x, y, box) * p.a;
      if (a > 0) {
        r = mix(r, 0x4f / 255, a);
        g = mix(g, 0xc4 / 255, a);
        b = mix(b, 0xe6 / 255, a);
      }
    }

    // Corner brackets.
    const m = 46;
    const inBracket =
      (Math.min(x, W - 1 - x) < 2 && Math.min(y, H - 1 - y) < m) ||
      (Math.max(x, W - 1 - x) < 2 && Math.max(y, H - 1 - y) < m);
    if (inBracket) {
      r = mix(r, 0x4f / 255, 0.55);
      g = mix(g, 0xd6 / 255, 0.55);
      b = mix(b, 1, 0.55);
    }

    // Bottom scrim so overlaid text always has contrast.
    const scrim = smooth(0.55, 1.0, v) * 0.55;
    r *= 1 - scrim * 0.85;
    g *= 1 - scrim * 0.85;
    b *= 1 - scrim * 0.85;

    // Vignette.
    const vig = 1 - 0.35 * (((u - 0.5) ** 2 + (v - 0.5) ** 2) * 2.2);
    const i = (y * W + x) * 4;
    px[i] = Math.round(clamp(r * vig) * 255);
    px[i + 1] = Math.round(clamp(g * vig) * 255);
    px[i + 2] = Math.round(clamp(b * vig) * 255);
    px[i + 3] = 255;
  }
}

fs.writeFileSync(path.join(ROOT, 'public', 'og-default.png'), encodePng(W, H, px));
console.log('✓ wrote public/og-default.png (1200×630)');
