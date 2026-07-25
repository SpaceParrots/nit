// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runClear } from '../dist/cli/clear.js';
import { ensureBase } from '../dist/store/workspace.js';
import { createStore } from '../dist/store/store.js';
import { tmpDir } from './helpers/tmp.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli', 'index.js');

function ann(id, status) {
  return {
    id, type: 'change-request', comment: `c ${id}`, status, author: 'Kevin',
    viewportScope: 'general', viewport: { mode: 'desktop', w: 1440, h: 900 }, route: '/',
    target: { component: 'div', ngComponent: null, selector: '.x', xpath: '/html[1]', tag: 'div', classes: [], text: '', rect: { x: 0, y: 0, w: 1, h: 1 } },
    screenshot: null, createdAt: '2026-07-20T10:00:00Z',
  };
}

/** staging: a1 open, a2 verified. localhost-4200: a1 verified. */
function seedWorkspace() {
  const dir = tmpDir('nit-clear-cli-');
  const staging = ensureBase(dir, 'https://staging.example.com', 'staging');
  const s = createStore(staging.dir, { url: staging.url, author: 'Kevin' });
  s.upsert(ann('a1', 'open'));
  s.upsert(ann('a2', 'verified'));
  s.flush();
  const local = ensureBase(dir, 'http://localhost:4200');
  const l = createStore(local.dir, { url: local.url, author: 'Kevin' });
  l.upsert(ann('a1', 'verified'));
  l.flush();
  return dir;
}

const ids = dir => JSON.parse(fs.readFileSync(path.join(dir, 'annotations.json'), 'utf8')).annotations.map(a => a.id);

test('clear: --base --verified removes only that base\'s verified items', async () => {
  const dir = seedWorkspace();
  const results = await runClear(dir, { base: 'staging', status: 'verified', yes: true, log: () => {} });
  assert.equal(results.length, 1);
  assert.equal(results[0].cleared, 1);
  assert.deepEqual(ids(path.join(dir, 'staging')), ['a1']);
  assert.deepEqual(ids(path.join(dir, 'localhost-4200')), ['a1'], 'other base untouched');
});

test('clear: --all --verified sweeps every base', async () => {
  const dir = seedWorkspace();
  const results = await runClear(dir, { all: true, status: 'verified', yes: true, log: () => {} });
  assert.equal(results.reduce((n, r) => n + r.cleared, 0), 2);
  assert.deepEqual(ids(path.join(dir, 'staging')), ['a1']);
  assert.deepEqual(ids(path.join(dir, 'localhost-4200')), []);
});

test('clear: --base with no status empties that base', async () => {
  const dir = seedWorkspace();
  await runClear(dir, { base: 'staging', yes: true, log: () => {} });
  assert.deepEqual(ids(path.join(dir, 'staging')), []);
});

test('clear: --dry-run reports without writing', async () => {
  const dir = seedWorkspace();
  const lines = [];
  const results = await runClear(dir, { all: true, status: 'verified', dryRun: true, log: l => lines.push(l) });
  assert.equal(results.reduce((n, r) => n + r.cleared, 0), 2);
  assert.deepEqual(ids(path.join(dir, 'staging')), ['a1', 'a2'], 'nothing removed');
  assert.match(lines.join('\n'), /would/i);
});

test('clear: no scope is an error that names the bases', async () => {
  const dir = seedWorkspace();
  await assert.rejects(() => runClear(dir, { yes: true, log: () => {} }), /--base|--all/);
  await assert.rejects(() => runClear(dir, { yes: true, log: () => {} }), /staging/);
});

test('clear: --base and --all together are refused', async () => {
  const dir = seedWorkspace();
  await assert.rejects(() => runClear(dir, { base: 'staging', all: true, yes: true, log: () => {} }), /both/i);
});

test('clear: the CLI exits 1 with no scope', () => {
  const dir = seedWorkspace();
  const res = spawnSync(process.execPath, [CLI, 'clear', dir], { encoding: 'utf8', timeout: 30000 });
  assert.equal(res.status, 1);
  assert.match(res.stdout + res.stderr, /--base|--all/);
});

test('clear: --verified is sugar for --status verified', () => {
  const dir = seedWorkspace();
  const res = spawnSync(process.execPath, [CLI, 'clear', dir, '--all', '--verified', '--yes'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.deepEqual(ids(path.join(dir, 'staging')), ['a1']);
});
