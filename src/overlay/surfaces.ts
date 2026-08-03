// SPDX-License-Identifier: AGPL-3.0-or-later
// Watches the page for dialog surfaces becoming visible, so the click trail can
// tell which click *opened* a dialog rather than guessing from position in the
// trail. Observed, not polled: the surface it most needs to catch is the
// permanently-mounted one that a framework animation merely shows and hides, so
// its element identity never changes and no before/after set diff would ever see
// it appear.
//
// Runs inside the inspected page (bundled into the overlay) on every mutation
// the site makes, so cost discipline is the whole design: a cheap CSS hint
// narrows the mutation stream before the predicate's style reads ever run, and
// the visible set holds a handful of elements at most.
import { DATA_DIALOG, SURFACE_HINT_SELECTOR, isDialogSurface, isRendered, openSurfaces } from '../capture/context.js';

/**
 * Reconcile `visible` against the world and return the surfaces that have just
 * become visible. Mutates `visible` in place — it is the caller's long-lived
 * record of what is on screen, not a value.
 *
 * Pruning runs first and runs unconditionally, including on the idle path where
 * `candidates` is empty. That is not an optimisation detail but a correctness
 * one: if a closed surface were left in the set, the *same* element being shown
 * again later would read as "already open" and its opening would never be
 * reported — which is exactly the always-mounted drawer this module exists for.
 * @param candidates elements worth testing (already narrowed by the CSS hint)
 * @param visible the surfaces believed to be on screen, updated in place
 * @returns the newly opened surfaces, in candidate order
 */
export function refreshVisible(candidates: Iterable<Element>, visible: Set<Element>): Element[] {
  for (const el of [...visible]) {
    if (!el.isConnected || !isRendered(el) || !isDialogSurface(el)) visible.delete(el);
  }
  const opened: Element[] = [];
  for (const el of candidates) {
    if (visible.has(el)) continue;
    if (!isDialogSurface(el) || !isRendered(el)) continue;
    visible.add(el);
    opened.push(el);
  }
  return opened;
}

/**
 * How long after a click a surface may take to show up and still be attributed
 * to it. Replaces the two fixed probes (150 ms / 600 ms) the trail used to run:
 * an event-driven watch costs nothing while nothing happens, so the window can
 * be generous enough for a modal that mounts behind a lazy chunk or a data
 * fetch — the old 600 ms ceiling silently lost those.
 */
export const OPEN_WINDOW_MS = 1500;

/**
 * Attributes worth re-testing an element after. `class` and `style` carry the
 * common show/hide (a framework animation writes inline styles; a utility-CSS
 * app toggles a class), the rest are the declared ways an element becomes a
 * dialog after it is already in the tree.
 */
const WATCHED_ATTRS = ['class', 'style', 'hidden', 'open', 'role', 'aria-modal', 'popover', DATA_DIALOG];

/** Watches for dialog surfaces appearing; one instance per page. */
export interface SurfaceWatcher {
  /**
   * Call `onOpen` with the first surface to become visible within
   * {@link OPEN_WINDOW_MS}, at most once. Silent when nothing opens, which is
   * the normal case for almost every click.
   */
  watch(onOpen: (surface: Element) => void): void;
}

/**
 * Install the page's surface watcher: one MutationObserver, one small set of
 * the surfaces currently on screen, seeded from what is already open at install.
 * @param doc the document to watch
 */
export function installSurfaceWatcher(doc: Document): SurfaceWatcher {
  const visible = new Set<Element>(openSurfaces(doc));
  const listeners = new Set<(surface: Element) => void>();

  const observer = new MutationObserver(records => {
    // With nobody watching, only the pruning half runs. Skipping the whole batch
    // would let the set go stale, and a stale entry swallows the next opening of
    // that same element (see refreshVisible).
    const opened = refreshVisible(listeners.size ? candidatesOf(records, doc) : [], visible);
    if (!opened.length) return;
    // Credit only the newest live listener, not all of them. Two clicks can
    // both be waiting when one dialog opens — a click a second before the
    // opener is common, while a dialog is almost always done appearing well
    // before the reviewer's *next* click — so the newest `watch()` call is
    // almost always the real opener and the rest would be misattributed if
    // notified. `Set` iterates in insertion order, so the last entry is the
    // newest; the older ones are cleared unfired rather than left to match a
    // later, unrelated opening.
    const registered = [...listeners];
    const newest = registered[registered.length - 1];
    listeners.clear();
    newest(opened[0]);
  });
  observer.observe(doc.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: WATCHED_ATTRS,
  });

  return {
    watch(onOpen) {
      listeners.add(onOpen);
      setTimeout(() => listeners.delete(onOpen), OPEN_WINDOW_MS);
    },
  };
}

/**
 * The elements in a mutation batch worth running the predicate on. Attribute
 * records name their element directly; childList records can carry an entire
 * routed page, so the added node is scanned with the CSS hint rather than walked.
 */
function candidatesOf(records: MutationRecord[], doc: Document): Set<Element> {
  const out = new Set<Element>();
  for (const record of records) {
    if (record.type === 'attributes') {
      addHinted(out, record.target, doc);
      continue;
    }
    for (const node of record.addedNodes) addHinted(out, node, doc);
  }
  return out;
}

/**
 * Add `node` and any hinted descendants to `out`. A direct child of `<body>` is
 * always worth testing whatever it looks like: that is where portal-mounted
 * modals land, and they are frequently a bare `<div>` with a generated class.
 */
function addHinted(out: Set<Element>, node: Node, doc: Document): void {
  if (node.nodeType !== 1) return;
  const el = node as Element;
  try {
    if (el.parentElement === doc.body || el.matches(SURFACE_HINT_SELECTOR)) out.add(el);
    for (const n of el.querySelectorAll(SURFACE_HINT_SELECTOR)) out.add(n);
  } catch { /* exotic or detached node — nothing to hint on */ }
}
