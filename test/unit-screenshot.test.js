// SPDX-License-Identifier: AGPL-3.0-or-later
// contextClip: the pure clip math behind element screenshots — minimum context
// size, element-centered expansion, page-bound clamping.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contextClip, MIN_SHOT_W, MIN_SHOT_H, SHOT_PADDING } from '../dist/capture/screenshot.js';

test('screenshot: a small element expands to the minimum context, centered', () => {
  // a 120×36 button in the middle of a large page
  const clip = contextClip({ x: 700, y: 500, w: 120, h: 36 }, { bounds: { w: 2000, h: 3000 } });
  assert.equal(clip.width, MIN_SHOT_W);
  assert.equal(clip.height, MIN_SHOT_H);
  // centered on the element's center (760, 518)
  assert.equal(clip.x, 760 - MIN_SHOT_W / 2);
  assert.equal(clip.y, 518 - MIN_SHOT_H / 2);
});

test('screenshot: a large element keeps padding-only behaviour', () => {
  const clip = contextClip({ x: 100, y: 100, w: 800, h: 600 }, { bounds: { w: 2000, h: 3000 } });
  assert.equal(clip.x, 100 - SHOT_PADDING);
  assert.equal(clip.y, 100 - SHOT_PADDING);
  assert.equal(clip.width, 800 + SHOT_PADDING * 2);
  assert.equal(clip.height, 600 + SHOT_PADDING * 2);
});

test('screenshot: the clip shifts instead of hanging off the page edges', () => {
  // element near the top-left corner: window slides right/down, keeps the min size
  const tl = contextClip({ x: 4, y: 4, w: 40, h: 20 }, { bounds: { w: 2000, h: 3000 } });
  assert.equal(tl.x, 0);
  assert.equal(tl.y, 0);
  assert.equal(tl.width, MIN_SHOT_W);
  assert.equal(tl.height, MIN_SHOT_H);

  // element near the bottom-right corner: window slides left/up
  const br = contextClip({ x: 1950, y: 2970, w: 40, h: 20 }, { bounds: { w: 2000, h: 3000 } });
  assert.equal(br.x + br.width, 2000);
  assert.equal(br.y + br.height, 3000);
  assert.equal(br.width, MIN_SHOT_W);
  assert.equal(br.height, MIN_SHOT_H);
});

test('screenshot: a page smaller than the minimum caps the clip to the page', () => {
  const clip = contextClip({ x: 10, y: 10, w: 50, h: 20 }, { bounds: { w: 390, h: 200 } });
  assert.equal(clip.x, 0);
  assert.equal(clip.y, 0);
  assert.equal(clip.width, 390);
  assert.equal(clip.height, 200);
});

test('screenshot: without bounds only the origin is clamped', () => {
  const clip = contextClip({ x: 10, y: 10, w: 50, h: 20 }, {});
  assert.equal(clip.x, 0, 'x clamped at 0');
  assert.equal(clip.y, 0, 'y clamped at 0');
  assert.equal(clip.width, MIN_SHOT_W);
  assert.equal(clip.height, MIN_SHOT_H);
});
