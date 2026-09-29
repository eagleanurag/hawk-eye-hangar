/**
 * Parkjets description parser.
 *
 * The Parkjets catalog is 100% designer-authored free text. This module turns
 * that text into structure WITHOUT INVENTING ANY VALUE.
 *
 * Rules:
 *  - A value is only emitted if a designer literally wrote `Key: value` or
 *    `Key = value`.
 *  - Unkeyed fragments are NEVER merged into a keyed field. They are preserved
 *    verbatim in `buildRequirementsRaw` / `notesRaw`.
 *  - Affiliate link decorations are stripped from values but the *text* the
 *    designer wrote is kept.
 */

const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', rsquo: '’',
  lsquo: '‘', ldquo: '“', rdquo: '”', deg: '°',
  eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç',
  uuml: 'ü', ouml: 'ö', auml: 'ä', szlig: 'ß',
  bull: '•', middot: '·', times: '×', frac12: '½',
};

export function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]{1,10});/g, (m, n) => HTML_ENTITIES[n] ?? m)
    .replace(/\u00a0/g, ' ');
}


export function stripTags(html) {
  if (!html) return '';
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Extract all <a href> from an HTML fragment, in order. */
export function extractLinks(html) {
  const out = [];
  const re = /<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html || ''))) {
    const href = decodeEntities(m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!href) continue;
    out.push({ url: href, label: stripTags(m[4]).trim() });
  }
  return out;
}

/** Split the description into { heading, html, text } blocks. */
const KNOWN_HEADINGS = [
  'NOTE FROM THE DESIGNER', 'NOTES FROM THE DESIGNER', 'NOTE FROM DESIGNER',
  'NOTE FROM GGRN', 'DESIGNER NOTES', 'DESCRIPTION', 'SPECIFICATIONS',
  'WHAT YOU NEED TO BUILD THIS', 'BUILD THREAD', 'BUILD THREADS',
  'BUILD TREADS', 'KIT AVAILABLE', 'SUGGESTED SET UP', 'SUGGESTED SET-UP',
  'SET UP', 'SUGGESTED PARTS', 'RECOMMENDED GEAR', 'SU-27 VIDEO',
  'ARROW VIDEO',
];

export function splitSections(excerptHtml) {
  const html = excerptHtml || '';
  const sections = [];
  let current = { heading: '', html: '' };

  const token = /(<h[2-6][^>]*>[\s\S]*?<\/h[2-6]>)|(<\/(?:p|div|li)[^>]*>)|(<!--[\s\S]*?-->)/gi;
  let last = 0;
  let m;
  const pushCurrent = () => {
    const t = stripTags(current.html);
    if (t) sections.push({ heading: current.heading, html: current.html, text: t });
    current = { heading: '', html: '' };
  };
  while ((m = token.exec(html))) {
    current.html += html.slice(last, m.index);
    last = token.lastIndex;
    if (m[1]) {
      const htxt = stripTags(m[1]).trim().toUpperCase();
      const isHeading = KNOWN_HEADINGS.includes(htxt) || htxt.length < 40;
      if (isHeading) {
        pushCurrent();
        current.heading = htxt;
      } else {
        current.html += m[1];
      }
    } else {
      current.html += m[0];
    }
  }
  current.html += html.slice(last);
  pushCurrent();
  return sections;
}

/* ------------------------------------------------------------------ */
/* Canonical specification keys                                       */
/* ------------------------------------------------------------------ */

export const SPEC_KEY_MAP = new Map(
  Object.entries({
    // geometry
    wingspan: ['wingspan', 'wing span', 'span', 'ws', 'wing-span', 'wings spans'],
    length: ['length', 'fuselage length', 'l'],
    width: ['width', 'span width', 'saucer width', 'saucer span'],
    wingArea: ['wing area', 'wa', 'area', 'wing size'],
    wingLoading: ['wing loading', 'wl', 'wing load'],
    scale: ['scale', 'scale ratio'],
    // mass
    weight: [
      'weight', 'weight rtf', 'auw', 'aow', 'all up weight', 'weight without battery',
      'flying weight', 'flying weight tested', 'w', 'weight (rtf)', 'rtf weight',
      'weight no battery', 'weight (aircraft)',
    ],
    centerOfGravity: [
      'center of gravity', 'centre of gravity', 'cog', 'cg', 'cg position',
      'cog location', 'cog position',
    ],
    // materials
    material: ['material', 'foam', 'construction', 'material used', 'skin', 'build material', 'build materials'],
    // power system
    motor: ['motor', 'motor x 2', 'motors', 'engine', 'motor(s)'],
    propeller: ['propeller', 'prop', 'prop x 2', 'propeller (counter rotating)', 'props', 'propeller size'],
    battery: ['battery', 'batt', 'lipo', 'cells', 'battery pack', 'battery (s)'],
    esc: ['esc', 'esc x 2', 'speed control', 'escs'],
    servos: ['servos', 'servo', 'servos x2', 'controls'],
    radio: ['radio', 'radio equipment', 'transmitter', 'tx'],
    receiver: ['receiver', 'rx', 'electronics', 'receiver (rx)'],
    // performance / power figures
    current: ['current', 'current draw', 'amps', 'amps draw'],
    power: ['watts', 'power', 'power input', 'power loading', 'powerplant', 'power plant'],
    flightControls: ['flight controls', 'controls', 'control configuration'],
    controlThrows: [
      'control throws', 'aileron', 'elevator', 'rudder', 'elevon control throws',
      'my control throws', 'control throw',
    ],
    speed: ['speed', 'cruise speed', 'max speed'],
    // misc
    foamThickness: ['foam thickness', 'foam thickness used'],
    construction: ['construction', 'build method'],
    kit: ['kit', 'kit available'],
  })
);

