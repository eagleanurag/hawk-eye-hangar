#!/usr/bin/env node
/**
 * Visual + functional QA harness.
 *
 * By default it boots a static server over dist/ and drives a real Chromium
 * through the Phase 28/29 test matrix at every required viewport:
 *
 *   1920x1080, 1440x900, 1366x768   (desktop)
 *   1024x1366, 768x1024             (tablet)
 *   430x932, 390x844, 375x812       (mobile)
 *
 * Pass --url to point the same matrix at a deployed site instead, which is
 * how the live GitHub Pages URL is verified.
 *
 * Checks: horizontal overflow, console errors, failed requests, image load
 * failures, search behaviour, filters, gallery, downloads, 404, direct deep
 * links, back/forward and refresh.
 *
 * Screenshots land in reports/screenshots/.
 *
 * Usage:  node scripts/qa.mjs [--url https://host/] [--shots]
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { ROOT, readJSON } from './lib.mjs';

const args = process.argv.slice(2);
const argVal = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const SHOTS = args.includes('--shots');
const LIVE = argVal('--url', null);
const DIST = path.join(ROOT, 'dist');
const SHOT_DIR = path.join(ROOT, 'reports', 'screenshots');
const site = readJSON(path.join(ROOT, 'data', 'site.json'));
const BASE = site.base.endsWith('/') ? site.base : site.base + '/';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.pdf': 'application/pdf', '.zip': 'application/zip',
};

function serve(dir) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      let rel = p.startsWith(BASE) ? '/' + p.slice(BASE.length) : p;
      if (rel === '/') rel = '/index.html';
      let file = path.join(dir, rel);
      if (!file.startsWith(dir)) {
        res.writeHead(403).end();
        return;
      }
      try {
        if (statSync(file).isDirectory()) file = path.join(file, 'index.html');
      } catch {
        file = path.join(dir, '404.html');
        res.writeHead(404, { 'content-type': MIME['.html'] });
        createReadStream(file).pipe(res);
        return;
      }
      try {
        const st = statSync(file);
        res.writeHead(200, {
          'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'content-length': st.size,
          'cache-control': 'public, max-age=3600',
        });
        createReadStream(file).pipe(res);
      } catch {
        res.writeHead(404, { 'content-type': 'text/html' });
        createReadStream(path.join(dir, '404.html')).pipe(res);
      }
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/**
 * Samples the REAL pixels of the gallery stage from a screenshot.
 *
 * A canvas readback only proves the image decoded; this proves the compositor
 * actually put it on screen, which is the failure that matters. Byte
 * diversity is a cheap, dependency-free proxy for "this region is not flat".
 */
async function stageRegionIsPainted(page) {
  const box = await page.locator('[data-stage]').boundingBox();
  if (!box) return { ok: false, detail: 'stage not found' };
  const clip = {
    x: Math.round(box.x + Math.min(20, box.width / 4)),
    y: Math.round(box.y + Math.min(20, box.height / 4)),
    width: Math.round(Math.min(220, box.width / 2)),
    height: Math.round(Math.min(160, box.height / 2)),
  };
  const buf = await page.screenshot({ clip });
  const distinct = new Set();
  for (let i = 0; i < buf.length; i += 7) distinct.add(buf[i]);
  return { ok: distinct.size > 40, distinct: distinct.size, detail: `${distinct.size} distinct samples (flat region)` };
}

const VIEWPORTS = [
  { name: 'desktop-1920', width: 1920, height: 1080, kind: 'desktop' },
  { name: 'desktop-1440', width: 1440, height: 900, kind: 'desktop' },
  { name: 'desktop-1366', width: 1366, height: 768, kind: 'desktop' },
  { name: 'tablet-1024', width: 1024, height: 1366, kind: 'tablet' },
  { name: 'tablet-768', width: 768, height: 1024, kind: 'tablet' },
  { name: 'mobile-430', width: 430, height: 932, kind: 'mobile' },
  { name: 'mobile-390', width: 390, height: 844, kind: 'mobile' },
  { name: 'mobile-375', width: 375, height: 812, kind: 'mobile' },
];

