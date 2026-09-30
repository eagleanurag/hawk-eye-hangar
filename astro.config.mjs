import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

/**
 * HawkEye Hangar - static site configuration.
 *
 * Output is 100% static HTML/CSS/JS so GitHub Pages can host it with no
 * server, no adapter and no runtime.
 *
 * `data/site.json` is the SINGLE SOURCE OF TRUTH for the deployment base path
 * and the site origin. Both the Astro router and every rendered asset URL
 * read from it, so a project page and a custom domain cannot drift apart.
 * `BASE_PATH` / `SITE_URL` may override it for a one-off build (e.g. a pull
 * request preview).
 */
const root = path.dirname(fileURLToPath(import.meta.url));
const site = JSON.parse(fs.readFileSync(path.join(root, 'data', 'site.json'), 'utf8'));

const base = process.env.BASE_PATH || site.base || '/';
const siteUrl = process.env.SITE_URL || site.url;

export default defineConfig({
  site: siteUrl,
  base,
  trailingSlash: 'ignore',
  output: 'static',
  build: {
    format: 'directory',
    inlineStylesheets: 'auto',
  },
  compressHTML: true,
  devToolbar: { enabled: false },
  integrations: [
    sitemap({
      changefreq: 'monthly',
      priority: 0.6,
      serialize(item) {
        if (/\/$/.test(item.url) && !/\/aircraft\//.test(item.url)) item.priority = 0.9;
        if (/\/aircraft\//.test(item.url)) item.priority = 0.8;
        if (/\/404\.html$/.test(item.url)) item.priority = 0.1;
        return item;
      },
    }),
  ],
  vite: {
    build: {
      assetsInlineLimit: 2048,
    },
  },
});
