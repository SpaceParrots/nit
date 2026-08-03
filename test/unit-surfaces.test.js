// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { installSurfaceWatcher, refreshVisible, LATE_SWEEP_MS, OPEN_WINDOW_MS } from '../dist/overlay/surfaces.js';

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

/**
 * The permanently-mounted surface this module exists for: a full-size box for
 * its whole life, shown and hidden with `visibility`, element identity never
 * changing. Nothing a before/after set diff could ever see appear.
 */
function mounted() {
  let shown = false;
  const el = {
    nodeType: 1,
    tagName: 'DIV',
    id: '',
    isConnected: true,
    parentElement: null,
    getAttribute: name => (name === 'role' ? 'dialog' : null),
    classList: { contains: () => false },
    getBoundingClientRect: () => ({ width: 400, height: 300 }),
    matches: () => true,
    querySelectorAll: () => [],
    ownerDocument: { defaultView: { getComputedStyle: () => ({ visibility: shown ? 'visible' : 'hidden' }) } },
  };
  el.show = v => { shown = v; };
  return el;
}

/** A document whose only scannable elements are `surfaces`, all body children. */
function fakeDocument(surfaces) {
  const body = { children: surfaces };
  for (const el of surfaces) el.parentElement = body;
  return { documentElement: {}, body, querySelectorAll: () => surfaces };
}

/**
 * Install the watcher against a stubbed MutationObserver and hand back a way to
 * drive mutation batches by hand — the whole point being to control exactly
 * which openings the observer gets to see, and which it does not.
 */
function install(doc) {
  let fire = () => {};
  const real = globalThis.MutationObserver;
  globalThis.MutationObserver = class {
    constructor(cb) { fire = cb; }
    observe() {}
    disconnect() {}
  };
  const watcher = installSurfaceWatcher(doc);
  if (real) globalThis.MutationObserver = real;
  else delete globalThis.MutationObserver;
  return {
    watcher,
    mutate: els => fire(els.map(target => ({ type: 'attributes', target, addedNodes: [] }))),
  };
}

test('installSurfaceWatcher: a surface hidden by visibility is not seeded as already open', t => {
  // `data-dialog` (or any declared surface) puts the element in the seed scan.
  // A visibility-hidden box still measures full size, so a rendered test built
  // on the box alone had it marked open before the reviewer touched anything —
  // and it is never pruned, so its real opening was never reported. Declaring
  // the dialog took away the way back into it.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sheet = mounted();
  const { watcher, mutate } = install(fakeDocument([sheet]));
  let credited = null;
  watcher.watch(s => { credited = s; });
  sheet.show(true);
  mutate([sheet]);
  assert.equal(credited, sheet, 'the opening is reported to the click that caused it');
});

test('installSurfaceWatcher: a surface that opened with no watch live is not credited to the next click', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sheet = mounted();
  const { watcher, mutate } = install(fakeDocument([sheet]));
  // Opened by a fetch, a timer or a hover — no click, so no watch was pending.
  sheet.show(true);
  mutate([sheet]);

  let credited = null;
  watcher.watch(s => { credited = s; }); // the reviewer's next, unrelated click
  mutate([sheet]);
  assert.equal(credited, null, 'it was already open when the click happened');
});

test('installSurfaceWatcher: an opening the observer cannot see is caught by the late sweep', t => {
  // showPopover() changes no attribute and adds no node; a :target or :checked
  // modal changes nothing at all. The old 150/600 ms probes caught those by
  // polling — the sweep is what buys that back.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const popover = mounted();
  const { watcher } = install(fakeDocument([popover]));
  let credited = null;
  watcher.watch(s => { credited = s; });
  popover.show(true);
  t.mock.timers.tick(LATE_SWEEP_MS + 1);
  assert.equal(credited, popover);
});

test('installSurfaceWatcher: the late sweep cannot fire for a credited or cancelled watch', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = mounted();
  const second = mounted();
  const { watcher, mutate } = install(fakeDocument([first, second]));

  const seen = [];
  watcher.watch(s => seen.push(s));
  first.show(true);
  mutate([first]);
  assert.deepEqual(seen, [first]);
  second.show(true); // another surface opens while the old window is still running
  t.mock.timers.tick(OPEN_WINDOW_MS + 1);
  assert.deepEqual(seen, [first], 'a credited watch is retired, sweep and all — at most one per click');

  const cancelled = [];
  watcher.watch(s => cancelled.push(s));
  watcher.cancel();
  t.mock.timers.tick(OPEN_WINDOW_MS + 1);
  assert.deepEqual(cancelled, [], 'a cancelled watch is never swept either');
});
