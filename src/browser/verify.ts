// SPDX-License-Identifier: AGPL-3.0-or-later
// nit verify (SPEC §12): for every annotation the agent marked "fixed", capture an
// "after" screenshot at the same route — of the re-anchored element when possible,
// of the originally recorded page region when the element can't be re-anchored
// (fixes legitimately remove/move elements). The human then rules verified/reopened.
import path from 'node:path';
import type { Page } from 'playwright';
import { captureElementShot } from '../capture/screenshot.js';
import { errorMessage } from '../util/error.js';
import type { NitSession, SessionUiState } from './session.js';
import type { Annotation, Rect } from '../types.js';

interface PendingShot {
  ann: Annotation;
  rect: Rect;
  /** true when the element could not be re-anchored and the original region is captured */
  fallback: boolean;
}

/**
 * Capture pending after-shots for `fixed` annotations, driven by the overlay's
 * `ui` events (which carry fresh element rects per re-anchored annotation).
 * Each annotation is captured once per session; the overlay UI is hidden while
 * capturing so pins/chips never leak into the evidence.
 * @param session the live verify session (store, log, capture guard)
 * @param page the site page that emitted the event
 * @param uiState the sanitized overlay ui state: re-anchored annotations with
 *   live rects, plus the ids that could not be re-anchored (their originally
 *   recorded region is captured)
 */
export async function captureAfterShots(session: NitSession, page: Page, uiState: SessionUiState): Promise<void> {
  const { store } = session;
  const captured = session._afterCaptured ??= new Set<string>();

  const pending: PendingShot[] = [];
  for (const p of uiState.placed ?? []) {
    if (!p.id || !p.rect) continue;
    const ann = store.annotations.find(a => a.id === p.id);
    if (ann?.status === 'fixed' && !captured.has(ann.id)) {
      pending.push({ ann, rect: p.rect, fallback: false });
    }
  }
  for (const id of uiState.unplaced ?? []) {
    const ann = store.annotations.find(a => a.id === id);
    if (ann?.status === 'fixed' && !captured.has(ann.id) && ann.target?.rect) {
      pending.push({ ann, rect: ann.target.rect, fallback: true });
    }
  }
  if (!pending.length) return;
  for (const p of pending) captured.add(p.ann.id);

  await page.evaluate(() => window.__nitOverlay?.setUiHidden(true)).catch(() => {});
  await new Promise(r => setTimeout(r, 80));
  try {
    for (const { ann, rect, fallback } of pending) {
      try {
        const file = store.afterShotPath(ann.id);
        await captureElementShot(page, rect, file);
        ann.screenshotAfter = `shots/${path.basename(file)}`;
        session.log(`o after-shot ${ann.id}${fallback ? ' (not re-anchored — captured the original region)' : ''}`);
      } catch (e) {
        captured.delete(ann.id); // retry on a later refresh
        session.log(`! after-shot failed for ${ann.id}: ${errorMessage(e)}`);
      }
    }
    store.flush();
  } finally {
    await page.evaluate(() => window.__nitOverlay?.setUiHidden(false)).catch(() => {});
  }
}
