// Overlay entrypoint. Bundled by esbuild (iife) and injected via addInitScript into
// every page of the session. Framework-agnostic vanilla JS in an open Shadow DOM;
// serves capture ('review') and replay ('view') with the same UI. The page overlay
// stays minimal (highlight, popover, pins, chip) — lists and controls live in the
// separate nit panel window, which talks to this overlay through the Node bridge.
import css from './overlay.css';
import { anchorTarget } from '../anchor/anchor.js';
import { installPicker } from './picker.js';
import { createPopover } from './popover.js';
import { createPins } from './pins.js';
import { createChip } from './chip.js';

const SYNC_INTERVAL_MS = 2000;

(function boot() {
  if (typeof window === 'undefined' || window !== window.top) return; // top frame only
  if (window.name === 'nit-panel') return; // never inject into our own panel window
  if (window.__NIT_BOOTED__) return;
  window.__NIT_BOOTED__ = true;
  const start = () => init().catch(e => console.error('[nit] failed to start:', e));
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();

async function init() {
  const cfg = window.__NIT_CONFIG || {};
  const loaded = await waitForBridge();
  if (!loaded) {
    console.warn('[nit] bridge unavailable — overlay disabled');
    return;
  }

  const state = {
    mode: loaded.mode || cfg.mode || 'review',
    author: loaded.author || 'anonymous',
    debug: Boolean(loaded.debug ?? cfg.debug),
    viewportMode: loaded.viewportMode || 'desktop',
    annotations: loaded.annotations || [],
    picking: false,
    hovered: null,
    selected: null,
    // review: show everything by default; replay: filter to general + current viewport
    showAll: (loaded.mode || cfg.mode) !== 'view',
    placed: [],
    unplaced: [],
  };

  const host = document.createElement('div');
  host.id = 'nit-root';
  host.style.cssText = 'all:initial; position:absolute; top:0; left:0; width:0; height:0; z-index:2147483646;';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = css;
  root.append(style);
  document.documentElement.append(host);

  const ui = { host, root };
  const actions = {
    refresh: () => refresh(state, ui),
    setPicking: on => ui.picker.setPicking(on),
    hideHighlight: () => ui.picker.highlight.hide(),
    uiChanged: () => {
      ui.chip.update();
      emitUi(state);
    },
    setUiHidden(hidden) {
      host.style.visibility = hidden ? 'hidden' : '';
    },
    setShowAll(v) {
      state.showAll = v;
      refresh(state, ui);
    },
    onSaved(annotation) {
      state.annotations = [...state.annotations.filter(a => a.id !== annotation.id), annotation];
      refresh(state, ui);
    },
    focusAnnotation(id) {
      try { window.__nitEvent?.({ type: 'focus', id }); } catch { /* bridge gone */ }
    },
  };

  ui.pins = createPins(root, state, actions);
  ui.chip = createChip(root, state, actions);
  ui.popover = createPopover(root, state, actions);
  ui.picker = installPicker(state, ui, actions);

  // Commands from the panel window (and verify screenshots), routed through Node.
  window.__nitOverlay = {
    cmd(c) {
      if (!c || typeof c !== 'object') return;
      if (c.cmd === 'togglePick' && state.mode === 'review') actions.setPicking(!state.picking);
      else if (c.cmd === 'toggleShowAll') actions.setShowAll(!state.showAll);
      else if (c.cmd === 'focus') ui.pins.focus(c.id);
    },
    setUiHidden: actions.setUiHidden,
  };

  installRouteWatcher(state, ui);
  installSync(state, ui);
  refresh(state, ui);
  if (state.debug) console.log(`[nit] overlay ready (${state.mode}, ${state.viewportMode})`);
}

function refresh(state, ui) {
  const route = location.pathname;
  const placed = [];
  const unplaced = [];
  for (const ann of state.annotations) {
    if ((ann.route || '/') !== route) continue;
    if (!scopeVisible(state, ann)) continue;
    const el = anchorTarget(ann.target, document);
    if (el && isRendered(el)) placed.push({ ann, el });
    else unplaced.push(ann);
  }
  state.placed = placed;
  state.unplaced = unplaced;
  ui.pins.render();
  ui.chip.update();
  emitUi(state);
}

function emitUi(state) {
  try {
    window.__nitEvent?.({
      type: 'ui',
      route: location.pathname,
      picking: state.picking,
      showAll: state.showAll,
      placed: state.placed.map(p => ({ id: p.ann.id, rect: pageRectOf(p.el) })),
      unplaced: state.unplaced.map(a => a.id),
    });
  } catch { /* bridge gone */ }
}

function pageRectOf(el) {
  const r = el.getBoundingClientRect();
  return {
    x: Math.round(r.x + window.scrollX),
    y: Math.round(r.y + window.scrollY),
    w: Math.round(r.width),
    h: Math.round(r.height),
  };
}

function scopeVisible(state, ann) {
  if (state.showAll) return true;
  const scope = ann.viewportScope || 'general';
  return scope === 'general' || scope === state.viewportMode;
}

function isRendered(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 || r.height > 0;
}

/** SPA route changes don't reload the page: watch history API + popstate + a slow
 *  interval fallback, and re-anchor pins after the new DOM settles. */
function installRouteWatcher(state, ui) {
  let last = location.pathname;
  const onMaybeChange = () => {
    if (location.pathname === last) return;
    last = location.pathname;
    setTimeout(() => refresh(state, ui), 300);
    setTimeout(() => refresh(state, ui), 1500);
  };
  for (const m of ['pushState', 'replaceState']) {
    const orig = history[m].bind(history);
    history[m] = (...args) => {
      const r = orig(...args);
      onMaybeChange();
      return r;
    };
  }
  window.addEventListener('popstate', onMaybeChange);
  setInterval(onMaybeChange, 1000);

  let t = null;
  window.addEventListener('resize', () => {
    clearTimeout(t);
    t = setTimeout(() => refresh(state, ui), 200);
  });
}

/** Periodic resync with Node: picks up panel-driven changes (deletes, viewport
 *  switches) without the panel needing a direct line into this page. */
function installSync(state, ui) {
  setInterval(async () => {
    let loaded;
    try { loaded = await window.__nitLoad(); } catch { return; }
    if (!loaded) return;
    if (loaded.viewportMode !== state.viewportMode) {
      state.viewportMode = loaded.viewportMode;
      ui.popover.close(); // its scope options are stale for the new mode
      refresh(state, ui);
      return;
    }
    const incoming = JSON.stringify(loaded.annotations);
    if (incoming !== JSON.stringify(state.annotations)) {
      state.annotations = loaded.annotations;
      refresh(state, ui);
    }
  }, SYNC_INTERVAL_MS);
}

async function waitForBridge() {
  for (let i = 0; i < 40; i++) {
    if (typeof window.__nitLoad === 'function') {
      try { return await window.__nitLoad(); } catch { /* not ready yet */ }
    }
    await new Promise(r => setTimeout(r, 250));
  }
  return null;
}
