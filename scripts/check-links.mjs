#!/usr/bin/env node
/**
 * Phase 26 — check-links.mjs
 *
 * Post-build link audit over dist/. Catches the classes of breakage that a
 * static site can suffer silently:
 *
 *   - internal links to pages that were not generated
 *   - references to media / asset files that are not in the build
 *   - srcset entries pointing at missing files
 *   - duplicate/blank ids, and aria references to ids that do not exist
 *   - images with no alt attribute
 *   - <a download> pointing at a non-existent local file
 *   - external links that are obviously malformed
 *
 * Usage:  node scripts/check-links.mjs [distDir]
 */

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON } from './lib.mjs';

const distDir = path.resolve(process.argv[2] || path.join(ROOT, 'dist'));
if (!fs.existsSync(distDir)) {
  console.error(`✗ build directory not found: ${distDir}\n  Run \`npm run build\` first.`);
  process.exit(1);
}

const site = readJSON(path.join(ROOT, 'data', 'site.json'));
const BASE = site.base.endsWith('/') ? site.base : site.base + '/';

const errors = [];
const warnings = [];
const err = (f, m) => errors.push(`${path.relative(distDir, f)}: ${m}`);
const warn = (f, m) => warnings.push(`${path.relative(distDir, f)}: ${m}`);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(distDir);
const htmlFiles = files.filter((f) => f.endsWith('.html'));

/** Every path the build can serve. */
const served = new Set();
for (const f of files) {
  const rel = '/' + path.relative(distDir, f).split(path.sep).join('/');
  served.add(rel);
  if (rel.endsWith('/index.html')) served.add(rel.replace(/index\.html$/, ''));
  if (rel.endsWith('.html')) served.add(rel.replace(/\.html$/, '/'));
}

const decode = (s) => s.replace(/&amp;/g, '&');
let checkedLinks = 0;
let checkedAssets = 0;
const externalHosts = new Map();
const missingBase = [];

for (const f of htmlFiles) {
  const html = fs.readFileSync(f, 'utf8');

  // ---- links ------------------------------------------------------------
  for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const raw = decode(m[1].trim());
    if (!raw) continue;
    if (raw.startsWith('#')) {
      const id = raw.slice(1);
      if (id && !html.includes(`id="${id}"`)) warn(f, `anchor #${id} has no matching id on this page`);
      continue;
    }
    if (/^(mailto:|tel:|data:|javascript:)/i.test(raw)) continue;
    if (/^https?:\/\//i.test(raw)) {
      let host = 'unknown';
      try {
        host = new URL(raw).hostname;
      } catch {
        err(f, `malformed external URL: ${raw.slice(0, 90)}`);
        continue;
      }
      externalHosts.set(host, (externalHosts.get(host) || 0) + 1);
      continue;
    }

    checkedLinks += 1;
    const [p] = raw.split(/[?#]/);
    if (!p) continue;

    if (p.startsWith('/') && BASE !== '/' && !p.startsWith(BASE)) missingBase.push(p);

    // Strip the deployment base once: the build writes files at the site root
    // and Astro prefixes every emitted URL with `base`.
    let rel = p;
    if (rel.startsWith(BASE)) rel = '/' + rel.slice(BASE.length);
    else if (rel !== '/' && !rel.startsWith('/')) {
      const dir = path.posix.dirname('/' + path.relative(distDir, f).split(path.sep).join('/'));
      rel = path.posix.normalize(path.posix.join(dir, rel));
    }

    const candidates = new Set([rel, rel + '/', rel.replace(/\/$/, '') + '/index.html', rel + '/index.html']);
    if ([...candidates].some((c) => served.has(c))) continue;
    err(f, `broken internal link -> ${raw}`);
  }

    // ---- srcset -----------------------------------------------------------
  for (const m of html.matchAll(/srcset="([^"]+)"/g)) {
    for (const part of decode(m[1]).split(',')) {
      let url = part.trim().split(/\s+/)[0];
      if (!url || url.startsWith('data:')) continue;
      checkedAssets += 1;
      if (url.startsWith(BASE)) url = '/' + url.slice(BASE.length);
      if (!served.has(url)) err(f, `srcset entry not in build -> ${url}`);
    }
  }


  // ---- a11y -------------------------------------------------------------
  // Scan markup with HTML comments removed first. A comment is not a DOM node,
  // so an <img> written inside one is documentation, not a missing-alt defect.
  // Without this, prose like "referenced with <img>" is reported as an error.
  const live = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const m of live.matchAll(/<img\b[^>]*>/g)) {
    const tag = m[0];
    if (!/\balt\s*=/.test(tag)) err(f, `<img> without alt: ${tag.slice(0, 90)}`);
    else if (/\balt\s*=\s*""\s*(?![^>]*role\s*=\s*"presentation")/.test(tag) && !/aria-hidden/.test(tag)) {
      warn(f, `<img alt=""> — confirm this image is decorative`);
    }
  }

  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const idSet = new Set(ids);
  for (const dup of ids.filter((v, i) => ids.indexOf(v) !== i)) err(f, `duplicate id "${dup}"`);
  for (const m of html.matchAll(/\s(aria-labelledby|aria-controls|aria-describedby)="([^"]+)"/g)) {
    for (const id of m[2].split(/\s+/)) {
      if (id && !idSet.has(id)) err(f, `${m[1]}="${id}" has no matching id on this page`);
    }
  }

  for (const m of html.matchAll(/<a\b[^>]*\bdownload\b[^>]*>/g)) {
    const href = /href="([^"]+)"/.exec(m[0]);
    if (href && href[1].startsWith('/')) {
      let url = href[1].split(/[?#]/)[0];
      if (url.startsWith(BASE)) url = '/' + url.slice(BASE.length);
      if (!served.has(url)) err(f, `download link points at a missing file -> ${href[1]}`);
    }
  }

  if (!/<h1[\s>]/.test(html)) warn(f, 'page has no <h1>');
  if (!/<html[^>]+lang=/.test(html)) err(f, '<html> has no lang attribute');
  if (!/<meta name="description"/.test(html)) warn(f, 'no meta description');
  if (!/<link rel="canonical"/.test(html)) warn(f, 'no canonical link');
}

