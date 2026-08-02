// SPDX-License-Identifier: AGPL-3.0-or-later
// The commander-based CLI: helpful output, per-command help, aliases, suggestions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  assert.ok(review.out.includes('[url]'), 'the url is optional — nit offers the known ones');
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
    ['r', '[url]'],
    ['annotate', '[url]'],
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
  // commander still owns the ones nit cannot offer a choice for
  const merge = run('merge');
  assert.notEqual(merge.code, 0);
  assert.ok(merge.out.includes('missing required argument'));
  assert.ok(merge.out.includes('--help'));

  // review and import ask instead — but only on a terminal, and this is a pipe
  for (const [cmd, needs, example] of [
    ['review', 'needs a url', /e\.g\. nit review https?:\/\/\S+/],
    ['import', 'needs a zip', /e\.g\. nit import \S+\.zip/],
  ]) {
    const { code, out } = run(cmd);
    assert.notEqual(code, 0, `${cmd} with no argument fails`);
    assert.ok(out.includes(needs), `${cmd} says what is missing`);
    assert.match(out, example, `${cmd} shows a worked example, not just its own name`);
  }
});

test('cli: --no-input suppresses the prompt rather than only being advertised', () => {
  const cwd = tmpDir('nit-cli-noinput-');
  for (const slug of ['staging', 'localhost-4200']) {
    fs.mkdirSync(path.join(cwd, 'nit-review', slug), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'nit-review', slug, 'annotations.json'), JSON.stringify({
      review: { url: `https://${slug}.test` },
      annotations: [{ id: 'a1', type: 'change-request', status: 'verified', comment: 'c', route: '/' }],
    }));
  }
  // A pipe cannot be prompted anyway, so --no-input is asserted where it is the
  // only thing standing between the user and a question: with --all, which
  // reaches runClear's confirmation.
  const clear = runIn(cwd, 'clear', '--all', '--verified', '--no-input');
  assert.notEqual(clear.code, 0);
  assert.ok(clear.out.includes('--yes for scripts'), 'the confirmation refuses instead of asking');

  const verify = runIn(cwd, 'verify', '--no-input');
  assert.notEqual(verify.code, 0);
  assert.ok(verify.out.includes('pass --base to pick one'), 'the base picker refuses instead of asking');
});

test('cli: --no-input turns the prompts off where they exist', () => {
  for (const cmd of ['review', 'view', 'verify', 'status', 'list', 'clear', 'export', 'import']) {
    const { code, out } = run(cmd, '--help');
    assert.equal(code, 0, `${cmd} --help exits 0`);
    assert.ok(out.includes('--no-input'), `${cmd} offers --no-input`);
  }
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

test('cli: -v, -V and --version all print the package version', () => {
  const expected = JSON.parse(
    fs.readFileSync(path.join(path.dirname(CLI), '..', '..', 'package.json'), 'utf8'),
  ).version;
  for (const flag of ['-v', '-V', '--version']) {
    const { code, out } = run(flag);
    assert.equal(code, 0, `${flag} exits 0`);
    assert.equal(out.trim(), expected, `${flag} prints ${expected}`);
  }
});

test('cli: list and clear appear in help with their flags', () => {
  const top = run('--help');
  assert.ok(top.out.includes('list'));
  assert.ok(top.out.includes('clear'));

  const list = run('list', '--help');
  assert.equal(list.code, 0);
  for (const flag of ['--base', '--all', '--status', '--actionable', '--json']) {
    assert.ok(list.out.includes(flag), `list help mentions ${flag}`);
  }

  const clear = run('clear', '--help');
  assert.equal(clear.code, 0);
  for (const flag of ['--base', '--all', '--verified', '--dry-run', '--yes']) {
    assert.ok(clear.out.includes(flag), `clear help mentions ${flag}`);
  }
});

test('cli: the base-aware commands all offer --base', () => {
  for (const cmd of ['review', 'view', 'verify', 'status', 'export']) {
    const { code, out } = run(cmd, '--help');
    assert.equal(code, 0, `${cmd} --help exits 0`);
    assert.ok(out.includes('--base'), `${cmd} help mentions --base`);
  }
});

test('cli: -h is help, same as --help', () => {
  const short = run('-h');
  const long = run('--help');
  assert.equal(short.code, 0);
  assert.equal(short.out, long.out);
});
