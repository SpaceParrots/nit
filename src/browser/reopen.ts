// SPDX-License-Identifier: AGPL-3.0-or-later
// Re-open the dialog an annotation was captured in, by replaying the clicks the
// reviewer made to get there (`context.reopen`, recorded by the overlay's click
// trail — see overlay/trail.ts).
//
// Why this exists: a fix inside a modal used to be unverifiable. `nit verify`
// navigates to the route, the dialog is closed, the element cannot be
// re-anchored, and after the grace period `captureAfterShots` banks a crop of
// the *originally recorded region* on a page that no longer has a dialog on it
// — a blank before/after pair the reviewer cannot rule on.
//
// This is the one place nit clicks a page on its own, and the selectors come out
// of a shared, hand-editable, agent-written file. The blast radius is kept small
// deliberately: at most MAX_REOPEN_STEPS steps (enforced on save *and* on load,
// see store.ts's sanitizeContext), short per-step timeouts, no navigation waits,
// exactly one automatic attempt per annotation and viewport, and only ever on
// the session's own site page.
import { wantedAfterModes } from '../util/after-shots.js';
import { errorMessage } from '../util/error.js';
import type { Page } from 'playwright';
import type { NitSession, SessionUiState } from './session.js';
import type { Annotation, ClickStep, ViewportMode } from '../types.js';

/** How long one recorded step may take to become clickable before the attempt is given up. */
export const REOPEN_STEP_TIMEOUT_MS = 2000;

/** Settle time after each click — enough for an open animation to put the surface on screen. */
const STEP_SETTLE_MS = 400;

/**
 * The recorded clicks that re-open an annotation's dialog, or `[]` when it has
 * none (a plain-page annotation, a review captured before this existed, or a
 * dialog the reviewer opened outside the recorded trail).
 */
export function reopenStepsOf(ann: Annotation | undefined): readonly ClickStep[] {
  return ann?.context?.kind === 'dialog' && Array.isArray(ann.context.reopen) ? ann.context.reopen : [];
}

/**
 * Replay an annotation's recorded re-open clicks on `page`, oldest first.
 *
 * Each step is clicked through `locator(...).first()` so Playwright's
 * actionability wait does the work (scroll into view, wait for it to stop
 * moving) — the same reason the picker records selectors rather than
 * coordinates. A step that never becomes clickable aborts the run: the later
 * steps were recorded *inside* the surface this one was supposed to open, so
 * clicking them against the closed page would hit whatever now sits at that
 * selector.
 *
 * Never throws — a failed re-open is an ordinary outcome, and the caller falls
 * back to the honest "couldn't re-find the element" path.
 * @returns how many steps landed, and whether the whole sequence did
 */
export async function replayReopen(
  session: NitSession,
  page: Page,
  ann: Annotation,
): Promise<{ ok: boolean; steps: number }> {
  const steps = reopenStepsOf(ann);
  if (!steps.length) return { ok: false, steps: 0 };

  let done = 0;
  for (const step of steps) {
    try {
      await page.locator(step.selector).first().click({ timeout: REOPEN_STEP_TIMEOUT_MS });
      await page.waitForTimeout(STEP_SETTLE_MS);
      done += 1;
    } catch (e) {
      session.log(`! couldn't re-open ${ann.id}: step ${done + 1}/${steps.length} `
        + `(${describeStep(step)}) — ${errorMessage(e)}`);
      return { ok: false, steps: done };
    }
  }
  session.log(`o re-opened ${ann.id} — ${steps.map(describeStep).join(' → ')}`);
  return { ok: true, steps: done };
}

