/**
 * Parkjets Archive — motion runtime.
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

  let ticking = false;
  const apply = () => {
    ticking = false;
    const y = window.scrollY;
    for (const el of layers) {
      const depth = Number(el.dataset.parallax) || 0.12;
      el.style.transform = `translate3d(0, ${(y * depth).toFixed(2)}px, 0)`;
    }
  };
  const onScroll = () => {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(apply);
    }
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  apply();
}

/* ------------------------------------------------------------------ */
/* Header state + mobile navigation                                    */
/* ------------------------------------------------------------------ */
function initHeader() {
  const header = document.querySelector('[data-header]');
  const toggle = document.querySelector('[data-nav-toggle]');
  const nav = document.querySelector('[data-nav]');

  if (header) {
    const onScroll = () => header.setAttribute('data-scrolled', String(window.scrollY > 12));
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
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
  // Close if the viewport grows past the breakpoint while open.
  addEventListener('resize', () => {
    if (!mq.matches && toggle.getAttribute('aria-expanded') === 'true') setOpen(false);
  });
}

/* ------------------------------------------------------------------ */
/* Page transition curtain (outgoing navigation)                      */
/* ------------------------------------------------------------------ */
function initPageTransitions() {
  if (reduce()) return;
  if (!import.meta.env?.PROD) return;
  const curtain = document.createElement('div');
  curtain.setAttribute('aria-hidden', 'true');
  curtain.style.cssText =
    'position:fixed;inset:0;z-index:150;pointer-events:none;background:linear-gradient(120deg,#05080f,#0b1220 55%,#05080f);transform:translateY(100%);transition:transform .42s cubic-bezier(.16,1,.3,1);';
  document.body.append(curtain);

  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest?.('a');
    if (!a) return;
    if (e.target.closest('[data-no-transition]')) return;
    const href = a.getAttribute('href') || '';
    if (!href || a.target === '_blank' || a.hasAttribute('download')) return;
    if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    if (a.origin !== location.origin) return;
    e.preventDefault();
    curtain.style.transform = 'translateY(0)';
    setTimeout(() => {
      location.href = href;
    }, 340);
  });

  addEventListener('pageshow', () => {
    curtain.style.transform = 'translateY(100%)';
  });
}

/* ------------------------------------------------------------------ */
/* Tilt on hero imagery                                                */
/* ------------------------------------------------------------------ */
function initTilt() {
  if (reduce()) return;
  for (const el of document.querySelectorAll('[data-tilt]')) {
    const max = Number(el.dataset.tilt) || 5;
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
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
