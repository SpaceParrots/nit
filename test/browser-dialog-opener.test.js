// SPDX-License-Identifier: AGPL-3.0-or-later
// The regression this whole change exists for: a dialog that is permanently
// mounted, nested inside components rather than parked on <body>, and shown by a
// class flip. detectDialog always found it; nothing ever saw it *open*, so the
// annotation saved no way back in. Recorded reviews of a real Angular app had
// eight such annotations and not one `context.reopen`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureServer } from './helpers/server.js';
import { startTestSession, waitFor, readAnnotations } from './helpers/session.js';

test('nit review — the opener of a nested, class-toggled dialog is recorded', async t => {
  const server = await startFixtureServer();
  const S = await startTestSession({ url: server.url + '/nested-dialog.html' });
  t.after(async () => {
    await S.session.close();
    await server.close();
  });
  const page = S.session.page;

  await waitFor(
    () => page.evaluate(() => Boolean(document.getElementById('nit-root')?.shadowRoot)),
    { message: 'overlay booted' },
  );

  /** Alt-pick `selector`, tick the dialog box if it is not already ticked, save. */
  const annotate = async (selector, comment) => {
    // #panel-note sits far below the fold (behind the 2000px filler); a real
    // reviewer would have to scroll to reach it, and the raw boundingBox +
    // mouse.click below needs the element actually within the viewport.
    await page.locator(selector).scrollIntoViewIfNeeded();
    const box = await page.locator(selector).boundingBox();
    await page.keyboard.press('Alt');
    await page.mouse.click(box.x + 5, box.y + 5);
    await page.locator('.nit-pop-comment').fill(comment);
    const check = page.locator('.nit-check input[type=checkbox]');
    await check.waitFor({ timeout: 5000 });
    if (!(await check.isChecked())) await check.check();
    await page.locator('.nit-save').click();
    return waitFor(() => {
      try {
        const d = readAnnotations(S.dir);
        return d.annotations.find(x => x.comment === comment) ?? null;
      } catch { return null; } // annotations.json not written yet
    }, { message: `annotation "${comment}" written` });
  };

  await t.test('the opener survives a wizard that overruns the click window', async () => {
    await page.locator('#open-sheet').click();
    await waitFor(
      () => page.evaluate(() => document.getElementById('sheet').classList.contains('open')),
      { message: 'sheet open' },
    );
    // Twelve in-sheet clicks: more than MAX_HISTORY, so the opener is gone from
    // `history` and can only come from the chain.
    for (let i = 0; i < 12; i++) await page.locator('#sheet .next').click();

    const a = await annotate('#sheet-total', 'total is misaligned in the sheet');
    assert.equal(a.context?.kind, 'dialog', 'saved as a dialog annotation');
    assert.deepEqual(
      a.context.reopen?.map(s => s.selector),
      ['#open-sheet'],
      'the opener is recorded even though it was evicted from history',
    );
    assert.equal(a.context.reopen[0].text, 'Feedback geben');
    assert.equal(
      a.history.some(s => s.selector === '#open-sheet'),
      false,
      'and it really had fallen out of the click window',
    );
  });

  await t.test('a data-dialog-trigger opener is recorded with no heuristics involved', async () => {
    await page.keyboard.press('Escape');
    await page.locator('#open-panel').click();
    await waitFor(
      () => page.evaluate(() => document.getElementById('panel').classList.contains('open')),
      { message: 'panel open' },
    );

    const b = await annotate('#panel-note', 'declared panel copy is wrong');
    assert.equal(b.context?.kind, 'dialog', 'data-dialog alone makes it a dialog surface');
    assert.deepEqual(b.context.reopen?.map(s => s.selector), ['#open-panel']);
  });
});
