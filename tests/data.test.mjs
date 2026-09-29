/**
 * Data integrity tests — run with `npm test` (node --test).
 *
 * These lock in the guarantees the archive makes to its readers:
 * nothing invented, nothing duplicated, nothing missing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseKeyValues,
  extractSpecifications,
  extractDesigner,
  splitSections,
  stripTags,
  isBoilerplate,
  decodeEntities,
} from '../scripts/parse-description.mjs';
import { validateZip, validatePdf, validateDxf, validateSvg, crc32 } from '../scripts/validate-files.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const aircraft = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'aircraft.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'archive-manifest.json'), 'utf8'));

/* ------------------------------------------------------------------ */
/* Description parsing                                                */
/* ------------------------------------------------------------------ */

test('parseKeyValues reads pipe-delimited key/value pairs', () => {
  const { pairs } = parseKeyValues('Wing area: 248 sq in | Span: 26.0" | Length: 36.3"');
  assert.equal(pairs.length, 3);
  assert.deepEqual(pairs.map((p) => p.canon), ['wingArea', 'wingspan', 'length']);
  assert.equal(pairs[1].value, '26.0"');
});

test('parseKeyValues reads newline-delimited pairs', () => {
  const { pairs } = parseKeyValues('Length : 750 mm / 29.5"\nWS : 540 mm / 21.1"');
  assert.equal(pairs.length, 2);
  assert.deepEqual(pairs.map((p) => p.canon), ['length', 'wingspan']);
});

test('parseKeyValues reads dashed pairs', () => {
  const { pairs } = parseKeyValues('Wingspan - 19.88" | Length - 26.18" | Build material - 8mm EPP');
  assert.deepEqual(pairs.map((p) => p.canon), ['wingspan', 'length', 'material']);
  assert.equal(pairs[2].value, '8mm EPP');
});

test('parseKeyValues never invents a value for an unlabelled fragment', () => {
  const { pairs, unkeyed } = parseKeyValues('GWS 350 with C gearing | GWS 20 A ESC | 9X7 slowfly prop');
  assert.equal(pairs.length, 0, 'no field may be invented from an unlabelled fragment');
  assert.equal(unkeyed.length, 3);
});

test('cleanValue strips affiliate decoration but keeps the designer wording', () => {
  const { pairs } = parseKeyValues('Motor: 2212 2200KV Brushless Outrunner → Amazon | Banggood (budget)');
  assert.equal(pairs[0].value, '2212 2200KV Brushless Outrunner');
});

test('affiliate split does not merge the following field into the first', () => {
  const { pairs } = parseKeyValues('ESC: 30A brushless ESC → Amazon | Battery: 3S 1300mAh');
  assert.equal(pairs.find((p) => p.canon === 'esc').value, '30A brushless ESC');
  assert.equal(pairs.find((p) => p.canon === 'battery').value, '3S 1300mAh');
});

test('two values for one field are kept, clearly separated', () => {
  const { specifications } = extractSpecifications('Weight: 12oz | AOW: 18.5 ounces');
  assert.match(specifications.weight, /12oz/);
  assert.match(specifications.weight, /18\.5 ounces/);
  assert.match(specifications.weight, / \/ /);
});

test('donation boilerplate never becomes a specification', () => {
  const { specifications, extra } = extractSpecifications('Suggested Donation: $10.00 | Wingspan: 71 cm');
  assert.equal(specifications.wingspan, '71 cm');
  assert.equal(Object.keys(specifications).length, 1);
  assert.equal(extra.length, 0);
});

test('extractDesigner prefers the credit written in the description', () => {
  assert.deepEqual(extractDesigner('Designed by Nick Cara\nSome notes.'), {
    designer: 'Nick Cara',
    source: 'description',
  });
});

test('extractDesigner falls back to the source tag', () => {
  const r = extractDesigner('No credit here.', 'Steve Shumate');
  assert.equal(r.designer, 'Steve Shumate');
  assert.equal(r.source, 'tag');
});

