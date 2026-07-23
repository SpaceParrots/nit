// SPDX-License-Identifier: AGPL-3.0-or-later
// Overlay placement classification (spec: docs/superpowers/specs/2026-07-23-overlay-placement-design.md):
// visibility-aware anchoring, dialog/viewport/not-found hidden reasons, ghost pins, hidden pill.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startFixtureServer } from './helpers/server.js';
import { startTestSession, waitFor, tmpDir } from './helpers/session.js';

const BASE = {
  type: 'change-request', author: 'Kevin', status: 'open', viewportScope: 'general',
  viewport: { mode: 'desktop', w: 1280, h: 720 }, createdAt: '2026-07-23T10:00:00Z',
  route: '/replay.html', screenshot: null,
};

function target(overrides) {
  return {
    component: 'fake-nav', ngComponent: null, selector: '#no-such', xpath: '/html[1]/body[1]/div[99]',
    tag: 'a', classes: [], text: '', rect: { x: 0, y: 0, w: 0, h: 0 }, ...overrides,
  };
}

function writeReview(dir, url, annotations) {
  const file = path.join(dir, 'annotations.json');
  fs.writeFileSync(file, JSON.stringify({
    review: { id: 'placement-fixture', url: `${url}/replay.html`, createdAt: '2026-07-23T10:00:00Z', authors: ['Kevin'] },
    annotations,
  }, null, 2));
  return file;
}

