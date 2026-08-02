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
// of a shared, hand-editable, agent-written file. Four things keep that safe:
//
//   1. **Origin.** A click can navigate. `trusted()` in bridge.ts gates the
//      bridge on page *identity*, not origin, so a site page that wandered off
//      the review origin would keep full access to __nitSave/__nitShot/… — the
//      exact escalation __nitGoTo refuses to allow. Every step re-checks the
//      origin and the route, and a replay that moved the page is abandoned and
//      navigated back.
//   2. **Volume.** At most MAX_REOPEN_STEPS steps per annotation (enforced on
//      save *and* on load, see store.ts's sanitizeContext), one automatic
//      attempt per annotation and viewport, one surface at a time.
//   3. **Serialization.** All replays share one chain, so two of them can never
//      fight over the same dialog.
//   4. **Timing.** The attempt waits out the same grace period the after-shot
//      fallback uses, so it isn't spent clicking at a page that hasn't rendered.
import { FALLBACK_GRACE_MS } from './verify.js';
import { currentRoute, routeKey } from '../util/route.js';
import { wantedAfterModes } from '../util/after-shots.js';
import { errorMessage } from '../util/error.js';
import type { Frame, Page } from 'playwright';
import type { NitSession, SessionUiState } from './session.js';
import type { Annotation, ClickStep, ViewportMode } from '../types.js';

/** How long one recorded step may take to become clickable before the attempt is given up. */
const STEP_TIMEOUT_MS = 2000;

/** Settle time after each click — enough for an open animation to put the surface on screen. */
const STEP_SETTLE_MS = 400;

/** How far a replay may be from the annotation's own dialog before it is abandoned. */
export type ReopenFailure = 'off-origin' | 'off-route' | 'step-failed';

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
 * coordinates. Between steps the page's origin and route are re-checked: a
 * replay takes seconds, in which the auto-tour can navigate to the next queue
 * item, and a recorded selector can itself match a link. Either way the
 * remaining steps would land somewhere they were never recorded, so the replay
 * stops and, if the page left the review origin, navigates back.
 *
 * Never throws — a failed re-open is an ordinary outcome, and the caller falls
 * back to the honest "couldn't re-find the element" path.
 * @returns how many steps landed, and why it stopped when it did not finish
 */
export async function replayReopen(
  session: NitSession,
  page: Page,
  ann: Annotation,
): Promise<{ ok: boolean; steps: number; failure?: ReopenFailure }> {
  const steps = reopenStepsOf(ann);
  if (!steps.length) return { ok: false, steps: 0, failure: 'step-failed' };

  const home = pageAnchor(session, page);
  if (!home.origin) {
    // Fail closed: without a home origin there is no way to tell that a click
    // navigated the page somewhere the bridge must not follow.
    session.log(`! refused to re-open ${ann.id}: the session has no resolvable origin to stay on`);
    return { ok: false, steps: 0, failure: 'off-origin' };
  }
  // A click that starts a navigation returns before the new document commits,
  // so polling `page.url()` right after it can still read the old one — and by
  // the time it is read, something else (the verify tour's own __nitGoTo) may
  // already have navigated back, hiding the excursion entirely. Latch it
  // instead: *any* off-origin commit during the replay condemns it, no matter
  // where the page ends up.
  let leftOrigin = false;
  const onNavigated = (frame: Frame): void => {
    if (frame !== page.mainFrame()) return;
    try {
      if (new URL(frame.url()).origin !== home.origin) leftOrigin = true;
    } catch {
      leftOrigin = true;
    }
  };
  page.on('framenavigated', onNavigated);

  let done = 0;
  try {
    for (const step of steps) {
      try {
        await page.locator(step.selector).first().click({ timeout: STEP_TIMEOUT_MS });
        // Lets an in-flight navigation finish; returns at once when there is none.
        await page.waitForLoadState('domcontentloaded', { timeout: STEP_TIMEOUT_MS }).catch(() => {});
        await page.waitForTimeout(STEP_SETTLE_MS);
        done += 1;
      } catch (e) {
        session.log(`! couldn't re-open ${ann.id}: step ${done + 1}/${steps.length} `
          + `(${describeStep(step)}) — ${errorMessage(e)}`);
        return { ok: false, steps: done, failure: 'step-failed' };
      }
      const drift = await checkAnchor(session, page, home, leftOrigin);
      if (drift) {
        session.log(`! abandoned re-open of ${ann.id} after step ${done}/${steps.length}: `
          + `the page moved ${drift === 'off-origin' ? 'off the review origin' : 'to another route'}`);
        return { ok: false, steps: done, failure: drift };
      }
    }
  } finally {
    page.off('framenavigated', onNavigated);
  }
  session.log(`o re-opened ${ann.id} — ${steps.map(describeStep).join(' → ')}`);
  return { ok: true, steps: done };
}

