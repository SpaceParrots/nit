// SPDX-License-Identifier: AGPL-3.0-or-later
// Click-history trail: pure bounded-append logic + the bridge-side sanitizer for
// untrusted __nitSave payloads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_HISTORY, MAX_REOPEN_STEPS, sanitizeHistory, sanitizeSteps } from '../dist/util/history.js';
import { appendStep, emptyTrail, markOpened, selectReopenSteps } from '../dist/overlay/trail.js';

const step = (n, at = `2026-07-22T10:00:0${n}Z`) => ({
  selector: `#el-${n}`, tag: 'button', component: 'app-thing', text: `Click ${n}`, at,
});

/**
 * A trail step recorded inside (`surface`) or outside (null) a dialog.
 * `opened` is the observed fact that this click made a surface appear.
 */
const on = (n, surface = null, opened = false) => ({ ...step(n), surface, opened });
/** A click that demonstrably opened something. */
const opens = (n, surface = null) => on(n, surface, true);

test('trail: appendStep keeps order and never mutates its input', () => {
  const t0 = emptyTrail('/products');
  const t1 = appendStep(t0, step(1), '/products');
  const t2 = appendStep(t1, step(2), '/products');
  assert.deepEqual(t2.steps.map(s => s.selector), ['#el-1', '#el-2']);
  assert.deepEqual(t1.steps.map(s => s.selector), ['#el-1'], 'earlier trail untouched');
  assert.deepEqual(t0.steps, [], 'empty trail untouched');
});

test('trail: appendStep drops the oldest entry beyond MAX_HISTORY', () => {
  let t = emptyTrail('/');
  for (let i = 0; i < MAX_HISTORY + 3; i++) {
    t = appendStep(t, { ...step(0), selector: `#el-${i}` }, '/');
  }
  assert.equal(t.steps.length, MAX_HISTORY);
  assert.equal(t.steps[0].selector, '#el-3', 'oldest dropped');
  assert.equal(t.steps[MAX_HISTORY - 1].selector, `#el-${MAX_HISTORY + 2}`);
});

test('trail: a pathname change resets the trail; query/hash changes do not', () => {
  let t = emptyTrail('/products');
  t = appendStep(t, step(1), '/products');
  t = appendStep(t, step(2), '/products'); // ?id=5 → same pathname arrives as such
  assert.equal(t.steps.length, 2);
  t = appendStep(t, step(3), '/checkout');
  assert.equal(t.page, '/checkout');
  assert.deepEqual(t.steps.map(s => s.selector), ['#el-3'], 'trail restarted on the new page');
});

test('reopen: the opener is the last plain-page click that actually opened something', () => {
  const steps = [on(1), opens(2), on(3, '#drawer')];
  assert.deepEqual(
    selectReopenSteps(steps).map(s => s.selector),
    ['#el-2'],
    'the click that opened the drawer, not the one that merely preceded it',
  );
});

test('reopen: a plain-page click that opened nothing is never the opener', () => {
  // The shape that used to break this: a NON-modal drawer stays open while the
  // reviewer clicks a row on the page behind it. Position says "outside a
  // dialog", but only the earlier click actually opened anything.
  const steps = [opens(1), on(2, '#drawer'), on(3)];
  assert.deepEqual(
    selectReopenSteps(steps).map(s => s.selector),
    ['#el-1'],
    'anchors on the real opener and drops the unrelated page click entirely',
  );
});

test('reopen: ordinary interactions inside the dialog are not replayed', () => {
  // "Remove avatar" must never be replayed unattended just because it followed
  // the opener; only clicks that opened a further surface stay in the chain.
  const steps = [opens(1), on(2, '#dlg'), opens(3, '#dlg'), on(4, '#dlg')];
  assert.deepEqual(selectReopenSteps(steps).map(s => s.selector), ['#el-1', '#el-3']);
});

test('reopen: the surface and causality markers never leave the overlay', () => {
  const [opener] = selectReopenSteps([opens(1), on(2, '#drawer')]);
  assert.deepEqual(Object.keys(opener).sort(), ['at', 'component', 'selector', 'tag', 'text']);
});

