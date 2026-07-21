// Milestone 7 (integration): nit view replays a feedback file — right pins on the
// right route/viewport, unanchorable items degrade to "couldn't place", no crash.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startFixtureServer } from './helpers/server.js';
import { startTestSession, waitFor, tmpDir } from './helpers/session.js';

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function makeFeedback(url) {
  return {
    review: { id: 'fixture-review', url: `${url}/`, createdAt: '2026-07-20T10:00:00Z', authors: ['Kevin'] },
    annotations: [
      {
        id: 'a1', type: 'change-request', comment: 'Welcome heading tweak', status: 'open', author: 'Kevin',
        viewportScope: 'general', viewport: { mode: 'desktop', w: 1440, h: 900 }, route: '/',
        target: { component: 'fake-hero', ngComponent: null, selector: '#hero-title', xpath: '/html[1]/body[1]/main[1]/fake-hero[1]/h2[1]', tag: 'h2', classes: [], text: 'Welcome to the fixture', rect: { x: 20, y: 80, w: 300, h: 30 } },
        screenshot: 'shots/a1.png', createdAt: '2026-07-20T10:01:00Z',
      },
      {
        id: 'a2', type: 'change-request', comment: 'Ghost element', status: 'open', author: 'Kevin',
        viewportScope: 'general', viewport: { mode: 'desktop', w: 1440, h: 900 }, route: '/',
        target: { component: 'no-such-component', ngComponent: null, selector: '#gone-element', xpath: '/html[1]/body[1]/div[99]', tag: 'div', classes: ['vanished'], text: 'TEXT THAT EXISTS NOWHERE AT ALL', rect: { x: 0, y: 0, w: 10, h: 10 } },
        screenshot: null, createdAt: '2026-07-20T10:02:00Z',
      },
      {
        id: 'a3', type: 'comment', comment: 'Button label unclear', status: 'open', author: 'Kevin',
        viewportScope: 'general', viewport: { mode: 'desktop', w: 1440, h: 900 }, route: '/about',
        target: { component: 'fake-about', ngComponent: null, selector: '#cta', xpath: '/html[1]/body[1]/main[1]/fake-about[1]/button[1]', tag: 'button', classes: [], text: 'Click me', rect: { x: 20, y: 80, w: 80, h: 30 } },
        screenshot: null, createdAt: '2026-07-20T10:03:00Z',
      },
      {
        id: 'a4', type: 'change-request', comment: 'Lead text too wide on phones', status: 'open', author: 'Kevin',
        viewportScope: 'mobile', viewport: { mode: 'mobile', w: 390, h: 844 }, route: '/',
        target: { component: 'fake-hero', ngComponent: null, selector: 'fake-hero p.lead', xpath: '/html[1]/body[1]/main[1]/fake-hero[1]/p[1]', tag: 'p', classes: ['lead', 'intro'], text: '', rect: { x: 20, y: 120, w: 300, h: 20 } },
        screenshot: null, createdAt: '2026-07-20T10:04:00Z',
      },
    ],
  };
}

test('nit view — replay flow', async t => {
  const server = await startFixtureServer();
  const dir = tmpDir('nit-view-');
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'shots', 'a1.png'), PNG_1PX);
  const reviewFile = path.join(dir, 'annotations.json');
  fs.writeFileSync(reviewFile, JSON.stringify(makeFeedback(server.url), null, 2));

  const S = await startTestSession({ mode: 'view', url: undefined, reviewFile });
  t.after(async () => {
    await S.session.close();
    await server.close();
  });
  const page = S.session.page;

  await t.test('desktop "/" shows the anchorable general pin only', async () => {
    await waitFor(async () => (await page.locator('.nit-pin').count()) === 1 ? true : null, { message: 'one pin on /' });
    assert.equal(await page.locator('.nit-pin').first().getAttribute('title'), 'Welcome heading tweak');
  });

  await t.test('unanchorable annotation degrades to the couldn\'t-place list (panel)', async () => {
    const panel = S.session.panelPage;
    assert.ok(panel, 'panel window opened');
    await waitFor(async () => (await panel.locator('.nit-item--unplaced').count()) === 1 ? true : null,
      { message: 'unplaced item in panel' });
    const text = await panel.locator('.unplaced').textContent();
    assert.ok(text.includes('Ghost element'));
    // and the page is still alive — no crash
    assert.equal(await page.evaluate(() => 1 + 1), 2);
  });

  await t.test('SPA route change re-anchors: /about shows its own pin', async () => {
    await page.locator('a[data-route="/about"]').click();
    await waitFor(() => page.evaluate(() => location.pathname === '/about'), { message: 'route change' });
    await waitFor(async () => {
      if ((await page.locator('.nit-pin').count()) !== 1) return null;
      return (await page.locator('.nit-pin').first().getAttribute('title')) === 'Button label unclear' ? true : null;
    }, { message: 'about pin replaces home pin' });
    await waitFor(async () => (await S.session.panelPage.locator('.nit-item--unplaced').count()) === 0 ? true : null,
      { message: 'unplaced list empty on /about' });
  });

  await t.test('viewport filter: mobile mode reveals the mobile-scoped pin', async () => {
    await page.locator('a[data-route="/"]').click();
    await waitFor(() => page.evaluate(() => location.pathname === '/'), { message: 'back home' });
    await waitFor(async () => (await page.locator('.nit-pin').count()) === 1 ? true : null, { message: 'general pin back' });

    const panel = S.session.panelPage;
    await panel.locator('.nit-vp-mobile').click();
    await waitFor(() => {
      const vp = page.viewportSize();
      return vp && vp.width === 390 ? true : null;
    }, { message: 'viewport switched' });
    await waitFor(async () => (await page.locator('.nit-pin').count()) === 2 ? true : null, { message: 'general + mobile pins' });

    // showing all scopes is a toggle away
    await panel.locator('.nit-filter').click();
    await waitFor(async () => (await page.locator('.nit-pin').count()) === 2 ? true : null, { message: 'all pins (a4 still anchorable)' });
  });
});
