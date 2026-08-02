// SPDX-License-Identifier: AGPL-3.0-or-later
// Capture context: an annotation picked inside a dialog records where it lived
// and how to get back in; plain-page annotations keep their file shape
// byte-identical (no context field, and no confirmation row in the popover).
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
  // Read from S.dir (the base folder the session actually writes into, e.g.
  // out/<slug>), not out itself — a fresh review is never flat.
  const readFile = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(S.dir, 'annotations.json'), 'utf8'));
    } catch {
      return null;
    }
  };

  /** The popover's dialog-confirmation checkbox (absent on a plain page). */
  const dialogBox = () => page.locator('#nit-root .nit-check input');

  await t.test('dialog pick records kind/selector/label', async () => {
    await page.evaluate(() => document.getElementById('dlg').showModal());
    const ta = await pick(page, '#dlg-save');
    // A <dialog> is a confident signal, so the row is there and already ticked —
    // the reviewer only has to touch it to correct a false positive.
    assert.equal(await dialogBox().count(), 1, 'confirmation row rendered');
    assert.equal(await dialogBox().isChecked(), true, 'pre-checked for a confident signal');
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
    const ta = await pick(page, '#present');
    assert.equal(await dialogBox().count(), 0, 'no confirmation row on a plain page');
    await fillAndSave(page, ta, 'Tighten this copy');
    const data = await waitFor(() => {
      const d = readFile();
      return d && d.annotations.length === 2 ? d : null;
    }, { message: 'second annotation saved', timeout: 15000 });
    assert.ok(!('context' in data.annotations[1]));
  });

  await t.test('a hand-rolled modal is offered unticked, and confirming records the way back in', async () => {
    await page.goto(`${server.url}/dialog.html`);
    await waitFor(
      () => page.evaluate(() => Boolean(document.getElementById('nit-root')?.shadowRoot)),
      { message: 'overlay booted on the dialog fixture' },
    );

    // A sticky bar is fixed-positioned but the page is not scroll-locked — the
    // suspicion tier must stay quiet, or every second annotation grows a row.
    await pick(page, '#sticky-note');
    assert.equal(await dialogBox().count(), 0, 'a sticky bar on a scrollable page is not a dialog');
    // Cancel, not Escape: focus sits in the popover's textarea, and the picker's
    // hotkey listener deliberately ignores keys inside nit's own UI.
    await page.locator('#nit-root .nit-cancel').click();

    // This is the click the trail records and nit verify replays.
    await page.locator('#open-drawer').click();
    const ta = await pick(page, '#drawer-total');
    assert.equal(await dialogBox().count(), 1, 'a .drawer class is worth asking about');
    assert.equal(await dialogBox().isChecked(), false, 'a guess is not pre-checked — the reviewer opts in');
    await dialogBox().check();
    await fillAndSave(page, ta, 'Total is misaligned');

    const data = await waitFor(() => {
      const d = readFile();
      return d && d.annotations.length === 3 ? d : null;
    }, { message: 'drawer annotation saved', timeout: 15000 });
    const ann = data.annotations[2];
    assert.equal(ann.context.kind, 'dialog');
    assert.equal(ann.context.label, 'Checkout', 'the heading names the surface');
    const hits = await page.evaluate(sel => document.querySelectorAll(sel).length, ann.context.selector);
    assert.equal(hits, 1, 'the selector re-finds the drawer itself');
    assert.deepEqual(ann.context.reopen.map(s => s.selector), ['#open-drawer']);
    assert.equal(ann.context.reopen[0].text, 'Open checkout');
  });

  await t.test('a modal-ish class on the page shell never offers the row', async () => {
    // #plain lives inside .mat-drawer-content — the class matches the modal-ish
    // pattern, but it is statically positioned and wraps the page. Before the
    // corroboration rule this put a checkbox on every annotation in a Material app.
    await pick(page, '#plain');
    assert.equal(await dialogBox().count(), 0);
    await page.locator('#nit-root .nit-cancel').click();
  });

  await t.test('ordinary clicks inside the dialog are not recorded as re-open steps', async () => {
    await page.locator('#open-drawer').click();
    // A destructive in-dialog click, made after the opener. It changed nothing
    // about which surfaces are open, so it must not end up in a sequence nit
    // replays unattended.
    await page.locator('#drawer-danger').click();
    const ta = await pick(page, '#drawer-total');
    await dialogBox().check();
    await fillAndSave(page, ta, 'Total still misaligned');
    const data = await waitFor(() => {
      const d = readFile();
      return d && d.annotations.length === 4 ? d : null;
    }, { message: 'fourth annotation saved', timeout: 15000 });
    const ann = data.annotations[3];
    assert.deepEqual(ann.context.reopen.map(s => s.selector), ['#open-drawer']);
    assert.equal(ann.context.reopen.some(s => s.selector === '#drawer-danger'), false,
      'the destructive click is in `history` for the agent to read, but never in `reopen`');
    assert.ok(ann.history.some(s => s.selector === '#drawer-danger'), 'still recorded as context');
  });

  await t.test('unticking the confirmation saves a plain-page annotation', async () => {
    await page.locator('#open-drawer').click();
    const ta = await pick(page, '#drawer-total');
    await dialogBox().uncheck();
    await fillAndSave(page, ta, 'Not really a dialog');
    const data = await waitFor(() => {
      const d = readFile();
      return d && d.annotations.length === 5 ? d : null;
    }, { message: 'unticked annotation saved', timeout: 15000 });
    assert.ok(!('context' in data.annotations[4]), 'a corrected false positive leaves no context behind');
  });
});
