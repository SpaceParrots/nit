// SPDX-License-Identifier: AGPL-3.0-or-later
// Pick-time screenshot staging: the shot is captured the moment an element is
// selected (while transient state like an open dropdown is still visible), held
// in memory, and consumed by the save — with save-time capture as the fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startFixtureServer } from './helpers/server.js';
import { startTestSession, waitFor, readAnnotations } from './helpers/session.js';
import { pngSize, MIN_SHOT_W, MIN_SHOT_H } from '../dist/capture/screenshot.js';

test('nit review — pick-time screenshot staging', async t => {
  const server = await startFixtureServer();
  const S = await startTestSession({ url: server.url + '/' });
  t.after(async () => {
    await S.session.close();
    await server.close();
  });
  const page = S.session.page;

  await waitFor(
    () => page.evaluate(() => Boolean(document.getElementById('nit-root')?.shadowRoot)),
    { message: 'overlay booted' },
  );

  await t.test('picking an element stages a shot before anything is saved', async () => {
    const box = await page.locator('fake-product-tile').first().locator('.badge').boundingBox();
    await page.keyboard.press('Alt');
    await page.mouse.move(box.x + 4, box.y + 4);
    await page.mouse.click(box.x + 4, box.y + 4);

    await waitFor(() => S.session.pendingShot ? true : null, { message: 'pending shot staged' });
    const staged = S.session.pendingShot;
    const size = pngSize(staged.buffer);
    assert.ok(size, 'staged buffer is a PNG');
    assert.ok(size.width >= MIN_SHOT_W - 2, `staged width ${size.width} ≥ context minimum`);
    assert.ok(size.height >= MIN_SHOT_H - 2, `staged height ${size.height} ≥ context minimum`);
    // nothing on disk yet — the buffer only becomes a file on save
    assert.ok(!fs.existsSync(path.join(S.out, 'shots', 'a1.png')), 'no file before save');
  });

  await t.test('saving consumes the staged shot instead of re-capturing', async () => {
    const staged = S.session.pendingShot.buffer;
    await page.locator('.nit-pop-comment').fill('badge context shot');
    await page.locator('.nit-save').click();

    const a = await waitFor(() => {
      try {
        return readAnnotations(S.out).annotations.find(x => x.comment === 'badge context shot') ?? null;
      } catch { return null; }
    }, { message: 'annotation written' });

    assert.ok(a.screenshot, 'annotation has a screenshot');
    const onDisk = fs.readFileSync(path.join(S.out, a.screenshot));
    assert.ok(staged.equals(onDisk), 'the file IS the staged buffer, byte for byte');
    assert.equal(S.session.pendingShot, null, 'pending shot consumed');
  });

  await t.test('a forged save without a staged shot still gets a screenshot (fallback)', async () => {
    // Simulate the fallback path: a save arriving with no pick beforehand.
    const res = await page.evaluate(() => window.__nitSave({
      comment: 'no staging fallback', type: 'change-request', viewportScope: 'general', route: '/',
      target: {
        component: 'fake-hero', ngComponent: null, selector: '#hero-title', xpath: '/html[1]',
        tag: 'h2', classes: [], text: '', rect: { x: 20, y: 80, w: 300, h: 30 },
      },
    }));
    assert.equal(res.ok, true);
    assert.ok(res.annotation.screenshot, 'fallback capture produced a screenshot');
    const buf = fs.readFileSync(path.join(S.out, res.annotation.screenshot));
    const size = pngSize(buf);
    assert.ok(size.width >= MIN_SHOT_W - 2, 'fallback shot also carries context');
  });
});
