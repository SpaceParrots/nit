// SPDX-License-Identifier: AGPL-3.0-or-later
// Verify-queue UX (2026-07-23 design): the panel's guided queue card rules fixed
// items without expanding rows — always-visible Verified / Reopen / Skip, a
// reopen note stored as statusReason, progress, and a done-state summary. Plus
// capture robustness: the fallback after-shot waits out the SPA grace period
// (FALLBACK_GRACE_MS) and is upgraded in place once the element anchors late.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startFixtureServer } from './helpers/server.js';
import { startTestSession, waitFor, tmpDir } from './helpers/session.js';
import { FALLBACK_GRACE_MS } from '../dist/browser/verify.js';
import { pngSize, MIN_SHOT_W, MIN_SHOT_H } from '../dist/capture/screenshot.js';

const base = {
  // Pinned to 'desktop': a 'general' scope wants a mobile after-shot too, and the
  // tour's auto viewport switch would perturb the dimension/timing assertions here.
  type: 'change-request', author: 'Kevin', viewportScope: 'desktop',
  viewport: { mode: 'desktop', w: 1440, h: 900 }, createdAt: '2026-07-20T10:00:00Z',
  screenshot: null, status: 'fixed', route: '/',
};

function makeQueueFeedback(url) {
  return {
    review: { id: 'verify-queue-fixture', url: `${url}/`, createdAt: '2026-07-20T10:00:00Z', authors: ['Kevin'] },
    annotations: [
      { ...base, id: 'q1', comment: 'Heading needs the brand voice',
        target: { component: 'fake-hero', ngComponent: null, selector: '#hero-title', xpath: '/html[1]/body[1]/main[1]/fake-hero[1]/h2[1]', tag: 'h2', classes: [], text: 'Welcome to the fixture', rect: { x: 20, y: 80, w: 300, h: 30 } } },
      { ...base, id: 'q2', comment: 'Paragraph runs too long',
        target: { component: 'main', ngComponent: null, selector: '#long-text', xpath: '/html[1]/body[1]/main[1]/p[2]', tag: 'p', classes: [], text: '', rect: { x: 20, y: 300, w: 600, h: 60 } } },
      { ...base, id: 'q3', comment: 'Note style is off',
        target: { component: 'article', ngComponent: null, selector: '.post-note', xpath: '/html[1]/body[1]/main[1]/article[1]/div[1]/div[1]/span[1]', tag: 'span', classes: ['post-note'], text: 'Landmark-anchored content', rect: { x: 20, y: 380, w: 200, h: 20 } } },
      { ...base, id: 'q4', comment: 'Fine print barely readable',
        target: { component: 'footer', ngComponent: null, selector: '.fine-print', xpath: '/html[1]/body[1]/main[1]/footer[1]/p[1]', tag: 'p', classes: ['fine-print'], text: 'Scrolled far down content for rect tests.', rect: { x: 20, y: 2000, w: 300, h: 20 } } },
    ],
  };
}

