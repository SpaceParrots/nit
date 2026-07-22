// SPDX-License-Identifier: AGPL-3.0-or-later
// Regression coverage: `__nitGoTo` must resolve an annotation's route against the
// origin the SESSION actually opened, never against `review.url` from the shared,
// agent-written annotations file. Driving the real binding through a fake
// BrowserContext/Page keeps this a unit test — a full Chromium run would need a
// second origin just to observe the gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { wireBridge } from '../dist/browser/bridge.js';
import { createStore } from '../dist/store/store.js';
import { tmpDir } from './helpers/tmp.js';

function makeStore(reviewUrl, route) {
  const dir = tmpDir('nit-bridge-');
  fs.writeFileSync(path.join(dir, 'annotations.json'), JSON.stringify({
    review: { id: 'r', url: reviewUrl, createdAt: '2026-07-20T10:00:00Z', authors: ['Kevin'] },
    annotations: [{
      id: 'a1', type: 'change-request', comment: 'c', status: 'open', author: 'Kevin',
      viewportScope: 'general', viewport: { mode: 'desktop', w: 1440, h: 900 }, route,
      target: {}, screenshot: null, createdAt: '2026-07-20T10:01:00Z',
    }],
  }, null, 2));
  return createStore(dir);
}

/** A minimal stand-in for the site Page: records the url `__nitGoTo` navigates to. */
function makeSitePage(currentUrl) {
  const frame = { name: 'main' };
  const navigations = [];
  return {
    navigations,
    frame,
    page: {
      mainFrame: () => frame,
      url: () => currentUrl,
      goto: async url => { navigations.push(url); },
    },
  };
}

/** Wire the real bridge onto fakes and hand back the `__nitGoTo` binding. */
async function wireGoTo({ targetUrl, reviewUrl, route, currentUrl }) {
  const store = makeStore(reviewUrl, route);
  const site = makeSitePage(currentUrl);
  const bindings = new Map();
  const context = { exposeBinding: (name, fn) => { bindings.set(name, fn); return Promise.resolve(); } };
  const session = {
    mode: 'view', author: 'Tester', debug: false, viewportMode: 'desktop',
    store, targetUrl, context,
    page: site.page, sitePage: site.page, panelPage: null,
    uiState: {}, pendingFocus: null, _closing: false,
    log: () => {},
    flush: () => {},
  };
  await wireBridge(context, session);
  const goTo = bindings.get('__nitGoTo');
  return {
    site,
    session,
    call: id => goTo({ context, page: site.page, frame: site.frame }, id),
  };
}

test('bridge: __nitGoTo resolves against the session url, not the file\'s review.url', async () => {
  // `nit view feedback.json --url http://localhost:4200` — the file still says staging.
  const { site, call } = await wireGoTo({
    targetUrl: 'http://localhost:4200/',
    reviewUrl: 'https://staging.example.com/',
    route: '/products',
    currentUrl: 'http://localhost:4200/',
  });

  const res = await call('a1');
  assert.equal(res.ok, true);
  assert.equal(res.url, 'http://localhost:4200/products', 'resolved on the session origin');
  assert.deepEqual(site.navigations, ['http://localhost:4200/products'],
    'the site page never navigates to the origin recorded in the file');
});

test('bridge: __nitGoTo rejects a route that only matches the file\'s review.url', async () => {
  // A shared / agent-written file claims a foreign origin; the session opened
  // mysite.com. The route is same-origin with the FILE, so an unfixed gate would
  // navigate the reviewer's browser — and hand evil.test full bridge trust.
  const { site, call } = await wireGoTo({
    targetUrl: 'https://mysite.com/',
    reviewUrl: 'https://evil.test/',
    route: 'https://evil.test/steal',
    currentUrl: 'https://mysite.com/',
  });

  const res = await call('a1');
  assert.equal(res.ok, false, 'off-session-origin route rejected');
  assert.match(res.error, /not on the review origin/);
  assert.deepEqual(site.navigations, [], 'no navigation happened');
});
