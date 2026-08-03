// SPDX-License-Identifier: AGPL-3.0-or-later
// The click trail: the last page clicks on the current pathname, recorded so an
// annotation can carry how the reviewer reached the state it describes — and, for
// an annotation inside a dialog, so `nit verify` can click its way back into that
// dialog instead of screenshotting the closed page. The trail keeps a separate
// opener chain rather than selecting one out of the bounded click window; both
// halves are pure (unit-tested from Node), and installTrail is the thin DOM
// shell around them.
import { buildSelector, cleanText, nearestComponentTag } from '../capture/target.js';
import { DATA_DIALOG_TRIGGER, detectDialog } from '../capture/context.js';
import { installSurfaceWatcher } from './surfaces.js';
import { MAX_HISTORY, MAX_REOPEN_STEPS } from '../util/history.js';
import type { ClickStep } from '../types.js';
import type { OverlayState } from './state.js';

/**
 * A recorded click plus the surface it happened on. `surface` is in-memory only
 * — {@link toClickStep} strips it before anything crosses the bridge, so the
 * stored `history` shape is unchanged.
 */
export interface TrailStep extends ClickStep {
  /** selector of the dialog-like container the click happened inside, or null on the plain page */
  surface: string | null;
}

/**
 * A click observed (or declared) to have opened a dialog surface.
 *
 * Whether a click opened something is never inferred from its position in the
 * trail: with a non-modal drawer open, a click on the page behind it looks
 * exactly like an opener, and treating it as one made verify replay an arbitrary
 * page click and then report success.
 */
export interface ChainStep {
  step: TrailStep;
  /** the surface seen to appear, or null when the opener was declared rather than observed */
  surface: Element | null;
  /** the click carried `data-dialog-trigger` — the author's word, taken over our heuristics */
  declared: boolean;
}

/** The recorded clicks plus the pathname they belong to. */
export interface Trail {
  /** pathname the steps were recorded on */
  page: string;
  /** oldest first, at most {@link MAX_HISTORY} entries */
  steps: readonly TrailStep[];
  /**
   * The chain of openings that leads into the surface currently on screen:
   * page → menu → dialog, oldest first.
   *
   * Stored apart from {@link steps} rather than derived from them, because
   * `steps` is a rolling window and the opener is the entry a reviewer is most
   * likely to push out of it — clicking through a five-step wizard modal
   * evicted the click that opened the wizard, and the annotation saved no way
   * back in. Ordinary clicks never touch the chain.
   */
  chain: readonly ChainStep[];
}

/** A fresh trail for a pathname. */
export function emptyTrail(page: string): Trail {
  return { page, steps: [], chain: [] };
}

/**
 * Append a click to the trail, returning a new trail (inputs are never mutated).
 * A different pathname starts a fresh trail — query and hash changes arrive as
 * the same pathname, so they keep the trail alive. Oldest entries fall off
 * beyond {@link MAX_HISTORY}; the chain is dropped outright, since clicks
 * recorded on another page cannot be replayed on this one.
 * @param trail the current trail
 * @param step the click to record
 * @param pathname `location.pathname` at click time
 */
export function appendStep(trail: Trail, step: TrailStep, pathname: string): Trail {
  const same = pathname === trail.page;
  return {
    page: pathname,
    steps: [...(same ? trail.steps : []), step].slice(-MAX_HISTORY),
    chain: same ? trail.chain : [],
  };
}

/**
 * Record that a click opened a surface. A click made on the plain page starts a
 * fresh chain; one made from inside a surface extends it, which is how a
 * page → menu → dialog sequence survives intact.
 *
 * Kept one entry longer than {@link MAX_REOPEN_STEPS} on purpose: {@link
 * chainFor} needs to be able to *see* that the chain overran the cap so it can
 * decline it, and a chain silently trimmed to the cap would instead be replayed
 * with its first click missing.
 * @param surface the surface observed to appear, or null for a declared opener
 * @param declared whether the click carried `data-dialog-trigger`
 */
export function openChain(trail: Trail, step: TrailStep, surface: Element | null, declared: boolean): Trail {
  const base = step.surface ? trail.chain : [];
  const chain = [...base, { step, surface, declared }].slice(-(MAX_REOPEN_STEPS + 1));
  return { ...trail, chain };
}

