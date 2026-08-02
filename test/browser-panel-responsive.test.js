// SPDX-License-Identifier: AGPL-3.0-or-later
// Regression coverage for the finding: on a laptop screen the panel's footer —
// and with it the Finish button — sat below the visible edge of its window.
//
// Two independent causes, one per test here:
//   1. The panel forced a fixed 860px viewport. A window manager clamps a popup
//      to the display work area but Chromium keeps laying the page out at the
//      size that was asked for, so the excess was simply off screen. The panel
//      now fits its viewport to the window it actually got.
//   2. Even at a correct viewport, the flex column let the footer be pushed out:
//      header/toolbar/footer could shrink while the verify card and the unplaced
//      section held on to their percentage caps.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PANEL_HTML } from '../dist/panel/shell.js';
import { PANEL_WIDTH } from '../dist/browser/panel.js';
import { startFixtureServer } from './helpers/server.js';
import { startTestSession, waitFor, tmpDir } from './helpers/session.js';

const panelCss = fs.readFileSync(
  fileURLToPath(new URL('../dist/panel/panel.css', import.meta.url)), 'utf8');

/** Heights a real panel window can end up at, from a big monitor down to a very short one. */
const HEIGHTS = [900, 700, 600, 520, 460, 400, 360];

test('nit panel — the footer stays on screen at every window height', async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());

  for (const height of HEIGHTS) {
    await t.test(`Finish button fully visible at ${PANEL_WIDTH}x${height}`, async () => {
      const page = await browser.newPage({ viewport: { width: PANEL_WIDTH, height } });
      await page.setContent(PANEL_HTML, { waitUntil: 'domcontentloaded' });
      await page.addStyleTag({ content: panelCss });
      // The densest state the panel ever reaches: verify mode, with a tall
      // before/after card, a long list and an unplaced section all at once.
      await page.evaluate(() => {
        const verify = document.getElementById('verify');
        verify.hidden = false;
        verify.innerHTML = '<div class="nit-vq">'
          + '<div class="vq-item">before / after<br><br><br><br><br><br><br><br>tall shot</div>'.repeat(3)
          + '<div class="vq-actions"><button class="btn">Verified</button>'
          + '<button class="btn">Reopen</button><button class="btn">Skip</button></div></div>';
        document.getElementById('list').innerHTML =
          '<div class="nit-item">an annotation row</div>'.repeat(12);
        document.getElementById('unplaced').hidden = false;
        document.getElementById('unplaced-list').innerHTML =
          '<div class="nit-item">an unplaced row</div>'.repeat(6);
      });

      const m = await page.evaluate(() => {
        const finish = document.getElementById('finish').getBoundingClientRect();
        return {
          top: Math.round(finish.top),
          bottom: Math.round(finish.bottom),
          viewport: window.innerHeight,
          scrollHeight: document.documentElement.scrollHeight,
        };
      });
      assert.ok(m.top >= 0 && m.bottom <= m.viewport,
        `Finish button at ${m.top}..${m.bottom} must fit inside ${m.viewport}px`);
      assert.equal(m.scrollHeight, m.viewport, 'the panel never overflows its window');
      await page.close();
    });
  }
});

test('nit panel — the viewport never exceeds the window showing it', async t => {
  const server = await startFixtureServer();
  const dir = tmpDir('nit-panel-fit-');
  const reviewFile = path.join(dir, 'annotations.json');
  fs.writeFileSync(reviewFile, JSON.stringify({
    review: { id: 'panel-fit', url: `${server.url}/`, createdAt: '2026-07-20T10:00:00Z', authors: ['Kevin'] },
    annotations: [],
  }, null, 2));

  const S = await startTestSession({ mode: 'view', url: undefined, reviewFile });
  t.after(async () => {
    await S.session.close();
    await server.close();
  });

  await t.test('the laid-out page fits the window, with no strip below the fold', async () => {
    const panel = S.session.panelPage;
    const geom = await panel.evaluate(() => ({
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      layoutWidth: document.documentElement.clientWidth,
      layoutHeight: document.documentElement.clientHeight,
    }));
    // The window frame is what separates outer from layout size; it is zero
    // headless, so any excess here is the panel laying itself out too large.
    assert.ok(geom.layoutHeight <= geom.outerHeight,
      `layout height ${geom.layoutHeight} must fit window height ${geom.outerHeight}`);
    assert.ok(geom.layoutWidth <= geom.outerWidth,
      `layout width ${geom.layoutWidth} must fit window width ${geom.outerWidth}`);
    assert.equal(panel.viewportSize().width, PANEL_WIDTH, 'panel keeps its content width');
  });

  await t.test('the Finish button is reachable without scrolling', async () => {
    const panel = S.session.panelPage;
    await waitFor(async () => await panel.locator('#finish').count() === 1 ? true : null,
      { message: 'footer rendered' });
    const fits = await panel.evaluate(() => {
      const r = document.getElementById('finish').getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight;
    });
    assert.equal(fits, true, 'Finish button sits inside the viewport');
  });

  await t.test('a window the user resizes is re-fitted, keeping the footer visible', async () => {
    const panel = S.session.panelPage;
    // Headless has no window frame, so resizing the viewport *is* resizing the
    // window — which is exactly the state the re-fit watcher has to converge on.
    await panel.setViewportSize({ width: PANEL_WIDTH, height: 420 });
    await waitFor(async () => {
      const ok = await panel.evaluate(() => {
        const r = document.getElementById('finish').getBoundingClientRect();
        return r.bottom <= window.innerHeight
          && document.documentElement.clientHeight <= window.outerHeight;
      });
      return ok ? true : null;
    }, { message: 'panel re-fits to the smaller window' });
    assert.equal(panel.viewportSize().height, 420, 'the re-fit settles instead of oscillating');
  });
});
