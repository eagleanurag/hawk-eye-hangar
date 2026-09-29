#!/usr/bin/env node
/**
 * Parkjets migration toolkit
 * ---------------------------------------------------------------------------
 * Shared HTTP helpers for the migration/import pipeline.
 *
 * These scripts are ONE-SHOT MIGRATION TOOLS. The deployed website never
 * depends on them and never depends on parkjets.com being online.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const CACHE_DIR = path.join(ROOT, 'work', 'cache');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export function readJSON(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJSON(p, data) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return p;
}

/** Cache key for a URL. */
export function cacheKey(url) {
  return crypto.createHash('sha1').update(url).digest('hex');
}

/**
 * Fetch a URL with a polite delay, optional on-disk cache and retries.
 * Returns { status, headers, buffer } or throws.
 */
export async function fetchURL(url, opts = {}) {
  const {
    retries = 3,
    delay = 350,
    timeout = 45000,
    cache = true,
    cacheDir = CACHE_DIR,
    headers: extraHeaders = {},
    method = 'GET',
    body = undefined,
  } = opts;

  if (cache) {
    const cf = path.join(cacheDir, cacheKey(url) + '.bin');
    if (fs.existsSync(cf)) {
      const buf = fs.readFileSync(cf);
      const metaPath = cf + '.meta.json';
      const meta = readJSON(metaPath, { status: 200 });
      return { status: meta.status, headers: meta.headers || {}, buffer: buf, cached: true };
    }
  }

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
      const res = await fetch(url, {
        method,
        body,
        redirect: 'follow',
        signal: ac.signal,
        headers: {
          'user-agent': UA,
          accept: '*/*',
          'accept-language': 'en-US,en;q=0.9',
          'accept-encoding': 'gzip, deflate, br',
          ...extraHeaders,
        },
      });
      // NOTE: undici transparently decompresses gzip/deflate/br, so the
      // content-encoding header may still be present — do NOT re-decompress.
      const buf = Buffer.from(await res.arrayBuffer());
      const headers = Object.fromEntries(res.headers.entries());
      const out = { status: res.status, headers, buffer: buf, url: res.url };

      if (cache && res.status === 200) {
        ensureDir(cacheDir);
        fs.writeFileSync(path.join(cacheDir, cacheKey(url) + '.bin'), buf);
        writeJSON(path.join(cacheDir, cacheKey(url) + '.bin.meta.json'), {
          status: res.status,
          headers,
          finalUrl: res.url,
          fetchedAt: new Date().toISOString(),
        });
      }
      return out;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(700 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

export async function fetchText(url, opts = {}) {
  const r = await fetchURL(url, opts);
  return { ...r, text: r.buffer.toString('utf8') };
}

export async function fetchJSON(url, opts = {}) {
  const r = await fetchText(url, opts);
  try {
    return { ...r, json: JSON.parse(r.text) };
  } catch (e) {
    throw new Error(`Invalid JSON from ${url}: ${e.message}`);
  }
}

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function log(...a) {
  console.log(...a);
}
