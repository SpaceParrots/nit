// SPDX-License-Identifier: AGPL-3.0-or-later
// Overlay entrypoint. Bundled by esbuild (iife) and injected via addInitScript into
// every page of the session. Framework-agnostic vanilla code in an open Shadow DOM;
// serves capture ('review') and replay ('view') with the same UI. The page overlay
// stays minimal (highlight, popover, pins, chip) — lists and controls live in the
// separate nit panel window, which talks to this overlay through the Node bridge.
import css from './overlay.css';
import { anchorTargetDetailed, isElementRendered } from '../anchor/anchor.js';
import { installPicker } from './picker.js';
import { installTrail } from './trail.js';
import { createPopover } from './popover.js';
import { createPins } from './pins.js';
import { createChip } from './chip.js';
import { createHiddenPill } from './hidden-pill.js';
import { currentRoute, routePath } from '../util/route.js';
import type { ApproxAnnotation, HiddenAnnotation, OverlayActions, OverlayState, OverlayUi, PlacedAnnotation } from './state.js';
import type { Annotation, CaptureContext, LoadResult, Rect } from '../types.js';

const SYNC_INTERVAL_MS = 2000;
const ANCHOR_RETRY_MS = 1000;
const ANCHOR_RETRY_MAX = 10;
const MUTATION_DEBOUNCE_MS = 250;
const MUTATION_REFRESH_FLOOR_MS = 500;

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
    // filter to general + current viewport by default; the show-all toggle overrides
    showAll: false,
    placed: [],
    unplaced: [],
    approx: [],
    hidden: [],
  };

  const host = document.createElement('div');
  host.id = 'nit-root';
  host.style.cssText = 'all:initial; position:absolute; top:0; left:0; width:0; height:0; z-index:2147483646;';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = css;
  root.append(style);
  document.documentElement.append(host);

  // Bottom-left dock: chip + hidden pill side by side without coordinate math.
  const dock = document.createElement('div');
  dock.className = 'nit-dock';
  root.append(dock);

  // Click trail: capture mode only — replay/verify sessions record nothing.
  const trail = mode === 'review' ? installTrail(state, host) : null;

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
    historySnapshot: () => trail ? trail.snapshot() : [],
  };

  const pins = createPins(root, state, actions);
  const chip = createChip(dock, state, actions);
  const hiddenPill = createHiddenPill(dock, state, actions);
  const popover = createPopover(root, state, actions);
  const picker = installPicker(state, { host, root, popover }, actions);
  ui = { host, root, pins, chip, hiddenPill, popover, picker };

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

  // Sites render on their own schedule in every mode — a review-mode route
  // change needs the retry cycle just as much as replay (pins used to vanish
  // on slow SPA routes during capture). Capture-time picks still anchor
  // instantly; retries only run while something is unplaced.
  const retryAnchors = installAnchorRetries(state, ui);
  installRouteWatcher(state, ui, retryAnchors);
  installSync(state, ui, retryAnchors);
  installMutationWatcher(state, ui);
  refresh(state, ui);
  retryAnchors();
  if (state.debug) console.log(`[nit] overlay ready (${state.mode}, ${state.viewportMode})`);
}

function refresh(state: OverlayState, ui: OverlayUi): void {
  const route = location.pathname;
  // matching ignores query/hash: an annotation captured at /p?id=5 still pins on /p
  const placed: PlacedAnnotation[] = [];
  const approx: ApproxAnnotation[] = [];
  const hidden: HiddenAnnotation[] = [];
  for (const ann of state.annotations) {
    if (routePath(ann.route) !== route) continue;
    if (!scopeVisible(state, ann)) {
      hidden.push({ ann, reason: 'viewport' });
      continue;
    }
    const found = anchorTargetDetailed(ann.target, document);
    if (found?.rendered) {
      placed.push({ ann, el: found.el });
      continue;
    }
    if (ann.context?.kind === 'dialog' && !dialogOpen(ann.context)) {
      hidden.push({ ann, reason: 'dialog', label: ann.context.label });
      continue;
    }
    const rect = ann.target?.rect;
    // Last resort: the recorded position — only meaningful outside dialogs and
    // at the viewport the annotation was captured at.
    if (ann.context?.kind !== 'dialog' && ann.viewport?.mode === state.viewportMode && rect && (rect.w > 0 || rect.h > 0)) {
      approx.push({ ann, rect });
    } else {
      hidden.push({ ann, reason: 'not-found' });
    }
  }
  state.placed = placed;
  state.approx = approx;
  state.hidden = hidden;
  // `unplaced` keeps its bridge meaning "on this route but not anchored": approx
  // ids are in (verify's fallback capture relies on it), viewport-filtered are out.
  state.unplaced = [...approx.map(a => a.ann), ...hidden.filter(h => h.reason !== 'viewport').map(h => h.ann)];
  ui.pins.render();
  ui.chip.update();
  ui.hiddenPill.update();
  emitUi(state);
}

