#!/usr/bin/env node
/**
 * Phase 1/3 — discover-aircraft.mjs
 *
 * Discovers the Parkjets aircraft catalog WITHOUT crawling HTML by hand.
 *
 * Evidence sources:
 *   1. https://www.parkjets.com/sitemap.xml          — canonical URL inventory
 *   2. https://www.parkjets.com/free-plans?format=json-pretty
 *      — Squarespace's own public JSON representation of the product
 *        collection. Contains every published item with its full record
 *        (title, designer tags, categories, description HTML, digital
 *        good filename, SEO metadata, prices).
 *   3. Category pages (/free-plans/<category>) — cross-check counts.
 *
 * Outputs:
 *   data/_raw/collection.json     raw collection JSON (cached evidence)
 *   data/_raw/sitemap.json        discovered URLs from sitemap.xml
 *   data/_raw/discovery.json      discovery report (URLs, counts, gaps)
 *
 * This is a MIGRATION TOOL. The built website never calls it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, fetchText, fetchJSON, writeJSON, ensureDir, log } from './lib.mjs';

const ORIGIN = 'https://www.parkjets.com';
const COLLECTION_PATH = '/free-plans';
const RAW = path.join(ROOT, 'data', '_raw');

async function main() {
  ensureDir(RAW);

  log('→ sitemap.xml');
  const sm = await fetchText(`${ORIGIN}/sitemap.xml`);
  const locs = [...sm.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) =>
    m[1].trim().replace(/&amp;/g, '&')
  );
  log(`   ${locs.length} URLs in sitemap`);

  const itemUrls = locs.filter((u) => u.startsWith(`${ORIGIN}${COLLECTION_PATH}/p/`));
  const categoryUrls = locs.filter(
    (u) => u.startsWith(`${ORIGIN}${COLLECTION_PATH}/`) && !u.includes('/p/')
  );

  log('→ collection JSON');
  const coll = await fetchJSON(`${ORIGIN}${COLLECTION_PATH}?format=json-pretty`);
  const items = coll.json.items || [];
  log(`   ${items.length} published items, collection.itemCount=${coll.json.collection?.itemCount}`);

  const cats = (coll.json.nestedCategories?.categories || []).map((c) => ({
    id: c.id,
    name: c.displayName,
    slug: c.shortSlug,
    sourceUrl: ORIGIN + c.fullUrl,
  }));
  const catById = new Map(cats.map((c) => [c.id, c]));
  const designers = [...(coll.json.collection?.tags || [])].sort();

  // Cross-check each category page so we can prove nothing is hidden.
  const categoryPages = [];
  for (const u of categoryUrls) {
    try {
      const r = await fetchJSON(`${u}?format=json-pretty`);
      const n = r.json?.items?.length ?? 0;
      categoryPages.push({ url: u, count: n });
      log(`   ${u.replace(ORIGIN, '')}: ${n} items`);
    } catch (e) {
      categoryPages.push({ url: u, count: null, error: e.message });
      log(`   ${u.replace(ORIGIN, '')}: ERROR ${e.message}`);
    }
  }

  const slugs = items.map((i) => i.urlId);
  const sitemapSlugs = itemUrls.map((u) => u.replace(`${ORIGIN}${COLLECTION_PATH}/p/`, ''));

  const report = {
    generatedAt: new Date().toISOString(),
    origin: ORIGIN,
    collectionPath: COLLECTION_PATH,
    collectionTitle: coll.json.collection?.title,
    collectionItemCount: coll.json.collection?.itemCount ?? null,
    totalSitemapUrls: locs.length,
    aircraftFromCollection: items.length,
    aircraftFromSitemap: sitemapSlugs.length,
    categories: cats,
    designersFromCollectionTags: designers,
    categoryPages,
    inSitemapNotInCollection: sitemapSlugs.filter((s) => !slugs.includes(s)),
    inCollectionNotInSitemap: slugs.filter((s) => !sitemapSlugs.includes(s)),
    duplicateSlugs: slugs.filter((s, i) => slugs.indexOf(s) !== i),
    items: items.map((i) => ({
      id: i.id,
      slug: i.urlId,
      title: i.title,
      fullUrl: i.fullUrl,
      sourceUrl: ORIGIN + i.fullUrl,
      categories: (i.categoryIds || []).map((c) => catById.get(c)?.name).filter(Boolean),
      designerTags: i.tags || [],
      digitalGood: (i.digitalGoods || [])[0]
        ? {
            filename: i.digitalGoods[0].filename,
            sourceType: i.digitalGoods[0].systemDataSourceType,
            urlId: i.digitalGoods[0].urlId,
          }
        : null,
      priceCents: i.priceCents,
    })),
  };

  fs.writeFileSync(path.join(RAW, 'collection.json'), JSON.stringify(coll.json, null, 1));
  writeJSON(path.join(RAW, 'sitemap.json'), { urls: locs });
  writeJSON(path.join(RAW, 'discovery.json'), report);

  log('');
  log(`✓ aircraft discovered : ${items.length}`);
  log(`✓ categories          : ${cats.length} (${cats.map((c) => c.name).join(', ')})`);
  log(`✓ designer tags       : ${designers.length}`);
  log(`✓ sitemap/collection gaps: ${report.inSitemapNotInCollection.length} / ${report.inCollectionNotInSitemap.length}`);
  log(`✓ wrote data/_raw/`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