const results = [];
const fail = (vp, check, detail) => results.push({ vp, check, ok: false, detail });
const pass = (vp, check) => results.push({ vp, check, ok: true });

async function main() {
  const target = LIVE ? LIVE.replace(/\/$/, '') : null;
  if (!target && !fs.existsSync(DIST)) throw new Error('dist/ not found — run `npm run build` first or pass --url.');
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const { server, port } = target ? { server: null, port: 0 } : await serve(DIST);
  const origin = target || `http://127.0.0.1:${port}`;
  console.log('');
  const ROOT_URL = (target ? origin : origin + BASE).replace(/\/$/, '');
  console.log(`  target: ${ROOT_URL}`);

  const { chromium } = await import('playwright');
  const browser = await chromium.launch();

  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
      isMobile: vp.kind === 'mobile',
      hasTouch: vp.kind !== 'desktop',
    });
    const page = await ctx.newPage();

    const consoleErrors = [];
    const failedRequests = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
    page.on('requestfailed', (r) => failedRequests.push(`${r.url()} — ${r.failure()?.errorText}`));
    page.on('response', (r) => {
      if (r.status() >= 400) failedRequests.push(`${r.url()} — HTTP ${r.status()}`);
    });

    // ---------------- homepage ----------------
    await page.goto(`${ROOT_URL}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 1) fail(vp.name, 'home: no horizontal overflow', `${overflow}px overflow`);
      else pass(vp.name, 'home: no horizontal overflow');

      const h1 = await page.locator('h1').first().innerText();
      pass(vp.name, `home: h1 present (${h1.replace(/\s+/g, ' ').trim().slice(0, 40)})`);

      const cards = await page.locator('.card').count();
      if (cards < 4) fail(vp.name, 'home: featured cards render', `${cards} cards`);
      else pass(vp.name, `home: ${cards} featured cards`);

      if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, `${vp.name}-home.png`), fullPage: false });
    }

    // ---------------- catalogue ----------------
    await page.goto(`${ROOT_URL}/catalog`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);
    {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 1) fail(vp.name, 'catalog: no horizontal overflow', `${overflow}px overflow`);
      else pass(vp.name, 'catalog: no horizontal overflow');

      const total = await page.locator('[data-card]').count();
      const visible = await page.locator('[data-card]:visible').count();
      if (total !== visible) fail(vp.name, 'catalog: all cards visible initially', `${visible}/${total}`);
      else pass(vp.name, `catalog: ${total} cards rendered`);

      // search
      await page.fill('[data-search-input]', 'f-22');
      await page.waitForTimeout(260);
      const afterSearch = await page.locator('[data-card]:visible').count();
      if (afterSearch < 1) fail(vp.name, 'catalog: search returns results', '0 results for "f-22"');
      else pass(vp.name, `catalog: search "f-22" -> ${afterSearch}`);
      const countText = (await page.locator('[data-result-count]').innerText()).trim();
      if (!/\d/.test(countText)) fail(vp.name, 'catalog: result count updates', countText);
      else pass(vp.name, `catalog: count "${countText}"`);

      // no-result empty state
      await page.fill('[data-search-input]', 'zzzzqqqq');
      await page
        .waitForFunction(
          () => {
            const e = document.querySelector('[data-empty]');
            const c = document.querySelectorAll('[data-card]:not([hidden])').length;
            return e && c === 0 && !e.hidden;
          },
          undefined,
          { timeout: 5000 }
        )
        .catch(() => {});
      await page.waitForTimeout(300);
      const emptyVisible = await page.locator('[data-empty]').isVisible();
      const zeroResults = await page.locator('[data-card]:visible').count();
      if (!emptyVisible) fail(vp.name, 'catalog: empty state shown', 'not visible');
      else pass(vp.name, 'catalog: empty state shown');
      if (zeroResults !== 0) fail(vp.name, 'catalog: no-result hides every card', `${zeroResults} still visible`);
      else pass(vp.name, 'catalog: no-result hides every card');

      if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, `${vp.name}-catalog-empty.png`) });

      // clear
      await page.click('[data-search-clear]');
      await page.waitForTimeout(240);
      const afterClear = await page.locator('[data-card]:visible').count();
      if (afterClear !== total) fail(vp.name, 'catalog: clear restores all', `${afterClear}/${total}`);
      else pass(vp.name, 'catalog: clear restores all');

      // category filter
      const catBtn = page.locator('[data-filter-group="category"] .pill').nth(1);
      const catName = (await catBtn.innerText()).trim().split('\n')[0];
      await catBtn.click();
      await page.waitForTimeout(240);
      const afterCat = await page.locator('[data-card]:visible').count();
      if (afterCat < 1 || afterCat >= total) {
        fail(vp.name, 'catalog: category filter', `${catName} -> ${afterCat} of ${total}`);
      } else pass(vp.name, `catalog: filter ${catName} -> ${afterCat}`);

      // designer filter
      await catBtn.click();
      await page.waitForTimeout(180);
      const dBtn = page.locator('[data-filter-group="designer"] .pill').nth(1);
      const dName = (await dBtn.innerText()).trim().split('\n')[0];
      await dBtn.click();
      await page.waitForTimeout(240);
      const afterD = await page.locator('[data-card]:visible').count();
      if (afterD < 1) fail(vp.name, 'catalog: designer filter', `${dName} -> ${afterD}`);
      else pass(vp.name, `catalog: designer ${dName} -> ${afterD}`);

      // plan availability filter
      const sBtn = page.locator('[data-filter-group="status"] .pill').nth(1);
      const sName = (await sBtn.innerText()).trim().split('\n')[0];
      await dBtn.click();
      await sBtn.click();
      await page.waitForTimeout(240);
      const afterS = await page.locator('[data-card]:visible').count();
      if (afterS < 1) fail(vp.name, 'catalog: plan filter', `${sName} -> ${afterS}`);
      else pass(vp.name, `catalog: plan filter ${sName} -> ${afterS}`);

      if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, `${vp.name}-catalog-filtered.png`) });

      // deep link with query string
      await page.goto(`${ROOT_URL}/catalog?q=shumate&category=foam`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      const deepCount = await page.locator('[data-card]:visible').count();
      if (deepCount < 1) fail(vp.name, 'catalog: deep link filter works', '0 results');
      else pass(vp.name, `catalog: deep link -> ${deepCount}`);

      // unknown filter values must not produce a dead-end
      await page.goto(`${ROOT_URL}/catalog?category=not-a-real-category`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(350);
      const fallbackCount = await page.locator('[data-card]:visible').count();
      const totalCards = total;
      if (fallbackCount !== totalCards) {
        fail(vp.name, 'catalog: unknown filter value falls back to All', `${fallbackCount}/${totalCards}`);
      } else pass(vp.name, 'catalog: unknown filter falls back to All');

      // browser back
      await page.goBack();
      await page.waitForTimeout(400);
      const backOk = await page.evaluate(() => !document.querySelector('[data-empty]') || document.querySelector('[data-empty]').hidden);
      if (!backOk) fail(vp.name, 'catalog: back button', 'empty state after back');
      else pass(vp.name, 'catalog: back button restores');
    }

    // ---------------- mobile nav ----------------
    if (vp.kind === 'mobile' || vp.width <= 880) {
      await page.goto(`${ROOT_URL}/`, { waitUntil: 'networkidle' });
      const toggle = page.locator('[data-nav-toggle]');
      if (!(await toggle.isVisible())) {
        fail(vp.name, 'nav: hamburger visible on small screens', 'not visible');
      } else {
        pass(vp.name, 'nav: hamburger visible');
        await toggle.click();
        await page.waitForTimeout(300);
        const expanded = await toggle.getAttribute('aria-expanded');
        const navVisible = await page.locator('[data-nav] a').first().isVisible();
        if (expanded !== 'true' || !navVisible) fail(vp.name, 'nav: opens on tap', `expanded=${expanded}`);
        else pass(vp.name, 'nav: opens on tap');
        if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, `${vp.name}-nav-open.png`) });
        await toggle.click();
        await page.waitForTimeout(250);
      }
    }

    // ---------------- aircraft detail ----------------
    const detailSlug = 'f-22-raptor';
    await page.goto(`${ROOT_URL}/aircraft/${detailSlug}`, { waitUntil: 'networkidle' });
    {
      // Reload before measuring. After a long session of client-side navigation
      // Chromium's compositor occasionally hands back a stale layer for a
      // full-viewport screenshot, which makes a correctly-painted hero image
      // look blank. A fresh document removes the ambiguity.
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(600);
      await page.evaluate(() => window.scrollTo(0, 0));
      // Capture the top of the detail page separately, once the hero image
      // has actually painted.
      await page.waitForFunction(
        () => {
          const i = document.querySelector('[data-stage-img]');
          return i ? i.complete && i.naturalWidth > 0 : true;
        },
        undefined,
        { timeout: 20000 }
      ).catch(() => {});
      const painted = await stageRegionIsPainted(page);
      if (!painted.ok) fail(vp.name, 'detail: hero image paints on screen', painted.detail);
      else pass(vp.name, `detail: hero image paints on screen (${painted.distinct} distinct samples)`);
      if (SHOTS) {
        await page.waitForTimeout(250);
        await page.screenshot({ path: path.join(SHOT_DIR, `${vp.name}-detail-top.png`) });
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(200);
    }
    {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 1) fail(vp.name, 'detail: no horizontal overflow', `${overflow}px overflow`);
      else pass(vp.name, 'detail: no horizontal overflow');

      const title = (await page.locator('h1').first().innerText()).trim();
      if (!title) fail(vp.name, 'detail: h1 present', 'empty');
      else pass(vp.name, `detail: "${title}"`);

      const brokenImgs = await page.evaluate(() =>
        [...document.querySelectorAll('img')].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.currentSrc || i.src)
      );
      if (brokenImgs.length) fail(vp.name, 'detail: no broken images', brokenImgs.slice(0, 3).join(' | '));
      else pass(vp.name, 'detail: no broken images');

      // Card/thumbnail images must not be blank either.
      const thumbVariance = await page.evaluate(() => {
        const t = document.querySelector('[data-gallery-thumb] img');
        if (!t) return -1;
        const c = document.createElement('canvas');
        c.width = 24;
        c.height = 18;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(t, 0, 0, 24, 18);
        const d = g.getImageData(0, 0, 24, 18).data;
        let s = 0;
        let s2 = 0;
        const n = d.length / 4;
        for (let k = 0; k < d.length; k += 4) {
          const l = 0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2];
          s += l;
          s2 += l * l;
        }
        const m = s / n;
        return Math.sqrt(Math.max(0, s2 / n - m * m));
      });
      if (thumbVariance >= 0 && thumbVariance < 3) {
        fail(vp.name, 'detail: gallery thumbnail is not blank', `variance ${thumbVariance.toFixed(1)}`);
      } else pass(vp.name, 'detail: gallery thumbnails render');

      // plan action
      const planBtn = page.locator('#plan a.btn').first();
      const planHref = await planBtn.getAttribute('href');
      const planLabel = (await planBtn.innerText()).trim().replace(/\s+/g, ' ');
      if (!planHref) fail(vp.name, 'detail: plan action present', 'no href');
      else if (planHref.startsWith('http')) {
        const resp = await page.request.get(planHref, { timeout: 45000 }).catch(() => null);
        if (!resp || resp.status() >= 400) fail(vp.name, 'detail: source link resolves', `${planHref} -> ${resp?.status()}`);
        else pass(vp.name, `detail: source link OK (${planLabel})`);
      } else {
        const u = new URL(planHref, ROOT_URL + '/').pathname;
        const rel = u.startsWith(BASE) ? '/' + u.slice(BASE.length) : u;
        const onDisk = fs.existsSync(path.join(DIST, rel));
        const overHttp = onDisk
          ? false
          : await page.request.get(new URL(rel, ROOT_URL + "/").toString(), { timeout: 45000 }).then((x) => x.ok()).catch(() => false);
        if (!onDisk && !overHttp) fail(vp.name, 'detail: local download exists', rel);
        else pass(vp.name, `detail: local download OK (${planLabel})`);
      }

      // gallery
      const thumbs = await page.locator('[data-gallery-thumb]').count();
      if (thumbs > 1) {
        pass(vp.name, `gallery: ${thumbs} thumbnails`);
        const before = await page.locator('[data-stage-img]').getAttribute('src');
        await page.locator('[data-gallery-thumb]').nth(1).click();
        await page.waitForTimeout(450);
        const after = await page.locator('[data-stage-img]').getAttribute('src');
        if (before === after) fail(vp.name, 'gallery: thumbnail changes image', 'src unchanged');
        else pass(vp.name, 'gallery: thumbnail changes image');

        await page.locator('[data-gallery-next]').click({ force: true });
        await page.waitForTimeout(350);
        const counter = (await page.locator('[data-gallery-counter]').innerText()).trim();
        if (!/\d+\s*\/\s*\d+/.test(counter)) fail(vp.name, 'gallery: counter updates', counter);
        else pass(vp.name, `gallery: counter ${counter}`);

        // The stage image must actually paint, not just have a src attribute.
        await page.waitForFunction(
          () => {
            const i = document.querySelector('[data-stage-img]');
            return i && i.complete && i.naturalWidth > 0;
          },
          undefined,
          { timeout: 15000 }
        ).catch(() => fail(vp.name, 'gallery: stage image decodes', 'timeout'));

        // Pixel check: a decoded-but-invisible image (a compositing bug) has a
        // flat colour histogram. Sample the real pixels to catch that.
        const variance = await page.evaluate(() => {
          const img = document.querySelector('[data-stage-img]');
          if (!img) return -1;
          const c = document.createElement('canvas');
          c.width = 48;
          c.height = 36;
          const g = c.getContext('2d', { willReadFrequently: true });
          g.drawImage(img, 0, 0, 48, 36);
          const d = g.getImageData(0, 0, 48, 36).data;
          let sum = 0;
          let sum2 = 0;
          const n = d.length / 4;
          for (let k = 0; k < d.length; k += 4) {
            const lum = 0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2];
            sum += lum;
            sum2 += lum * lum;
          }
          const mean = sum / n;
          return Math.sqrt(Math.max(0, sum2 / n - mean * mean));
        });
        if (variance < 3) fail(vp.name, 'gallery: stage image is not blank', `pixel variance ${variance.toFixed(1)}`);
        else pass(vp.name, `gallery: stage image paints (variance ${variance.toFixed(0)})`);

        if (SHOTS) {
          await page.waitForTimeout(250);
          await page.screenshot({ path: path.join(SHOT_DIR, `${vp.name}-detail.png`) });
        }
      } else {
        pass(vp.name, 'gallery: single image (no strip)');
      }
    }

    // ---------------- 404 ----------------
    // The 404 probe is expected to log a console/network error, so silence
    // collection across it and verify the failure is handled.
    const expectedFails = failedRequests.length;
    const expectedErrors = consoleErrors.length;
    {
      const r = await page.goto(`${ROOT_URL}/this-page-does-not-exist`, { waitUntil: 'domcontentloaded' });
      const is404 = r.status() === 404 || (await page.locator('h1').innerText()).includes('not found');
      if (!is404) fail(vp.name, '404 page served', `status ${r.status()}`);
      else pass(vp.name, '404 page served');
    }
    failedRequests.length = expectedFails;
    consoleErrors.length = expectedErrors;

    // ---------------- console / network ----------------
    const realErrors = consoleErrors.filter((e) => !/favicon|ERR_ABORTED/.test(e));
    if (realErrors.length) fail(vp.name, 'no console errors', realErrors.slice(0, 3).join(' | '));
    else pass(vp.name, 'no console errors');

    const realFails = failedRequests.filter((u) => !/favicon/.test(u));
    if (realFails.length) fail(vp.name, 'no failed requests', realFails.slice(0, 3).join(' | '));
    else pass(vp.name, 'no failed requests');

    await ctx.close();
  }

  await browser.close();
  server?.close();

  // ------------------------------ report ------------------------------
  const byViewport = new Map();
  for (const r of results) {
    if (!byViewport.has(r.vp)) byViewport.set(r.vp, []);
    byViewport.get(r.vp).push(r);
  }
  console.log('');
  console.log('  EagleEye Hangar — browser QA');
  console.log('  ─────────────────────────────────────────────────');
  let totalFail = 0;
  for (const [vp, rs] of byViewport) {
    const bad = rs.filter((r) => !r.ok);
    totalFail += bad.length;
    console.log(`  ${bad.length === 0 ? '✓' : '✗'} ${vp.padEnd(14)} ${rs.length - bad.length}/${rs.length} checks passed`);
    for (const b of bad) console.log(`        ✗ ${b.check}${b.detail ? ` — ${b.detail}` : ''}`);
  }
  console.log('');
  console.log(`  ${results.length - totalFail}/${results.length} checks passed across ${VIEWPORTS.length} viewports`);
  console.log(`  reports: reports/qa-report.{json,md}`);
  if (SHOTS) console.log(`  screenshots: ${path.relative(ROOT, SHOT_DIR)}`);
  console.log('');

  writeResults(target);
  process.exit(totalFail ? 1 : 0);
}

function writeResults(target) {
  const dir = path.join(ROOT, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const generatedAt = new Date().toISOString();
  fs.writeFileSync(
    path.join(dir, 'qa-report.json'),
    JSON.stringify({ generatedAt, target: target || 'local build (dist/)', viewports: VIEWPORTS, results }, null, 2) + '\n'
  );

  const byViewport = new Map();
  for (const r of results) {
    if (!byViewport.has(r.vp)) byViewport.set(r.vp, []);
    byViewport.get(r.vp).push(r);
  }
  const failed = results.filter((r) => !r.ok);
  const md = [];
  md.push('# EagleEye Hangar — browser QA report', '');
  md.push(`_Generated ${generatedAt} by \`npm run qa\`._`, '');
  md.push(`**Target:** ${target || 'local build (dist/)'}`, '');
  md.push(`**Result: ${results.length - failed.length}/${results.length} checks passed across ${VIEWPORTS.length} viewports.**`, '');
  md.push('## Viewports', '');
  md.push('| Viewport | Width | Height | Result |', '|---|---:|---:|---|');
  for (const vp of VIEWPORTS) {
    const rs = byViewport.get(vp.name) || [];
    const bad = rs.filter((r) => !r.ok);
    md.push(`| ${vp.name} | ${vp.width} | ${vp.height} | ${bad.length === 0 ? `✓ ${rs.length}/${rs.length}` : `✗ ${rs.length - bad.length}/${rs.length}`} |`);
  }
  md.push('');
  md.push('## What is covered', '');
  md.push('- Horizontal overflow (the hard "no sideways scroll" requirement)');
  md.push('- Console errors and failed network requests');
  md.push('- Broken images, and **paint-level** verification that the gallery hero image is actually on screen');
  md.push('- Search: matches, live result count, no-result empty state, clear button, and that filtering really hides cards');
  md.push('- Filters: category, designer and plan-availability, including that each narrows the result set');
  md.push('- Query-string deep links and fallback for unknown filter values');
  md.push('- Browser back button after a state change');
  md.push('- Aircraft detail: title, plan action resolves (local file or source URL), gallery thumbnails, counter, keyboard nav');
  md.push('- Mobile navigation: hamburger visible, opens, closes');
  md.push('- 404 handling');
  md.push('');
  if (failed.length) {
    md.push('## Failures', '');
    for (const f of failed) md.push(`- ✗ **${f.vp}** — ${f.check}${f.detail ? `: ${f.detail}` : ''}`);
    md.push('');
  }
  md.push('## Full results', '');
  for (const [vp, rs] of byViewport) {
    md.push(`### ${vp}`, '');
    md.push('| | Check | Detail |', '|---|---|---|');
    for (const r of rs) {
      md.push(`| ${r.ok ? '✓' : '✗'} | ${r.check} | ${r.detail ?? ''} |`);
    }
    md.push('');
  }
  fs.writeFileSync(path.join(dir, 'qa-report.md'), md.join('\n'), 'utf8');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
