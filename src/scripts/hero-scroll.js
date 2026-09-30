/**
 * HawkEye Hangar — hero scroll story.
 *
 * Deliberately the smallest thing that can drive the hero: no GSAP, no scroll
 * library, no smooth-scroll hijack, no wheel/touch interception. Native browser
 * scrolling is left completely alone.
 *
 * Design rules enforced here:
 *   * ONE passive `scroll` listener + ONE `resize` listener for the whole page.
 *     Both are rAF-throttled, so at most one update runs per animation frame no
 *     matter how many scroll events fire.
 *   * Only `transform` and `opacity` are written. Both are compositor-only, so
 *     the browser can animate them without re-rasterising layout or paint.
 *   * Layers are isolated with `will-change` set from CSS, not JS, and the
 *     work is skipped entirely once the hero has left the viewport (an
 *     IntersectionObserver, not a scroll-distance guess).
 *   * `prefers-reduced-motion: reduce` disables the flight path completely and
 *     leaves the hero in its final, fully readable state.
 *   * On narrow viewports the path is shortened and rotation is reduced via the
 *     `--hero-*` custom properties, which are set by CSS media queries.
 *
 * Total: ~1.4 KB of JavaScript, zero dependencies.
 */

const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);
/** Smooth, jitter-free interpolation between scroll progress points. */
const smooth = (t) => t * t * (3 - 2 * t);
/** Map a global 0..1 progress into a 0..1 sub-progress over [from, to]. */
const span = (t, from, to) => clamp01((t - from) / (to - from));

function initHeroScroll() {
  const hero = document.querySelector('[data-hero-story]');
  if (!hero) return;

  const plane = hero.querySelector('[data-hero-plane]');
  const skin = hero.querySelector('[data-hero-skin]');
  const wire = hero.querySelector('[data-hero-wire]');
  const copy = hero.querySelector('[data-hero-copy]');
  const notes = hero.querySelectorAll('[data-hero-note]');
  if (!plane) return;

  const reduceQuery = matchMedia('(prefers-reduced-motion: reduce)');
  const narrowQuery = matchMedia('(max-width: 880px)');

  let active = false;
  let queued = false;
  let last = -1;

  // Everything the animation needs, read from CSS so media queries and
  // reduced-motion can retune it without duplicating the logic here.
  const params = () => {
    const cs = getComputedStyle(hero);
    const num = (name, fallback) => {
      const v = parseFloat(cs.getPropertyValue(name));
      return Number.isFinite(v) ? v : fallback;
    };
    return {
      travelX: num('--hero-travel-x', 0),
      travelY: num('--hero-travel-y', 0),
      bank: num('--hero-bank', 0),
      scaleFrom: num('--hero-scale-from', 1),
      scaleTo: num('--hero-scale-to', 0.8),
      fadeFrom: num('--hero-fade-from', 0.4),
      fadeTo: num('--hero-fade-to', 1),
    };
  };

  function apply() {
    queued = false;
    const p = params();

    // Progress across the hero's own scrollable span.
    const rect = hero.getBoundingClientRect();
    const spanY = rect.height - window.innerHeight;
    const raw = spanY > 0 ? clamp01(-rect.top / spanY) : 0;
    if (Math.abs(raw - last) < 0.0004) return;
    last = raw;

    // ---- Stage 1: forward flight (0 -> 0.55) ----
    const s1 = smooth(span(raw, 0, 0.55));
    // ---- Stage 2: bank + technical transition (0.4 -> 0.8) ----
    const s2 = smooth(span(raw, 0.4, 0.8));
    // ---- Stage 3: hand off to the catalogue (0.75 -> 1) ----
    const s3 = smooth(span(raw, 0.75, 1));

    const x = s1 * p.travelX;
    const y = s1 * p.travelY - s3 * Math.abs(p.travelY) * 0.4;
    const rot = s2 * p.bank;
    const scale = p.scaleFrom + (p.scaleTo - p.scaleFrom) * s2 + s3 * 0.06;

    plane.style.transform =
      `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) ` +
      `rotate(${rot.toFixed(2)}deg) scale(${scale.toFixed(4)})`;

    // Copy stays fully readable throughout: it fades only in the hand-off.
    if (copy) {
      const o = 1 - s3 * 0.85;
      copy.style.opacity = o.toFixed(3);
    }
    // Skin dissolves into the blueprint in stage 2.
    if (skin) skin.style.opacity = (1 - s2 * 0.85).toFixed(3);
    if (wire) wire.style.opacity = (s2 * 0.95).toFixed(3);

    // Engineering annotations appear with the technical stage.
    for (const n of notes) {
      n.style.opacity = (s2 * (n.dataset.heroNoteOpacity ? Number(n.dataset.heroNoteOpacity) : 1)).toFixed(3);
    }
  }

  function onScroll() {
    if (!active || queued) return;
    queued = true;
    requestAnimationFrame(apply);
  }

  function measure() {
    last = -1;
    if (!active) return;
    apply();
  }

  // Stop all work once the hero is gone. This is what keeps scrolling cheap:
  // no listener work at all below the hero.
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const nowActive = e.isIntersecting && !reduceQuery.matches;
        if (nowActive === active) continue;
        active = nowActive;
        if (active) apply();
        else {
          // Reset to the resting state so re-entry animates from the top.
          plane.style.transform = '';
          if (copy) copy.style.opacity = '';
          if (skin) skin.style.opacity = '';
          if (wire) wire.style.opacity = '';
          for (const n of notes) n.style.opacity = '';
          last = -1;
        }
      }
    },
    { rootMargin: '80px 0px' }
  );
  io.observe(hero);

  // Reduced motion: park the hero in its readable end state and do nothing else.
  function syncMotionPreference() {
    if (reduceQuery.matches) {
      active = false;
      plane.style.transform = '';
      if (copy) copy.style.opacity = '';
      if (skin) skin.style.opacity = '';
      if (wire) wire.style.opacity = '';
      for (const n of notes) n.style.opacity = '';
    } else {
      last = -1;
      if (active) apply();
    }
  }
  reduceQuery.addEventListener('change', syncMotionPreference);

  if (reduceQuery.matches) {
    syncMotionPreference();
    return;
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', measure, { passive: true });
  narrowQuery.addEventListener('change', measure);

  // Paint the initial state as soon as the hero is first seen.
  requestAnimationFrame(() => {
    if (active) apply();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initHeroScroll, { once: true });
} else {
  initHeroScroll();
}
