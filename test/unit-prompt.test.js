// SPDX-License-Identifier: AGPL-3.0-or-later
// The gate every interactive fallback is built on (canAsk), and the real
// @clack implementation behind it. The rest of the suite drives the prompts
// through a stand-in, which proves the flows but not the questions — these
// run the actual prompts against a pair of mock TTYs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { canAsk, createClackPrompts } from '../dist/cli/prompt.js';

/** Run `fn` with process.stdin/stdout claiming to be (or not be) TTYs. */
function withTty(stdin, stdout, fn) {
  const original = [process.stdin.isTTY, process.stdout.isTTY];
  Object.defineProperty(process.stdin, 'isTTY', { value: stdin, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: stdout, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process.stdin, 'isTTY', { value: original[0], configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: original[1], configurable: true });
  }
}

test('canAsk: only a terminal at both ends may be asked', () => {
  for (const [stdin, stdout, expected] of [
    [true, true, true],
    [true, false, false],
    [false, true, false],
    [false, false, false],
    [undefined, undefined, false],
  ]) {
    assert.equal(withTty(stdin, stdout, () => canAsk()), expected,
      `stdin=${stdin} stdout=${stdout} -> ${expected}`);
  }
});

test('canAsk: --no-input and --json close the gate even on a terminal', () => {
  withTty(true, true, () => {
    assert.equal(canAsk(), true, 'the baseline this run would otherwise allow');
    assert.equal(canAsk({ input: false }), false, '--no-input');
    assert.equal(canAsk({ json: true }), false, '--json output is for a machine');
    assert.equal(canAsk({ input: false, json: true }), false);
    assert.equal(canAsk({ input: true }), true, 'the flag absent means commander default true');
  });
});

test('canAsk: the tty override wins over the real streams, for tests', () => {
  withTty(false, false, () => {
    assert.equal(canAsk({ tty: true }), true);
    assert.equal(canAsk({ tty: true, input: false }), false, 'the flags still close it');
    assert.equal(canAsk({ tty: true, json: true }), false);
  });
});

/** A pair of streams @clack will treat as a terminal, plus what was drawn. */
function mockTty() {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 100;
  const drawn = [];
  output.on('data', c => drawn.push(String(c)));
  return { input, output, frames: () => drawn.join('') };
}

/** Type `keys` into the prompt once it has drawn its first frame. */
function answer(input, output, keys) {
  output.once('data', () => setImmediate(() => input.write(keys)));
}

const ENTER = '\r';
const ESC = '\x1B';
const DOWN = '\x1B[B';

test('clack select: draws every row and returns the preselected value on Enter', async () => {
  const { input, output, frames } = mockTty();
  const prompts = createClackPrompts({ input, output });
  answer(input, output, ENTER);
  const picked = await prompts.select('Which base?', [
    { value: 'staging', label: 'staging   2 fixed' },
    { value: 'localhost-4200', label: 'localhost-4200   0 fixed' },
  ], 'localhost-4200');
  assert.equal(picked, 'localhost-4200', 'initial is what Enter confirms');
  const drawn = frames();
  assert.match(drawn, /Which base\?/);
  assert.match(drawn, /staging {3}2 fixed/, 'the first row is drawn');
  assert.match(drawn, /localhost-4200 {3}0 fixed/, 'and so is the row that is not focused');
});

test('clack select: arrowing moves off the preselected row', async () => {
  const { input, output } = mockTty();
  const prompts = createClackPrompts({ input, output });
  answer(input, output, DOWN + ENTER);
  const picked = await prompts.select('Which base?', [
    { value: 'a', label: 'a' },
    { value: 'b', label: 'b' },
  ], 'a');
  assert.equal(picked, 'b');
});

test('clack select: escape is a cancel, reported as null', async () => {
  const { input, output } = mockTty();
  const prompts = createClackPrompts({ input, output });
  answer(input, output, ESC);
  assert.equal(await prompts.select('Which base?', [{ value: 'a', label: 'a' }], 'a'), null);
});

test('clack text: an answer comes back trimmed of nothing but the newline', async () => {
  const { input, output } = mockTty();
  const prompts = createClackPrompts({ input, output });
  answer(input, output, `http://localhost:3000${ENTER}`);
  assert.equal(await prompts.text('Which url?'), 'http://localhost:3000');
});

test('clack text: validate rejects the answer instead of returning it', async () => {
  const { input, output, frames } = mockTty();
  const prompts = createClackPrompts({ input, output });
  // A rejected answer keeps the prompt open with the value still in it, so the
  // way out of this test is a cancel, not a second answer appended to the first.
  let rejected = false;
  output.on('data', chunk => {
    if (!rejected && String(chunk).includes('that is not a url')) {
      rejected = true;
      setImmediate(() => input.write(ESC));
    }
  });
  answer(input, output, `nope${ENTER}`);
  const picked = await prompts.text('Which url?', {
    validate: value => (value.startsWith('http') ? undefined : 'that is not a url'),
  });
  assert.equal(picked, null, 'a rejected answer is never handed back to the caller');
  assert.match(frames(), /that is not a url/, 'and the reason is shown to the user');
});

test('clack text: escape is a cancel, reported as null', async () => {
  const { input, output } = mockTty();
  const prompts = createClackPrompts({ input, output });
  answer(input, output, ESC);
  assert.equal(await prompts.text('Which url?'), null);
});

test('clack cancelled: the note is drawn on the given output, not on stdout', async () => {
  const { input, output, frames } = mockTty();
  createClackPrompts({ input, output }).cancelled('nothing was done');
  await new Promise(r => setImmediate(r));
  assert.match(frames(), /nothing was done/);
});
