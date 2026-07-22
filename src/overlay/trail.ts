// SPDX-License-Identifier: AGPL-3.0-or-later
// The click trail: the last page clicks on the current pathname, recorded so an
// annotation can carry how the reviewer reached the state it describes. The
// bounded-append logic is pure (unit-tested from Node); installTrail is the thin
// DOM shell around it.
import { buildSelector, cleanText, nearestComponentTag } from '../capture/target.js';
import { MAX_HISTORY } from '../util/history.js';
import type { ClickStep } from '../types.js';
import type { OverlayState } from './state.js';

/** The recorded clicks plus the pathname they belong to. */
export interface Trail {
  /** pathname the steps were recorded on */
  page: string;
  /** oldest first, at most {@link MAX_HISTORY} entries */
  steps: readonly ClickStep[];
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
export function appendStep(trail: Trail, step: ClickStep, pathname: string): Trail {
  const base = pathname === trail.page ? trail.steps : [];
  return { page: pathname, steps: [...base, step].slice(-MAX_HISTORY) };
}

/** What the overlay reads from the live trail (snapshot for the save payload). */
export interface TrailApi {
  /** the current steps, oldest first (already bounded) */
  snapshot(): ClickStep[];
}

/**
 * Install the trail recorder: a capture-phase click listener that describes each
 * page click with the same primitives annotations use. Skips picking clicks
 * (they select, they don't interact), clicks inside nit's own UI, and non-Element
 * targets. Review mode only — the caller decides.
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

  return {
    snapshot: () => {
      // reset-on-navigate also applies when no click happened since the change
      if (trail.page !== location.pathname) trail = emptyTrail(location.pathname);
      return [...trail.steps];
    },
  };
}

/** A light element descriptor — enough to find and re-click it, ~200 bytes. */
function describeClick(el: Element): ClickStep {
  return {
    selector: buildSelector(el),
    tag: el.tagName.toLowerCase(),
    component: nearestComponentTag(el),
    text: cleanText(el),
    at: new Date().toISOString(),
  };
}
