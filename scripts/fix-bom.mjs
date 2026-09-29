#!/usr/bin/env node
/**
 * Strips a UTF-8 BOM from any tracked text file that has one.
 *
 * PowerShell 5.1's `Set-Content -Encoding UTF8` writes a BOM, which is invalid
 * in JSON and undesirable everywhere else. This normalises the tree.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, log } from './lib.mjs';

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.astro', 'work', 'reports']);
const BINARY = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.zip', '.pdf', '.dxf',
  '.woff', '.woff2', '.ttf', '.otf', '.mp4', '.webm',
]);

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
let fixed = 0;
let scanned = 0;

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name));
      continue;
    }
    const p = path.join(dir, e.name);
    if (BINARY.has(path.extname(e.name).toLowerCase())) continue;
    const buf = fs.readFileSync(p);
    scanned += 1;
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      fs.writeFileSync(p, buf.subarray(3));
      fixed += 1;
      log(`  stripped BOM: ${path.relative(ROOT, p)}`);
    }
  }
}

walk(ROOT);
log('');
log(`  scanned ${scanned} text files, stripped ${fixed} BOM(s)`);
if (fixed) {
  log('  ⚠ remember to commit the result');
}
log('');
