#!/usr/bin/env node
/**
 * Phase 26 — validate-aircraft.mjs
 *
 * Gate that must pass before the site is allowed to build. Checks, in order:
 *
 *   1. JSON validity + required shape for every aircraft record
 *   2. Duplicate detection: slugs, ids, source URLs, display names
 *   3. Missing / broken local images referenced by aircraft.json
 *   4. Broken local plan downloads
 *   5. Archive manifest ↔ aircraft.json agreement
 *   6. Sanity of every source URL
 *
 * Exit code is non-zero on any ERROR. Warnings are reported but do not fail
 * the build (they describe real, accepted limitations of the source data).
 */

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON, sha256 } from './lib.mjs';
import { validateFile } from './validate-files.mjs';

const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

const aircraft = readJSON(path.join(ROOT, 'data', 'aircraft.json'));
if (!aircraft) {
  console.error('✗ data/aircraft.json is missing or not valid JSON.');
  process.exit(1);
}
if (!Array.isArray(aircraft) || !aircraft.length) {
  console.error('✗ data/aircraft.json must be a non-empty array.');
  process.exit(1);
}
const manifest = readJSON(path.join(ROOT, 'data', 'archive-manifest.json'));
const site = readJSON(path.join(ROOT, 'data', 'site.json'));
if (!site) err('data/site.json is missing or invalid.');

/* ---------------------------- 1. shape ---------------------------- */
const REQUIRED = ['id', 'slug', 'name', 'displayName', 'category', 'designer', 'description',
  'specifications', 'images', 'sourceUrl', 'archiveStatus', 'download', 'license', 'source', 'summary'];

for (const a of aircraft) {
  const where = a.slug || a.id || '<unnamed>';
  for (const k of REQUIRED) {
    if (a[k] === undefined || a[k] === null) err(`${where}: missing required field "${k}"`);
  }
  if (!a.slug || !/^[a-z0-9][a-z0-9-]*$/.test(a.slug)) {
    err(`${where}: slug must be lowercase kebab-case, got "${a.slug}"`);
  }
  if (!a.name) err(`${where}: name is empty`);
  if (!a.displayName) err(`${where}: displayName is empty`);
  if (!Array.isArray(a.category)) err(`${where}: category must be an array`);
  else if (!a.category.length) warn(`${where}: not filed under any source category`);
  if (!Array.isArray(a.images)) err(`${where}: images must be an array`);
  if (typeof a.specifications !== 'object' || Array.isArray(a.specifications)) {
    err(`${where}: specifications must be an object`);
  }
  for (const [k, v] of Object.entries(a.specifications || {})) {
    if (typeof v !== 'string' || !v.trim()) err(`${where}: specification "${k}" is empty or not a string`);
  }
  if (!['ARCHIVED', 'SOURCE_ONLY', 'UNAVAILABLE', 'MANUAL_REVIEW'].includes(a.archiveStatus)) {
    err(`${where}: unknown archiveStatus "${a.archiveStatus}"`);
  }
  if (typeof a.sourceUrl !== 'string' || !/^https:\/\/www\.parkjets\.com\/free-plans\/p\//.test(a.sourceUrl)) {
    err(`${where}: sourceUrl is not a Parkjets product page (${a.sourceUrl})`);
  }
  if (a.source?.parkjetsId && a.id !== a.source.parkjetsId) {
    warn(`${where}: id does not match source.parkjetsId`);
  }
}

