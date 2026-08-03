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
import { isDialogSurface, isRendered } from '../capture/context.js';

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
