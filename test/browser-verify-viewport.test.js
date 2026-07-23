// SPDX-License-Identifier: AGPL-3.0-or-later
// Viewport-keyed after-shots (2026-07-23 design): a general-scoped fixed item
// wants an after-shot on BOTH viewports (its fix must hold on desktop and
// mobile alike), a scoped item only ever gets its own viewport's shot, and the
// verify tour switches the live viewport automatically to collect the missing
// ones. The primary viewport's shot keeps the legacy `<id>-after.png` name and
// is mirrored in `screenshotAfter`; other modes land as `<id>-after-<mode>.png`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startFixtureServer } from './helpers/server.js';
import { startTestSession, waitFor, tmpDir } from './helpers/session.js';

const base = {
  type: 'change-request', author: 'Kevin', createdAt: '2026-07-20T10:00:00Z',
  screenshot: null, status: 'fixed', route: '/',
  target: { component: 'fake-hero', ngComponent: null, selector: '#hero-title', xpath: '/html[1]/body[1]/main[1]/fake-hero[1]/h2[1]', tag: 'h2', classes: [], text: 'Welcome to the fixture', rect: { x: 20, y: 80, w: 300, h: 30 } },
};

function makeFeedback(url, reviewId, annotations) {
  return {
    review: { id: reviewId, url: `${url}/`, createdAt: '2026-07-20T10:00:00Z', authors: ['Kevin'] },
    annotations,
  };
}

test('nit verify — a general item is captured on both viewports via the auto viewport switch', async t => {
  const server = await startFixtureServer();
  const dir = tmpDir('nit-vvp-general-');
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  const reviewFile = path.join(dir, 'annotations.json');
  fs.writeFileSync(reviewFile, JSON.stringify(makeFeedback(server.url, 'verify-vp-general', [
    { ...base, id: 'v1', comment: 'Hero heading needs work everywhere',
      viewportScope: 'general', viewport: { mode: 'desktop', w: 1440, h: 900 } },
  ]), null, 2));

  const S = await startTestSession({ mode: 'verify', url: undefined, reviewFile });
  t.after(async () => {
    await S.session.close();
    await server.close();
  });
  const page = S.session.page;
  const panel = S.session.panelPage;
  assert.ok(panel, 'panel window opened');
  const readAnn = () => JSON.parse(fs.readFileSync(reviewFile, 'utf8')).annotations[0];

  await t.test('the primary (desktop) shot lands first, on the legacy name', async () => {
    await waitFor(() => {
      const a = readAnn();
      return a.screenshotAfter === 'shots/v1-after.png'
        && a.screenshotsAfter?.desktop === 'shots/v1-after.png' ? true : null;
    }, { message: 'desktop after-shot recorded (legacy name + keyed entry)', timeout: 30000 });
    assert.ok(fs.readFileSync(path.join(dir, 'shots', 'v1-after.png')).length > 200);
    assert.equal(readAnn().screenshotsAfter.mobile, undefined, 'mobile shot not captured yet on desktop');
  });

  await t.test('the tour switches the viewport to mobile by itself and the mobile shot lands', async () => {
    // No manual action here: the panel's auto-tour sees the missing mobile shot
    // and calls __nitSetViewport('mobile') on its own.
    await waitFor(() => {
      const vp = page.viewportSize();
      return vp && vp.width === 390 && vp.height === 844 ? true : null;
    }, { message: 'site viewport auto-switched to mobile (390x844)', timeout: 30000 });

    await waitFor(() => readAnn().screenshotsAfter?.mobile === 'shots/v1-after-mobile.png' ? true : null,
      { message: 'mobile after-shot recorded under the mode-suffixed name', timeout: 30000 });
    assert.ok(fs.readFileSync(path.join(dir, 'shots', 'v1-after-mobile.png')).length > 200);
    assert.equal(readAnn().screenshotAfter, 'shots/v1-after.png',
      'screenshotAfter keeps mirroring the primary (desktop) shot');
  });

  await t.test('the panel card shows one captioned after-shot per viewport', async () => {
    // innerText reflects the rendered text, and the panel CSS uppercases the
    // caption lines — compare case-insensitively.
    await waitFor(async () => {
      const text = (await panel.locator('#verify .vq-shots').innerText()).toLowerCase();
      return text.includes('after · desktop') && text.includes('after · mobile') ? true : null;
    }, { message: 'card captions both after-shots', timeout: 30000 });
    assert.equal(await panel.locator('#verify .vq-shots img.shot').count(), 2,
      'both after-shot images rendered');
  });
});

test('nit verify — a mobile-scoped item gets exactly its own viewport shot, as the primary', async t => {
  const server = await startFixtureServer();
  const dir = tmpDir('nit-vvp-scoped-');
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  const reviewFile = path.join(dir, 'annotations.json');
  fs.writeFileSync(reviewFile, JSON.stringify(makeFeedback(server.url, 'verify-vp-scoped', [
    // Captured on desktop but scoped to mobile: the scope viewport is primary.
    { ...base, id: 'm1', comment: 'Hero heading clips on phones',
      viewportScope: 'mobile', viewport: { mode: 'desktop', w: 1440, h: 900 } },
  ]), null, 2));

  const S = await startTestSession({ mode: 'verify', url: undefined, reviewFile });
  t.after(async () => {
    await S.session.close();
    await server.close();
  });
  const page = S.session.page;
  assert.ok(S.session.panelPage, 'panel window opened');
  const readAnn = () => JSON.parse(fs.readFileSync(reviewFile, 'utf8')).annotations[0];

  await t.test('the tour switches to mobile and the shot lands under the legacy primary name', async () => {
    // The session runs desktop, but the only wanted mode is mobile — nothing may
    // be captured before the tour's automatic switch.
    await waitFor(() => {
      const vp = page.viewportSize();
      return vp && vp.width === 390 && vp.height === 844 ? true : null;
    }, { message: 'site viewport auto-switched to mobile (390x844)', timeout: 30000 });

    await waitFor(() => {
      const a = readAnn();
      return a.screenshotAfter === 'shots/m1-after.png'
        && a.screenshotsAfter?.mobile === 'shots/m1-after.png' ? true : null;
    }, { message: 'mobile shot recorded as the primary (legacy name)', timeout: 30000 });
    assert.ok(fs.readFileSync(path.join(dir, 'shots', 'm1-after.png')).length > 200);
  });

  await t.test('no desktop shot ever appears for a mobile-scoped item', async () => {
    const a = readAnn();
    assert.equal(a.screenshotsAfter.desktop, undefined, 'desktop entry stays absent');
    assert.ok(!fs.existsSync(path.join(dir, 'shots', 'm1-after-desktop.png')), 'no desktop file on disk');
  });
});
