// SPDX-License-Identifier: AGPL-3.0-or-later
// Viewport-anchored pins: a pin on an element inside a fixed container stays glued
// to it when the page scrolls, while a pin on normal content moves with the content
// (and leaves the viewport instead of clamping to the screen edge).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startFixtureServer } from './helpers/server.js';
import { startTestSession, waitFor, tmpDir } from './helpers/session.js';

function makeFeedback(url) {
  const ann = (id, selector, tag, text, rect) => ({
    id, type: 'change-request', comment: `pin on ${selector}`, status: 'open', author: 'Kevin',
    viewportScope: 'general', viewport: { mode: 'desktop', w: 1440, h: 900 }, route: '/',
    target: { component: tag, ngComponent: null, selector, xpath: '/html[1]', tag, classes: [], text, rect },
    screenshot: null, createdAt: '2026-07-22T10:00:00Z',
  });
  return {
    review: { id: 'pins-fixture', url: `${url}/`, createdAt: '2026-07-22T10:00:00Z', authors: ['Kevin'] },
    annotations: [
      ann('a1', '#tabbar', 'nav', '', { x: 0, y: 850, w: 1440, h: 48 }),
      ann('a2', '#hero-title', 'h2', 'Welcome to the fixture', { x: 20, y: 80, w: 300, h: 30 }),
    ],
  };
}

test('nit view — pins track fixed elements across scrolling', async t => {
  const server = await startFixtureServer();
  const dir = tmpDir('nit-pins-');
  const reviewFile = path.join(dir, 'annotations.json');
  fs.writeFileSync(reviewFile, JSON.stringify(makeFeedback(server.url), null, 2));

  const S = await startTestSession({ mode: 'view', reviewFile });
  t.after(async () => {
    await S.session.close();
    await server.close();
  });
  const page = S.session.page;

  await waitFor(async () => (await page.locator('.nit-pin').count()) === 2 ? true : null,
    { message: 'both pins placed' });

  // Screen positions of pins and their elements before scrolling.
  const before = await positions(page);
  assert.ok(near(before.tabbarPin.top, before.tabbar.top - 10), 'tabbar pin sits on the tabbar');
  assert.ok(near(before.heroPin.top, before.hero.top - 10), 'hero pin sits on the heading');

  await page.evaluate(() => window.scrollTo(0, 500));
  await page.waitForTimeout(120); // > one rAF: reposition has run
  const after = await positions(page);

  // The fixed tabbar did not move on screen — neither may its pin.
  assert.ok(near(after.tabbar.top, before.tabbar.top), 'tabbar itself is fixed');
  assert.ok(near(after.tabbarPin.top, before.tabbarPin.top), 'tabbar pin stayed glued');
  assert.ok(near(after.tabbarPin.top, after.tabbar.top - 10), 'still aligned to the tabbar');

  // Normal content moved up by the scroll distance — and so did its pin.
  assert.ok(near(after.heroPin.top, before.heroPin.top - 500), 'content pin moved with the content');
  assert.ok(after.heroPin.top < 0, 'off-viewport pin is NOT clamped to the screen edge');
});

/** Viewport (client) coordinates of both pins and their elements. */
function positions(page) {
  return page.evaluate(() => {
    const root = document.getElementById('nit-root').shadowRoot;
    const pins = [...root.querySelectorAll('.nit-pin')];
    // pins are numbered in placed order; identify by title (comment)
    const pinOf = sel => pins.find(p => p.title.includes(sel)).getBoundingClientRect();
    return {
      tabbar: document.querySelector('#tabbar').getBoundingClientRect().toJSON(),
      hero: document.querySelector('#hero-title').getBoundingClientRect().toJSON(),
      tabbarPin: pinOf('#tabbar').toJSON(),
      heroPin: pinOf('#hero-title').toJSON(),
    };
  });
}

function near(a, b, tolerance = 3) {
  return Math.abs(a - b) <= tolerance;
}
