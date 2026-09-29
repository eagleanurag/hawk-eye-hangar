/**
 * Catalog data layer.
 *
 * Reads data/aircraft.json (produced by the migration importer) and derives
 * every statistic the site shows. NOTHING is hard-coded: if an aircraft is
 * added or removed the homepage counters, filter lists and sitemap all follow.
 */

import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const SITE = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'site.json'), 'utf8'));

export interface ImportedImage {
  alt: string;
  caption?: string;
  width?: number | null;
  height?: number | null;
  card: string | null;
  full: string | null;
  cardBytes?: number;
  fullBytes?: number;
  sourceUrl: string;
  credit?: string;
}

export interface Aircraft {
  id: string;
  slug: string;
  sourceSlug: string;
  name: string;
  displayName: string;
  originalTitle: string;
  category: string[];
  designer: string;
  designerKey: string;
  designerSource: string;
  description: string;
  summary: string;
  designerNotes: string;
  specifications: Record<string, string>;
  specificationsExtra: { key: string; value: string }[];
  specificationsRaw: string;
  unkeyedSpecFragments: string[];
  buildRequirements: string;
  buildRequirementsLinks: { url: string; label: string }[];
  buildThreads: { url: string; label: string }[];
  externalLinks: { label: string; url: string; host: string }[];
  kitAvailability: string;
  images: ImportedImage[];
  sourceUrl: string;
  archiveStatus: 'ARCHIVED' | 'SOURCE_ONLY' | 'UNAVAILABLE' | 'MANUAL_REVIEW';
  download: {
    type: 'local' | 'source' | 'unavailable';
    file: string | null;
    filename?: string | null;
    sourceUrl: string;
    originalFilename?: string | null;
    format?: string | null;
    status: string;
    bytes?: number;
    sha256?: string;
    fileType?: string;
  };
  license: { status: string; notes: string };
  source: {
    parkjetsId: string;
    addedOn: string | null;
    updatedOn: string | null;
    priceCents: number | null;
    seoTitle: string | null;
    seoDescription: string | null;
  };
  review: { field: string; issue: string }[];
}

export const aircraft: Aircraft[] = JSON.parse(
  fs.readFileSync(path.join(DATA_DIR, 'aircraft.json'), 'utf8')
);

export const bySlug = new Map(aircraft.map((a) => [a.slug, a]));

/** Canonical, human-readable labels for the parsed specification fields. */
export const SPEC_LABELS: Record<string, string> = {
  wingspan: 'Wingspan',
  length: 'Length',
  width: 'Width',
  scale: 'Scale',
  wingArea: 'Wing area',
  wingLoading: 'Wing loading',
  weight: 'Weight (AUW)',
  centerOfGravity: 'Centre of gravity',
  material: 'Material',
  foamThickness: 'Foam thickness',
  motor: 'Motor',
  propeller: 'Propeller',
  battery: 'Battery',
  esc: 'ESC',
  servos: 'Servos',
  radio: 'Radio',
  receiver: 'Receiver',
  current: 'Current draw',
  power: 'Power',
  speed: 'Speed',
  flightControls: 'Flight controls',
  controlThrows: 'Control throws',
  construction: 'Construction',
  kit: 'Kit',
};

export const SPEC_GROUPS: { title: string; keys: string[] }[] = [
  {
    title: 'Airframe',
    keys: ['wingspan', 'length', 'width', 'scale', 'wingArea', 'wingLoading', 'weight', 'centerOfGravity', 'material', 'foamThickness', 'construction'],
  },
  {
    title: 'Power system',
    keys: ['motor', 'propeller', 'battery', 'esc', 'servos', 'radio', 'receiver', 'current', 'power', 'speed'],
  },
  {
    title: 'Control & flight',
    keys: ['flightControls', 'controlThrows', 'kit'],
  },
];

export const ARCHIVE_STATUS_META: Record<
  string,
  { label: string; short: string; tone: string; blurb: string }
