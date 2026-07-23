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
});
