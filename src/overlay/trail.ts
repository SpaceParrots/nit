// SPDX-License-Identifier: AGPL-3.0-or-later
// The click trail: the last page clicks on the current pathname, recorded so an
// annotation can carry how the reviewer reached the state it describes — and, for
// an annotation inside a dialog, so `nit verify` can click its way back into that
// dialog instead of screenshotting the closed page. The bounded-append and
// reopen-selection logic is pure (unit-tested from Node); installTrail is the
// thin DOM shell around it.
import { buildSelector, cleanText, nearestComponentTag } from '../capture/target.js';
import { detectDialog } from '../capture/context.js';
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
 * click made *outside* any dialog surface, plus everything clicked after it.
 *
 * "Outside any surface" rather than "outside this surface" on purpose — it makes
 * the sequence self-contained. Every later click happened on some overlay, so
 * replaying the run reproduces a dialog opened from a dialog just as well as a
 * plain one, and it never depends on two `detectDialog` calls agreeing on which
 * ancestor is the container.
 *
 * Returns `[]` when every recorded click already happened inside a surface — the
 * dialog was opened before the trail window (or on another route), and there is
 * nothing honest to replay.
 * @param steps the trail's steps, oldest first
 */
export function selectReopenSteps(steps: readonly TrailStep[]): ClickStep[] {
  let opener = -1;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (!steps[i].surface) { opener = i; break; }
  }
  if (opener < 0) return [];
  // Slice forward from the opener, never backward from the end: the opener is
  // the one step the sequence cannot do without.
  return steps.slice(opener, opener + MAX_REOPEN_STEPS).map(toClickStep);
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
    trail = appendStep(trail, describeClick(t), location.pathname);
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
