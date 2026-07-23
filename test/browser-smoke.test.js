// SPDX-License-Identifier: AGPL-3.0-or-later
// Milestones 1, 2, 4, 6, 9: the full capture loop against the CSP-hardened fixture SPA.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startFixtureServer } from './helpers/server.js';
import { startTestSession, waitFor, readAnnotations } from './helpers/session.js';
import { pngSize, SHOT_PADDING, MIN_SHOT_W, MIN_SHOT_H } from '../dist/capture/screenshot.js';

test('nit review — capture flow', async t => {
  const server = await startFixtureServer();
  const S = await startTestSession({ url: server.url + '/' });
  t.after(async () => {
    await S.session.close();
    await server.close();
  });
  const page = S.session.page;

  await t.test('m1: overlay boots on a CSP page and logs an overlay click', async () => {
    await waitFor(
      () => page.evaluate(() => Boolean(document.getElementById('nit-root') && document.getElementById('nit-root').shadowRoot)),
      { message: 'overlay host in page' },
    );
    await page.mouse.click(40, 300);
    await waitFor(() => S.logs.some(l => l.includes('overlay: click')), { message: 'click logged to stdout' });
    assert.ok(S.events.some(e => e && e.type === 'click'), 'click event reached the Node bridge');
  });

  await t.test('m2: Alt-pick + comment + save writes a complete annotation', async () => {
    const box = await page.locator('fake-product-tile').first().locator('.badge').boundingBox();
    await page.keyboard.press('Alt');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.locator('.nit-pop-comment').fill('Badge should be yellow, not gray');
    await page.locator('.nit-save').click();

    const data = await waitFor(() => {
      try {
        const d = readAnnotations(S.out);
        return d.annotations.length >= 1 ? d : null;
      } catch { return null; }
    }, { message: 'annotations.json written' });

    // regression: the popover must actually disappear after save
    await waitFor(async () => (await page.locator('.nit-popover').isVisible()) === false ? true : null,
      { message: 'popover hidden after save' });

    const a = data.annotations[0];
    assert.equal(a.id, 'a1');
    assert.equal(a.type, 'change-request'); // overlay default
    assert.equal(a.status, 'open');
    assert.equal(a.author, 'Tester');
    assert.equal(a.viewportScope, 'general'); // default = general (most fixes apply everywhere)
    assert.deepEqual(a.viewport, { mode: 'desktop', w: 1440, h: 900 });
    assert.equal(a.route, '/');
    assert.equal(a.comment, 'Badge should be yellow, not gray');
    assert.equal(a.target.component, 'fake-product-tile');
    assert.equal(a.target.tag, 'div');
    assert.ok(a.target.classes.includes('badge'));
    assert.match(a.target.selector, /fake-product-tile/);
    assert.match(a.target.xpath, /^\/html\[1\]/);
    assert.ok(a.target.rect.w > 0 && a.target.rect.h > 0);
    assert.ok(a.createdAt);
  });

  await t.test('m2: type + viewport-scope toggles are recorded', async () => {
    const box = await page.locator('#hero-title').boundingBox();
    await page.keyboard.press('Alt');
    await page.mouse.click(box.x + 10, box.y + 10);
    await page.locator('.nit-pop-comment').fill('Consider warmer welcome copy');
    await page.locator('.nit-seg-btn[data-value="comment"]').click();
    // General is the default now — toggling means narrowing to the viewport.
    await page.locator('.nit-seg-btn[data-value="desktop"]').click();
    await page.locator('.nit-save').click();

    const data = await waitFor(() => {
      const d = readAnnotations(S.out);
      return d.annotations.some(x => x.id === 'a2') ? d : null;
    }, { message: 'second annotation' });
    const a = data.annotations.find(x => x.id === 'a2');
    assert.equal(a.type, 'comment');
    assert.equal(a.viewportScope, 'desktop');
    assert.equal(a.target.selector, '#hero-title');
  });

  await t.test('security: bridge rejects calls from an untrusted iframe', async () => {
    const before = readAnnotations(S.out).annotations.length;
    // A third-party iframe on the reviewed page can see the __nit* bindings, but
    // its calls must be rejected — it can't delete or forge annotations.
    const result = await page.evaluate(async () => {
      const f = document.createElement('iframe');
      f.srcdoc = '<!doctype html><title>ad</title>';
      document.body.appendChild(f);
      await new Promise(r => (f.onload = r));
      const w = f.contentWindow;
      const del = w.__nitDelete ? await w.__nitDelete('a1') : { noBinding: true };
      const save = w.__nitSave ? await w.__nitSave({
        comment: 'forged from iframe', type: 'change-request',
        target: { component: 'x', selector: 'x', xpath: '/x', tag: 'x', classes: [], text: '', rect: { x: 0, y: 0, w: 1, h: 1 } },
        route: '/',
      }) : { noBinding: true };
      f.remove();
      return { del, save };
    });
    // Bindings exist in the frame but reject; a1 is still present, nothing forged.
    assert.equal(result.del.ok, false);
    assert.equal(result.save.ok, false);
    const after = readAnnotations(S.out).annotations;
    assert.equal(after.length, before, 'no annotation added or removed by the iframe');
    assert.ok(after.some(x => x.id === 'a1'), 'a1 not deleted by the iframe');
  });

  await t.test('m2: Esc cancels picking', async () => {
    await page.keyboard.press('Alt');
    assert.equal(await page.evaluate(() => document.documentElement.style.cursor), 'crosshair');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.documentElement.style.cursor), '');
  });

  await t.test('m4: screenshot is a non-empty PNG with minimum context size', async () => {
    const data = readAnnotations(S.out);
    const a = data.annotations.find(x => x.id === 'a1');
    assert.ok(a.screenshot, 'annotation has a screenshot');
    const buf = fs.readFileSync(path.join(S.out, a.screenshot));
    assert.ok(buf.length > 200, 'png is not empty');
    const size = pngSize(buf);
    const r = a.target.rect;
    // The badge is small, so the clip expands to the context minimum — a tight
    // rect+padding crop is useless to the fixing agent.
    assert.ok(r.w + SHOT_PADDING * 2 < MIN_SHOT_W, 'fixture element is genuinely small');
    assert.ok(Math.abs(size.width - MIN_SHOT_W) <= 2, `png width ${size.width} ≈ ${MIN_SHOT_W}`);
    assert.ok(Math.abs(size.height - MIN_SHOT_H) <= 2, `png height ${size.height} ≈ ${MIN_SHOT_H}`);
  });

  await t.test('m6: viewport switch via the panel window, recorded on annotations', async () => {
    const panel = S.session.panelPage;
    assert.ok(panel, 'panel window opened');
    await panel.locator('.nit-vp-mobile').click();
    await waitFor(() => {
      const vp = page.viewportSize();
      return vp && vp.width === 390 && vp.height === 844 ? true : null;
    }, { message: 'page viewport switched to mobile' });

    // Save via the bridge directly: a payload without a scope defaults to
    // 'general' (the popover always sends one; this is the programmatic path).
    const res = await page.evaluate(() => {
      const el = document.querySelector('#hero-title');
      const r = el.getBoundingClientRect();
      return window.__nitSave({
        comment: 'Mobile: heading wraps awkwardly',
        type: 'change-request',
        target: {
          component: 'fake-hero', ngComponent: null, selector: '#hero-title',
          xpath: '/html[1]/body[1]/main[1]/fake-hero[1]/h2[1]', tag: 'h2', classes: [], text: 'Welcome to the fixture',
          rect: { x: Math.round(r.x + scrollX), y: Math.round(r.y + scrollY), w: Math.round(r.width), h: Math.round(r.height) },
        },
        route: location.pathname,
      });
    });
    assert.ok(res.ok);
    assert.deepEqual(res.annotation.viewport, { mode: 'mobile', w: 390, h: 844 });
    assert.equal(res.annotation.viewportScope, 'general');

    await panel.locator('.nit-vp-desktop').click();
    await waitFor(() => {
      const vp = page.viewportSize();
      return vp && vp.width === 1440 ? true : null;
    }, { message: 'back to desktop' });
    // the panel window itself must never be resized by viewport switching
    assert.equal(panel.viewportSize().width, 344);
  });

  await t.test('m9: delete removes annotation + shot, finish flushes and closes', async () => {
    const before = readAnnotations(S.out);
    const doomed = before.annotations.find(a => a.id === 'a3');
    assert.ok(doomed, 'a3 exists before delete');
    const shotFile = doomed.screenshot ? path.join(S.out, doomed.screenshot) : null;

    const res = await page.evaluate(() => window.__nitDelete('a3'));
    assert.ok(res.ok);
    await waitFor(() => {
      const d = readAnnotations(S.out);
      return d.annotations.every(a => a.id !== 'a3') ? true : null;
    }, { message: 'annotation removed from file' });
    if (shotFile) assert.ok(!fs.existsSync(shotFile), 'screenshot file deleted');

    await page.evaluate(() => window.__nitFinish());
    await S.session.done;
    assert.ok(fs.existsSync(path.join(S.out, 'review.md')), 'review.md flushed');
    assert.ok(fs.existsSync(path.join(S.out, 'fix-annotations.md')), 'fix-annotations.md flushed');
    const finalData = readAnnotations(S.out);
    assert.equal(finalData.annotations.length, 2);
  });
});