test('overlay placement', async t => {
  const server = await startFixtureServer();
  let S;
  t.after(async () => {
    await S?.session.close();
    await server.close();
  });

  await t.test('anchoring prefers the visible responsive twin over the hidden selector match', async () => {
    const dir = tmpDir('nit-place-');
    const reviewFile = writeReview(dir, server.url, [
      { ...BASE, id: 'a1', comment: 'Rename the products link',
        target: target({
          selector: '#nav-desktop a.nav-link',
          xpath: '/html[1]/body[1]/fake-nav[1]/div[1]/a[1]',
          text: 'Products',
          rect: { x: 20, y: 60, w: 80, h: 18 },
        }) },
    ]);
    S = await startTestSession({ mode: 'view', url: undefined, reviewFile });
    const page = S.session.page;

    await waitFor(() => S.session.uiState.placed?.some(p => p.id === 'a1') ? true : null,
      { message: 'a1 placed', timeout: 15000 });
    const placedRect = S.session.uiState.placed.find(p => p.id === 'a1').rect;
    const visibleRect = await page.evaluate(() => {
      const r = document.querySelector('#nav-mobile a.nav-link').getBoundingClientRect();
      return { x: Math.round(r.x + scrollX), y: Math.round(r.y + scrollY), w: Math.round(r.width) };
    });
    assert.equal(placedRect.x, visibleRect.x);
    assert.equal(placedRect.y, visibleRect.y);
    assert.equal(placedRect.w, visibleRect.w);
    await S.session.close();
    S = null;
  });

  await t.test('classification: dialog / viewport / not-found reasons and approx rects', async () => {
    const dir = tmpDir('nit-class-');
    const reviewFile = writeReview(dir, server.url, [
      // in the (closed) <dialog> — context recorded at capture time
      { ...BASE, id: 'd1', comment: 'Dialog button label',
        context: { kind: 'dialog', selector: '#dlg', label: 'Checkout' },
        target: target({ component: 'dialog', selector: '#dlg-save', xpath: '/html[1]/body[1]/dialog[1]/button[1]', tag: 'button', text: 'Save order', rect: { x: 100, y: 200, w: 90, h: 30 } }) },
      // mobile-scoped — session runs desktop, so it must be viewport-hidden
      { ...BASE, id: 'm1', comment: 'Mobile spacing', viewportScope: 'mobile',
        viewport: { mode: 'mobile', w: 390, h: 844 },
        target: target({ selector: '#present', xpath: '/html[1]/body[1]/p[1]', tag: 'p', text: 'Always here' }) },
      // gone element, page context, same viewport → approx ghost rect
      { ...BASE, id: 'g1', comment: 'Removed banner',
        target: target({ selector: '#never', xpath: '/html[1]/body[1]/div[42]', tag: 'div', text: 'NO SUCH TEXT ANYWHERE', component: 'no-such-component', rect: { x: 40, y: 900, w: 200, h: 50 } }) },
      // gone element captured at the OTHER viewport → rect meaningless → not-found
      { ...BASE, id: 'g2', comment: 'Removed mobile banner', viewport: { mode: 'mobile', w: 390, h: 844 },
        target: target({ selector: '#never2', xpath: '/html[1]/body[1]/div[43]', tag: 'div', text: 'ALSO NO SUCH TEXT', component: 'no-such-component', rect: { x: 10, y: 500, w: 100, h: 40 } }) },
    ]);
    S = await startTestSession({ mode: 'view', url: undefined, reviewFile });
    const page = S.session.page;

    await waitFor(() => {
      const h = S.session.uiState.hidden ?? [];
      return h.some(x => x.id === 'd1') && h.some(x => x.id === 'm1') && h.some(x => x.id === 'g2')
        && (S.session.uiState.approx ?? []).some(x => x.id === 'g1') ? true : null;
    }, { message: 'classification reported', timeout: 15000 });

    const hidden = new Map(S.session.uiState.hidden.map(h => [h.id, h]));
    assert.deepEqual(hidden.get('d1'), { id: 'd1', reason: 'dialog', label: 'Checkout' });
    assert.equal(hidden.get('m1').reason, 'viewport');
    assert.equal(hidden.get('g2').reason, 'not-found');
    // approx carries the recorded rect; its id also counts as unplaced (verify contract)
    assert.deepEqual(S.session.uiState.approx.find(a => a.id === 'g1').rect, { x: 40, y: 900, w: 200, h: 50 });
    assert.ok(S.session.uiState.unplaced.includes('g1'));
    assert.ok(S.session.uiState.unplaced.includes('d1'));
    assert.ok(!S.session.uiState.unplaced.includes('m1'), 'viewport-filtered ids stay out of unplaced');

    // opening the dialog re-anchors d1 into placed (the MutationObserver from
    // Task 6 makes this instant; until then the 1s retry cycle covers it)
    await page.evaluate(() => document.getElementById('dlg').showModal());
    await waitFor(() => S.session.uiState.placed?.some(p => p.id === 'd1') ? true : null,
      { message: 'd1 placed once dialog opens', timeout: 15000 });
    await S.session.close();
    S = null;
  });

  await t.test('ghost pin renders dashed at the recorded rect; placed pins stay numbered first', async () => {
    const dir = tmpDir('nit-ghost-');
    const reviewFile = writeReview(dir, server.url, [
      { ...BASE, id: 'p1', comment: 'Title casing',
        target: target({ selector: '#page-title', xpath: '/html[1]/body[1]/h1[1]', tag: 'h1', text: 'Replay fixture', component: 'h1', rect: { x: 20, y: 20, w: 200, h: 30 } }) },
      { ...BASE, id: 'g1', comment: 'Removed banner',
        target: target({ selector: '#never', text: 'NO SUCH TEXT ANYWHERE', component: 'no-such-component', rect: { x: 40, y: 300, w: 200, h: 50 } }) },
    ]);
    S = await startTestSession({ mode: 'view', url: undefined, reviewFile });
    const page = S.session.page;

    await waitFor(() => (S.session.uiState.approx ?? []).some(a => a.id === 'g1') ? true : null,
      { message: 'g1 approx', timeout: 15000 });
    const pins = await page.evaluate(() => {
      const root = document.getElementById('nit-root').shadowRoot;
      return [...root.querySelectorAll('.nit-pin')].map(p => ({
        n: p.textContent, approx: p.classList.contains('nit-pin--approx'),
        left: p.style.left, top: p.style.top,
      }));
    });
    assert.deepEqual(pins.map(p => [p.n, p.approx]), [['1', false], ['2', true]]);
    // page not scrolled → viewport coords equal page coords, offset by the 10px pin nudge
    assert.equal(pins[1].left, `${40 - 10}px`);
    assert.equal(pins[1].top, `${300 - 10}px`);
    await S.session.close();
    S = null;
  });
});
