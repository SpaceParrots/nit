// SPDX-License-Identifier: AGPL-3.0-or-later
// The click trail: the last page clicks on the current pathname, recorded so an
// annotation can carry how the reviewer reached the state it describes — and, for
// an annotation inside a dialog, so `nit verify` can click its way back into that
// dialog instead of screenshotting the closed page. The bounded-append and
// reopen-selection logic is pure (unit-tested from Node); installTrail is the
// thin DOM shell around it.
import { buildSelector, cleanText, nearestComponentTag } from '../capture/target.js';
import { detectDialog, openSurfaces } from '../capture/context.js';
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
  /**
   * Whether a dialog surface appeared *because of* this click — observed, not
   * inferred, by comparing the open surfaces before and shortly after it.
   *
   * Position in the trail is not evidence of anything: with a non-modal drawer
   * open, a click on the page behind it also has `surface: null`, and treating
   * that as the opener made verify replay an arbitrary page click and report
   * success.
   */
  opened: boolean;
}

/** The recorded clicks plus the pathname they belong to. */
export interface Trail {
  /** pathname the steps were recorded on */
  page: string;
  /** oldest first, at most {@link MAX_HISTORY} entries */
  steps: readonly TrailStep[];
}

/** A fresh trail for a pathname. */
export function emptyTrail(page: string): Trail {
  return { page, steps: [] };
}

/**
 * Append a click to the trail, returning a new trail (inputs are never mutated).
 * A different pathname starts a fresh trail — query and hash changes arrive as
 * the same pathname, so they keep the trail alive. Oldest entries fall off
 * beyond {@link MAX_HISTORY}.
 * @param trail the current trail
 * @param step the click to record
 * @param pathname `location.pathname` at click time
 */
export function appendStep(trail: Trail, step: TrailStep, pathname: string): Trail {
  const base = pathname === trail.page ? trail.steps : [];
  return { page: pathname, steps: [...base, step].slice(-MAX_HISTORY) };
}

/**
 * The clicks that re-open the dialog the reviewer is currently inside: the last
 * click that was made on the plain page *and* opened a surface, plus every
 * later click that opened one too.
 *
 * Both halves matter. Anchoring on a click that demonstrably opened something
 * is what keeps an unrelated page click — perfectly possible behind a non-modal
 * drawer — from being replayed as if it were the opener. Keeping only
 * surface-opening clicks after it is what keeps ordinary interactions inside
 * the dialog ("Remove avatar") out of a sequence nit replays unattended. What
 * survives is a chain of openings: page → menu → dialog.
 *
 * Returns `[]` rather than a partial sequence when nothing qualifies (the
 * dialog predates the trail window, or opened on hover instead of a click) or
 * when the chain is longer than {@link MAX_REOPEN_STEPS}. A truncated sequence
 * would still report success while leaving the dialog half-restored, and a
 * wrong re-open is worse than an honest "couldn't get back in".
 * @param steps the trail's steps, oldest first
 */
export function selectReopenSteps(steps: readonly TrailStep[]): ClickStep[] {
  let opener = -1;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (!steps[i].surface && steps[i].opened) { opener = i; break; }
  }
  if (opener < 0) return [];
  const chain = [steps[opener], ...steps.slice(opener + 1).filter(s => s.opened)];
  return chain.length > MAX_REOPEN_STEPS ? [] : chain.map(toClickStep);
}

/**
 * Record that a step turned out to open a surface. Returns a new trail — the
 * observation lands one probe *after* the click was appended, and mutating the
 * stored step in place would edit a snapshot an earlier `save` may already hold.
 * @param trail the trail holding the step
 * @param step the step to mark, by identity
 */
export function markOpened(trail: Trail, step: TrailStep): Trail {
  if (!trail.steps.includes(step) || step.opened) return trail;
  return { ...trail, steps: trail.steps.map(s => s === step ? { ...s, opened: true } : s) };
}

/** Drop the in-memory `surface` marker — what crosses the bridge is a plain {@link ClickStep}. */
function toClickStep(s: TrailStep): ClickStep {
  return { selector: s.selector, tag: s.tag, component: s.component, text: s.text, at: s.at };
}

/** What the overlay reads from the live trail (snapshots for the save payload). */
export interface TrailApi {
  /** the current steps, oldest first (already bounded) */
  snapshot(): ClickStep[];
  /** the clicks that re-open the dialog being annotated — see {@link selectReopenSteps} */
  reopenSteps(): ClickStep[];
}

/**
 * Install the trail recorder: a capture-phase click listener that describes each
 * page click with the same primitives annotations use, noting the dialog surface
 * (if any) it happened on. Skips picking clicks (they select, they don't
 * interact), clicks inside nit's own UI, and non-Element targets. Review mode
 * only — the caller decides.
 * @param state shared overlay state (read for `picking`)
 * @param host nit's overlay host element (clicks inside it are ignored)
 */
export function installTrail(state: OverlayState, host: HTMLElement): TrailApi {
  let trail = emptyTrail(location.pathname);

  window.addEventListener('click', e => {
    if (state.picking || e.composedPath().includes(host)) return;
    const t = e.composedPath()[0];
    if (!(t instanceof Element)) return;
    // Capture phase: this runs before the app handles the click, so the surfaces
    // on screen now are the ones the click has not yet changed.
    const before = new Set(openSurfaces(document));
    const step = describeClick(t);
    trail = appendStep(trail, step, location.pathname);
    watchForOpening(before, () => { trail = markOpened(trail, step); });
  }, true);

  /** reset-on-navigate also applies when no click happened since the change */
  const current = (): readonly TrailStep[] => {
    if (trail.page !== location.pathname) trail = emptyTrail(location.pathname);
    return trail.steps;
  };

  return {
    snapshot: () => current().map(toClickStep),
    reopenSteps: () => selectReopenSteps(current()),
  };
}

/**
 * When to look for a surface a click may have opened. Two probes rather than
 * one: a dialog often mounts synchronously but animates in from zero size, and
 * a framework overlay (Angular CDK) attaches a tick later still. Both are cheap
 * and only ever run after a real page click.
 */
const OPEN_PROBES_MS = [150, 600];

/**
 * Call `onOpened` once if a dialog surface shows up that was not open before.
 * Silent when nothing appears, which is the normal case for almost every click.
 * @param before the surfaces open at click time
 * @param onOpened invoked at most once, on the first probe that sees a new surface
 */
function watchForOpening(before: ReadonlySet<Element>, onOpened: () => void): void {
  let done = false;
  for (const delay of OPEN_PROBES_MS) {
    setTimeout(() => {
      if (done) return;
      if (!openSurfaces(document).some(el => !before.has(el))) return;
      done = true;
      onOpened();
    }, delay);
  }
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
    // Set later by watchForOpening, once there is evidence rather than a guess.
    opened: false,
  };
}