test('nit verify — the guided queue card', async t => {
  const server = await startFixtureServer();
  const dir = tmpDir('nit-vq-');
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  const reviewFile = path.join(dir, 'annotations.json');
  fs.writeFileSync(reviewFile, JSON.stringify(makeQueueFeedback(server.url), null, 2));

  const S = await startTestSession({ mode: 'verify', url: undefined, reviewFile });
  t.after(async () => {
    await S.session.close();
    await server.close();
  });
  const panel = S.session.panelPage;
  assert.ok(panel, 'panel window opened');
  const readFile = () => JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
  const currentComment = () => panel.locator('#verify .nit-vq .vq-item .item-head .comment').innerText();

  await t.test('queue card, progress and verdict buttons are visible without expanding anything', async () => {
    await waitFor(async () => (await panel.locator('#verify .nit-vq').count()) === 1 ? true : null,
      { message: 'queue card rendered' });
    assert.equal(await panel.locator('#verify .nit-vq').isVisible(), true, 'card visible');
    assert.match(await panel.locator('#verify .vq-head').innerText(), /0 of 4 ruled/,
      'progress header shows "0 of 4 ruled"');
    assert.equal(await panel.locator('#verify .vq-bar .vq-fill').count(), 1, 'progress bar present');
    for (const cls of ['nit-vq-verified', 'nit-vq-reopen', 'nit-vq-skip']) {
      assert.equal(await panel.locator(`#verify .${cls}`).isVisible(), true,
        `${cls} visible without expanding a list row`);
    }
    assert.equal(await currentComment(), 'Heading needs the brand voice', 'first fixed item is current');
  });

  await t.test('Verified rules the current item and advances the queue', async () => {
    // Let all four (anchorable) after-shots land first — once they exist the
    // polled state stops changing, so later repaints cannot race the note input.
    await waitFor(() => readFile().annotations.every(a => a.screenshotAfter) ? true : null,
      { message: 'all after-shots captured', timeout: 20000 });
    await panel.locator('#verify .nit-vq-verified').click();
    await waitFor(() => {
      const q1 = readFile().annotations.find(a => a.id === 'q1');
      return q1.status === 'verified' && q1.verifiedAt ? true : null;
    }, { message: 'q1 verified in the file' });
    await waitFor(async () => (await panel.locator('#verify .vq-head').innerText()).includes('1 of 4 ruled')
      ? true : null, { message: 'progress numerator advances' });
    assert.equal(await currentComment(), 'Paragraph runs too long', 'card moved to the next item');
  });

  await t.test('Reopen with a note stores the note as statusReason', async () => {
    await panel.locator('#verify .nit-vq-reopen').click();
    await waitFor(async () => await panel.locator('#verify .nit-vq-note').isVisible() ? true : null,
      { message: 'note input revealed' });
    await panel.locator('#verify .nit-vq-note').fill('spacing is still off on mobile');
    await panel.locator('#verify .nit-vq-note-confirm').click();
    await waitFor(() => {
      const q2 = readFile().annotations.find(a => a.id === 'q2');
      return q2.status === 'reopened' && q2.statusReason === 'spacing is still off on mobile' ? true : null;
    }, { message: 'q2 reopened with the note as statusReason' });
    await waitFor(async () => (await currentComment()) === 'Note style is off' ? true : null,
      { message: 'card moved on to q3' });
  });

  await t.test('Skip keeps the status fixed and shows another item', async () => {
    await panel.locator('#verify .nit-vq-skip').click();
    await waitFor(async () => (await currentComment()) === 'Fine print barely readable' ? true : null,
      { message: 'skipping q3 parks the card on q4' });
    assert.equal(readFile().annotations.find(a => a.id === 'q3').status, 'fixed',
      'skip is session-local — the file keeps status fixed');
  });

  await t.test('done state sums the session up and offers Finish', async () => {
    await panel.locator('#verify .nit-vq-verified').click(); // rule q4 — nothing unskipped remains
    // The done summary is a direct child of the card (the capturing/unplaced
    // notes render deeper, inside the current item).
    await waitFor(async () => {
      const line = panel.locator('#verify .nit-vq > .vq-status');
      if (await line.count() !== 1) return null;
      return (await line.innerText()).includes('All fixed items ruled') ? true : null;
    }, { message: 'done state shown' });
    const summary = await panel.locator('#verify .nit-vq > .vq-status').innerText();
    assert.match(summary, /2 verified/);
    assert.match(summary, /1 reopened/);
    assert.match(summary, /1 skipped/);
    assert.match(await panel.locator('#verify .vq-head').innerText(), /3 of 4 ruled/);
    assert.equal(await panel.locator('#finish').isVisible(), true, 'Finish button visible in verify mode');
  });
});

function makeGraceFeedback(url) {
  return {
    review: { id: 'verify-grace-fixture', url: `${url}/`, createdAt: '2026-07-20T10:00:00Z', authors: ['Kevin'] },
    annotations: [
      { ...base, id: 'g1', comment: 'Late-rendered box needs padding',
        target: { component: 'no-such-component', ngComponent: null, selector: '#late-box', xpath: '/html[1]/body[1]/div[99]', tag: 'div', classes: ['late-box'], text: 'LATE RENDERED BOX CONTENT', rect: { x: 40, y: 300, w: 120, h: 40 } } },
    ],
  };
}

