// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshVisible } from '../dist/overlay/surfaces.js';

/** A surface the predicate accepts, whose rendered-ness the test can flip. */
function surface({ rendered = true, attrs = { role: 'dialog' } } = {}) {
  const el = {
    nodeType: 1,
    tagName: 'DIV',
    isConnected: true,
    parentElement: null,
    getAttribute: name => (name in attrs ? attrs[name] : null),
    classList: { contains: () => false },
    getBoundingClientRect: () => (rendered ? { width: 400, height: 300 } : { width: 0, height: 0 }),
    ownerDocument: null,
  };
  el.show = v => { rendered = v; };
  return el;
}

/** Something the predicate rejects: a plain box with nothing dialog-ish on it. */
function plain() {
  const el = surface({ attrs: {} });
  el.ownerDocument = { defaultView: { getComputedStyle: () => ({ position: 'static' }) } };
  return el;
}

test('refreshVisible: a newly rendered surface is reported opened, once', () => {
  const visible = new Set();
  const dialog = surface();
  assert.deepEqual(refreshVisible([dialog], visible), [dialog], 'first sight reports it');
  assert.deepEqual(refreshVisible([dialog], visible), [], 'still open is not opening again');
});

test('refreshVisible: a non-surface candidate is ignored', () => {
  const visible = new Set();
  assert.deepEqual(refreshVisible([plain()], visible), []);
  assert.equal(visible.size, 0);
});

test('refreshVisible: a surface that stops rendering is pruned, and re-opening reports again', () => {
  const visible = new Set();
  const dialog = surface();
  refreshVisible([dialog], visible);

  dialog.show(false);
  assert.deepEqual(refreshVisible([], visible), [], 'closing is not an opening');
  assert.equal(visible.size, 0, 'pruned even with no candidates — the idle path keeps the set honest');

  dialog.show(true);
  assert.deepEqual(refreshVisible([dialog], visible), [dialog], 'the same element re-opening is a new opening');
});

test('refreshVisible: a disconnected surface is pruned', () => {
  const visible = new Set();
  const dialog = surface();
  refreshVisible([dialog], visible);
  dialog.isConnected = false;
  dialog.show(false);
  refreshVisible([], visible);
  assert.equal(visible.size, 0);
});
