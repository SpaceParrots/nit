// SPDX-License-Identifier: AGPL-3.0-or-later
// Reviewing a second base url turns a flat review folder into a workspace.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureBase, openWorkspace } from '../dist/store/workspace.js';
import { createStore } from '../dist/store/store.js';
import { tmpDir } from './helpers/tmp.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli', 'index.js');

test('migrate: a store opened on an ensureBase folder writes inside that base', () => {
  const dir = tmpDir('nit-migrate-');
  const base = ensureBase(dir, 'https://staging.example.com', 'staging');
  const store = createStore(base.dir, { url: base.url, author: 'Kevin' });
  store.upsert({ id: 'a1', comment: 'hi', status: 'open', type: 'change-request' });
  store.flush();

  assert.ok(fs.existsSync(path.join(dir, 'staging', 'annotations.json')));
  assert.ok(!fs.existsSync(path.join(dir, 'annotations.json')), 'nothing at the workspace root');
  const ws = openWorkspace(dir);
  assert.equal(ws.layout, 'multi');
  assert.equal(ws.bases[0].url, 'https://staging.example.com');
});

test('migrate: two bases keep independent id sequences', () => {
  const dir = tmpDir('nit-migrate-');
  for (const [url, alias] of [['https://staging.example.com', 'staging'], ['http://localhost:4200', undefined]]) {
    const base = ensureBase(dir, url, alias);
    const store = createStore(base.dir, { url: base.url });
    store.upsert({ id: store.nextId(), comment: 'first', status: 'open', type: 'change-request' });
    store.flush();
  }
  const ws = openWorkspace(dir);
  assert.deepEqual(ws.bases.map(b => b.slug), ['localhost-4200', 'staging']);
  for (const b of ws.bases) {
    const data = JSON.parse(fs.readFileSync(b.file, 'utf8'));
    assert.deepEqual(data.annotations.map(a => a.id), ['a1'], `${b.slug} starts at a1`);
  }
});

test('migrate: nit review exposes --base for naming a url\'s folder', () => {
  const res = spawnSync(process.execPath, [CLI, 'review', '--help'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(res.status, 0);
  const out = res.stdout + res.stderr;
  assert.match(out, /-b, --base/, 'the flag is declared');
  assert.match(out, /derived from the host/, 'and says what the default is');
});
