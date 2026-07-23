// SPDX-License-Identifier: AGPL-3.0-or-later
// Re-anchor reliability: review-mode retry cycle after slow SPA route changes,
// and MutationObserver-driven recovery when an SPA re-render replaces DOM nodes.
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { startFixtureServer } from './helpers/server.js';
import { startTestSession, waitFor, tmpDir } from './helpers/session.js';

const ANN = {
  id: 'a1', type: 'change-request', author: 'Kevin', status: 'open', viewportScope: 'general',
  viewport: { mode: 'desktop', w: 1280, h: 720 }, createdAt: '2026-07-23T10:00:00Z',
  route: '/about', comment: 'About paragraph wording', screenshot: null,
  target: { component: 'fake-about', ngComponent: null, selector: 'fake-about p.about-text',
    xpath: '/html[1]/body[1]/main[1]/fake-about[1]/p[1]', tag: 'p', classes: ['about-text'],
    text: 'About page paragraph', rect: { x: 20, y: 60, w: 300, h: 20 } },
};

function writeReview(dir, url) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'annotations.json'), JSON.stringify({
    review: { id: 'reanchor-fixture', url: `${url}/`, createdAt: '2026-07-23T10:00:00Z', authors: ['Kevin'] },
    annotations: [ANN],
  }, null, 2));
}

test('overlay re-anchoring', async t => {
  const server = await startFixtureServer();
  let S;
  t.after(async () => {
    await S?.session.close();
    await server.close();
  });

  await t.test('review mode: pins appear after a slow SPA route render (retry cycle)', async () => {
    const out = tmpDir('nit-retry-');
    writeReview(out, server.url);
    S = await startTestSession({ mode: 'review', out, url: `${server.url}/` });
    const page = S.session.page;
    await waitFor(() => S.session.uiState.route !== undefined ? true : null, { message: 'overlay up', timeout: 15000 });

    // SPA-navigate to a route that renders 2.5s later — beyond the fixed
    // 300ms/1500ms post-route refreshes, so only the retry cycle can catch it.
    await page.evaluate(() => {
      history.pushState({}, '', '/about?slow');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() => S.session.uiState.placed?.some(p => p.id === 'a1') ? true : null,
      { message: 'a1 placed after slow render', timeout: 15000 });
    await S.session.close();
    S = null;
  });

  await t.test('view mode: a DOM re-render that replaces nodes re-anchors pins (MutationObserver)', async () => {
    const dir = tmpDir('nit-mutate-');
    writeReview(dir, server.url);
    S = await startTestSession({ mode: 'view', url: undefined, reviewFile: path.join(dir, 'annotations.json') });
    const page = S.session.page;

    await page.evaluate(() => {
      history.pushState({}, '', '/about');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() => S.session.uiState.placed?.some(p => p.id === 'a1') ? true : null,
      { message: 'a1 placed', timeout: 15000 });

    // The retry cycle stops after its first tick once everything is placed,
    // but that stopping tick is still pending (restartAnchors() above queued
    // one ~1s out). Wait it out so the cycle is fully drained before the
    // mutation below — otherwise that pending tick, not the observer, could
    // be what re-anchors the pin, making this test pass for the wrong reason.
    await new Promise(r => setTimeout(r, 1600));

    // Replace every node under #app with fresh clones (what SPA re-renders do),
    // and prepend a spacer so the new paragraph renders 40px lower than the
    // detached original. A stale pin (never re-anchored) keeps the OLD
    // position forever — nothing but a fresh render() moves it — so this
    // makes the assertion below fail definitively without re-anchoring,
    // instead of coincidentally matching because the layout didn't move.
    // No route change, no annotation change: only the MutationObserver can see it.
    await page.evaluate(() => {
      const app = document.getElementById('app');
      app.innerHTML = '<div style="height:40px"></div>' + app.innerHTML;
    });
    // The overlay must (a) report a fresh placed rect for the NEW node and
    // (b) not leave the pin tracking the detached one.
    await waitFor(async () => {
      const ok = await page.evaluate(() => {
        const root = document.getElementById('nit-root').shadowRoot;
        const pin = root.querySelector('.nit-pin');
        if (!pin || pin.style.visibility === 'hidden') return false;
        const el = document.querySelector('fake-about p.about-text');
        const r = el.getBoundingClientRect();
        return Math.abs(parseFloat(pin.style.left) - (r.left - 10)) < 2
          && Math.abs(parseFloat(pin.style.top) - (r.top - 10)) < 2;
      });
      return ok ? true : null;
    }, { message: 'pin re-anchored to the replacing node', timeout: 5000 });
    await S.session.close();
    S = null;
  });
});
