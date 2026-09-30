/**
 * HawkEye Hangar — motion runtime.
 *
 * Deliberately dependency-free (~3 KB, no framework, no GSAP). Everything is
 * CSS-driven; this file only adds the scroll observers, number counters and
 * micro-interactions that CSS cannot express on its own.
 *
 * Respects prefers-reduced-motion: when the user asks for reduced motion every
 * observer resolves immediately and parallax/looping animation is disabled.
 */

const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const onReady = (fn) =>
  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', fn, { once: true })
    : fn();

/* ------------------------------------------------------------------ */
/* Scroll reveal                                                       */
/* ------------------------------------------------------------------ */
function initReveal() {
  const items = document.querySelectorAll('[data-reveal]');
  if (!items.length) return;

  if (reduce() || !('IntersectionObserver' in window)) {
    items.forEach((el) => el.classList.add('is-revealed'));
    return;
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-revealed');
        io.unobserve(entry.target);
      }
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.06 }
  );
  items.forEach((el) => io.observe(el));
}

/* ------------------------------------------------------------------ */
/* Animated counters                                                   */
/* ------------------------------------------------------------------ */
function initCounters() {
  const els = document.querySelectorAll('[data-count-to]');
  if (!els.length) return;

  const run = (el) => {
    const target = Number(el.dataset.countTo);
    if (!Number.isFinite(target)) return;
    if (reduce()) {
      el.textContent = target.toLocaleString();
      return;
    }
    const dur = 1100;
    const start = performance.now();
    const from = 0;
    const tick = (now) => {
      const p = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(from + (target - from) * eased).toLocaleString();
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  if (!('IntersectionObserver' in window)) {
    els.forEach(run);
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        run(e.target);
        io.unobserve(e.target);
      }
    },
    { threshold: 0.4 }
  );
  els.forEach((el) => io.observe(el));
}

/* ------------------------------------------------------------------ */
/* Hero parallax (pointer + scroll)                                    */
/* ------------------------------------------------------------------ */
function initParallax() {
  const layers = document.querySelectorAll('[data-parallax]');
  if (!layers.length || reduce()) return;

  // Shares the document scroll listener above, so this adds no new listener and
  // no separate rAF loop.
  const apply = () => {
    const y = window.scrollY;
    for (const el of layers) {
      const depth = Number(el.dataset.parallax) || 0.12;
      el.style.transform = `translate3d(0, ${(y * depth).toFixed(2)}px, 0)`;
    }
  };
  scrollSubscribers.add(apply);
  apply();
}

/* ------------------------------------------------------------------ */
/* Header state + mobile navigation                                    */
/* ------------------------------------------------------------------ */

/*
 * ONE scroll listener for the whole document, shared by the header state and
 * the hero parallax. Previously each feature attached its own passive listener;
 * they are consolidated here and dispatched from a single rAF so the browser
 * does the work at most once per frame.
 */
const scrollSubscribers = new Set();
let scrollQueued = false;
function onDocumentScroll() {
  if (scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    for (const fn of scrollSubscribers) fn();
  });
}
if ('IntersectionObserver' in window || true) {
  window.addEventListener('scroll', onDocumentScroll, { passive: true });
}

function initHeader() {
  const header = document.querySelector('[data-header]');
  const toggle = document.querySelector('[data-nav-toggle]');
  const nav = document.querySelector('[data-nav]');

  if (header) {
    const apply = () => header.setAttribute('data-scrolled', String(window.scrollY > 12));
    scrollSubscribers.add(apply);
    apply();
  }

  if (!toggle || !nav) return;
  const mq = matchMedia('(max-width: 880px)');
  const setOpen = (open) => {
    toggle.setAttribute('aria-expanded', String(open));
    nav.dataset.open = String(open);
    document.body.classList.toggle('no-scroll', open && mq.matches);
  };
  setOpen(false);
  toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'));
  nav.addEventListener('click', (e) => {
    if (e.target.closest('a') && mq.matches) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
      setOpen(false);
      toggle.focus();
    }
  });
  mq.addEventListener('change', () => setOpen(false));
}

/* ------------------------------------------------------------------ */
/* Page transition                                                     */
/* ------------------------------------------------------------------ */
/*
 * The outgoing "curtain" transition was removed on purpose.
 *
 * It intercepted every same-origin link click and delayed navigation by 340ms,
 * which showed up directly as perceived input latency: a visitor who clicked a
 * catalogue card waited a third of a second before the page changed. The brief
 * for this redesign is that clicks and scrolls feel immediate, so navigation is
 * left to the browser. Native scroll restoration and the back button behave
 * better without a scripted overlay in the path.
 *
 * The function is retained as an explicit no-op so any external caller that
 * still references it does not break.
 */
function initPageTransitions() {
  return;
}

/* ------------------------------------------------------------------ */
/* Tilt on hero imagery                                                */
/* ------------------------------------------------------------------ */
function initTilt() {
  if (reduce()) return;
  for (const el of document.querySelectorAll('[data-tilt]')) {
    const max = Number(el.dataset.tilt) || 5;
    // The rect was previously read on every pointermove, which forces a
    // synchronous layout per event. It only changes on resize/scroll of the
    // element, so it is measured once and refreshed on resize.
    let rect = el.getBoundingClientRect();
    const remeasure = () => {
      rect = el.getBoundingClientRect();
    };
    addEventListener('resize', remeasure, { passive: true });

    el.addEventListener('pointermove', (e) => {
      const px = (e.clientX - rect.left) / rect.width - 0.5;
      const py = (e.clientY - rect.top) / rect.height - 0.5;
      el.style.transform = `perspective(900px) rotateY(${(px * max).toFixed(2)}deg) rotateX(${(-py * max).toFixed(2)}deg)`;
    });
    el.addEventListener('pointerleave', () => {
      el.style.transform = '';
    });
  }
}

function boot() {
  initReveal();
  initCounters();
  initParallax();
  initHeader();
  initTilt();
  initPageTransitions();
}

onReady(boot);