test('reopen: nothing to replay when no recorded click opened a surface', () => {
  assert.deepEqual(selectReopenSteps([on(1, '#drawer'), on(2, '#drawer')]), [], 'opened before the trail window');
  assert.deepEqual(selectReopenSteps([on(1), on(2)]), [], 'a hover-opened dialog has no opening click');
  assert.deepEqual(selectReopenSteps([]), []);
});

test('reopen: a chain longer than the cap is dropped, not truncated', () => {
  const steps = [opens(1), opens(2, '#a'), opens(3, '#b'), opens(4, '#c')];
  assert.deepEqual(
    selectReopenSteps(steps), [],
    'a truncated sequence would still report success while leaving the dialog half-restored',
  );
  assert.equal(selectReopenSteps(steps.slice(0, MAX_REOPEN_STEPS)).length, MAX_REOPEN_STEPS, 'a chain that fits is kept');
});

test('reopen: a dialog opened from a menu replays the whole opening chain', () => {
  const steps = [opens(1), opens(2, '#menu')];
  assert.deepEqual(selectReopenSteps(steps).map(s => s.selector), ['#el-1', '#el-2']);
});

test('trail: markOpened is immutable and only ever promotes a step it holds', () => {
  const s1 = on(1);
  const t0 = appendStep(emptyTrail('/'), s1, '/');
  const t1 = markOpened(t0, s1);
  assert.equal(t1.steps[0].opened, true);
  assert.equal(t0.steps[0].opened, false, 'the earlier trail is untouched');
  assert.equal(markOpened(t1, s1), t1, 'already opened — same trail back, no churn');
  assert.equal(markOpened(t0, on(9)), t0, 'a step this trail never held changes nothing');
});

test('history: sanitizeSteps caps at whatever the caller asks for', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ ...step(0), selector: `#el-${i}` }));
  assert.equal(sanitizeSteps(many, MAX_REOPEN_STEPS).length, MAX_REOPEN_STEPS);
  assert.equal(sanitizeSteps(many, MAX_HISTORY).length, 8);
  assert.equal(sanitizeSteps(many, 0), undefined, 'a zero cap leaves nothing, which reads as absent');
});

test('history: sanitizeHistory accepts a clean payload and preserves order', () => {
  const out = sanitizeHistory([step(1), step(2)]);
  assert.deepEqual(out.map(s => s.selector), ['#el-1', '#el-2']);
  assert.deepEqual(Object.keys(out[0]).sort(), ['at', 'component', 'selector', 'tag', 'text']);
});

test('history: sanitizeHistory rejects non-arrays and drops malformed entries', () => {
  assert.equal(sanitizeHistory(undefined), undefined);
  assert.equal(sanitizeHistory('not an array'), undefined);
  assert.equal(sanitizeHistory({ length: 2 }), undefined);
  const out = sanitizeHistory([
    step(1),
    null,
    'text',
    { selector: '#x' }, // missing fields
    { ...step(2), text: 42 }, // wrong type
  ]);
  assert.deepEqual(out.map(s => s.selector), ['#el-1']);
});

test('history: sanitizeHistory returns undefined when nothing survives', () => {
  assert.equal(sanitizeHistory([]), undefined);
  assert.equal(sanitizeHistory([null, 7]), undefined);
});

test('history: sanitizeHistory caps the array and every field length', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ ...step(0), selector: `#el-${i}` }));
  const out = sanitizeHistory(many);
  assert.equal(out.length, MAX_HISTORY);
  assert.equal(out[0].selector, '#el-0', 'first 10 kept — the save snapshot is already bounded');

  const [big] = sanitizeHistory([{
    selector: 's'.repeat(999),
    tag: 't'.repeat(999),
    component: 'c'.repeat(999),
    text: 'x'.repeat(999),
    at: 'a'.repeat(999),
  }]);
  assert.equal(big.selector.length, 300);
  assert.equal(big.tag.length, 60);
  assert.equal(big.component.length, 60);
  assert.equal(big.text.length, 80);
  assert.equal(big.at.length, 40);
});

test('history: sanitizeHistory collapses whitespace so entries cannot inject markdown blocks', () => {
  const [s] = sanitizeHistory([{
    ...step(1),
    text: 'line one\n\n## Fake heading\nline two',
    selector: '#a\n\n#b',
  }]);
  assert.equal(s.text, 'line one ## Fake heading line two');
  assert.equal(s.selector, '#a #b');
});
