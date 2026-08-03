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
  /**
   * The surface seen to appear, or null when nothing was observed — which is
   * the normal state of a declared opener whose dialog the watcher cannot see,
   * and the whole reason the attribute exists.
   */
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
 *
 * A surface *closing* does not invalidate the chain — only a click on the plain
 * page replaces it and only a pathname change drops it. So a stale prefix can
 * be extended: close the dialog, then open another one from inside a surface
 * that is still up, and the older opener stays in front of the new one. That is
 * deliberate (the same behaviour the design's event table lists), and
 * {@link chainFor}'s check on the last opening is what keeps a stale chain from
 * being offered for a dialog it does not lead to.
 * @param trail the current trail
 * @param step the click being recorded as an opener
 * @param surface the surface observed to appear, or null for a declared opener
 * @param declared whether the click carried `data-dialog-trigger`
 */
export function openChain(trail: Trail, step: TrailStep, surface: Element | null, declared: boolean): Trail {
  const base = step.surface ? trail.chain : [];
  const chain = [...base, { step, surface, declared }].slice(-(MAX_REOPEN_STEPS + 1));
  return { ...trail, chain };
}

/**
 * Fold an observed opening into the trail — the whole body of the surface
 * watcher's callback, kept pure so it can be tested without a page.
 *
 * Two things it must get right, both of which cost a wrongly replayed click:
 *
 * - **The page may have moved on.** The callback runs up to a window after the
 *   click, and a click that navigated an SPA has already had the chain dropped
 *   by {@link appendStep}, on the grounds that clicks recorded on another page
 *   cannot be replayed on this one. Repopulating it here would put back exactly
 *   such a step — route-driven modals being the common way to hit it.
 * - **A declared opener that *was* observed gets verified.** `data-dialog-trigger`
 *   asserts "this click opens *a* dialog", not "*the* dialog you are
 *   annotating", so when the watcher does see a surface, that observation is
 *   recorded on the entry the click already created and {@link chainFor} holds
 *   it to the usual relation check. Blind trust is kept only for the case the
 *   attribute exists for: nothing observed at all.
 * @param trail the current trail
 * @param step the click the watch was registered for
 * @param surface the surface observed to appear
 * @param pathname `location.pathname` as it was at click time
 */
export function observeOpen(trail: Trail, step: TrailStep, surface: Element, pathname: string): Trail {
  if (trail.page !== pathname) return trail;
  const last = trail.chain[trail.chain.length - 1];
  if (last?.step === step && last.declared) {
    return { ...trail, chain: [...trail.chain.slice(0, -1), { ...last, surface }] };
  }
  return openChain(trail, step, surface, false);
}

/**
 * The clicks that re-open `surface`, oldest first — or `[]` when the chain does
 * not lead there.
 *
 * The chain is only offered when its last opening is about the surface being
 * annotated: the same page can hold several dialogs, and replaying the opener of
 * a different one would open the wrong thing and still report success.
 *
 * A declared opener is trusted **only when nothing was observed**.
 * `data-dialog-trigger` asserts that the click opens *a* dialog, not that it
 * opens *the* one being annotated — click a declared trigger, close what it
 * opened, then reach a different dialog by a route the watcher cannot see, and
 * blind trust would hand back the wrong opener for verify to replay and call a
 * success. So when the watcher did see a surface for that click (recorded by
 * {@link observeOpen}), the same relation check applies to it; the attribute
 * keeps its blind path exactly where it was meant to have one — the surfaces
 * our heuristics cannot see at all.
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
  const leadsHere = last.surface ? relates(last.surface, surface) : last.declared;
  if (!leadsHere) return [];
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
    // Read once: the click may navigate, and everything below has to agree on
    // which page it was made on — including the watch callback, which runs a
    // window later and must not write a chain onto a page the trail has since
    // been reset for (see observeOpen).
    const page = location.pathname;
    trail = appendStep(trail, step, page);
    // A declared trigger is recorded as the opener immediately, with no
    // observation required — the attribute exists for surfaces the heuristics
    // cannot see, so making it *depend* on them would defeat it. Cancel first:
    // the author declared this click the opener, so nothing still pending from
    // an earlier click may go on to claim the surface it is about to open. The
    // watch registered below would supersede that too, but tying the drop to
    // the moment the declaration is written keeps the two independent.
    if (t.closest(`[${DATA_DIALOG_TRIGGER}]`)) {
      surfaces.cancel();
      trail = openChain(trail, step, null, true);
    }
    // Registered either way. For a declared trigger this only *verifies*: if a
    // surface does show up, observeOpen records it on the entry above so the
    // chain can be checked against the dialog actually being annotated instead
    // of being trusted on the attribute's word alone.
    surfaces.watch(surface => { trail = observeOpen(trail, step, surface, page); });
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
