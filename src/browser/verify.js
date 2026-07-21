// nit verify (SPEC §12): for every annotation the agent marked "fixed", capture an
// "after" screenshot at the same route — of the re-anchored element when possible,
// of the originally recorded page region when the element can't be re-anchored
// (fixes legitimately remove/move elements). The human then rules verified/reopened.
import path from 'node:path';
import { captureElementShot } from '../capture/screenshot.js';

export async function captureAfterShots(session, page, evt) {
  const { store } = session;
  if (!session._afterCaptured) session._afterCaptured = new Set();

  const pending = [];
  for (const p of Array.isArray(evt.placed) ? evt.placed : []) {
    if (!p || typeof p !== 'object' || !p.id || !p.rect) continue;
    const ann = store.annotations.find(a => a.id === p.id);
    if (ann && ann.status === 'fixed' && !session._afterCaptured.has(ann.id)) {
      pending.push({ ann, rect: p.rect, fallback: false });
    }
  }
  for (const id of Array.isArray(evt.unplaced) ? evt.unplaced : []) {
    const ann = store.annotations.find(a => a.id === id);
    if (ann && ann.status === 'fixed' && !session._afterCaptured.has(ann.id) && ann.target && ann.target.rect) {
      pending.push({ ann, rect: ann.target.rect, fallback: true });
    }
  }
  if (!pending.length) return;
  for (const p of pending) session._afterCaptured.add(p.ann.id);

  await page.evaluate(() => window.__nitOverlay && window.__nitOverlay.setUiHidden(true)).catch(() => {});
  await new Promise(r => setTimeout(r, 80));
  try {
    for (const { ann, rect, fallback } of pending) {
      try {
        const file = store.afterShotPath(ann.id);
        await captureElementShot(page, rect, file);
        ann.screenshotAfter = `shots/${path.basename(file)}`;
        session.log(`o after-shot ${ann.id}${fallback ? ' (not re-anchored — captured the original region)' : ''}`);
      } catch (e) {
        session._afterCaptured.delete(ann.id); // retry on a later refresh
        session.log(`! after-shot failed for ${ann.id}: ${e.message}`);
      }
    }
    store.flush();
  } finally {
    await page.evaluate(() => window.__nitOverlay && window.__nitOverlay.setUiHidden(false)).catch(() => {});
  }
}
