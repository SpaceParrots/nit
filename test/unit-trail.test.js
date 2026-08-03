// SPDX-License-Identifier: AGPL-3.0-or-later
// The trail's pure half: the bounded click window, and the opener chain that
// must survive it. The chain exists because the opener used to live in the same
// ten-entry window as ordinary clicks — a reviewer clicking through a wizard
// modal evicted the click that opened it, and the annotation saved no way back in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyTrail, appendStep, openChain, observeOpen, chainFor } from '../dist/overlay/trail.js';
import { MAX_REOPEN_STEPS } from '../dist/util/history.js';

/** A recorded click. `surface` is the dialog it happened *inside*, null on the page. */
function step(selector, surface = null) {
  return { selector, tag: 'button', component: 'button', text: selector, at: '2026-08-03T10:00:00Z', surface };
}

/** A stand-in for a dialog element; `contains` answers only for its own children. */
function el(children = []) {
  const node = { contains: other => children.includes(other) };
  return node;
}

test('appendStep: the click window is bounded and a pathname change resets it', () => {
  let trail = emptyTrail('/account');
  for (let i = 0; i < 14; i++) trail = appendStep(trail, step(`#b${i}`), '/account');
  assert.equal(trail.steps.length, 10, 'bounded at MAX_HISTORY');
  assert.equal(trail.steps[0].selector, '#b4', 'oldest fall off');

  trail = appendStep(trail, step('#other'), '/product');
  assert.deepEqual(trail.steps.map(s => s.selector), ['#other']);
  assert.deepEqual(trail.chain, [], 'a chain recorded on another page cannot be replayed here');
});

test('openChain: the opener survives clicks that would evict it from the window', () => {
  const sheet = el();
  const opener = step('#open-sheet');
  let trail = emptyTrail('/account');
  trail = appendStep(trail, opener, '/account');
  trail = openChain(trail, opener, sheet, false);

  // The wizard: twenty clicks inside the sheet, far past MAX_HISTORY.
  for (let i = 0; i < 20; i++) {
    const inside = step(`#weiter${i}`, 'div.action-sheet');
    trail = appendStep(trail, inside, '/account');
  }

  assert.equal(trail.steps.some(s => s.selector === '#open-sheet'), false, 'evicted from history, as before');
  assert.deepEqual(chainFor(trail.chain, sheet).map(s => s.selector), ['#open-sheet'], 'but kept in the chain');
});

test('chainFor: a chain that opened another dialog is not offered for this one', () => {
  const other = el();
  const wanted = el();
  const opener = step('#open-other');
  let trail = emptyTrail('/account');
  trail = openChain(trail, opener, other, false);
  assert.deepEqual(chainFor(trail.chain, wanted), [], 'surfaces unrelated — nothing honest to replay');
  assert.deepEqual(chainFor(trail.chain, other).map(s => s.selector), ['#open-other']);
});

test('chainFor: the observed surface may be an ancestor or a descendant of the picked container', () => {
  const inner = el();
  const outer = el([inner]);
  let trail = emptyTrail('/account');
  trail = openChain(trail, step('#open'), outer, false);
  assert.equal(chainFor(trail.chain, inner).length, 1, 'observed container wraps the annotated one');

  trail = emptyTrail('/account');
  trail = openChain(trail, step('#open'), inner, false);
  assert.equal(chainFor(trail.chain, outer).length, 1, 'and the other way round');
});

test('chainFor: a declared trigger is trusted without any observed surface', () => {
  // The blind path the attribute exists for: nothing observed, so there is
  // nothing to check it against and the author's word is all there is.
  let trail = emptyTrail('/account');
  trail = openChain(trail, step('#open-panel'), null, true);
  assert.deepEqual(chainFor(trail.chain, el()).map(s => s.selector), ['#open-panel']);
});

test('chainFor: a declared trigger seen opening another dialog is not offered for this one', () => {
  // `data-dialog-trigger` says the click opens *a* dialog, not *the* one being
  // annotated. Click a declared trigger, close what it opened, reach a
  // different dialog some other way — blind trust would replay the wrong opener
  // and report success on the wrong surface.
  const declaredSurface = el();
  const annotated = el();
  const trigger = step('#open-panel');
  let trail = emptyTrail('/account');
  trail = openChain(trail, trigger, null, true);
  trail = observeOpen(trail, trigger, declaredSurface, '/account');

  assert.equal(trail.chain.length, 1, 'verification updates the declared entry, it never adds one');
  assert.equal(trail.chain[0].declared, true, 'still the author\'s declaration');
  assert.deepEqual(chainFor(trail.chain, annotated), [], 'observed opening something else — not offered');
  assert.deepEqual(chainFor(trail.chain, declaredSurface).map(s => s.selector), ['#open-panel']);
});

test('observeOpen: a watch that fires after the page changed does not repopulate the chain', () => {
  // The callback runs up to a window after the click. If the click navigated,
  // appendStep has already dropped the chain — clicks recorded on another page
  // cannot be replayed on this one — and the late callback must not put one back.
  const opener = step('#open-modal');
  let trail = emptyTrail('/account');
  trail = appendStep(trail, opener, '/account');
  trail = appendStep(trail, step('#link'), '/product');

  const after = observeOpen(trail, opener, el(), '/account');
  assert.equal(after, trail, 'the trail is handed back untouched');
  assert.deepEqual(after.chain, []);
});

test('observeOpen: an ordinary observed opening extends the chain as usual', () => {
  const dialog = el();
  const opener = step('#open');
  let trail = emptyTrail('/account');
  trail = appendStep(trail, opener, '/account');
  trail = observeOpen(trail, opener, dialog, '/account');
  assert.deepEqual(chainFor(trail.chain, dialog).map(s => s.selector), ['#open']);
  assert.equal(trail.chain[0].declared, false);
});

test('chainFor: an unobserved, undeclared opener is never replayed', () => {
  let trail = emptyTrail('/account');
  trail = openChain(trail, step('#open'), null, false);
  assert.deepEqual(chainFor(trail.chain, el()), []);
});

test('openChain: a click made inside a surface extends the chain, one on the page restarts it', () => {
  const menu = el();
  const dialog = el();
  let trail = emptyTrail('/account');
  trail = openChain(trail, step('#open-menu'), menu, false);
  trail = openChain(trail, step('#menu-item', 'div.menu'), dialog, false);
  assert.deepEqual(chainFor(trail.chain, dialog).map(s => s.selector), ['#open-menu', '#menu-item']);

  trail = openChain(trail, step('#open-elsewhere'), dialog, false);
  assert.deepEqual(chainFor(trail.chain, dialog).map(s => s.selector), ['#open-elsewhere'], 'page click restarts');
});

test('chainFor: past the cap it returns nothing rather than a truncated sequence', () => {
  const dialog = el();
  let trail = emptyTrail('/account');
  trail = openChain(trail, step('#one'), dialog, false);
  for (let i = 0; i < MAX_REOPEN_STEPS; i++) {
    trail = openChain(trail, step(`#nested${i}`, 'div.surface'), dialog, false);
  }
  assert.ok(trail.chain.length > MAX_REOPEN_STEPS);
  assert.deepEqual(chainFor(trail.chain, dialog), [], 'half a way back in is worse than an honest none');
});

test('chainFor: strips the in-memory fields — only ClickStep crosses the bridge', () => {
  const dialog = el();
  let trail = emptyTrail('/account');
  trail = openChain(trail, step('#open'), dialog, false);
  const [only] = chainFor(trail.chain, dialog);
  assert.deepEqual(Object.keys(only).sort(), ['at', 'component', 'selector', 'tag', 'text']);
});