/** Where the page must stay while a replay runs: the review origin, on the annotation's route. */
interface PageAnchor {
  origin: string | null;
  route: string | null;
}

function pageAnchor(session: NitSession, page: Page): PageAnchor {
  // Taken from the url this session actually opened, never from the file's
  // `review.url` — the same reasoning __nitGoTo documents. Deliberately not
  // derived from the annotation's own route: that can fail to resolve, and a
  // guard that switches itself off when it cannot read its input is no guard.
  let origin: string | null = null;
  try {
    origin = new URL(session.targetUrl).origin;
  } catch { /* no usable home origin — handled as "refuse to click" below */ }
  return { origin, route: safeRouteOf(page) };
}

function safeRouteOf(page: Page): string | null {
  try {
    return routeKey(currentRoute(new URL(page.url())));
  } catch {
    return null;
  }
}

/**
 * Whether the page has drifted away from where the replay started, and put it
 * back on the review origin when it has left it. Returns null while the page is
 * still where the recorded steps expect it.
 */
async function checkAnchor(
  session: NitSession,
  page: Page,
  home: PageAnchor,
  leftOrigin: boolean,
): Promise<ReopenFailure | null> {
  if (!home.origin) return 'off-origin';
  let now: URL;
  try {
    now = new URL(page.url());
  } catch {
    return 'off-origin';
  }
  if (leftOrigin || now.origin !== home.origin) {
    // Leaving the origin is the dangerous one: bridge access is gated on page
    // identity, so an off-origin site page would inherit every binding.
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    if (safeOriginOf(page) !== home.origin) {
      await page.goto(session.targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    }
    return 'off-origin';
  }
  return home.route && routeKey(currentRoute(now)) !== home.route ? 'off-route' : null;
}

function safeOriginOf(page: Page): string | null {
  try {
    return new URL(page.url()).origin;
  } catch {
    return null;
  }
}

/**
 * Verify mode: for every fixed annotation the overlay reports hidden behind a
 * closed dialog at the current viewport, replay its recorded re-open clicks
 * once. Driven by the `ui` event, so it runs as soon as the route has settled
 * and re-runs across viewport switches.
 *
 * Three rules keep concurrent `ui` events (exposeBinding handlers are not
 * serialized) from fighting each other over one page:
 *
 * - a `${id}:${mode}` key is claimed before the first `await`, as
 *   `captureAfterShots` does;
 * - an annotation with an unsettled attempt at *any* viewport is skipped, so a
 *   viewport switch mid-replay cannot start a second run of the same steps;
 * - only one annotation per dialog surface is replayed, and every replay runs
 *   on one session-wide chain.
 *
 * The first attempt also waits out {@link FALLBACK_GRACE_MS} of continuous
 * "hidden behind a dialog" reports. The overlay's first `ui` event fires at
 * DOMContentLoaded, before an SPA has rendered anything to click; spending the
 * one attempt there would fail exactly the slow-rendering apps the grace period
 * exists for.
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
  const state = session._reopen ??= new Map<string, ReopenState>();
  const waiting = session._reopenWaiting ??= new Map<string, number>();
  const mode = session.viewportMode;
  const now = Date.now();

  const closedIds = new Set((uiState.hidden ?? []).filter(h => h.reason === 'dialog').map(h => h.id));
  // An id that stopped being reported dialog-hidden is never going to get the
  // attempt it is queued for — release the hold so its after-shot fallback can
  // run. Only ever releases a queued one: a 'pending' entry is a replay already
  // in flight, and dropping its marker would let a later event start a second.
  const suffix = `:${mode}`;
  for (const [key, value] of [...state]) {
    if (value !== 'waiting' || !key.endsWith(suffix)) continue;
    // Ids are qualified in merged reviews (`kevin:a1`), so strip the known
    // viewport suffix rather than splitting on the first colon.
    if (closedIds.has(key.slice(0, -suffix.length))) continue;
    state.delete(key);
    waiting.delete(key);
  }

  const pending: Annotation[] = [];
  const surfaces = new Set<string>();
  for (const id of closedIds) {
    const ann = store.annotations.find(a => a.id === id);
    if (ann?.status !== 'fixed') continue;
    // A re-open at a viewport the annotation wants no shot in is pure noise:
    // nothing would be captured, and the page would be left with a modal open.
    if (!wantedAfterModes(ann).includes(mode)) continue;
    if (!reopenStepsOf(ann).length) continue;
    const key = `${ann.id}:${mode}`;
    // 'waiting' must fall through — it is this loop that graduates it to
    // 'pending' once the grace period is up. Only a spent or running attempt
    // is skipped.
    if (state.get(key) === 'pending' || state.get(key) === 'done') continue;
    // Any viewport: a general-scoped annotation whose desktop replay is still
    // running must not have its mobile replay started on top of it.
    if (unsettledFor(state, ann.id)) continue;
    // Two annotations in the same dialog need one re-open between them, not two
    // — the second would re-click a toggle-style opener and close it again.
    const surface = ann.context?.selector ?? ann.id;
    if (surfaces.has(surface)) continue;

    const since = waiting.get(key) ?? now;
    waiting.set(key, since);
    if (now - since < FALLBACK_GRACE_MS) {
      state.set(key, 'waiting');
      continue;
    }
    surfaces.add(surface);
    state.set(key, 'pending');
    pending.push(ann);
  }
  if (!pending.length) return;

  const opened = session._reopenOpened ??= new Map<string, Promise<void>>();
  for (const ann of pending) {
    // Claimed *before* the click: the dialog opens mid-replay, the overlay
    // reports the element placed on its very next `ui` event, and that event's
    // capture can bank the after-shot while this call is still settling.
    // Marking afterwards would leave the dialog standing open behind the tour.
    const attempt = runSerialized(session, () => replayReopen(session, page, ann).then(r => r.ok));
    opened.set(ann.id, attempt.then(() => {}, () => {}));
    const ok = await attempt.catch(() => false);
    if (!ok) opened.delete(ann.id); // nothing was opened, so nothing to close later
    state.set(`${ann.id}:${mode}`, 'done');
    waiting.delete(`${ann.id}:${mode}`);
  }
}

/** How far an automatic re-open attempt has got, keyed `${annotationId}:${viewportMode}`. */
export type ReopenState = 'waiting' | 'pending' | 'done';

/** Whether any viewport's attempt for this annotation has yet to finish. */
function unsettledFor(state: Map<string, ReopenState>, id: string): boolean {
  for (const [key, value] of state) {
    if (key.startsWith(`${id}:`) && value === 'pending') return true;
  }
  return false;
}

/**
 * Run a page-touching replay on the session's single replay chain. Two replays
 * are never in flight at once: the second would click its opener while the
 * first has a modal on screen, so its steps would be intercepted by a backdrop
 * — or worse, dismiss the dialog the first one just opened.
 */
export function runSerialized<T>(session: NitSession, work: () => Promise<T>): Promise<T> {
  const previous = session._reopenChain ?? Promise.resolve();
  const next = previous.then(work, work);
  session._reopenChain = next.then(() => {}, () => {});
  return next;
}

/**
 * Whether an automatic re-open attempt for this annotation is still coming at
 * this viewport, i.e. the after-shot fallback must wait rather than bank a crop
 * of the closed page. True while the attempt is queued behind the grace period
 * (`waiting`) or running (`pending`).
 *
 * Never true for an annotation that has no entry: it can have re-open steps and
 * still be unplaced for a reason that schedules no attempt at all — the fix
 * removed the element while the dialog happens to be open, say — and holding
 * the fallback for an attempt that will never come would leave that item stuck
 * on "capturing after-shot…" for the rest of the session.
 */
export function reopenInFlight(session: NitSession, ann: Annotation, mode: ViewportMode): boolean {
  const value = session._reopen?.get(`${ann.id}:${mode}`);
  return value === 'waiting' || value === 'pending';
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

/**
 * Close every dialog nit still has standing open. Called once a capture pass
 * has settled: a replay that opened a dialog whose element then never anchored
 * banks no shot of its own, and leaving that modal up would put it in front of
 * every *other* annotation's after-shot on the same route.
 */
export async function closeAllReopened(session: NitSession, page: Page): Promise<void> {
  for (const id of [...(session._reopenOpened?.keys() ?? [])]) {
    await closeReopened(session, page, id);
  }
}

/** A recorded step in log form: its visible text when it had one, else its selector. */
function describeStep(step: ClickStep): string {
  return step.text ? `"${step.text}"` : step.selector;
}
