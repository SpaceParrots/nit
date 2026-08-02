// SPDX-License-Identifier: AGPL-3.0-or-later
// The replay is the one thing nit clicks on a live page by itself, and its
// selectors come out of a shared, hand-editable, agent-written file. These
// cover the guards that keeps that safe, and the replay-mode half of the
// feature (`nit view` offers the same Re-open button the verify card does).
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

const step = (selector, text) => ({ selector, tag: 'button', component: 'button', text, at: '2026-07-20T10:00:00Z' });

function write(dir, url, annotations, route = '/dialog.html') {
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  for (const a of annotations) fs.writeFileSync(path.join(dir, 'shots', `${a.id}.png`), PNG_1PX);
  const file = path.join(dir, 'annotations.json');
  fs.writeFileSync(file, JSON.stringify({
    review: { id: 'safety', url: `${url}${route}`, createdAt: '2026-07-20T10:00:00Z', authors: ['Kevin'] },
    annotations: annotations.map(a => ({
      type: 'change-request', author: 'Kevin', viewportScope: 'desktop',
      viewport: { mode: 'desktop', w: 1440, h: 900 }, createdAt: '2026-07-20T10:00:00Z',
      route, screenshot: `shots/${a.id}.png`,
      target: {
        component: 'span', ngComponent: null, selector: '#drawer-total',
        xpath: '/html[1]/body[1]/div[2]/span[1]', tag: 'span', classes: [],
        text: 'Total: 12,00', rect: { x: 300, y: 200, w: 160, h: 20 },
      },
      ...a,
    })),
  }, null, 2));
  return file;
}

test('a crafted re-open step cannot navigate the session off the review origin', async t => {
  const server = await startFixtureServer();
  // A second server on its own port — a genuinely different origin, which is
  // what the guard compares against.
  const elsewhere = await startFixtureServer();
  const dir = tmpDir('nit-reopen-origin-');
  // The step clicks a link pointing at that origin. Bridge access is gated on
  // page *identity*, not origin, so a site page that wandered off would keep
  // __nitSave/__nitShot/… — exactly what __nitGoTo refuses to allow.
  const reviewFile = write(dir, server.url, [{
    id: 'a1', comment: 'crafted', status: 'fixed',
    context: { kind: 'dialog', selector: '#drawer', label: 'Checkout', reopen: [step('#leave-origin', 'Elsewhere')] },
  }], `/dialog.html?away=${encodeURIComponent(`${elsewhere.url}/dialog.html`)}`);
  const S = await startTestSession({ mode: 'verify', url: undefined, reviewFile });
  t.after(async () => {
    await S.session.close();
    await server.close();
    await elsewhere.close();
  });

  await waitFor(() => S.logs.some(l => l.includes('abandoned re-open of a1')) || null,
    { message: 'the replay is abandoned', timeout: 25000 });
  assert.ok(
    S.logs.some(l => l.includes('off the review origin')),
    `the reason is the origin, not a generic failure — logs:\n${S.logs.join('\n')}`,
  );
  const origin = await S.session.page.evaluate(() => location.origin);
  assert.equal(origin, new URL(server.url).origin, 'the session is back on the origin it opened');

  // The evidence still lands: an abandoned re-open falls through to the honest
  // recorded-region fallback rather than stalling the queue.
  await waitFor(() => JSON.parse(fs.readFileSync(reviewFile, 'utf8')).annotations[0].screenshotAfter ?? null,
    { message: 'a1 still gets its fallback after-shot', timeout: 25000 });
});

test('nit view offers the same Re-open button on a dialog-hidden row', async t => {
  const server = await startFixtureServer();
  const dir = tmpDir('nit-reopen-view-');
  const reviewFile = write(dir, server.url, [{
    id: 'a1', comment: 'Total is misaligned', status: 'open',
    context: { kind: 'dialog', selector: '#drawer', label: 'Checkout', reopen: [step('#open-drawer', 'Open checkout')] },
  }]);
  const S = await startTestSession({ mode: 'view', url: undefined, reviewFile });
  t.after(async () => {
    await S.session.close();
    await server.close();
  });
  const panel = S.session.panelPage;
  assert.ok(panel, 'panel window opened');

  // The drawer is closed, so the annotation lands in "couldn't place on this
  // page" — with a way back in rather than a dead end.
  const btn = panel.locator('#unplaced-list .nit-reopen-dialog');
  await waitFor(async () => (await btn.count()) === 1 ? true : null,
    { message: 'replay offers Re-open', timeout: 20000 });

  await btn.click();
  await waitFor(async () => {
    const open = await S.session.page.evaluate(() => document.body.classList.contains('is-open'));
    return open ? true : null;
  }, { message: 'the drawer re-opened from replay mode', timeout: 20000 });

  // And once it is open the pin places normally, so the row leaves the section.
  await waitFor(async () => (await btn.count()) === 0 ? true : null,
    { message: 'the row is placed once the dialog is open', timeout: 20000 });
});