for (const want of ['/robots.txt', '/sitemap-index.xml', '/favicon.svg', '/og-default.png']) {
  if (!served.has(want)) err(path.join(distDir, want), 'expected build output is missing');
}

// ---------------------------------------------------------------------------
console.log('');
console.log('  EagleEye Hangar — link & markup audit');
console.log('  ─────────────────────────────────────────────────');
console.log(`  html pages        ${htmlFiles.length}`);
console.log(`  files in build    ${files.length}`);
console.log(`  internal links    ${checkedLinks}`);
console.log(`  srcset entries    ${checkedAssets}`);
console.log(`  external hosts    ${externalHosts.size}`);
console.log('');

if (missingBase.length) {
  console.log(`  ⚠ ${missingBase.length} root-relative link(s) missing the deployment base:`);
  for (const u of [...new Set(missingBase)].slice(0, 8)) console.log(`      ${u}`);
  console.log('      (fine on a custom domain, broken on a GitHub project page)');
  console.log('');
}

if (externalHosts.size) {
  console.log('  external hosts linked (preserved from the source catalogue):');
  const allow = /(github\.io|github\.com|parkjets\.com|rcgroups\.com|paypal\.com|amazon\.com|banggood\.com|amzn\.to|modelbouw-hans\.nl|foamyfactory\.com|tomhe\.net)/i;
  for (const [h, n] of [...externalHosts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`      ${allow.test(h) ? '·' : ' '} ${String(n).padStart(4)}× ${h}`);
  }
  console.log('');
}

if (warnings.length) {
  console.log(`  ⚠ ${warnings.length} warning(s)`);
  const byKind = new Map();
  for (const w of warnings) {
    const kind = w.includes('no <h1>') ? 'missing h1'
      : w.includes('meta description') ? 'missing meta description'
        : w.includes('canonical') ? 'missing canonical'
          : w.includes('anchor #') ? 'dead in-page anchor'
            : w.includes('alt=""') ? 'empty alt on image'
              : 'other';
    byKind.set(kind, (byKind.get(kind) || 0) + 1);
  }
  for (const [k, n] of byKind) console.log(`      ${n}× ${k}`);
  if (process.env.VERBOSE) for (const w of warnings.slice(0, 25)) console.log(`        ${w}`);
  console.log('');
}

if (errors.length) {
  console.log(`  ✗ ${errors.length} error(s):`);
  for (const e of errors.slice(0, 60)) console.log(`      ${e}`);
  if (errors.length > 60) console.log(`      … and ${errors.length - 60} more`);
  console.log('');
  process.exit(1);
}

console.log('  ✓ link audit passed');
console.log('');
