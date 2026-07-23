// SPDX-License-Identifier: AGPL-3.0-or-later
// The commander-based CLI: helpful output, per-command help, aliases, suggestions.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli', 'index.js');

function run(...args) {
  const res = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 30000 });
  return { code: res.status, out: res.stdout + res.stderr };
}

/** Like {@link run}, but from a given working directory (for default lookups). */
function runIn(cwd, ...args) {
  const res = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', timeout: 30000 });
  return { code: res.status, out: res.stdout + res.stderr };
}

test('cli: top-level help lists all commands with summaries and the loop', () => {
  const { code, out } = run('--help');
  assert.equal(code, 0);
  for (const cmd of ['review', 'view', 'verify', 'merge', 'mcp']) {
    assert.ok(out.includes(cmd), `help mentions ${cmd}`);
  }
  assert.ok(out.includes('The loop:'));
  assert.ok(out.includes('Examples:'));
  assert.ok(out.includes('annotate a site'));
});

test('cli: per-command help is detailed', () => {
  const review = run('review', '--help');
  assert.equal(review.code, 0);
  assert.ok(review.out.includes('<url>'));
  assert.ok(review.out.includes('--author'));
  assert.ok(review.out.includes('Alt'));
  assert.ok(review.out.includes('--mobile'));

  const verify = run('verify', '--help');
  assert.equal(verify.code, 0);
  assert.ok(verify.out.includes('guided queue'));
  assert.ok(verify.out.includes('Verified, Reopen (with an optional note), or Skip'));
});

test('cli: aliases resolve to their commands', () => {
  for (const [alias, marker] of [
    ['r', '<url>'],
    ['annotate', '<url>'],
    ['v', '[source]'],
    ['replay', '[source]'],
    ['check', 'after'],
    ['combine', '<files...>'],
    ['serve', 'annotations.json'],
  ]) {
    const { code, out } = run(alias, '--help');
    assert.equal(code, 0, `${alias} --help exits 0`);
    assert.ok(out.includes(marker), `${alias} help shows ${marker}`);
  }
});

test('cli: version flag works', () => {
  const { code, out } = run('--version');
  assert.equal(code, 0);
  assert.match(out, /\d+\.\d+\.\d+/);
});

test('cli: unknown command suggests the nearest one', () => {
  const { code, out } = run('reviw');
  assert.notEqual(code, 0);
  assert.ok(out.includes('review'), 'suggestion mentions review');
});

test('cli: missing required argument fails with guidance', () => {
  const { code, out } = run('review');
  assert.notEqual(code, 0);
  assert.ok(out.includes('missing required argument'));
  assert.ok(out.includes('--help'));
});

test('cli: view/verify help shows worked examples and the nit-review default', () => {
  for (const cmd of ['view', 'verify']) {
    const { code, out } = run(cmd, '--help');
    assert.equal(code, 0);
    assert.ok(out.includes('Examples:'), `${cmd} help has examples`);
    assert.ok(out.includes(`$ nit ${cmd}\n`) || out.includes(`$ nit ${cmd} `), `${cmd} shows the bare form`);
    assert.ok(out.includes('nit-review'), `${cmd} names the default directory`);
  }
});

test('cli: verify with no review nearby suggests the next step instead of a stack of errors', () => {
  const dir = tmpDir('nit-cli-empty-');
  const { code, out } = runIn(dir, 'verify');
  assert.notEqual(code, 0);
  assert.ok(out.includes('no review found'), 'says what was looked for');
  assert.ok(out.includes('nit review'), 'suggests starting a review');
  assert.ok(out.includes('nit status'), 'suggests checking what exists');
  assert.ok(!out.includes('at Object'), 'no stack trace leaks');
});
