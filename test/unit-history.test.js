// SPDX-License-Identifier: AGPL-3.0-or-later
// Click-history trail: pure bounded-append logic + the bridge-side sanitizer for
// untrusted __nitSave payloads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_HISTORY, sanitizeHistory } from '../dist/util/history.js';
import { appendStep, emptyTrail } from '../dist/overlay/trail.js';

const step = (n, at = `2026-07-22T10:00:0${n}Z`) => ({
  selector: `#el-${n}`, tag: 'button', component: 'app-thing', text: `Click ${n}`, at,
});

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
