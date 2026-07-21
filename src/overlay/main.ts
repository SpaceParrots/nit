// SPDX-License-Identifier: AGPL-3.0-or-later
// Overlay entrypoint. Bundled by esbuild (iife) and injected via addInitScript into
// every page of the session. Framework-agnostic vanilla code in an open Shadow DOM;
// serves capture ('review') and replay ('view') with the same UI. The page overlay
// stays minimal (highlight, popover, pins, chip) — lists and controls live in the
// separate nit panel window, which talks to this overlay through the Node bridge.
import css from './overlay.css';
import { anchorTarget } from '../anchor/anchor.js';
import { installPicker } from './picker.js';
import { createPopover } from './popover.js';
import { createPins } from './pins.js';
import { createChip } from './chip.js';
import type { OverlayActions, OverlayState, OverlayUi, PlacedAnnotation } from './state.js';
import type { Annotation, LoadResult, Rect } from '../types.js';

const SYNC_INTERVAL_MS = 2000;

(function boot() {
  if (typeof window === 'undefined' || window !== window.top) return; // top frame only
  if (window.name === 'nit-panel') return; // never inject into our own panel window
  if (window.__NIT_BOOTED__) return;
  window.__NIT_BOOTED__ = true;
  const start = (): void => {
    init().catch((e: unknown) => console.error('[nit] failed to start:', e));
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();

async function init(): Promise<void> {
  const cfg = window.__NIT_CONFIG;
  const loaded = await waitForBridge();
  if (!loaded) {
    console.warn('[nit] bridge unavailable — overlay disabled');
    return;
  }

  const mode = loaded.mode || cfg?.mode || 'review';
  const state: OverlayState = {
    mode,
    author: loaded.author || 'anonymous',
    debug: Boolean(loaded.debug ?? cfg?.debug),
    viewportMode: loaded.viewportMode || 'desktop',
    annotations: loaded.annotations ?? [],
    picking: false,
    hovered: null,
    selected: null,
    // review: show everything by default; replay: filter to general + current viewport
    showAll: mode !== 'view',
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

  // `ui` is assembled below; the actions close over it and only run afterwards.
  let ui: OverlayUi;
  const actions: OverlayActions = {
    refresh: () => refresh(state, ui),
    setPicking: on => ui.picker.setPicking(on),
    hideHighlight: () => ui.picker.highlight.hide(),
    uiChanged: () => {
      ui.chip.update();
      emitUi(state);
    },
    // Arrow on purpose: this is handed to `window.__nitOverlay` detached.
    setUiHidden: (hidden: boolean): void => {
      host.style.visibility = hidden ? 'hidden' : '';
    },
    setShowAll(v: boolean): void {
      state.showAll = v;
      refresh(state, ui);
    },
    onSaved(annotation: Annotation): void {
      state.annotations = [...state.annotations.filter(a => a.id !== annotation.id), annotation];
      refresh(state, ui);
    },
    focusAnnotation(id: string): void {
      try { void window.__nitEvent?.({ type: 'focus', id }); } catch { /* bridge gone */ }
    },
  };

  const pins = createPins(root, state, actions);
  const chip = createChip(root, state, actions);
  const popover = createPopover(root, state, actions);
  const picker = installPicker(state, { host, root, popover }, actions);
  ui = { host, root, pins, chip, popover, picker };

  // Commands from the panel window (and verify screenshots), routed through Node.
  window.__nitOverlay = {
    cmd(c): void {
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

function refresh(state: OverlayState, ui: OverlayUi): void {
  const route = location.pathname;
  const placed: PlacedAnnotation[] = [];
  const unplaced: Annotation[] = [];
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

function emitUi(state: OverlayState): void {
  try {
    void window.__nitEvent?.({
      type: 'ui',
      route: location.pathname,
      picking: state.picking,
      showAll: state.showAll,
      placed: state.placed.map(p => ({ id: p.ann.id, rect: pageRectOf(p.el) })),
      unplaced: state.unplaced.map(a => a.id),
    });
  } catch { /* bridge gone */ }
}

function pageRectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return {
    x: Math.round(r.x + window.scrollX),
    y: Math.round(r.y + window.scrollY),
    w: Math.round(r.width),
    h: Math.round(r.height),
  };
}

function scopeVisible(state: OverlayState, ann: Annotation): boolean {
  if (state.showAll) return true;
  const scope = ann.viewportScope || 'general';
  return scope === 'general' || scope === state.viewportMode;
}

function isRendered(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 || r.height > 0;
}

/** SPA route changes don't reload the page: watch history API + popstate + a slow
 *  interval fallback, and re-anchor pins after the new DOM settles. */
function installRouteWatcher(state: OverlayState, ui: OverlayUi): void {
  let last = location.pathname;
  const onMaybeChange = (): void => {
    if (location.pathname === last) return;
    last = location.pathname;
    setTimeout(() => refresh(state, ui), 300);
    setTimeout(() => refresh(state, ui), 1500);
  };
  for (const m of ['pushState', 'replaceState'] as const) {
    const orig = history[m].bind(history);
    history[m] = (...args: Parameters<History['pushState']>) => {
      orig(...args);
      onMaybeChange();
    };
  }
  window.addEventListener('popstate', onMaybeChange);
  setInterval(onMaybeChange, 1000);

  let t: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener('resize', () => {
    clearTimeout(t);
    t = setTimeout(() => refresh(state, ui), 200);
  });
}

/** Periodic resync with Node: picks up panel-driven changes (deletes, viewport
 *  switches) without the panel needing a direct line into this page. */
function installSync(state: OverlayState, ui: OverlayUi): void {
  setInterval(() => {
    void (async () => {
      let loaded: LoadResult | undefined;
      try { loaded = await window.__nitLoad?.(); } catch { return; }
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
    })();
  }, SYNC_INTERVAL_MS);
}

async function waitForBridge(): Promise<LoadResult | null> {
  for (let i = 0; i < 40; i++) {
    if (typeof window.__nitLoad === 'function') {
      try { return await window.__nitLoad(); } catch { /* not ready yet */ }
    }
    await new Promise(r => setTimeout(r, 250));
  }
  return null;
}
