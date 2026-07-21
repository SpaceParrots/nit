// Overlay entrypoint. Bundled by esbuild (iife) and injected via addInitScript into
// every page of the session. Framework-agnostic vanilla JS in an open Shadow DOM;
// serves capture ('review') and replay ('view') with the same UI.
import css from './overlay.css';
import { anchorTarget } from '../anchor/anchor.js';
import { installPicker } from './picker.js';
import { createPopover } from './popover.js';
import { createSidebar } from './sidebar.js';
import { createPins } from './pins.js';

(function boot() {
  if (typeof window === 'undefined' || window !== window.top) return; // top frame only
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
    setUiHidden(hidden) {
      host.style.visibility = hidden ? 'hidden' : '';
    },
    async setViewport(mode) {
      try {
        const res = await window.__nitSetViewport(mode);
        if (res && res.ok) {
          state.viewportMode = res.mode;
          refresh(state, ui);
        }
      } catch (e) {
        console.warn('[nit] viewport switch failed:', e);
      }
    },
    setShowAll(v) {
      state.showAll = v;
      refresh(state, ui);
    },
    async del(id) {
      try {
        const res = await window.__nitDelete(id);
        if (res && res.ok) {
          state.annotations = state.annotations.filter(a => a.id !== id);
          refresh(state, ui);
        }
      } catch (e) {
        console.warn('[nit] delete failed:', e);
      }
    },
    async finish() {
      try { await window.__nitFinish(); } catch { /* browser is closing */ }
    },
    onSaved(annotation) {
      state.annotations = [...state.annotations.filter(a => a.id !== annotation.id), annotation];
      refresh(state, ui);
    },
    focusAnnotation(id) {
      ui.sidebar.focus(id);
    },
  };

  ui.pins = createPins(root, state, actions);
  ui.sidebar = createSidebar(root, state, actions);
  ui.popover = createPopover(root, state, actions);
  ui.picker = installPicker(state, ui, actions);

  installRouteWatcher(state, ui);
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
  ui.sidebar.render();
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

async function waitForBridge() {
  for (let i = 0; i < 40; i++) {
    if (typeof window.__nitLoad === 'function') {
      try { return await window.__nitLoad(); } catch { /* not ready yet */ }
    }
    await new Promise(r => setTimeout(r, 250));
  }
  return null;
}