const ALIAS_LOOKUP = new Map();
for (const [canon, aliases] of SPEC_KEY_MAP) {
  for (const a of aliases) ALIAS_LOOKUP.set(a.toLowerCase(), canon);
}

/** Remove affiliate-link decoration and normalise whitespace. */
export function cleanValue(v) {
  if (!v) return '';
  let s = String(v);
  // " -> Amazon | Banggood (budget)" / "→ Amazon"
  s = s.replace(/\s*[→>»]+\s*Amazon.*$/i, '');
  s = s.replace(/\s*[→>»]+.*$/u, '');
  s = s.replace(/^\s*[-–—:;=]\s+/, ''); // leading separator residue ("- 6mm depron")
  s = s.replace(/\s*\|\s*$/, '');
  s = s.replace(/\s*\(\s*budget\s*\)\s*$/i, '');
  s = s.replace(/\s*\(\s*estimated?\s*\)\s*$/i, '');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/[,;]\s*$/, '').trim();
  return s;
}

const KEY_RE = /^([A-Za-z][A-Za-z0-9 /&'’()\-.%]{0,45}?)\s*[:=]\s*(.+)$/;
const DASH_RE = /^([A-Za-z][A-Za-z0-9 /&'’()%]{0,30}?)\s+[-–—]\s+(\S.*)$/;

/**
 * Aliases that are strong enough to be recognised even when a designer wrote
 * them without a colon ("Wing span 72.1 cm", "Wingspan - 19.88\"").
 */
const STRONG_ALIASES = [
  'all up weight', 'center of gravity', 'centre of gravity', 'cog location',
  'cg position', 'cog position', 'build material', 'flight controls',
  'control throws', 'power loading', 'wing loading', 'wing area',
  'weight without battery', 'weight estimating', 'weight about',
  'flying weight', 'radio equipment', 'propeller slot', 'wingspan',
  'wing span', 'length', 'width', 'weight', 'scale', 'material', 'foam',
  'motor', 'propeller', 'prop', 'battery', 'lipo', 'cells', 'esc', 'servos',
  'radio', 'receiver', 'current', 'watts', 'cog', 'cg', 'ws', 'wa', 'auw',
  'aow', 'span', 'rx',
].sort((a, b) => b.length - a.length);

// Only aliases that map to a canonical field may be used for bare matching.
const CANONICAL_STRONG = STRONG_ALIASES.filter((a) => ALIAS_LOOKUP.has(a));

function canonicalKey(k) {
  const norm = String(k)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*\(\s*[^)]*\)\s*$/, '')
    .replace(/[.:;,]+$/, '')
    .trim();
  if (ALIAS_LOOKUP.has(norm)) return ALIAS_LOOKUP.get(norm);
  // Prefix match: "weight estimating" / "weight about" -> weight
  for (const [canon, aliases] of SPEC_KEY_MAP) {
    for (const a of aliases) {
      if (a.length >= 4 && norm.startsWith(a + ' ')) return canon;
    }
  }
  return null;
}

/** Look for a strong alias at/near the start of an unpunctuated segment. */
function matchStrongAlias(seg) {
  for (const alias of CANONICAL_STRONG) {
    if (new RegExp(`^${alias}\\s+(?=\\S)`, 'i').test(seg)) {
      return { canon: ALIAS_LOOKUP.get(alias), key: seg.slice(0, alias.length).trim(), value: seg.slice(alias.length).trim() };
    }
  }
  // Allow a short generic lead-in: "Size Wingspan 40.5""
  const m = /^([A-Za-z]{1,12}(?:\s+[A-Za-z]{1,12})?)\s+([A-Za-z][A-Za-z ]{2,20}?)\s+(\S.*)$/.exec(seg);
  if (m) {
    for (const alias of CANONICAL_STRONG) {
      if (m[2].toLowerCase() === alias) {
        return { canon: ALIAS_LOOKUP.get(alias), key: m[2].trim(), value: m[3].trim() };
      }
    }
  }
  return null;
}

/**
 * Designers sometimes run two fields together inside one value
 * ("Length 35.5"/ 90cm Weight Estimating 500g"). Splitting those would be a
 * guess, so they are deliberately LEFT ALONE. The verbatim text is preserved
 * in `specificationsRaw` and displayed in full on the aircraft page.
 */

/**
 * Labels that are pure page furniture, not data. Kept deliberately narrow:
 * anything that could plausibly be a real field name must be kept so the
 * value is never silently dropped.
 */
const BOILERPLATE_KEY = /^(suggested donation|donation|donations?|price|e-?mail|email|paypal|copy e-?mail|warning|thank you|thanks|more information|add to cart|file size|video|videos|note from (the )?designer)\b/i;

/**
 * Pull keyed `Key: value` pairs out of a block of text.
 * Handles `A: 1 | B: 2`, newline-separated lines, `A - 1` and bare `A 1`
 * forms for recognised keys. Unkeyed segments are never merged into a value.
 */
export function parseKeyValues(text) {
  const pairs = [];
  const unkeyed = [];
  if (!text) return { pairs, unkeyed };

  const segments = String(text)
    .split(/\s*[|;\n]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);

  const add = (key, value, canon) => {
    if (BOILERPLATE_KEY.test(key)) return;
    pairs.push({ key, value: cleanValue(value), canon });
  };

  for (const seg of segments) {
    const km = KEY_RE.exec(seg);
    if (km) {
      add(km[1].trim(), km[2], canonicalKey(km[1]));
      continue;
    }
    const dm = DASH_RE.exec(seg);
    if (dm) {
      const canon = canonicalKey(dm[1]);
      if (canon) {
        add(dm[1].trim(), dm[2], canon);
        continue;
      }
    }
    const am = matchStrongAlias(seg);
    if (am) {
      add(am.key, am.value, am.canon);
      continue;
    }
    unkeyed.push(cleanValue(seg));
  }
  return { pairs, unkeyed };
}

/** Extra safety: reject obviously-wrong short aliases like bare "l" unless numeric-ish. */
function valueIsPlausible(canon, value) {
  if (!value) return false;
  if (value.length > 220) return false;
  if (canon === 'length' && /^(l)$/i.test(value)) return false;
  if (canon === 'width' && value.length < 2) return false;
  return true;
}

/**
 * Build the specification record for one aircraft.
 *
 * `sectionTexts` are the description blocks eligible for canonical extraction
 * (already filtered by the caller). Only literal designer-written `key: value`
 * pairs are promoted into `specifications`. Everything else is preserved in
 * `extra` / `unkeyedNotes` and in the verbatim raw blocks kept by the importer.
 */
export function extractSpecifications(sectionTexts) {
  const specifications = {};
  const seen = new Map(); // canon -> [raw keys]
  const extra = [];
  const unkeyedNotes = [];

  const blocks = Array.isArray(sectionTexts) ? sectionTexts : [sectionTexts];
  for (const text of blocks) {
    const { pairs, unkeyed } = parseKeyValues(text);
    for (const u of unkeyed) if (u) unkeyedNotes.push(u);
    for (const { key, value, canon } of pairs) {
      if (canon && valueIsPlausible(canon, value)) {
        if (!specifications[canon]) {
          specifications[canon] = value;
          seen.set(canon, [key]);
        } else if (
          canon !== 'controlThrows' &&
          seen.get(canon).length < 4 &&
          !seen.get(canon).some((k) => k.toLowerCase() === key.toLowerCase())
        ) {
          // Keep both, clearly separated, when a designer gave two numbers.
          specifications[canon] = `${specifications[canon]} / ${value}`;
          seen.get(canon).push(key);
        }
      } else if (value) {
        extra.push({ key, value });
      }
    }
  }
  return { specifications, extra, unkeyedNotes };
}

const DESIGNER_PATTERNS = [
  /^designed\s+by\s+(.{2,60}?)\s*$/i,
  /^design\s*[:\-]\s*(.{2,60}?)\s*$/i,
  /^created\s+by\s+(.{2,60}?)\s*$/i,
  /^by\s+(.{2,60}?)\s*$/i,
  /designed\s+by\s+([A-Z][^.|<>\n]{2,50})/i,
];

export function extractDesigner(text, tag) {
  if (text) {
    for (const line of text.split('\n')) {
      const l = line.trim();
      for (const re of DESIGNER_PATTERNS) {
        const m = re.exec(l);
        if (m) {
          let name = m[1].trim().replace(/[.,;]$/, '');
          // Drop trailing donation boilerplate
          name = name.replace(/\s*\(.*?\)\s*$/, (s) => (s.length < 24 ? s : '')).trim();
          if (name && name.length <= 60 && !/^(the|a|an|this|these|it)\b/i.test(name)) {
            return { designer: name, source: 'description' };
          }
        }
      }
    }
  }
  if (tag && tag.length && !/^decals$/i.test(tag)) {
    return { designer: tag, source: 'tag' };
  }
  return { designer: '', source: 'unknown' };
}

const DONATION_RE = /^(if you (download|build)|please consider sending|consider sending|keep the plans|copy e-?mail)/i;
const PAYPAL_RE = /^(paypal|e-?mail|click here)/i;

export function isBoilerplate(line) {
  const l = line.trim();
  if (!l) return true;
  if (DONATION_RE.test(l)) return true;
  if (PAYPAL_RE.test(l)) return true;
  if (/^suggested donation/i.test(l)) return true;
  if (/^(be sure to check out|check out my|subscribe)/i.test(l)) return true;
  if (/^links below are affiliate/i.test(l)) return true;
  return false;
}
