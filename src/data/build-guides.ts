/**
 * How-to Build guides.
 *
 * One data model for every aircraft build page, so ten pages cannot drift into
 * ten different designs. The F-22 Raptor page is deliberately NOT modelled here:
 * it is a bespoke interactive experience and is left exactly as it is.
 *
 * PROVENANCE RULES - these are enforced by review, not by code, and they matter:
 *   thread      facts stated in the aircraft's own build thread
 *   plan        facts from the designer's published plan / build documentation
 *   catalogue   facts already published on HawkEye Hangar
 *   external    facts from a third-party source linked from the thread
 *   inferred    reasoned from the above, and labelled as such on the page
 * Anything not supported by a source stays out of the data entirely rather than
 * being guessed at.
 */

/** Where a single fact came from. Rendered as a visible label on the page. */
export type Provenance = 'thread' | 'plan' | 'catalogue' | 'external' | 'inferred';

export const PROVENANCE_LABEL: Record<Provenance, string> = {
  thread: 'Build thread',
  plan: 'Plan documentation',
  catalogue: 'HawkEye Hangar',
  external: 'External source',
  inferred: 'Inferred',
};

export interface BuildFact {
  label: string;
  value: string;
  source: Provenance;
}

export interface BuildThreadRef {
  url: string;
  label: string;
  pages?: number;
  posts?: number;
  /** Rendered with rel/target so external forums are safe to link. */
  external?: boolean;
}

export interface BuildReference {
  label: string;
  href: string;
  external?: boolean;
}

/** A line of thread text, with whose words these are. */
export interface Quote {
  text: string;
  author: string;
  date: string;
  source: Provenance;
}

export interface QuotedFact extends BuildFact {
  /** Post author, when the fact came from a thread. */
  author?: string;
  date?: string;
}

export interface QuotedStage {
  title: string;
  body: string[];
  author?: string;
  date?: string;
  source: Provenance;
}

export interface QuotedProblem {
  title: string;
  problem: string;
  fix: string;
  author?: string;
  date?: string;
}

export interface BuildGuide {
  slug: string;

  /**
   * Hero banner. The strongest image the archive already holds for this
   * aircraft. Absent when the archive has no photograph, in which case the
   * page simply opens with text rather than a fabricated image.
   */
  hero?: { image: string; alt: string; caption?: string };

  /** Short lede under the title. */
  intro: string;

  /** Free prose drawn from the thread, attributed per paragraph. */
  overview?: Quote[];

  facts?: QuotedFact[];
  threads?: BuildThreadRef[];

  /** Thread text grouped by subject. Each group renders only if it has content. */
  materials?: Quote[];
  electronics?: Quote[];
  balance?: Quote[];
  finishing?: Quote[];
  flightNotes?: Quote[];

  stages?: QuotedStage[];
  problems?: QuotedProblem[];

  references?: BuildReference[];

  /** How this guide was assembled. Shown on the page. */
  provenance: string;

  /** What the source does not establish. Shown on the page. */
  limitations?: string[];
}

import { GUIDES } from './build-guides.data';

const byslug = new Map(GUIDES.map((g) => [g.slug, g]));

/**
 * Aircraft that have a How to Build page which is NOT in the GUIDES table,
 * because the page is bespoke rather than rendered by AircraftBuildPage.
 *
 * The F-22 Raptor is the only one: it has its own interactive scroll experience.
 * It still needs its "How to Build" button on the aircraft page, so it is listed
 * here explicitly rather than relying on the registry alone.
 */
export const BESOKE_BUILD_PAGES: readonly string[] = ['f-22-raptor'];

export function buildGuide(slug: string): BuildGuide | undefined {
  return byslug.get(slug);
}

export function allBuildGuides(): BuildGuide[] {
  return [...byslug.values()];
}

export function hasBuildGuide(slug: string): boolean {
  return byslug.has(slug) || BESOKE_BUILD_PAGES.includes(slug);
}