> = {
  ARCHIVED: {
    label: 'Plan archived locally',
    short: 'Archived',
    tone: 'ok',
    blurb: 'A validated copy of the plan file is stored in this repository and downloadable from this site.',
  },
  SOURCE_ONLY: {
    label: 'Available from original source',
    short: 'Source only',
    tone: 'warn',
    blurb:
      'Parkjets releases this plan file to members only. The catalogue entry, imagery and original filename are archived here; the file itself is downloaded from the original product page.',
  },
  UNAVAILABLE: {
    label: 'No plan published',
    short: 'No plan',
    tone: 'muted',
    blurb: 'The original catalogue entry publishes no downloadable plan file.',
  },
  MANUAL_REVIEW: {
    label: 'Needs manual review',
    short: 'Review',
    tone: 'alert',
    blurb: 'A file is present but did not pass automated validation.',
  },
};

function tally<T extends string>(values: T[]): { value: T; count: number }[] {
  const m = new Map<T, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

export const categories = tally(aircraft.flatMap((a) => a.category));

/**
 * Designers grouped by the case-insensitive key so "FuelsGuy" and "Fuelsguy"
 * are one person. Where a designer is spelled more than one way in the source
 * the most frequent spelling wins, then alphabetical order, so the displayed
 * name is deterministic rather than dependent on catalogue order.
 */
export const designerSpellings = (() => {
  const m = new Map<string, Map<string, number>>();
  for (const a of aircraft) {
    if (!a.designer || !a.designerKey || a.designerKey === 'uncredited') continue;
    if (!m.has(a.designerKey)) m.set(a.designerKey, new Map());
    const byName = m.get(a.designerKey)!;
    byName.set(a.designer, (byName.get(a.designer) || 0) + 1);
  }
  return m;
})();

export const designers = [...designerSpellings.entries()]
  .map(([key, byName]) => {
    const variants = [...byName.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return { key, value: variants[0][0], count: 0, spellings: variants.map(([n, c]) => ({ name: n, count: c })) };
  })
  .map((d) => {
    d.count = d.spellings.reduce((s, v) => s + v.count, 0);
    return d;
  })
  .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));

export const uncreditedCount = aircraft.filter((a) => a.designerKey === 'uncredited').length;

export const stats = {
  aircraft: aircraft.length,
  archived: aircraft.filter((a) => a.archiveStatus === 'ARCHIVED').length,
  sourceOnly: aircraft.filter((a) => a.archiveStatus === 'SOURCE_ONLY').length,
  unavailable: aircraft.filter((a) => a.archiveStatus === 'UNAVAILABLE').length,
  manualReview: aircraft.filter((a) => a.archiveStatus === 'MANUAL_REVIEW').length,
  categories: categories.length,
  designers: designers.length,
  images: aircraft.reduce((s, a) => s + a.images.length, 0),
  specifications: aircraft.filter((a) => Object.keys(a.specifications).length).length,
  buildThreads: new Set(aircraft.flatMap((a) => a.buildThreads.map((t) => t.url))).size,
  externalLinks: new Set(aircraft.flatMap((a) => a.externalLinks.map((t) => t.url))).size,
};

export { SITE };

/**
 * The deployment base path. Taken from the Astro build config so it can never
 * drift from the router; `data/site.json` is the fallback for non-Astro use.
 */
export const BASE: string = (import.meta.env?.BASE_URL || SITE.base || '/') as string;

/** Prefix a site-root-absolute path with the deployment base. */
export function pub(pathname: string): string {
  if (!pathname) return '';
  if (/^(https?:)?\/\//i.test(pathname) || pathname.startsWith('data:')) return pathname;
  const b = BASE.endsWith('/') ? BASE : BASE + '/';
  return b + pathname.replace(/^\/+/, '');
}

/** Absolute URL helper that respects the configured `base`. */
export function abs(pathname: string): string {
  return new URL(pub(pathname), SITE.url).toString();
}

/** One-line card summary: the two most useful specs the designer gave. */
export function cardSpecs(a: Aircraft): string[] {
  const order = ['wingspan', 'length', 'weight', 'material', 'wingArea'];
  return order.filter((k) => a.specifications[k]).slice(0, 2);
}

export function searchText(a: Aircraft): string {
  return [
    a.name,
    a.displayName,
    a.designer,
    a.category.join(' '),
    a.summary,
    a.description,
    a.designerNotes,
    a.specificationsRaw,
    a.buildRequirements,
    Object.entries(a.specifications)
      .map(([k, v]) => `${k} ${v}`)
      .join(' '),
    a.specificationsExtra.map((e) => `${e.key} ${e.value}`).join(' '),
  ]
    .join(' ')
    .toLowerCase();
}
