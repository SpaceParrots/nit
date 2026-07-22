// SPDX-License-Identifier: AGPL-3.0-or-later
// Click-history trail (integration): real page clicks are recorded, picking clicks
// and nit's own UI are not, the trail rides along on save, and a pathname change
// resets it while staying alive across annotations on the same page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureServer } from './helpers/server.js';
import { startTestSession, waitFor, readAnnotations } from './helpers/session.js';

test('nit review — click trail', async t => {
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

  const save = async comment => {
    const box = await page.locator('#hero-title').boundingBox();
    await page.keyboard.press('Alt');
    await page.mouse.click(box.x + 10, box.y + 10);
    await page.locator('.nit-pop-comment').fill(comment);
    await page.locator('.nit-save').click();
    return waitFor(() => {
      try {
        const d = readAnnotations(S.out);
        return d.annotations.find(x => x.comment === comment) ?? null;
      } catch { return null; } // annotations.json not written yet
    }, { message: `annotation "${comment}" written` });
  };

  await t.test('page clicks are recorded and ride along on save; picking clicks are not', async () => {
    await page.locator('#long-text').click();
    await page.locator('#hero-title').click();

    const a = await save('first with trail');
    assert.ok(Array.isArray(a.history), 'history stored');
    assert.deepEqual(a.history.map(s => s.selector), ['#long-text', '#hero-title'], 'both clicks, in order');
    const [longText, heroTitle] = a.history;
    assert.equal(longText.tag, 'p');
    assert.equal(longText.component, 'p', 'no custom-element ancestor — falls back to own tag');
    assert.ok(longText.text.length > 0 && longText.text.length <= 80, 'text captured and capped');
    assert.match(longText.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(heroTitle.component, 'fake-hero', 'custom-element ancestor recorded');
    // the Alt-pick selection click and the popover Save click are NOT in the trail
    assert.equal(a.history.some(s => s.selector.includes('nit')), false);
  });

  await t.test('the trail survives a save — a second annotation carries the same steps', async () => {
    const b = await save('second same page');
    assert.deepEqual(
      b.history.map(s => s.selector),
      ['#long-text', '#hero-title'],
      'not cleared by the first save',
    );
  });

  await t.test('a pathname change resets the trail', async () => {
    await page.locator('a[data-route="/about"]').click(); // recorded on "/", then navigates
    await waitFor(() => page.evaluate(() => location.pathname === '/about'), { message: 'on /about' });
    await page.locator('#cta').click();

    const box = await page.locator('#cta').boundingBox();
    await page.keyboard.press('Alt');
    await page.mouse.click(box.x + 5, box.y + 5);
    await page.locator('.nit-pop-comment').fill('about page annotation');
    await page.locator('.nit-save').click();
    const a = await waitFor(() => {
      const d = readAnnotations(S.out);
      return d.annotations.find(x => x.comment === 'about page annotation') ?? null;
    }, { message: 'about annotation written' });

    assert.equal(a.route, '/about');
    assert.deepEqual(a.history.map(s => s.selector), ['#cta'], 'only the click made on /about');
  });

  await t.test('an annotation saved with no prior clicks has no history field', async () => {
    // navigate home — fresh pathname, no clicks yet except the nav link click made on /about
    await page.locator('a[data-route="/"]').click();
    await waitFor(() => page.evaluate(() => location.pathname === '/'), { message: 'back home' });
    const a = await save('no clicks before this');
    assert.equal('history' in a, false, 'field absent, not an empty array');
  });
});
