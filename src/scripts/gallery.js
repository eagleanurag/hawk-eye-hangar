/**
 * Aircraft image gallery.
 *
 * - thumbnail strip with roving tabindex
 * - arrow-key navigation
 * - horizontal swipe on touch devices
 * - full-screen lightbox with focus trapping and restore
 * - only the selected full-size image is loaded; thumbnails stay lazy
 */

const gallery = document.querySelector('[data-gallery]');
if (gallery) {
  const stage = gallery.querySelector('[data-stage]');
  const stageImg = gallery.querySelector('[data-stage-img]');
  const thumbs = Array.from(gallery.querySelectorAll('[data-gallery-thumb]'));
  const counter = gallery.querySelector('[data-gallery-counter]');
  const prevBtn = gallery.querySelector('[data-gallery-prev]');
  const nextBtn = gallery.querySelector('[data-gallery-next]');
  const zoomBtn = gallery.querySelector('[data-gallery-zoom]');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let index = 0;
  let lastFocus = null;

  const show = (i, focusThumb = false) => {
    if (!thumbs.length || !stageImg) return;
    index = (i + thumbs.length) % thumbs.length;
    const t = thumbs[index];
    const full = t.dataset.full || t.dataset.card;
    // Swap immediately and let CSS replay the entry animation by restarting it.
    if (full && stageImg.getAttribute('src') !== full) {
      stageImg.src = full;
      if (!reduce) {
        stageImg.style.animation = 'none';
        void stageImg.offsetWidth; // force reflow so the animation restarts
        stageImg.style.animation = '';
      }
    }
    if (t.dataset.alt) stageImg.alt = t.dataset.alt;
    thumbs.forEach((el, n) => el.setAttribute('aria-selected', String(n === index)));
    if (counter) counter.textContent = `${index + 1} / ${thumbs.length}`;
    if (focusThumb) thumbs[index].focus();
    thumbs[index].scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
  };

  thumbs.forEach((t, i) => {
    t.addEventListener('click', () => show(i));
    t.addEventListener('keydown', (e) => {
      const map = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
      if (e.key in map) {
        e.preventDefault();
        show(index + map[e.key], true);
      } else if (e.key === 'Home') {
        e.preventDefault();
        show(0, true);
      } else if (e.key === 'End') {
        e.preventDefault();
        show(thumbs.length - 1, true);
      }
    });
  });

  prevBtn?.addEventListener('click', () => show(index - 1));
  nextBtn?.addEventListener('click', () => show(index + 1));

  stage?.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      show(index - 1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      show(index + 1);
    }
  });
  stage?.setAttribute('tabindex', '0');

  // ---- touch swipe -------------------------------------------------------
  let x0 = null;
  let y0 = null;
  stage?.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType === 'mouse') return;
      x0 = e.clientX;
      y0 = e.clientY;
    },
    { passive: true }
  );
  stage?.addEventListener(
    'pointerup',
    (e) => {
      if (x0 == null) return;
      const dx = e.clientX - x0;
      const dy = e.clientY - y0;
      x0 = null;
      if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.4) show(index + (dx < 0 ? 1 : -1));
    },
    { passive: true }
  );

  // ---- lightbox ----------------------------------------------------------
  let lightbox = null;
  const openLightbox = () => {
    if (!stageImg || lightbox) return;
    lastFocus = document.activeElement;
    lightbox = document.createElement('div');
    lightbox.className = 'lightbox is-open';
    lightbox.setAttribute('role', 'dialog');
    lightbox.setAttribute('aria-modal', 'true');
    lightbox.setAttribute('aria-label', `${stageImg.alt} — enlarged`);
    const img = document.createElement('img');
    img.src = stageImg.src;
    img.alt = stageImg.alt;
    const close = document.createElement('button');
    close.className = 'lightbox-close';
    close.type = 'button';
    close.setAttribute('aria-label', 'Close enlarged image');
    close.innerHTML =
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    const bar = document.createElement('div');
    bar.className = 'lightbox-bar mono';
    bar.textContent = `Photograph ${index + 1} of ${thumbs.length} · EagleEye Hangar`;
    lightbox.append(img, close, bar);
    document.body.append(lightbox);
    document.body.classList.add('no-scroll');
    close.focus();

    const trap = (e) => {
      if (e.key === 'Escape') {
        destroy();
      } else if (e.key === 'ArrowRight') {
        show(index + 1);
        img.src = stageImg.src;
      } else if (e.key === 'ArrowLeft') {
        show(index - 1);
        img.src = stageImg.src;
      } else if (e.key === 'Tab') {
        e.preventDefault();
        close.focus();
      }
    };
    const destroy = () => {
      document.removeEventListener('keydown', trap);
      lightbox?.remove();
      lightbox = null;
      document.body.classList.remove('no-scroll');
      lastFocus?.focus();
    };
    lightbox.addEventListener('click', (e) => {
      if (e.target === lightbox || e.target === close) destroy();
    });
    document.addEventListener('keydown', trap);
  };
  zoomBtn?.addEventListener('click', openLightbox);
  stageImg?.addEventListener('dblclick', openLightbox);

  show(0);
}
