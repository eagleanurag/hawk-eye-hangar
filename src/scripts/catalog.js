/**
 * HawkEye Hangar — catalogue search, filtering and sorting.
 *
 * Progressive enhancement: every card is already server-rendered, so the
 * catalogue is fully browsable and indexable with JavaScript disabled. This
 * module only adds instant client-side filtering over the existing DOM — no
 * re-rendering, no framework, no network requests.
 *
 * Deep links are supported (?q= &category= &designer= &status=) so filtered
 * views can be shared, bookmarked and used with the back button.
 */

const root = document.querySelector('[data-catalog]');
if (root) {
  const grid = root.querySelector('[data-grid]');
  const cards = Array.from(root.querySelectorAll('[data-card]'));
  const input = root.querySelector('[data-search-input]');
  const clearBtn = root.querySelector('[data-search-clear]');
  const countEl = root.querySelector('[data-result-count]');
  const emptyEl = root.querySelector('[data-empty]');
  const emptyDetail = root.querySelector('[data-empty-detail]');
  const sortSelect = root.querySelector('[data-sort-select]');
  const activeFiltersEl = root.querySelector('[data-active-filters]');
  const resetButtons = root.querySelectorAll('[data-reset-all]');

  const groups = {};
  for (const fieldset of root.querySelectorAll('[data-filter-group]')) {
    groups[fieldset.dataset.filterGroup] = {
      value: 'all',
      buttons: Array.from(fieldset.querySelectorAll('[data-filter-value]')),
    };
  }

  const state = { q: '', category: 'all', designer: 'all', status: 'all', sort: 'name' };

  const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------------------------- tokenising ---------------------------- */
  const tokenize = (s) =>
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}+.]+/u)
      .filter(Boolean);

  /*
   * Search text now lives in one shared JSON index rather than a
   * `data-search` attribute per card, which keeps ~60 KB of escaped prose out
   * of the catalogue's HTML. Cards carry `data-slug` and look their text up
   * here, once, at startup.
   */
  const searchIndex = (() => {
    const map = new Map();
    const el = document.getElementById('catalogue-index');
    if (el && el.textContent) {
      try {
        const parsed = JSON.parse(el.textContent);
        for (const k of Object.keys(parsed)) map.set(k, parsed[k]);
      } catch {
        /* malformed index: search degrades to the visible card text below */
      }
    }
    return map;
  })();

  /** Fallback haystack built from attributes that are always present. */
  function haystackFor(card) {
    const fromIndex = searchIndex.get(card.dataset.slug);
    if (fromIndex) return fromIndex;
    return [
      card.dataset.name,
      card.dataset.display,
      card.dataset.designer,
      card.dataset.categories,
      card.textContent,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
  }

  // Resolved once per card, not per keystroke.
  const haystacks = new WeakMap();
  for (const card of cards) haystacks.set(card, haystackFor(card));

  /** Every whitespace-separated term must appear somewhere in the haystack. */
  function matches(card, terms) {
    if (!terms.length) return true;
    const hay = haystacks.get(card) || '';
    for (const t of terms) {
      if (!hay.includes(t)) return false;
    }
    return true;
  }

  /* ----------------------------- rendering ---------------------------- */
  let visible = 0;

  function paint() {
    const terms = tokenize(state.q);
    let shown = 0;

    for (const card of cards) {
      const okCat = state.category === 'all' || (card.dataset.categorySlugs || '').split('|').includes(state.category);
      const okDesigner =
        state.designer === 'all' ||
        (card.dataset.designer || '').toLowerCase() === state.designer.toLowerCase() ||
        (card.dataset.designerKey || '') === state.designer.toLowerCase();
      const okStatus = state.status === 'all' || card.dataset.status === state.status;
      const ok = okCat && okDesigner && okStatus && matches(card, terms);

      card.hidden = !ok;
      if (ok) {
        shown += 1;
        card.classList.add('is-revealed');
      }
    }

    visible = shown;
    if (countEl) {
      const active =
        state.q ||
        state.category !== 'all' ||
        state.designer !== 'all' ||
        state.status !== 'all';
      countEl.textContent = active
        ? `${shown} of ${cards.length} aircraft match`
        : `Showing all ${cards.length} aircraft`;
    }
    if (emptyEl) emptyEl.hidden = shown !== 0;
    if (emptyDetail) {
      emptyDetail.textContent = state.q
        ? `Nothing matches “${state.q}”. Try a shorter term, a designer name, or clear the filters.`
        : 'No aircraft match the selected filters. Try clearing one of them.';
    }
    if (clearBtn) clearBtn.hidden = !state.q;
    paintChips();
    if (resetButtons.length) {
      for (const b of resetButtons) {
        b.hidden = !(state.q || state.category !== 'all' || state.designer !== 'all' || state.status !== 'all');
      }
    }
  }

  function paintChips() {
    if (!activeFiltersEl) return;
    const chips = [];
    if (state.q) chips.push({ label: `“${state.q}”`, clear: () => setQuery('') });
    for (const [key, label] of [
      ['category', 'Category'],
      ['designer', 'Designer'],
      ['status', 'Plan'],
    ]) {
      if (state[key] !== 'all') chips.push({ label: `${label}: ${state[key]}`, clear: () => setFilter(key, 'all') });
    }
    activeFiltersEl.innerHTML = '';
    activeFiltersEl.hidden = chips.length === 0;
    for (const c of chips) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip chip--cyan';
      b.innerHTML = `${escapeHtml(c.label)} <span aria-hidden="true">✕</span>`;
      b.setAttribute('aria-label', `Remove filter ${c.label}`);
      b.addEventListener('click', c.clear);
      activeFiltersEl.append(b);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  /* ------------------------------- sort ------------------------------- */
  const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

  function sortCards() {
    const list = cards.slice();
    const mode = state.sort;
    list.sort((a, b) => {
      if (mode === 'designer') {
        const d = collator.compare(a.dataset.designer || 'zzz', b.dataset.designer || 'zzz');
        return d || collator.compare(a.dataset.sort, b.dataset.sort);
      }
      if (mode === 'images') {
        const d = (Number(b.dataset.images) || 0) - (Number(a.dataset.images) || 0);
        return d || collator.compare(a.dataset.sort, b.dataset.sort);
      }
      if (mode === 'newest') {
        const d = (Number(b.dataset.added) || 0) - (Number(a.dataset.added) || 0);
        return d || collator.compare(a.dataset.sort, b.dataset.sort);
      }
      return collator.compare(a.dataset.sort, b.dataset.sort);
    });
    if (grid) {
      const frag = document.createDocumentFragment();
      for (const c of list) frag.append(c);
      grid.append(frag);
    }
  }

  /* ---------------------------- URL syncing ---------------------------- */
  /** Ignore filter values the current dataset does not know about. */
  function readUrl() {
    const p = new URLSearchParams(location.search);
    state.q = p.get('q') || '';

    const cat = (p.get('category') || 'all').toLowerCase();
    state.category = groups.category.buttons.some((b) => b.dataset.filterValue === cat) ? cat : 'all';

    const des = p.get('designer') || 'all';
    const desKey = designerKeyOf(des);
    state.designer = groups.designer.buttons.some((b) => b.dataset.filterValue === des) ||
      groups.designer.buttons.some((b) => designerKeyOf(b.dataset.filterValue) === desKey)
      ? des
      : 'all';

    const st = p.get('status') || 'all';
    state.status = groups.status.buttons.some((b) => b.dataset.filterValue === st) ? st : 'all';

    const sort = p.get('sort') || 'name';
    state.sort = ['name', 'designer', 'images', 'newest'].includes(sort) ? sort : 'name';
  }

  function designerKeyOf(v) {
    return String(v || '').toLowerCase().replace(/[''`]/g, '').replace(/\s+/g, ' ').replace(/\s*\(.*?\)\s*/g, ' ').trim();
  }

  function writeUrl(replace = true) {
    const p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.category !== 'all') p.set('category', state.category);
    if (state.designer !== 'all') p.set('designer', state.designer);
    if (state.status !== 'all') p.set('status', state.status);
    if (state.sort !== 'name') p.set('sort', state.sort);
    const qs = p.toString();
    const url = location.pathname + (qs ? `?${qs}` : '') + location.hash;
    try {
      history[replace ? 'replaceState' : 'pushState']({}, '', url);
    } catch {
      /* file:// or sandboxed context — deep linking is simply unavailable */
    }
  }

  /* ------------------------------ setters ----------------------------- */
  function setQuery(v) {
    state.q = v;
    if (input) input.value = v;
    paint();
    writeUrl();
  }

  function setFilter(group, value) {
    state[group] = value;
    const g = groups[group];
    if (g) {
      for (const b of g.buttons) {
        const on = b.dataset.filterValue === value;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-pressed', String(on));
      }
    }
    paint();
    writeUrl();
  }

  function resetAll() {
    state.q = '';
    state.category = 'all';
    state.designer = 'all';
    state.status = 'all';
    if (input) input.value = '';
    for (const key of Object.keys(groups)) setFilterSilent(key, 'all');
    paint();
    writeUrl();
  }

  function setFilterSilent(group, value) {
    state[group] = value;
    for (const b of groups[group]?.buttons || []) {
      const on = b.dataset.filterValue === value;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }

  /* ------------------------------- wire ------------------------------- */
  for (const [name, g] of Object.entries(groups)) {
    for (const b of g.buttons) {
      b.addEventListener('click', () => {
        const v = b.dataset.filterValue;
        setFilter(name, state[name] === v ? 'all' : v);
      });
    }
  }

  if (input) {
    let t = null;
    input.addEventListener('input', () => {
      state.q = input.value;
      clearTimeout(t);
      t = setTimeout(() => {
        paint();
        writeUrl();
      }, 90);
      // Keep the clear button responsive immediately.
      if (clearBtn) clearBtn.hidden = !input.value;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && input.value) {
        e.preventDefault();
        setQuery('');
      }
    });
  }
  clearBtn?.addEventListener('click', () => {
    setQuery('');
    input?.focus();
  });
  sortSelect?.addEventListener('change', () => {
    state.sort = sortSelect.value;
    sortCards();
    writeUrl();
  });
  for (const b of resetButtons) b.addEventListener('click', resetAll);

  addEventListener('popstate', () => {
    readUrl();
    if (input) input.value = state.q;
    for (const key of Object.keys(groups)) setFilterSilent(key, state[key]);
    if (sortSelect) sortSelect.value = state.sort;
    sortCards();
    paint();
  });

  /* ------------------------------- init ------------------------------- */
  readUrl();
  if (input) input.value = state.q;
  if (sortSelect) sortSelect.value = state.sort;
  for (const key of Object.keys(groups)) setFilterSilent(key, state[key]);
  sortCards();
  paint();

  // "/" focuses search, like a proper catalogue.
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    e.preventDefault();
    input?.focus();
    input?.select();
  });
}
