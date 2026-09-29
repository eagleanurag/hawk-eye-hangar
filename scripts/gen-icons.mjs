#!/usr/bin/env node
/**
 * Generates the favicon.ico and apple-touch-icon.png from public/favicon.svg
 * by re-encoding the same artwork to PNG with a tiny hand-rolled encoder —
 * no native image dependency, so CI needs no build tools.
 *
 * Run: node scripts/gen-icons.mjs
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

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Rasterises the same shapes used in favicon.svg: rounded dark tile,
 * cyan delta-wing planform, grid hairlines. Anti-aliased via 3×3 supersampling.
 */
function render(size) {
  const S = 3;
  const W = size * S;
  const px = Buffer.alloc(size * size * 4);

  const r = 0.219 * W; // 14/64 corner radius
  const inRounded = (x, y) => {
    const cx = Math.min(Math.max(x, r), W - r);
    const cy = Math.min(Math.max(y, r), W - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };

  // Planform polygon in 64-unit space (same numbers as the SVG).
  const poly = [
    [8, 35.5], [55, 17], [44, 32], [55, 41], [8, 46], [16, 39],
  ];
  const tail = [
    [[30, 30], [39, 15], [42, 16.5], [33, 29.5]],
    [[30, 30], [39, 45], [42, 43.5], [33, 30.5]],
  ];
  const inPoly = (pts, x, y) => {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i];
      const [xj, yj] = pts[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };

  for (let oy = 0; oy < size; oy++) {
    for (let ox = 0; ox < size; ox++) {
      let acc = [0, 0, 0, 0];
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const x = (ox * S + sx + 0.5) * (W / (size * S)) ;
          const y = (oy * S + sy + 0.5) * (W / (size * S)) ;
          if (!inRounded(x, y)) continue;
          const u = (x / W) * 64;
          const v = (y / W) * 64;
          let c = [0x0b, 0x12, 0x20];
          if (inPoly(poly, u, v) || tail.some((t) => inPoly(t, u, v))) {
            const t = Math.min(1, (u / 64 + v / 64) / 2);
            c = [
              Math.round(0x4f + (0x16 - 0x4f) * t),
              Math.round(0xd6 + (0xa6 - 0xd6) * t),
              0xff,
            ];
          }
          acc[0] += c[0];
          acc[1] += c[1];
          acc[2] += c[2];
          acc[3] += 255;
        }
      }
      const n = S * S;
      const i = (oy * size + ox) * 4;
      px[i] = Math.round(acc[0] / n);
      px[i + 1] = Math.round(acc[1] / n);
      px[i + 2] = Math.round(acc[2] / n);
      px[i + 3] = Math.round(acc[3] / n);
    }
  }
  return encodePng(size, size, px);
}

function makeIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + 16 * pngs.length;
  pngs.forEach((p, i) => {
    const o = i * 16;
    dir[o] = p.size >= 256 ? 0 : p.size;
    dir[o + 1] = p.size >= 256 ? 0 : p.size;
    dir[o + 2] = 0;
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(p.buf.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += p.buf.length;
  });
  return Buffer.concat([header, dir, ...pngs.map((p) => p.buf)]);
}

const out = path.join(ROOT, 'public');
const at = render(180);
fs.writeFileSync(path.join(out, 'apple-touch-icon.png'), at);

const icoSizes = [16, 32, 48];
const ico = makeIco(icoSizes.map((size) => ({ size, buf: render(size) })));
fs.writeFileSync(path.join(out, 'favicon.ico'), ico);

console.log('✓ wrote public/apple-touch-icon.png, public/favicon.ico');
