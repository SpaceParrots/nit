// SPDX-License-Identifier: AGPL-3.0-or-later
// The arithmetic behind the panel's window fit. A window manager clamps a popup
// to the display work area while Chromium keeps laying the page out at the size
// that was requested, so the panel must derive its viewport from the window it
// actually got — the fixed 860px it used to force is what put the footer (and
// the Finish button) below the visible edge on a laptop screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { panelContentSize, PANEL_WIDTH } from '../dist/browser/panel.js';

// Windows, headed, persistent context: measured at 16px of border and 134px of
// title bar plus the automation infobar (see src/browser/panel.ts).
const WIN_CHROME = { width: 16, height: 134 };

test('panel fit — a clamped laptop window gets a viewport that fits inside it', () => {
  // 1440x900 logical screen, 48px taskbar: the popup asks for more than the work
  // area allows and is clamped to an 852px-tall window.
  const fitted = panelContentSize({ width: 376, height: 852 }, WIN_CHROME);
  assert.equal(fitted.height, 718, 'viewport is the window minus its frame');
  assert.ok(fitted.height < 860, 'and well under the height the panel used to force');
  assert.equal(fitted.width, PANEL_WIDTH);
});

test('panel fit — a roomy desktop window is filled edge to edge', () => {
  const fitted = panelContentSize({ width: 376, height: 1168 }, WIN_CHROME);
  assert.deepEqual(fitted, { width: PANEL_WIDTH, height: 1034 });
});

test('panel fit — headless has no frame, so the viewport is the window', () => {
  const fitted = panelContentSize({ width: PANEL_WIDTH, height: 1034 }, { width: 0, height: 0 });
  assert.deepEqual(fitted, { width: PANEL_WIDTH, height: 1034 });
});

test('panel fit — a degenerate window falls back to the readable minimum', () => {
  const fitted = panelContentSize({ width: 100, height: 150 }, WIN_CHROME);
  assert.equal(fitted.width, PANEL_WIDTH, 'never narrower than the panel content width');
  assert.equal(fitted.height, 320, 'never shorter than the stylesheet can lay out');
});
