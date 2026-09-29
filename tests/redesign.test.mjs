/**
 * EagleEye Hangar redesign regression tests.
 *
 * These lock in the things that are easy to break silently:
 *   * the public brand, and the deliberate separation between the library's own
 *     branding and the historical Parkjets provenance that must survive;
 *   * the animation performance contract (no repaint-forcing animation, no
 *     backdrop-filter on sticky/fixed surfaces, no scripted navigation delay);
 *   * the catalogue search index, which must stay searchable after the move out
 *     of per-card data attributes.
 *
 * They run against the built output, because the failure modes above only exist
 * in the shipped CSS and HTML.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

const read = (rel) => fs.readFileSync(path.join(DIST, rel), 'utf8');
const has = (rel) => fs.existsSync(path.join(DIST, rel));

const home = has('index.html') ? read('index.html') : '';
const catalog = has(path.join('catalog', 'index.html')) ? read(path.join('catalog', 'index.html')) : '';
const cssFiles = fs.existsSync(path.join(DIST, '_astro'))
  ? fs.readdirSync(path.join(DIST, '_astro')).filter((f) => f.endsWith('.css'))
  : [];
const allCss = cssFiles.map((f) => read(path.join('_astro', f))).join('\n');

const skip = home ? false : 'dist/ not built';
test('brand is EagleEye Hangar in the document title', { skip }, () => {
  assert.match(home, /<title>[^<]*EagleEye Hangar/);
});

test('OpenGraph and Twitter metadata carry the new brand', { skip }, () => {
  assert.match(home, /property="og:site_name" content="EagleEye Hangar"/);
  assert.match(home, /property="og:title" content="[^"]*EagleEye Hangar/);
  assert.match(home, /name="twitter:title" content="[^"]*EagleEye Hangar/);
  assert.doesNotMatch(home, /content="Parkjets Archive"/);
});

test('the hero uses the required copy', { skip }, () => {
  assert.match(home, /Digital Aviation Library/i);
  assert.match(home, /EagleEye/);
  assert.match(home, /Hangar/);
  assert.match(home, /RC Aircraft Plans/i);
});

test('the hero count is read from the dataset, not hard-coded', { skip }, () => {
  const catalog = read(path.join('catalog', 'index.html'));
  const n = (catalog.match(/data-card\b/g) || []).length;
  assert.equal(n, 109, 'catalogue still renders 109 cards');
  // the CTA must carry the same number the catalogue actually has
  const cta = home.match(/Explore\s*([\d,]+)\s*Aircraft/i);
  assert.ok(cta, 'primary CTA states a count');
  assert.equal(Number(cta[1].replace(/,/g, '')), n, 'hero CTA count matches the dataset');
});

test('the site never claims to be the original Parkjets site', { skip }, () => {
  // The brand must not appear in the hero or the nav.
  const header = home.slice(0, home.indexOf('</header>'));
  assert.doesNotMatch(header, /Parkjets/i, 'navbar carries no Parkjets branding');
  const hero = home.slice(home.indexOf('data-hero-story'), home.indexOf('hangar-library'));
  assert.doesNotMatch(hero, /Parkjets/i, 'hero carries no Parkjets branding');
});

test('provenance is preserved where it belongs', { skip }, () => {
  // Parkjets must still be credited on the about page and in the footer.
  const about = has(path.join('about', 'index.html')) ? read(path.join('about', 'index.html')) : '';
  assert.match(about, /Parkjets/, 'about page still explains the source');
  assert.match(about, /original Parkjets/i, 'about page names the original collection');
  assert.match(home, /parkjets\.com/, 'source link still present');
});

/* ------------------------------------------------------------------ */
/* Performance contract                                                */
/* ------------------------------------------------------------------ */

test('no animation of repaint-forcing properties', { skip }, () => {
  /*
   * `background-position` on a full-viewport fixed layer was the measured
   * bottleneck: median scroll frame 316ms with it, 50ms without (-84%).
   * Nothing in the shipped CSS may reintroduce that.
   */
  const offenders = [];
  // find @keyframes blocks and check the properties they touch
  for (const m of allCss.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n?\s*\}\s*(?=@|[\w.#:-])/g)) {
    const [, name, body] = m;
    for (const bad of ['background-position', 'top', 'left', 'width', 'height', 'margin', 'padding', 'box-shadow']) {
      const re = new RegExp(`(^|[;{\\s])${bad}\\s*:`, 'm');
      if (re.test(body)) offenders.push(`@keyframes ${name} animates ${bad}`);
    }
  }
  assert.deepEqual(offenders, [], `repaint-forcing animation: ${offenders.join('; ')}`);
});

test('no backdrop-filter on sticky or fixed surfaces', { skip }, () => {
  // A sticky/fixed element with a backdrop filter re-blurs the page every frame.
  const offenders = [];
  for (const m of allCss.matchAll(/([^{}]*\{[^}]*backdrop-filter\s*:[^}]*\})/g)) {
    const block = m[0];
    const selector = block.split('{')[0];
    if (/position\s*:\s*(sticky|fixed)/.test(block)) offenders.push(selector.trim().slice(0, 60));
  }
  assert.deepEqual(offenders, [], `backdrop-filter on sticky/fixed: ${offenders.join('; ')}`);
});