test('extractDesigner records an absence instead of guessing', () => {
  assert.deepEqual(extractDesigner('Nothing here.', undefined), { designer: '', source: 'unknown' });
});

test('stripTags and decodeEntities handle the real Squarespace markup', () => {
  assert.equal(stripTags('<p>a &amp; b</p><p>c</p>'), 'a & b\nc');
  assert.equal(decodeEntities('caf&eacute; &mdash; 6&nbsp;mm'), 'café — 6 mm');
});

test('splitSections groups the designer’s notes under their heading', () => {
  const html =
    '<p>Designed by X</p><h2>NOTE FROM THE DESIGNER</h2><p>Text.</p><h2>BUILD THREAD</h2><p>Link</p>';
  const s = splitSections(html);
  assert.equal(s[0].heading, '');
  assert.equal(s[1].heading, 'NOTE FROM THE DESIGNER');
  assert.equal(s[2].heading, 'BUILD THREAD');
});

test('isBoilerplate recognises the donation block', () => {
  assert.ok(isBoilerplate('If you download plans and build the F-22, please consider...'));
  assert.ok(isBoilerplate('Suggested Donation: $10.00'));
  assert.ok(!isBoilerplate('A pusher park jet for beginners.'));
});

/* ------------------------------------------------------------------ */
/* File validation                                                    */
/* ------------------------------------------------------------------ */

test('crc32 matches the known check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('validateZip detects a well-formed archive', () => {
  // Store-mode ("no compression") ZIP containing one file.
  const name = 'plan.pdf';
  const data = Buffer.from('%PDF-1.4 test plan content');
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 8); // stored
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const localBlock = Buffer.concat([local, Buffer.from(name, 'latin1'), data]);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0, 10);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(data.length, 20);
  cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(name.length, 28);
  cd.writeUInt32LE(0, 42);
  const cdBlock = Buffer.concat([cd, Buffer.from(name, 'latin1')]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdBlock.length, 12);
  eocd.writeUInt32LE(localBlock.length, 16);

  const zip = Buffer.concat([localBlock, cdBlock, eocd]);
  const v = validateZip(zip);
  assert.ok(v.valid, v.error);
  assert.equal(v.files, 1);
  assert.equal(v.entries, 1);
  assert.equal(v.byExtension['.pdf'], 1);
});

test('validateZip rejects a truncated archive', () => {
  const v = validateZip(Buffer.from('PK and then some rubbish'));
  assert.equal(v.valid, false);
  assert.match(v.error, /end-of-central-directory/);
});

test('validateZip rejects an archive with a corrupt CRC', () => {
  const zip = Buffer.from(
    '504b0304' + '0000000000000000000000000000000000000000000000000000000000',
    'hex'
  );
  const v = validateZip(zip);
  assert.equal(v.valid, false);
});

test('validatePdf accepts a real PDF and rejects a fake one', () => {
  const pdf = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 7>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'
  );
  const v = validatePdf(pdf);
  assert.ok(v.valid, v.error);
  assert.equal(v.pages, 7);
  assert.equal(validatePdf(Buffer.from('not a pdf at all, not even close')).valid, false);
});

