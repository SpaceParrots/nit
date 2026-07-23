// SPDX-License-Identifier: AGPL-3.0-or-later
// Milestone 10 (SPEC §12): nit verify captures after-shots for fixed annotations and
// lets the human rule verified/reopened from the panel. Open annotations are untouched.
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

function makeFeedback(url) {
  const base = {
    // Pinned to 'desktop': a 'general' scope wants a mobile after-shot too, and the
    // tour's auto viewport switch would perturb the dimension/timing assertions here.
    type: 'change-request', author: 'Kevin', viewportScope: 'desktop',
    viewport: { mode: 'desktop', w: 1440, h: 900 }, createdAt: '2026-07-20T10:00:00Z',
  };
  return {
    review: { id: 'verify-fixture', url: `${url}/`, createdAt: '2026-07-20T10:00:00Z', authors: ['Kevin'] },
    annotations: [
      { ...base, id: 'a1', comment: 'Heading tweak (was fixed)', status: 'fixed', route: '/',
        target: { component: 'fake-hero', ngComponent: null, selector: '#hero-title', xpath: '/html[1]/body[1]/main[1]/fake-hero[1]/h2[1]', tag: 'h2', classes: [], text: 'Welcome to the fixture', rect: { x: 20, y: 80, w: 300, h: 30 } },
        screenshot: 'shots/a1.png' },
      { ...base, id: 'a2', comment: 'Removed element (was fixed)', status: 'fixed', route: '/',
        target: { component: 'no-such-component', ngComponent: null, selector: '#gone', xpath: '/html[1]/body[1]/div[99]', tag: 'div', classes: ['vanished'], text: 'DOES NOT EXIST ANYWHERE', rect: { x: 30, y: 400, w: 120, h: 40 } },
        screenshot: 'shots/a2.png' },
      { ...base, id: 'a3', comment: 'Still open — must get no after-shot', status: 'open', route: '/',
        target: { component: 'fake-hero', ngComponent: null, selector: 'fake-hero p.lead', xpath: '/html[1]/body[1]/main[1]/fake-hero[1]/p[1]', tag: 'p', classes: ['lead'], text: '', rect: { x: 20, y: 120, w: 300, h: 20 } },
        screenshot: null },
    ],
  };
}

test('nit verify — after-shots + verdicts', async t => {
  const server = await startFixtureServer();
  const dir = tmpDir('nit-verify-');
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'shots', 'a1.png'), PNG_1PX);
  fs.writeFileSync(path.join(dir, 'shots', 'a2.png'), PNG_1PX);
  const reviewFile = path.join(dir, 'annotations.json');
  fs.writeFileSync(reviewFile, JSON.stringify(makeFeedback(server.url), null, 2));

  const S = await startTestSession({ mode: 'verify', url: undefined, reviewFile });
  t.after(async () => {
    await S.session.close();
    await server.close();
  });
  const page = S.session.page;
  const readFile = () => JSON.parse(fs.readFileSync(reviewFile, 'utf8'));

  await t.test('after-shots are captured for fixed annotations only', async () => {
    const data = await waitFor(() => {
      const d = readFile();
      const a1 = d.annotations.find(a => a.id === 'a1');
      const a2 = d.annotations.find(a => a.id === 'a2');
      return a1.screenshotAfter && a2.screenshotAfter ? d : null;
    }, { message: 'after-shots recorded', timeout: 15000 });

    const a1 = data.annotations.find(a => a.id === 'a1');
    assert.equal(a1.screenshotAfter, 'shots/a1-after.png');
    const buf1 = fs.readFileSync(path.join(dir, a1.screenshotAfter));
    assert.ok(buf1.length > 200);
    // After-shots use the same context-clip rules as capture shots (rect + padding,
    // expanded to the context minimum, clamped to the page) so before/after compare.
    const dims = await page.evaluate(() => {
      const r = document.querySelector('#hero-title').getBoundingClientRect();
      return {
        w: Math.round(r.width), h: Math.round(r.height),
        pageW: document.documentElement.scrollWidth, pageH: document.documentElement.scrollHeight,
      };
    });
    const size1 = pngSize(buf1);
    const expectW = Math.min(dims.pageW, Math.max(dims.w + SHOT_PADDING * 2, MIN_SHOT_W));
    const expectH = Math.min(dims.pageH, Math.max(dims.h + SHOT_PADDING * 2, MIN_SHOT_H));
    assert.ok(Math.abs(size1.width - expectW) <= 2, `after-shot width ${size1.width} ≈ ${expectW}`);
    assert.ok(Math.abs(size1.height - expectH) <= 2, `after-shot height ${size1.height} ≈ ${expectH}`);

    // unanchorable fixed annotation: original recorded region (small) is captured
    // instead — expanded to the same context minimum
    const a2 = data.annotations.find(a => a.id === 'a2');
    const size2 = pngSize(fs.readFileSync(path.join(dir, a2.screenshotAfter)));
    assert.equal(size2.width, MIN_SHOT_W);
    assert.equal(size2.height, MIN_SHOT_H);

    // open annotation is untouched
    assert.equal(data.annotations.find(a => a.id === 'a3').screenshotAfter, undefined);
  });

  await t.test('panel verdicts flip status to verified/reopened with verifiedAt', async () => {
    const panel = S.session.panelPage;
    assert.ok(panel, 'panel window opened');

    await waitFor(async () => (await panel.locator('.nit-item[data-id="a1"]').count()) === 1 ? true : null,
      { message: 'a1 listed in panel' });
    await panel.locator('.nit-item[data-id="a1"]').click();
    await panel.locator('.nit-item[data-id="a1"] .nit-verdict-verified').click();
    await waitFor(() => {
      const a1 = readFile().annotations.find(a => a.id === 'a1');
      return a1.status === 'verified' && a1.verifiedAt ? true : null;
    }, { message: 'a1 verified' });

    await panel.locator('.nit-item[data-id="a2"]').click();
    await panel.locator('.nit-item[data-id="a2"] .nit-verdict-reopen').click();
    await waitFor(() => {
      const a2 = readFile().annotations.find(a => a.id === 'a2');
      return a2.status === 'reopened' && a2.verifiedAt ? true : null;
    }, { message: 'a2 reopened' });

    // a verdict-ed annotation no longer offers verdict buttons
    await waitFor(async () =>
      (await panel.locator('.nit-verdict-verified').count()) === 0 ? true : null,
    { message: 'verdict buttons gone after decisions' });
  });
});
