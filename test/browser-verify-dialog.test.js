// SPDX-License-Identifier: AGPL-3.0-or-later
// nit verify on an annotation captured inside a dialog: the recorded opener click
// is replayed automatically, so the after-shot shows the re-opened surface instead
// of the blank page the fallback used to bank. An annotation with no recorded
// opener still gets the honest recorded-region fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startFixtureServer } from './helpers/server.js';
import { startTestSession, waitFor, tmpDir } from './helpers/session.js';
import { pngSize, SHOT_PADDING, MIN_SHOT_W, MIN_SHOT_H } from '../dist/capture/screenshot.js';

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const opener = {
  selector: '#open-drawer', tag: 'button', component: 'button',
  text: 'Open checkout', at: '2026-07-20T10:00:00Z',
};

/**
 * Two annotations inside the fixture's hand-rolled drawer, identical apart from
 * the recorded way back in — the only variable this file is about. Scope is
 * pinned to desktop so the tour's auto viewport switch cannot perturb timing.
 */
function makeFeedback(url) {
  const base = {
    type: 'change-request', author: 'Kevin', viewportScope: 'desktop', status: 'fixed',
    viewport: { mode: 'desktop', w: 1440, h: 900 }, createdAt: '2026-07-20T10:00:00Z',
    route: '/dialog.html',
    target: {
      component: 'span', ngComponent: null, selector: '#drawer-total',
      xpath: '/html[1]/body[1]/div[1]/span[1]', tag: 'span', classes: [],
      text: 'Total: 12,00', rect: { x: 300, y: 200, w: 160, h: 20 },
    },
  };
  return {
    review: { id: 'verify-dialog', url: `${url}/dialog.html`, createdAt: '2026-07-20T10:00:00Z', authors: ['Kevin'] },
    annotations: [
      { ...base, id: 'a1', comment: 'Total is misaligned in the drawer', screenshot: 'shots/a1.png',
        context: { kind: 'dialog', selector: '#drawer', label: 'Checkout', reopen: [opener] } },
      // Same drawer, but nothing recorded to get back in — and a target that
      // never resolves, so the fallback is the only outcome available and the
      // assertion below cannot be won by a1 happening to leave the drawer open.
      { ...base, id: 'a2', comment: 'Same drawer, no recorded opener', screenshot: 'shots/a2.png',
        target: { ...base.target, selector: '#drawer-gone', xpath: '/html[1]/body[1]/div[99]', text: 'GONE' },
        context: { kind: 'dialog', selector: '#drawer', label: 'Checkout' } },
      // Re-open steps recorded, but its surface reads as *already open* (the
      // selector points at something always rendered) while the element itself
      // is gone — the "fix removed the element" shape. The overlay reports it
      // 'not-found', not 'dialog', so no re-open attempt is ever scheduled for
      // it. The fallback must still land rather than leave the item stuck on
      // "capturing after-shot…" for the rest of the session.
      { ...base, id: 'a3', comment: 'Steps recorded, surface open, element gone', screenshot: 'shots/a3.png',
        target: { ...base.target, selector: '#never-existed', xpath: '/html[1]/body[1]/div[98]', text: 'GONE TOO' },
        context: { kind: 'dialog', selector: '#page-title', label: 'Checkout', reopen: [opener] } },
    ],
  };
}

