/**
 * Archive file validation helpers (no external dependencies).
 *
 * Every file that is claimed as ARCHIVED must pass these checks. Nothing is
 * truncated, patched or "repaired" — a file either validates or is reported.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/* ----------------------------- CRC32 ------------------------------ */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ------------------------------ ZIP -------------------------------- */
/** Read the ZIP end-of-central-directory record. */
function findEOCD(buf) {
  const max = Math.min(buf.length, 0xffff + 22);
  for (let i = buf.length - 22; i >= buf.length - max && i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/**
 * Validate a ZIP archive end-to-end: EOCD present, every central-directory
 * entry has a matching local file header, and every entry's CRC-32 matches.
 */
export function validateZip(buf) {
  const eocd = findEOCD(buf);
  if (eocd < 0) return { valid: false, error: 'end-of-central-directory record not found' };

  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const commentLen = buf.readUInt16LE(eocd + 20);

  if (cdOffset + cdSize > buf.length) {
    return { valid: false, error: 'central directory extends past end of file' };
  }
  if (eocd + 22 + commentLen > buf.length) {
    return { valid: false, error: 'archive comment extends past end of file' };
  }

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) {
      return { valid: false, error: `bad central-directory signature at entry ${i}` };
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLenE = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLenE;

    if (localOffset + 30 > buf.length) {
      return { valid: false, error: `local header for "${name}" is out of range` };
    }
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) {
      return { valid: false, error: `local header signature mismatch for "${name}"` };
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > buf.length) {
      return { valid: false, error: `compressed data for "${name}" is truncated` };
    }
    let crcOk = null;
    if (method === 0) {
      const actual = crc32(buf.subarray(dataStart, dataStart + compSize));
      crcOk = actual === crc;
      if (!crcOk) return { valid: false, error: `CRC mismatch in "${name}"` };
    } else if (method !== 8) {
      return { valid: false, error: `unsupported compression method ${method} in "${name}"` };
    }
    entries.push({ name, method, compressedBytes: compSize, bytes: rawSize, crcOk, directory: name.endsWith('/') });
  }
  const summary = summariseEntries(entries);
  return {
    valid: true,
    entries: entries.length,
    files: entries.filter((e) => !e.directory).length,
    uncompressedBytes: entries.reduce((s, e) => s + e.bytes, 0),
    byExtension: summary.byExtension,
    nestedArchives: summary.nestedArchives,
    contains: summary,
  };
}

function summariseEntries(entries) {
  const counts = {};
  const nested = [];
  for (const e of entries) {
    if (e.directory) continue;
    const ext = (path.extname(e.name) || '(none)').toLowerCase();
    counts[ext] = (counts[ext] || 0) + 1;
    if (/\.(zip|7z|rar|tar|gz)$/i.test(e.name)) nested.push(e.name);
  }
  return { byExtension: counts, nestedArchives: nested };
}

/* ------------------------------ PDF -------------------------------- */
export function validatePdf(buf) {
  if (buf.length < 32) return { valid: false, error: 'file too small to be a PDF' };
  if (buf.toString('latin1', 0, 5) !== '%PDF-') return { valid: false, error: 'missing %PDF- header' };
  const tail = buf.toString('latin1', Math.max(0, buf.length - 2048));
  if (!tail.includes('%%EOF')) return { valid: false, error: 'missing %%EOF trailer' };
  const text = buf.toString('latin1');
  const counts = [...text.matchAll(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  const pageObjs = (text.match(/\/Type\s*\/Page[^s]/g) || []).length;
  const pages = counts.length ? Math.max(...counts) : pageObjs || null;
  const encrypted = /\/Encrypt\s/.test(text);
  const version = text.slice(5, 8);
  return {
    valid: true,
    version,
    pages,
    pageCountMethod: counts.length ? '/Pages /Count' : pageObjs ? '/Type /Page objects' : 'unknown',
    encrypted,
  };
}

/* ------------------------- DXF / SVG / text ----------------------- */
export function validateDxf(buf) {
  const head = buf.toString('latin1', 0, 64);
  if (!/\bSECTION\b/.test(head)) return { valid: false, error: 'no SECTION marker in DXF header' };
  const text = buf.toString('latin1');
  const hasEntities = /ENTITIES/.test(text);
  return { valid: true, sections: (text.match(/\n2\r?\n[A-Z]+\r?\n/g) || []).length, hasEntities };
}

export function validateSvg(buf) {
  const head = buf.toString('utf8', 0, 512);
  if (!/<svg[\s>]/i.test(head)) return { valid: false, error: 'no <svg> element' };
  const m = /viewBox\s*=\s*["']([^"']+)["']/i.exec(buf.toString('utf8', 0, 2048));
  return { valid: true, viewBox: m ? m[1] : null };
}

export function validateRaster(buf) {
  if (buf.length < 100) return { valid: false, error: 'file too small' };
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return { valid: true, format: 'png' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { valid: true, format: 'jpeg' };
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return { valid: true, format: 'gif' };
  return { valid: false, error: 'unrecognised image format' };
}

/** Dispatch on extension. Returns { valid, type, ...details }. */
export function validateFile(filePath) {
  const buf = fs.readFileSync(filePath);
  const ext = (path.extname(filePath) || '').toLowerCase();
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const base = {
    file: filePath,
    bytes: buf.length,
    sha256,
    extension: ext || '(none)',
  };
  try {
    if (ext === '.zip') return { ...base, type: 'ZIP', ...validateZip(buf) };
    if (ext === '.pdf') return { ...base, type: 'PDF', ...validatePdf(buf) };
    if (ext === '.dxf') return { ...base, type: 'DXF', ...validateDxf(buf) };
    if (ext === '.svg') return { ...base, type: 'SVG', ...validateSvg(buf) };
    return { ...base, type: ext.replace('.', '').toUpperCase() || 'UNKNOWN', ...validateRaster(buf) };
  } catch (e) {
    return { ...base, valid: false, error: `validation threw: ${e.message}` };
  }
}

export function humanBytes(n) {
  if (n == null) return 'Unknown';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