test('validateDxf and validateSvg check structure, not just the extension', () => {
  assert.ok(validateDxf(Buffer.from('  0\nSECTION\n  2\nENTITIES\n  0\nENDSEC\n  0\nEOF\n')).valid);
  assert.equal(validateDxf(Buffer.from('nope')).valid, false);
  assert.ok(validateSvg(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>')).valid);
  assert.equal(validateSvg(Buffer.from('<html></html>')).valid, false);
});

/* ------------------------------------------------------------------ */
/* Dataset integrity                                                  */
/* ------------------------------------------------------------------ */

test('aircraft.json is a non-empty array of unique records', () => {
  assert.ok(Array.isArray(aircraft));
  assert.ok(aircraft.length > 0);
  assert.equal(new Set(aircraft.map((a) => a.slug)).size, aircraft.length);
  assert.equal(new Set(aircraft.map((a) => a.id)).size, aircraft.length);
  assert.equal(new Set(aircraft.map((a) => a.sourceUrl)).size, aircraft.length);
  assert.equal(new Set(aircraft.map((a) => a.displayName)).size, aircraft.length);
});

test('every aircraft keeps a link back to its original source page', () => {
  for (const a of aircraft) {
    assert.match(a.sourceUrl, /^https:\/\/www\.parkjets\.com\/free-plans\/p\//, a.slug);
  }
});

test('no aircraft claims a download it does not have', () => {
  for (const a of aircraft) {
    if (a.archiveStatus === 'ARCHIVED') {
      assert.equal(a.download.type, 'local', a.slug);
      assert.ok(a.download.file, `${a.slug} ARCHIVED without a file`);
      assert.ok(fs.existsSync(path.join(ROOT, 'public', a.download.file.replace(/^\//, ''))), a.slug);
    } else {
      assert.notEqual(a.download.type, 'local', a.slug);
      assert.ok(a.download.sourceUrl, a.slug);
    }
  }
});

test('every local download validates and matches its recorded checksum', () => {
  for (const a of aircraft.filter((x) => x.download.type === 'local')) {
    const abs = path.join(ROOT, 'public', a.download.file.replace(/^\//, ''));
    const buf = fs.readFileSync(abs);
    const sha = require('node:crypto').createHash('sha256').update(buf).digest('hex');
    assert.equal(sha, a.download.sha256, a.slug);
  }
});

test('every referenced image exists on disk, in both sizes', () => {
  for (const a of aircraft) {
    for (const im of a.images) {
      for (const key of ['card', 'full']) {
        assert.ok(im[key], `${a.slug} image missing ${key}`);
        const abs = path.join(ROOT, 'public', im[key].replace(/^\//, ''));
        assert.ok(fs.existsSync(abs), `${a.slug} ${key} not on disk: ${im[key]}`);
        assert.ok(fs.statSync(abs).size > 200, `${a.slug} ${key} is suspiciously small`);
      }
      assert.ok(im.alt && im.alt.length > 3, `${a.slug} image missing alt text`);
    }
  }
});

test('specification values are non-empty strings, never invented numbers', () => {
  for (const a of aircraft) {
    for (const [k, v] of Object.entries(a.specifications)) {
      assert.equal(typeof v, 'string', `${a.slug}.${k}`);
      assert.ok(v.trim().length > 0, `${a.slug}.${k} is empty`);
      assert.ok(v.length < 250, `${a.slug}.${k} looks like a whole sentence was swallowed`);
    }
  }
});

test('designers and categories are real, non-empty values', () => {
  for (const a of aircraft) {
    if (a.designer) assert.ok(a.designer.length < 60, `${a.slug} designer string too long`);
    if (!a.designer) assert.equal(a.designerKey, 'uncredited', a.slug);
  }
});

test('the archive manifest covers every aircraft and agrees with it', () => {
  assert.equal(manifest.entries.length, aircraft.length);
  const bySlug = new Map(aircraft.map((a) => [a.slug, a]));
  for (const e of manifest.entries) {
    const a = bySlug.get(e.slug);
    assert.ok(a, `manifest entry ${e.slug} has no aircraft record`);
    assert.equal(e.archiveStatus, a.archiveStatus, e.slug);
    assert.equal(e.sourceUrl, a.sourceUrl, e.slug);
    if (e.archiveStatus === 'ARCHIVED') {
      assert.equal(e.validation.status, 'passed', e.slug);
      assert.match(e.sha256, /^[0-9a-f]{64}$/, e.slug);
    }
  }
});

test('SOURCE_ONLY entries explain themselves', () => {
  for (const e of manifest.entries.filter((x) => x.archiveStatus === 'SOURCE_ONLY')) {
    assert.ok(e.notes && e.notes.length > 20, `${e.slug} has no explanation`);
    assert.ok(e.attempts.length > 0, `${e.slug} records no download attempts`);
  }
});