/* -------------------------- 2. duplicates -------------------------- */
function dups(values) {
  const seen = new Map();
  for (const v of values) {
    if (v == null) continue;
    seen.set(v, (seen.get(v) || 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1);
}
for (const [label, key] of [['id', 'id'], ['slug', 'slug'], ['sourceUrl', 'sourceUrl'], ['displayName', 'displayName']]) {
  for (const [v, n] of dups(aircraft.map((a) => a[key]))) {
    err(`duplicate ${label}: "${v}" appears ${n} times`);
  }
}
for (const [v, n] of dups(aircraft.map((a) => a.source?.parkjetsId))) {
  err(`duplicate Parkjets id: "${v}" appears ${n} times`);
}

/* --------------------------- 3. images ----------------------------- */
let imageFilesChecked = 0;
let imageBytes = 0;
for (const a of aircraft) {
  for (const [i, im] of (a.images || []).entries()) {
    const where = `${a.slug}[${i}]`;
    if (!im.alt) warn(`${where}: image has no alt text`);
    if (!im.card) err(`${where}: missing "card" image path`);
    if (!im.full) err(`${where}: missing "full" image path`);
    for (const key of ['card', 'full']) {
      const rel = im[key];
      if (!rel) continue;
      const abs = path.join(ROOT, 'public', rel.replace(/^\//, ''));
      if (!fs.existsSync(abs)) {
        err(`${where}: ${key} image missing on disk -> ${rel}`);
      } else {
        const buf = fs.readFileSync(abs);
        if (buf.length < 200) err(`${where}: ${key} image is only ${buf.length} bytes`);
        if (buf.length > 8 * 1024 * 1024) err(`${where}: ${key} image exceeds 8 MB (${buf.length})`);
        imageFilesChecked += 1;
        imageBytes += buf.length;
      }
    }
    if (!/^https:\/\/images\.squarespace-cdn\.com\//.test(im.sourceUrl || '')) {
      warn(`${where}: unusual image source URL ${im.sourceUrl}`);
    }
  }
}

/* ------------------------- 4. plan files --------------------------- */
for (const a of aircraft) {
  const d = a.download || {};
  if (d.type === 'local') {
    if (!d.file) {
      err(`${a.slug}: download.type is "local" but no file path is set`);
    } else {
      const abs = path.join(ROOT, 'public', d.file.replace(/^\//, ''));
      if (!fs.existsSync(abs)) {
        err(`${a.slug}: local download file missing on disk -> ${d.file}`);
      } else {
        const v = validateFile(abs);
        if (!v.valid) err(`${a.slug}: local download failed validation: ${v.error}`);
        if (d.sha256 && d.sha256 !== v.sha256) {
          err(`${a.slug}: recorded SHA-256 does not match the file on disk`);
        }
        if (!d.sha256) warn(`${a.slug}: local download has no recorded SHA-256`);
        a.archiveStatus = v.valid ? 'ARCHIVED' : 'MANUAL_REVIEW';
      }
    }
  } else if (d.type === 'source') {
    if (!d.sourceUrl) err(`${a.slug}: download.type is "source" but no sourceUrl`);
    if (a.archiveStatus === 'ARCHIVED') {
      err(`${a.slug}: archiveStatus ARCHIVED but no local file is present`);
    }
  } else if (d.type === 'unavailable') {
    if (a.archiveStatus === 'ARCHIVED') err(`${a.slug}: ARCHIVED with no download`);
  } else {
    err(`${a.slug}: unknown download.type "${d.type}"`);
  }
}

/* --------------------------- 5. manifest --------------------------- */
if (!manifest) {
  warn('data/archive-manifest.json missing — run `npm run archive`');
} else {
  if (manifest.entries?.length !== aircraft.length) {
    err(`archive manifest has ${manifest.entries?.length} entries, aircraft.json has ${aircraft.length}`);
  }
  const bySlug = new Map(aircraft.map((a) => [a.slug, a]));
  for (const e of manifest.entries || []) {
    const a = bySlug.get(e.slug);
    if (!a) {
      err(`manifest references unknown aircraft "${e.slug}"`);
      continue;
    }
    if (e.archiveStatus !== a.archiveStatus) {
      err(`${e.slug}: manifest status "${e.archiveStatus}" != aircraft status "${a.archiveStatus}"`);
    }
    if (e.archiveStatus === 'ARCHIVED') {
      if (!e.sha256) err(`${e.slug}: manifest marks ARCHIVED without a SHA-256`);
      if (e.validation?.status !== 'passed') err(`${e.slug}: manifest marks ARCHIVED without passing validation`);
      if (e.localFile) {
        const abs = path.join(ROOT, e.localFile);
        if (!fs.existsSync(abs)) err(`${e.slug}: manifest local file missing -> ${e.localFile}`);
        else if (sha256(fs.readFileSync(abs)) !== e.sha256) err(`${e.slug}: manifest SHA-256 does not match file`);
      }
    }
  }
}

/* -------------------------- 6. site.json --------------------------- */
if (site) {
  for (const k of ['name', 'description', 'url', 'base']) {
    if (!site[k]) err(`data/site.json: missing "${k}"`);
  }
  if (site.base && !site.base.startsWith('/')) err('data/site.json: base must start with "/"');
  if (site.base && !site.base.endsWith('/')) err('data/site.json: base must end with "/"');
}

/* ----------------------------- report ----------------------------- */
const statusCount = aircraft.reduce((m, a) => ((m[a.archiveStatus] = (m[a.archiveStatus] || 0) + 1), m), {});
const withSpecs = aircraft.filter((a) => Object.keys(a.specifications).length).length;
const designers = new Set(aircraft.map((a) => a.designerKey).filter((k) => k && k !== 'uncredited'));

console.log('');
console.log('  Parkjets Archive — data validation');
console.log('  ─────────────────────────────────────────────────');
console.log(`  aircraft            ${aircraft.length}`);
console.log(`  designers credited  ${designers.size}`);
console.log(`  categories          ${new Set(aircraft.flatMap((a) => a.category)).size}`);
console.log(`  images referenced   ${aircraft.reduce((s, a) => s + a.images.length, 0)}`);
console.log(`  image files checked ${imageFilesChecked} (${(imageBytes / 1048576).toFixed(1)} MB)`);
console.log(`  with specifications ${withSpecs}`);
console.log(`  archive status      ${Object.entries(statusCount).map(([k, v]) => `${k}=${v}`).join('  ')}`);
console.log('');

if (warnings.length) {
  console.log(`  ⚠ ${warnings.length} warning(s):`);
  const byKind = new Map();
  for (const w of warnings) {
    const kind = w.includes('no alt text') ? 'missing alt text'
      : w.includes('not filed under') ? 'uncategorised'
        : w.includes('image source URL') ? 'unexpected image source'
          : w.includes('SHA-256') ? 'missing checksum'
            : 'other';
    byKind.set(kind, (byKind.get(kind) || 0) + 1);
  }
  for (const [k, n] of byKind) console.log(`      ${n}× ${k}`);
  console.log('');
}

if (errors.length) {
  console.log(`  ✗ ${errors.length} error(s):`);
  for (const e of errors.slice(0, 60)) console.log(`      ${e}`);
  if (errors.length > 60) console.log(`      … and ${errors.length - 60} more`);
  console.log('');
  process.exit(1);
}

console.log('  ✓ validation passed');
console.log('');