/**
 * Verify mode: for every fixed annotation the overlay reports hidden behind a
 * closed dialog at the current viewport, replay its recorded re-open clicks
 * once. Driven by the `ui` event, so it runs as soon as the route has settled
 * and re-runs across viewport switches.
 *
 * Bookkeeping mirrors `captureAfterShots`: keys are `${id}:${viewportMode}` and
 * are claimed before the first `await`, so overlapping `ui` events can never
 * schedule the same attempt twice. A key stays `'pending'` for the duration of
 * the attempt — that is what holds the blank fallback shot back — and becomes
 * `'done'` either way when it resolves.
 * @param session the live verify session
 * @param page the site page that emitted the event
 * @param uiState the sanitized overlay ui state (its `hidden` entries carry the reason)
 */
export async function attemptDialogReopens(
  session: NitSession,
  page: Page,
  uiState: SessionUiState,
): Promise<void> {
  const { store } = session;
  const state = session._reopen ??= new Map<string, 'pending' | 'done'>();
  const mode = session.viewportMode;

  const pending: Annotation[] = [];
  for (const h of uiState.hidden ?? []) {
    if (h.reason !== 'dialog') continue;
    const ann = store.annotations.find(a => a.id === h.id);
    if (ann?.status !== 'fixed') continue;
    // A re-open at a viewport the annotation wants no shot in is pure noise:
    // nothing would be captured, and the page would be left with a modal open.
    if (!wantedAfterModes(ann).includes(mode)) continue;
    if (!reopenStepsOf(ann).length) continue;
    const key = `${ann.id}:${mode}`;
    if (state.has(key)) continue;
    state.set(key, 'pending');
    pending.push(ann);
  }
  if (!pending.length) return;

  const opened = session._reopenOpened ??= new Map<string, Promise<void>>();
  for (const ann of pending) {
    // Claimed *before* the click, not after it: the dialog opens mid-replay, the
    // overlay reports the element placed on its very next `ui` event, and that
    // event's capture can bank the after-shot while this call is still settling.
    // Marking afterwards would leave the dialog standing open behind the tour.
    // Only ids selected above get here, and they were selected precisely because
    // their dialog was closed — so this can never claim one the reviewer opened.
    const attempt = replayReopen(session, page, ann).then(() => {}, () => {});
    opened.set(ann.id, attempt);
    await attempt;
    state.set(`${ann.id}:${mode}`, 'done');
  }
}

/**
 * Whether an automatic re-open attempt for this annotation is in flight at this
 * viewport, i.e. the after-shot fallback must wait rather than bank a crop of
 * the closed page.
 *
 * Strictly `'pending'`, never "not done yet": an annotation can have re-open
 * steps and still be unplaced for a reason that schedules no attempt at all —
 * the fix removed the element while the dialog happens to be open, say — and
 * treating a missing entry as in-flight would leave that item stuck on
 * "capturing after-shot…" for the rest of the session. `attemptDialogReopens`
 * runs ahead of the capture in the same `ui` event, so by the time an item that
 * *does* get an attempt reaches here, its entry exists.
 */
export function reopenInFlight(session: NitSession, ann: Annotation, mode: ViewportMode): boolean {
  return session._reopen?.get(`${ann.id}:${mode}`) === 'pending';
}

/**
 * Close a dialog nit opened itself, once its after-shot is banked. Escape is the
 * one close gesture every dialog implementation honours; a dialog that ignores
 * it is left open, which the next `__nitGoTo` reload clears anyway.
 *
 * Waits out the attempt that opened it first: with a multi-step sequence the
 * element can anchor (and be shot) after the first click, and closing the
 * surface from under the remaining clicks would make them fail for no reason.
 * @param id the annotation whose dialog was re-opened
 */
export async function closeReopened(session: NitSession, page: Page, id: string): Promise<void> {
  const attempt = session._reopenOpened?.get(id);
  if (!attempt) return;
  session._reopenOpened?.delete(id);
  await attempt;
  await page.keyboard.press('Escape').catch(() => {});
}

/** A recorded step in log form: its visible text when it had one, else its selector. */
function describeStep(step: ClickStep): string {
  return step.text ? `"${step.text}"` : step.selector;
}