/** Whether the dialog an annotation was captured in is currently open. */
function dialogOpen(ctx: CaptureContext): boolean {
  if (!ctx.selector) return false;
  try {
    const el = document.querySelector(ctx.selector);
    return Boolean(el && isElementRendered(el));
  } catch {
    return false;
  }
}

function emitUi(state: OverlayState): void {
  try {
    void window.__nitEvent?.({
      type: 'ui',
      route: currentRoute(location),
      picking: state.picking,
      showAll: state.showAll,
      placed: state.placed.map(p => ({ id: p.ann.id, rect: pageRectOf(p.el) })),
      unplaced: state.unplaced.map(a => a.id),
      approx: state.approx.map(a => ({ id: a.ann.id, rect: a.rect })),
      hidden: state.hidden.map(h => ({ id: h.ann.id, reason: h.reason, ...(h.label ? { label: h.label } : {}) })),
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

/** SPAs render after DOMContentLoaded, so the first refresh after a route change
 *  often anchors nothing. Returns a restart function that begins a retry cycle:
 *  re-run `refresh` every second (up to {@link ANCHOR_RETRY_MAX} attempts) while
 *  annotations for the current route remain unplaced. Each refresh emits a fresh
 *  `ui` event, which drives both the panel and the verify after-shot capture —
 *  including its per-viewport fallback grace-period clock, which is why viewport
 *  switches restart the cycle too (see installSync / the resize handler): the
 *  clock at the new viewport starves without fresh events. Restarting clears
 *  any pending cycle first, so no trigger can ever stack timers. */
function installAnchorRetries(state: OverlayState, ui: OverlayUi): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  const tick = (): void => {
    timer = undefined;
    refresh(state, ui);
    attempts += 1;
    if (attempts >= ANCHOR_RETRY_MAX || state.unplaced.length === 0) return;
    timer = setTimeout(tick, ANCHOR_RETRY_MS);
  };
  return (): void => {
    clearTimeout(timer);
    attempts = 0;
    timer = setTimeout(tick, ANCHOR_RETRY_MS);
  };
}

/** SPA route changes don't reload the page: watch history API + popstate + a slow
 *  interval fallback, and re-anchor pins after the new DOM settles. A route
 *  change — and, since a viewport switch lands in the page as a resize, a
 *  debounced resize — also restarts the anchor retry cycle, which now runs in
 *  every mode. */
function installRouteWatcher(state: OverlayState, ui: OverlayUi, restartAnchors: () => void): void {
  let last = currentRoute(location);
  const onMaybeChange = (): void => {
    if (currentRoute(location) === last) return;
    last = currentRoute(location);
    setTimeout(() => refresh(state, ui), 300);
    setTimeout(() => refresh(state, ui), 1500);
    restartAnchors();
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
    t = setTimeout(() => {
      refresh(state, ui);
      // A resize re-lays-out the page just like a route change: the retry cycle
      // must restart or the per-viewport after-shot capture starves for events.
      restartAnchors();
    }, 200);
  });
}

/** Periodic resync with Node: picks up panel-driven changes (deletes, viewport
 *  switches) without the panel needing a direct line into this page. A viewport
 *  switch re-lays-out the page, so beyond the immediate refresh it restarts the
 *  anchor retry cycle, which now runs in every mode — the viewport-keyed
 *  after-shot capture needs a stream of `ui` events at the new viewport, not a
 *  single one. */
function installSync(state: OverlayState, ui: OverlayUi, restartAnchors: () => void): void {
  setInterval(() => {
    void (async () => {
      let loaded: LoadResult | undefined;
      try { loaded = await window.__nitLoad?.(); } catch { return; }
      if (!loaded) return;
      if (loaded.viewportMode !== state.viewportMode) {
        state.viewportMode = loaded.viewportMode;
        ui.popover.close(); // its scope options are stale for the new mode
        refresh(state, ui);
        restartAnchors();
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

/** SPA re-renders replace DOM nodes without any route change: pins would keep
 *  tracking detached elements and unplaced annotations would wait a full retry
 *  tick to appear. Watch the page body (the overlay host lives on
 *  documentElement and its UI in a shadow root, so our own mutations are never
 *  seen) and refresh — debounced, with a floor between refreshes so animated
 *  pages can't thrash — whenever something is unplaced or a tracked element got
 *  detached. */
function installMutationWatcher(state: OverlayState, ui: OverlayUi): void {
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let lastRefresh = 0;
  const needsRefresh = (): boolean =>
    state.unplaced.length > 0 || state.placed.some(p => !p.el.isConnected);
  const tick = (): void => {
    debounce = undefined;
    if (!needsRefresh()) return;
    const since = Date.now() - lastRefresh;
    if (since < MUTATION_REFRESH_FLOOR_MS) {
      debounce = setTimeout(tick, MUTATION_REFRESH_FLOOR_MS - since);
      return;
    }
    lastRefresh = Date.now();
    refresh(state, ui);
  };
  const observe = (): void => {
    if (!document.body) return;
    new MutationObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(tick, MUTATION_DEBOUNCE_MS);
    }).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'open'],
    });
  };
  observe();
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
