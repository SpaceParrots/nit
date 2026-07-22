// SPDX-License-Identifier: AGPL-3.0-or-later
// Milestone 11 (integration): the panel's filter dropdown sorts, groups by page,
// and collapses/expands groups on click — the current route's group starts open,
// every other group starts collapsed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startFixtureServer } from './helpers/server.js';
import { startTestSession, waitFor, tmpDir } from './helpers/session.js';

function makeFeedback(url) {
  return {
    review: { id: 'panel-fixture', url: `${url}/`, createdAt: '2026-07-20T10:00:00Z', authors: ['Kevin'] },
    annotations: [
      {
        id: 'a1', type: 'change-request', comment: 'Welcome heading tweak', status: 'open', author: 'Kevin',
        viewportScope: 'general', viewport: { mode: 'desktop', w: 1440, h: 900 }, route: '/',
        target: { component: 'fake-hero', ngComponent: null, selector: '#hero-title', xpath: '/html[1]/body[1]/main[1]/fake-hero[1]/h2[1]', tag: 'h2', classes: [], text: 'Welcome to the fixture', rect: { x: 20, y: 80, w: 300, h: 30 } },
        screenshot: null, createdAt: '2026-07-20T10:01:00Z',
      },
      {
        id: 'a2', type: 'comment', comment: 'Button label unclear', status: 'open', author: 'Kevin',
        viewportScope: 'general', viewport: { mode: 'desktop', w: 1440, h: 900 }, route: '/about',
        target: { component: 'fake-about', ngComponent: null, selector: '#cta', xpath: '/html[1]/body[1]/main[1]/fake-about[1]/button[1]', tag: 'button', classes: [], text: 'Click me', rect: { x: 20, y: 80, w: 80, h: 30 } },
        screenshot: null, createdAt: '2026-07-20T10:02:00Z',
      },
    ],
  };
}

test('nit panel — filter dropdown sort, group and collapse', async t => {
  const server = await startFixtureServer();
  const dir = tmpDir('nit-panel-');
  const reviewFile = path.join(dir, 'annotations.json');
  fs.writeFileSync(reviewFile, JSON.stringify(makeFeedback(server.url), null, 2));

  const S = await startTestSession({ mode: 'view', url: undefined, reviewFile });
  t.after(async () => {
    await S.session.close();
    await server.close();
  });

  await t.test('groups by page with the current route expanded and others collapsed', async () => {
    const panel = S.session.panelPage;
    await waitFor(async () => (await panel.locator('.nit-group').count()) >= 2 ? true : null,
      { message: 'two route groups' });
    const first = panel.locator('.nit-group').first();
    assert.equal(await first.getAttribute('data-group'), '/', 'current route first');
    assert.equal(await first.locator('.nit-item').count() > 0, true, 'current route expanded');
    const other = panel.locator('.nit-group[data-group="/about"]');
    assert.equal(await other.locator('.nit-item').count(), 0, 'other routes collapsed');
  });

  await t.test('a group header toggles its items', async () => {
    const panel = S.session.panelPage;
    await panel.locator('.nit-group[data-group="/about"] .nit-group-head').click();
    await waitFor(async () => (await panel.locator('.nit-group[data-group="/about"] .nit-item').count()) === 1
      ? true : null, { message: 'about group expands' });
    // toggling again collapses it back
    await panel.locator('.nit-group[data-group="/about"] .nit-group-head').click();
    await waitFor(async () => (await panel.locator('.nit-group[data-group="/about"] .nit-item').count()) === 0
      ? true : null, { message: 'about group collapses again' });
  });

  await t.test('switching group to none flattens the list', async () => {
    const panel = S.session.panelPage;
    await panel.locator('.nit-filter-btn').click();
    await panel.locator('.nit-group-by[data-group="none"]').click();
    await waitFor(async () => (await panel.locator('.nit-group').count()) === 0 ? true : null,
      { message: 'no group sections' });
    await waitFor(async () => (await panel.locator('.nit-item').count()) === 2 ? true : null,
      { message: 'both items shown flat' });
  });

  await t.test('sort row is present and the active sort is highlighted', async () => {
    const panel = S.session.panelPage;
    const active = panel.locator('.nit-sort.active');
    assert.equal(await active.count(), 1, 'exactly one sort option marked active');
    assert.equal(await active.getAttribute('data-sort'), 'time', 'default sort is time');
  });
});
