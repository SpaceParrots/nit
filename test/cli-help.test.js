// The commander-based CLI: helpful output, per-command help, aliases, suggestions.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'index.js');

function run(...args) {
  const res = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 30000 });
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
  assert.ok(verify.out.includes('Verified or Reopen'));
});

test('cli: aliases resolve to their commands', () => {
  for (const [alias, marker] of [
    ['r', '<url>'],
    ['annotate', '<url>'],
    ['v', '<file>'],
    ['replay', '<file>'],
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
  assert.ok(out.includes("missing required argument"));
  assert.ok(out.includes('--help'));
});
