// SPDX-License-Identifier: AGPL-3.0-or-later
// nit verify (SPEC §12): for every annotation the agent marked "fixed", capture
// "after" screenshots at the same route — of the re-anchored element when possible,
// of the originally recorded page region when the element can't be re-anchored
// (fixes legitimately remove/move elements). Capture is viewport-keyed: a shot is
// only taken while the session viewport is one the annotation actually wants
// (wantedAfterModes — its scope viewport, or both for general scope), so the
// before/after pair always compares like with like, and every piece of
// bookkeeping (grace clock, fallback, upgrade, retry) runs per (id, viewport).
// The fallback waits out a grace period so an SPA that renders after
// DOMContentLoaded isn't captured while still blank, and is upgraded to a real
// element shot if the element anchors later. The human then rules
// verified/reopened.
import path from 'node:path';
import type { Page } from 'playwright';
import { captureElementShot } from '../capture/screenshot.js';
import { primaryAfterMode, wantedAfterModes } from '../util/after-shots.js';
import { errorMessage } from '../util/error.js';
import type { NitSession, SessionUiState } from './session.js';
import type { Annotation, Rect } from '../types.js';

/**
 * How long an id must be continuously reported unplaced before its original
 * region is captured as the fallback after-shot. The overlay's first `ui` event
 * fires at DOMContentLoaded, before an SPA renders — capturing right away would
 * snapshot a blank page. Its 1 s re-anchor retries keep events coming, so a
 * late-rendering element anchors well inside this window instead.
 */
export const FALLBACK_GRACE_MS = 4000;

/**
 * A gap between unplaced reports longer than this resets the grace clock: it
 * means the user was on another route in between, and the fresh route load must
 * restart the wait so a returning SPA page isn't captured blank again.
 */
export const UNPLACED_GAP_RESET_MS = 3000;

interface PendingShot {
  ann: Annotation;
  rect: Rect;
  /** 'fallback' captures the original region; 'upgrade' replaces an earlier fallback shot */
  kind: 'anchored' | 'fallback' | 'upgrade';
}

/**
 * Capture pending after-shots for `fixed` annotations, driven by the overlay's
 * `ui` events (which carry fresh element rects per re-anchored annotation).
 * Everything is keyed `${id}:${viewportMode}` at event time: an annotation is
 * only considered while the session viewport is in its `wantedAfterModes`, so a
 * mobile-scoped item never gets a desktop shot and its grace clock never even
 * starts on desktop. Re-anchored elements are captured immediately; unplaced
 * ones only after the grace period above, and such a fallback shot is
 * overwritten once should the element re-anchor later. An `'anchored'` shot is
 * never redone for its viewport. The overlay UI is hidden while capturing so
 * pins/chips never leak into the evidence.
 * @param session the live verify session (store, log, capture bookkeeping)
 * @param page the site page that emitted the event
 * @param uiState the sanitized overlay ui state: re-anchored annotations with
 *   live rects, plus the ids that could not be re-anchored (their originally
 *   recorded region is captured)
 */
export async function captureAfterShots(session: NitSession, page: Page, uiState: SessionUiState): Promise<void> {
  const { store } = session;
  const captured = session._afterCaptured ??= new Map<string, 'anchored' | 'fallback'>();
  const unplacedSeen = session._afterUnplacedSeen ??= new Map<string, { first: number; last: number }>();
  // Bound once per event: the page on screen is laid out at this viewport, and
  // every capture key below is scoped to it.
  const mode = session.viewportMode;
  const now = Date.now();

  const pending: PendingShot[] = [];
  for (const p of uiState.placed ?? []) {
    if (!p.id || !p.rect) continue;
    const ann = store.annotations.find(a => a.id === p.id);
    if (ann?.status !== 'fixed') continue;
    // A shot at the wrong viewport is worse than none — a mobile-scoped fix
    // must never be judged by a desktop screenshot.
    if (!wantedAfterModes(ann).includes(mode)) continue;
    const key = `${ann.id}:${mode}`;
    unplacedSeen.delete(key); // placed now — a later unplaced report starts a fresh clock
    const how = captured.get(key);
    if (how === 'anchored') continue; // a real element shot is final
    pending.push({ ann, rect: p.rect, kind: how === 'fallback' ? 'upgrade' : 'anchored' });
  }
  for (const id of uiState.unplaced ?? []) {
    const ann = store.annotations.find(a => a.id === id);
    if (ann?.status !== 'fixed' || !ann.target?.rect) continue;
    // The grace clock must not even start at a viewport the annotation doesn't
    // want — time spent on desktop must not count toward a mobile-only fallback.
    if (!wantedAfterModes(ann).includes(mode)) continue;
    const key = `${ann.id}:${mode}`;
    if (captured.has(key)) continue;
    // Grace period: a gap since the last report means the user was on another
    // route, so the clock restarts — otherwise a returning SPA page would be
    // captured before it has rendered.
    const seen = unplacedSeen.get(key);
    const first = seen && now - seen.last <= UNPLACED_GAP_RESET_MS ? seen.first : now;
    unplacedSeen.set(key, { first, last: now });
    if (now - first < FALLBACK_GRACE_MS) continue;
    pending.push({ ann, rect: ann.target.rect, kind: 'fallback' });
  }
  if (!pending.length) return;
  // Claim the keys before the async capture so an overlapping `ui` event can't
  // schedule the same shot twice.
  for (const p of pending) captured.set(`${p.ann.id}:${mode}`, p.kind === 'fallback' ? 'fallback' : 'anchored');

  await page.evaluate(() => window.__nitOverlay?.setUiHidden(true)).catch(() => {});
  await new Promise(r => setTimeout(r, 80));
  try {
    for (const { ann, rect, kind } of pending) {
      const key = `${ann.id}:${mode}`;
      try {
        // The primary viewport's shot keeps the legacy un-suffixed filename so
        // existing reviews, tests, and MCP consumers keep resolving it.
        const isPrimary = mode === primaryAfterMode(ann);
        const file = isPrimary ? store.afterShotPath(ann.id) : store.afterShotPath(ann.id, mode);
        await captureElementShot(page, rect, file);
        const rel = `shots/${path.basename(file)}`;
        ann.screenshotsAfter = { ...(ann.screenshotsAfter ?? {}), [mode]: rel };
        // The schema promises screenshotAfter always mirrors the primary entry.
        if (isPrimary) ann.screenshotAfter = rel;
        unplacedSeen.delete(key);
        if (kind === 'upgrade') {
          session.log(`o after-shot upgraded ${ann.id} [${mode}] (element re-anchored)`);
        } else {
          session.log(`o after-shot ${ann.id} [${mode}]${kind === 'fallback' ? ' (not re-anchored — captured the original region)' : ''}`);
        }
      } catch (e) {
        captured.delete(key); // retry on a later refresh
        session.log(`! after-shot failed for ${ann.id}: ${errorMessage(e)}`);
      }
    }
    store.flush();
  } finally {
    await page.evaluate(() => window.__nitOverlay?.setUiHidden(false)).catch(() => {});
  }
}
