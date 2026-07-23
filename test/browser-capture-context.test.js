// SPDX-License-Identifier: AGPL-3.0-or-later
// Capture context: an annotation picked inside a dialog records where it lived;
// plain-page annotations keep their file shape byte-identical (no context field).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startFixtureServer } from './helpers/server.js';
import { startTestSession, waitFor, tmpDir } from './helpers/session.js';

// Shared pick step: Alt-toggle picking, click the target's center, wait for the
// popover's comment box to be visible (the popover is in the shadow root;
// Playwright locators pierce open shadow roots, so `#nit-root ...` works).
async function pick(page, targetSelector) {
  await page.keyboard.press('Alt');
  const box = await page.locator(targetSelector).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const ta = page.locator('#nit-root .nit-pop-comment');
  await ta.waitFor({ state: 'visible' });
  return ta;
}

// Shared save step: fill the comment and click Save.
async function fillAndSave(page, ta, comment) {
  await ta.fill(comment);
  await page.locator('#nit-root .nit-save').click();
}

async function annotate(page, targetSelector, comment) {
  const ta = await pick(page, targetSelector);
  await fillAndSave(page, ta, comment);
}

test('capture context', async t => {
  const server = await startFixtureServer();
  const out = tmpDir('nit-ctx-');
  const S = await startTestSession({ mode: 'review', out, url: `${server.url}/replay.html` });
  t.after(async () => {
    await S.session.close();
    await server.close();
  });
  const page = S.session.page;
  // annotations.json doesn't exist until the first save flushes it — swallow
  // the pre-existence ENOENT so waitFor keeps polling instead of throwing.
  const readFile = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(out, 'annotations.json'), 'utf8'));
    } catch {
      return null;
    }
  };

  await t.test('dialog pick records kind/selector/label', async () => {
    await page.evaluate(() => document.getElementById('dlg').showModal());
    const ta = await pick(page, '#dlg-save');
    // A showModal() dialog sits in the browser's top layer, which always wins
    // hit-testing over regular content — while it stays open, no click can
    // reach nit's own popover (verified: even a raw click dispatched at an
    // unrelated element's coordinates lands on the dialog instead of that
    // element). Picking itself and the pick-time staged screenshot still work
    // because the pick click targets a point *inside* the dialog, which the
    // picker's capture-phase window listener sees regardless. So the reviewer
    // closes the dialog before typing/saving; detectDialog() re-derives the
    // context from the (still-connected, just no-longer-"open") dialog
    // ancestor at save time, so context capture is unaffected by the close.
    await page.evaluate(() => document.getElementById('dlg').close());
    await fillAndSave(page, ta, 'Rename this button');
    const data = await waitFor(() => {
      const d = readFile();
      return d && d.annotations.length === 1 ? d : null;
    }, { message: 'annotation saved', timeout: 15000 });
    const ann = data.annotations[0];
    assert.equal(ann.context.kind, 'dialog');
    assert.equal(ann.context.label, 'Checkout'); // aria-label wins over the heading
    // the selector re-finds the dialog container itself
    const hits = await page.evaluate(sel => document.querySelectorAll(sel).length, ann.context.selector);
    assert.equal(hits, 1);
    // The dialog is closed (display:none) by the time save() resolves the
    // target, which would otherwise persist a zero-size rect — the popover
    // must fall back to the rect it snapshotted at pick time, while the
    // element was still visible inside the open dialog.
    assert.ok(ann.target.rect.w > 0 && ann.target.rect.h > 0,
      'target.rect keeps the pick-time (open-dialog) size, not the collapsed one');
  });

  await t.test('plain-page pick stores no context field at all', async () => {
    await annotate(page, '#present', 'Tighten this copy');
    const data = await waitFor(() => {
      const d = readFile();
      return d && d.annotations.length === 2 ? d : null;
    }, { message: 'second annotation saved', timeout: 15000 });
    assert.ok(!('context' in data.annotations[1]));
  });
});