test('nit verify — fallback grace period and anchored upgrade', async t => {
  const server = await startFixtureServer();
  const dir = tmpDir('nit-vq-grace-');
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  const reviewFile = path.join(dir, 'annotations.json');
  fs.writeFileSync(reviewFile, JSON.stringify(makeGraceFeedback(server.url), null, 2));

  const S = await startTestSession({ mode: 'verify', url: undefined, reviewFile });
  const startedAt = Date.now();
  t.after(async () => {
    await S.session.close();
    await server.close();
  });
  const page = S.session.page;
  const panel = S.session.panelPage;
  assert.ok(panel, 'panel window opened');
  const readFile = () => JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
  const afterPng = () => path.join(dir, 'shots', 'g1-after.png');

  await t.test('an unanchorable item is only fallback-captured after the grace period', async () => {
    // While the grace clock runs, the card says so: capturing + unplaced notes.
    await waitFor(async () =>
      (await panel.locator('#verify .vq-capturing').count()) === 1
      && (await panel.locator('#verify .vq-unplaced').count()) === 1 ? true : null,
    { message: 'capturing/unplaced notes shown while the grace period runs', timeout: 3000 });

    // Check well inside the grace window, even if the overlay's first unplaced
    // report predates session start by up to ~1 s (panel-window setup time).
    const earlyMs = FALLBACK_GRACE_MS / 2 - 500;
    const remaining = startedAt + earlyMs - Date.now();
    if (remaining > 0) await new Promise(r => setTimeout(r, remaining));
    assert.equal(readFile().annotations[0].screenshotAfter, undefined,
      `no fallback shot inside the first ${earlyMs} ms (FALLBACK_GRACE_MS is ${FALLBACK_GRACE_MS} ms)`);

    await waitFor(() => readFile().annotations[0].screenshotAfter ? true : null,
      { message: `fallback shot within FALLBACK_GRACE_MS + 8000 (${FALLBACK_GRACE_MS + 8000} ms)`,
        timeout: FALLBACK_GRACE_MS + 8000 });
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= FALLBACK_GRACE_MS - 1500,
      `capture waited out the grace period (captured after ${elapsed} ms, FALLBACK_GRACE_MS ${FALLBACK_GRACE_MS} ms)`);
    assert.ok(S.logs.some(l => l.includes('after-shot g1') && l.includes('not re-anchored')),
      'fallback capture logged as not re-anchored');
    const size = pngSize(fs.readFileSync(afterPng()));
    assert.equal(size.width, MIN_SHOT_W, 'fallback shot of the small recorded region expands to the context minimum');
    assert.equal(size.height, MIN_SHOT_H);
  });

  await t.test('a late-anchoring element upgrades the fallback shot in place', async () => {
    const before = pngSize(fs.readFileSync(afterPng()));
    // The "SPA finally rendered it" moment, driven from the test so the ordering
    // (fallback first, upgrade second) is deterministic on slow CI: insert the
    // annotated element, then nudge the overlay to re-anchor via its resize
    // refresh path — the 1 s retry cycle may already be exhausted by now.
    await page.evaluate(() => {
      const el = document.createElement('div');
      el.id = 'late-box';
      el.className = 'late-box';
      el.textContent = 'LATE RENDERED BOX CONTENT';
      el.style.cssText = 'width:600px;height:120px;background:#fdd;';
      document.body.prepend(el);
    });
    await waitFor(async () => {
      await page.evaluate(() => window.dispatchEvent(new Event('resize'))).catch(() => {});
      return S.logs.some(l => l.includes('after-shot upgraded g1')) ? true : null;
    }, { message: 'upgrade logged once the element anchors', timeout: 15000, interval: 500 });
    // The 600 px element beats the fallback's context-minimum width, so the
    // overwritten png is measurably the element shot, not the original region.
    await waitFor(() => {
      const size = pngSize(fs.readFileSync(afterPng()));
      return size.width > before.width ? size : null;
    }, { message: 'after-shot overwritten with the (wider) element shot' });
    assert.equal(readFile().annotations[0].screenshotAfter, 'shots/g1-after.png', 'path unchanged — upgraded in place');
  });
});