/**
 * The clicks that re-open `surface`, oldest first — or `[]` when the chain does
 * not lead there.
 *
 * The chain is only offered when its last opening is about the surface being
 * annotated: the same page can hold several dialogs, and replaying the opener of
 * a different one would open the wrong thing and still report success. A
 * declared opener skips that check — an author who wrote `data-dialog-trigger`
 * on the button knows something our heuristics do not, which is the entire
 * reason the attribute exists.
 *
 * Returns `[]` rather than a partial sequence when the chain is longer than
 * {@link MAX_REOPEN_STEPS}: a truncated re-open would leave the dialog
 * half-restored while reporting success, and a wrong re-open is worse than an
 * honest "couldn't get back in".
 * @param chain the trail's chain
 * @param surface the dialog container the annotation was captured in
 */
export function chainFor(chain: readonly ChainStep[], surface: Element): ClickStep[] {
  const last = chain[chain.length - 1];
  if (!last) return [];
  if (!last.declared && !relates(last.surface, surface)) return [];
  if (chain.length > MAX_REOPEN_STEPS) return [];
  return chain.map(c => toClickStep(c.step));
}

/** Whether two elements are the same surface: identical, or one inside the other. */
function relates(observed: Element | null, surface: Element): boolean {
  if (!observed) return false;
  if (observed === surface) return true;
  return contains(observed, surface) || contains(surface, observed);
}

function contains(a: Element, b: Element): boolean {
  return typeof a.contains === 'function' && a.contains(b);
}

/** Drop the in-memory `surface` marker — what crosses the bridge is a plain {@link ClickStep}. */
function toClickStep(s: TrailStep): ClickStep {
  return { selector: s.selector, tag: s.tag, component: s.component, text: s.text, at: s.at };
}

/** What the overlay reads from the live trail (snapshots for the save payload). */
export interface TrailApi {
  /** the current steps, oldest first (already bounded) */
  snapshot(): ClickStep[];
  /**
   * The clicks that re-open the dialog being annotated — see {@link chainFor}.
   * @param surface the dialog container the annotation was captured in
   */
  reopenSteps(surface: Element): ClickStep[];
}

/**
 * Install the trail recorder: a capture-phase click listener that describes each
 * page click with the same primitives annotations use, noting the dialog surface
 * (if any) it happened on, and watching whether a surface opened as a result.
 * Skips picking clicks (they select, they don't interact), clicks inside nit's
 * own UI, and non-Element targets. Review mode only — the caller decides.
 * @param state shared overlay state (read for `picking`)
 * @param host nit's overlay host element (clicks inside it are ignored)
 */
export function installTrail(state: OverlayState, host: HTMLElement): TrailApi {
  let trail = emptyTrail(location.pathname);
  const surfaces = installSurfaceWatcher(document);

  window.addEventListener('click', e => {
    if (state.picking || e.composedPath().includes(host)) return;
    const t = e.composedPath()[0];
    if (!(t instanceof Element)) return;
    const step = describeClick(t);
    trail = appendStep(trail, step, location.pathname);
    // A declared trigger needs no observation at all — which is the point of the
    // attribute. It exists for the surfaces our heuristics cannot see, so making
    // it depend on them would defeat it.
    if (t.closest(`[${DATA_DIALOG_TRIGGER}]`)) {
      trail = openChain(trail, step, null, true);
      return;
    }
    surfaces.watch(surface => { trail = openChain(trail, step, surface, false); });
  }, true);

  /** reset-on-navigate also applies when no click happened since the change */
  const current = (): Trail => {
    if (trail.page !== location.pathname) trail = emptyTrail(location.pathname);
    return trail;
  };

  return {
    snapshot: () => current().steps.map(toClickStep),
    reopenSteps: (surface: Element) => chainFor(current().chain, surface),
  };
}

/** A light element descriptor — enough to find and re-click it, ~200 bytes. */
function describeClick(el: Element): TrailStep {
  // Captured at click time: the dialog may be long gone by the time the reviewer
  // saves, and this is the only moment the ancestry can still be walked.
  const dialog = detectDialog(el);
  return {
    selector: buildSelector(el),
    tag: el.tagName.toLowerCase(),
    component: nearestComponentTag(el),
    text: cleanText(el),
    at: new Date().toISOString(),
    surface: dialog ? buildSelector(dialog.container) : null,
  };
}