test('the blueprint grid is not animated any more', { skip }, () => {
  assert.doesNotMatch(allCss, /@keyframes\s+grid-drift/);
  assert.doesNotMatch(allCss, /grid-drift/);
});

test('the hero has no looping scan animation', { skip }, () => {
  assert.doesNotMatch(allCss, /hangar-scan/);
});

test('scroll motion is limited to transform and opacity', { skip }, () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'scripts', 'hero-scroll.js'), 'utf8');
  const writes = [...src.matchAll(/\.style\.(\w+)\s*=/g)].map((m) => m[1]);
  const allowed = new Set(['transform', 'opacity']);
  for (const w of writes) {
    assert.ok(allowed.has(w), `hero-scroll.js writes .style.${w}, which is not compositor-only`);
  }
  assert.ok(writes.length > 0, 'hero-scroll.js actually animates something');
});

test('navigation is not delayed by a scripted transition', { skip }, () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'scripts', 'motion.js'), 'utf8');
  // The curtain used to intercept every same-origin link and wait before navigating.
  assert.doesNotMatch(src, /location\.href\s*=\s*href/, 'no intercepted navigation');
  assert.doesNotMatch(src, /preventDefault\(\)[\s\S]{0,400}setTimeout/, 'no delayed navigation');
});

test('the hero is a single inline SVG with no duplicate image request', { skip }, () => {
  assert.match(home, /data-hero-plane[\s\S]{0,400}<svg/, 'hero artwork is an inline SVG');
  assert.doesNotMatch(home, /data-hero-plane[^>]*>\s*<img/, 'hero is not an <img>');
  // exactly one hero plane, and both cross-fade layers present
  assert.equal((home.match(/data-hero-plane/g) || []).length, 1);
  assert.match(home, /data-hero-skin/);
  assert.match(home, /data-hero-wire/);
});

test('reduced motion is honoured in the shipped CSS', { skip }, () => {
  assert.match(allCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  const hero = fs.readFileSync(path.join(ROOT, 'src', 'components', 'HangarHero.astro'), 'utf8');
  assert.match(hero, /prefers-reduced-motion:\s*reduce/, 'hero component handles reduced motion');
  const engine = fs.readFileSync(path.join(ROOT, 'src', 'scripts', 'hero-scroll.js'), 'utf8');
  assert.match(engine, /prefers-reduced-motion/, 'scroll engine checks the preference');
});

test('the scroll engine never hijacks wheel or touch input', { skip }, () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'scripts', 'hero-scroll.js'), 'utf8');
  for (const bad of ["addEventListener('wheel'", 'addEventListener("wheel"', "'touchmove'", '"touchmove"', 'preventDefault']) {
    assert.ok(!src.includes(bad), `hero-scroll.js must not use ${bad}`);
  }
  // the scroll listener it does use must be passive
  assert.match(src, /addEventListener\('scroll',\s*onScroll,\s*\{\s*passive:\s*true\s*\}\)/);
});

/* ------------------------------------------------------------------ */
/* Catalogue                                                           */
/* ------------------------------------------------------------------ */

test('the catalogue search index is present and complete', { skip }, () => {
  assert.match(catalog, /id="catalogue-index"/, 'shared index emitted once');
  const m = catalog.match(/id="catalogue-index"[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(m, 'index block is parseable');
  const idx = JSON.parse(m[1].replace(/\\u003c/g, '<'));
  const cards = (catalog.match(/data-card\b/g) || []).length;
  assert.equal(Object.keys(idx).length, cards, 'one index entry per card');
});

test('per-card search blobs are no longer duplicated into the markup', { skip }, () => {
  assert.doesNotMatch(catalog, /data-search=/, 'no per-card data-search attribute');
  assert.doesNotMatch(catalog, /data-specs=/, 'no unused data-specs attribute');
  assert.match(catalog, /data-slug=/, 'cards carry a slug for the index lookup');
});

test('the search index still contains searchable prose', { skip }, () => {
  const m = catalog.match(/id="catalogue-index"[^>]*>([\s\S]*?)<\/script>/);
  const idx = JSON.parse(m[1].replace(/\\u003c/g, '<'));
  const all = Object.values(idx).join(' ');
  // specification values and build notes must remain reachable by search
  assert.match(all, /2200kv/i, 'motor specification text is indexed');
  assert.ok(all.length > 20000, 'index is not truncated');
  // no raw markup leaked into the index
  for (const v of Object.values(idx)) {
    assert.ok(!/[<>]/.test(v), 'index values contain no angle brackets');
  }
});

test('cards stay lazily loaded and dimensioned', { skip }, () => {
  const imgs = [...catalog.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
  assert.ok(imgs.length >= 109, 'every card has an image');
  for (const t of imgs) {
    assert.match(t, /\balt\s*=/, 'image has alt text');
    assert.match(t, /\bwidth\s*=/, 'image has width');
    assert.match(t, /\bheight\s*=/, 'image has height');
  }
  assert.ok(
    imgs.filter((t) => /loading="lazy"/.test(t)).length >= imgs.length - 6,
    'all but the first row are lazy loaded'
  );
});