test('nit verify — dialogs are re-opened before the after-shot', async t => {
  const server = await startFixtureServer();
  const dir = tmpDir('nit-verify-dlg-');
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'shots', 'a1.png'), PNG_1PX);
  fs.writeFileSync(path.join(dir, 'shots', 'a2.png'), PNG_1PX);
  fs.writeFileSync(path.join(dir, 'shots', 'a3.png'), PNG_1PX);
  const reviewFile = path.join(dir, 'annotations.json');
  fs.writeFileSync(reviewFile, JSON.stringify(makeFeedback(server.url), null, 2));

  const S = await startTestSession({ mode: 'verify', url: undefined, reviewFile });
  t.after(async () => {
    await S.session.close();
    await server.close();
  });
  const page = S.session.page;
  const readFile = () => JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
  const annOf = id => readFile().annotations.find(a => a.id === id);

  await t.test('the recorded opener is clicked, and the shot is of the open drawer', async () => {
    await waitFor(() => annOf('a1').screenshotAfter ?? null,
      { message: 'a1 after-shot recorded', timeout: 25000 });

    // Assert on the artifact, not on a log line: a log saying "anchored" proves
    // nothing about what was actually cropped. The after-shot must match the
    // live #drawer-total box under the same clip rules capture shots use, which
    // is only possible if the drawer was genuinely re-opened.
    // Measure the live element, then put the page back exactly as it was —
    // directly, not via Escape, so the next subtest starts from a known state.
    const dims = await page.evaluate(() => {
      const body = document.body;
      const was = body.classList.contains('is-open');
      body.classList.add('is-open');
      const r = document.querySelector('#drawer-total').getBoundingClientRect();
      const out = {
        w: Math.round(r.width), h: Math.round(r.height),
        pageW: document.documentElement.scrollWidth, pageH: document.documentElement.scrollHeight,
      };
      if (!was) body.classList.remove('is-open');
      return out;
    });
    const size = pngSize(fs.readFileSync(path.join(dir, annOf('a1').screenshotAfter)));
    const expectW = Math.min(dims.pageW, Math.max(dims.w + SHOT_PADDING * 2, MIN_SHOT_W));
    const expectH = Math.min(dims.pageH, Math.max(dims.h + SHOT_PADDING * 2, MIN_SHOT_H));
    assert.ok(Math.abs(size.width - expectW) <= 2, `after-shot width ${size.width} ≈ ${expectW}`);
    assert.ok(Math.abs(size.height - expectH) <= 2, `after-shot height ${size.height} ≈ ${expectH}`);
    // The recorded rect is 160×20 and would have been clipped to the context
    // minimum, so these dimensions are only reachable from the real element.
    assert.ok(size.width > MIN_SHOT_W, `${size.width}px is wider than a recorded-region fallback`);
  });

  await t.test('nit closes the dialog it opened once the evidence is banked', async () => {
    await waitFor(async () => {
      const open = await page.evaluate(() => document.body.classList.contains('is-open'));
      return open ? null : true;
    }, { message: 'drawer closed again after the shot', timeout: 15000 });
  });

  await t.test('without a recorded opener the honest recorded-region fallback still lands', async () => {
    await waitFor(() => annOf('a2').screenshotAfter ?? null,
      { message: 'a2 after-shot recorded', timeout: 20000 });
    assert.ok(
      S.logs.some(l => l.startsWith('o after-shot a2') && l.includes('not re-anchored')),
      'a2 fell back to the recorded region rather than silently waiting forever',
    );
    assert.equal(S.logs.some(l => l.includes('re-opened a2')), false, 'nothing to replay, nothing clicked');
  });

  await t.test('an item whose re-open is never scheduled is not left waiting forever', async () => {
    await waitFor(() => annOf('a3').screenshotAfter ?? null,
      { message: 'a3 after-shot recorded', timeout: 20000 });
    assert.ok(
      S.logs.some(l => l.startsWith('o after-shot a3') && l.includes('not re-anchored')),
      'a3 fell back rather than stalling on an attempt that was never going to happen',
    );
  });

  await t.test('the panel offers a manual Re-open only for the item that has steps', async () => {
    const panel = S.session.panelPage;
    assert.ok(panel, 'panel window opened');
    // The queue card parks on a1 first; its dialog is closed again by now, so
    // the closed-dialog row (and its button) is what the reviewer sees.
    await waitFor(async () =>
      (await panel.locator('.vq-dialog .nit-vq-reopen-dialog').count()) === 1 ? true : null,
    { message: 'verify card offers Re-open for a1', timeout: 15000 });

    await panel.locator('.vq-dialog .nit-vq-reopen-dialog').click();
    await waitFor(async () => {
      const open = await page.evaluate(() => document.body.classList.contains('is-open'));
      return open ? true : null;
    }, { message: 'the button re-opened the drawer', timeout: 15000 });
  });
});
