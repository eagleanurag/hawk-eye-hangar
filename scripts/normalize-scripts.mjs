#!/usr/bin/env node
/**
 * Normalises line endings and encoding for Windows script files.
 *
 * Windows PowerShell 5.1 reads a .ps1 as the OEM/ANSI code page unless the
 * file carries a UTF-8 BOM. Without it, any non-ASCII character (an em dash, a
 * curly quote) is decoded as mojibake and the script fails to parse with a
 * cascade of confusing syntax errors.
 *
 * So: keep these files ASCII-only, then stamp them with a UTF-8 BOM, and give
 * them CRLF line endings so they behave identically everywhere.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = [
  'scripts/resume-parkjets.ps1',
  'scripts/resume-parkjets.cmd',
  'scripts/install-parkjets-task.ps1',
];
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

let changed = 0;
for (const rel of TARGETS) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) {
    console.log(`  (skip ${rel} — not present)`);
    continue;
  }
  let text = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');

  // Report, do not silently swallow, non-ASCII characters.
  const bad = [...text].filter((c) => c.codePointAt(0) > 126);
  if (bad.length) {
    console.log(`  ✗ ${rel} contains ${bad.length} non-ASCII character(s): ${[...new Set(bad)].map((c) => c.codePointAt(0).toString(16)).join(', ')}`);
    console.log('    Replace them with ASCII before committing — PowerShell 5.1 cannot read this reliably.');
    changed += 1;
    continue;
  }

  const crlf = text.replace(/\r?\n/g, '\r\n');
  fs.writeFileSync(p, Buffer.concat([BOM, Buffer.from(crlf, 'ascii')]));
  console.log(`  ✓ ${rel} — ASCII, CRLF, UTF-8 BOM`);
  changed += 1;
}

if (changed) {
  fs.appendFileSync(
    path.join(ROOT, '.migration', 'logs', `normalize-scripts-${new Date().toISOString().slice(0, 10)}.log`),
    `normalize-scripts: processed ${changed} file(s) at ${new Date().toISOString()}\n`
  );
}
