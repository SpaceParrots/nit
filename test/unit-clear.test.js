// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { selectForClear, clearBase } from '../dist/store/clear.js';
import { ensureBase, openWorkspace } from '../dist/store/workspace.js';
import { createStore } from '../dist/store/store.js';
import { tmpDir } from './helpers/tmp.js';

const ANNS = [
  { id: 'a1', status: 'open', type: 'change-request' },
  { id: 'a2', status: 'verified', type: 'change-request' },
  { id: 'a3', status: 'verified', type: 'comment' },
  { id: 'a4', status: 'wontfix', type: 'change-request' },
];

test('clear: an empty scope selects everything', () => {
  assert.deepEqual(selectForClear(ANNS, {}).map(a => a.id), ['a1', 'a2', 'a3', 'a4']);
});

test('clear: a status scope selects only that status, across types', () => {
  assert.deepEqual(selectForClear(ANNS, { status: 'verified' }).map(a => a.id), ['a2', 'a3']);
  assert.deepEqual(selectForClear(ANNS, { status: 'wontfix' }).map(a => a.id), ['a4']);
  assert.deepEqual(selectForClear(ANNS, { status: 'fixed' }).map(a => a.id), []);
});

/** A base with the four ANNS and a screenshot on the verified a2. */
function seedBase() {
  const dir = tmpDir('nit-clear-');
  const base = ensureBase(dir, 'https://staging.example.com', 'staging');
  const store = createStore(base.dir, { url: base.url, author: 'Kevin' });
  for (const a of ANNS) {
    store.upsert({
      ...a, comment: `c ${a.id}`, author: 'Kevin', viewportScope: 'general',
      viewport: { mode: 'desktop', w: 1440, h: 900 }, route: '/',
      target: { component: 'div', ngComponent: null, selector: '.x', xpath: '/html[1]', tag: 'div', classes: [], text: '', rect: { x: 0, y: 0, w: 1, h: 1 } },
      screenshot: a.id === 'a2' ? 'shots/a2.png' : null, createdAt: '2026-07-20T10:00:00Z',
    });
  }
  store.flush();
  fs.writeFileSync(path.join(base.dir, 'shots', 'a2.png'), 'png-bytes');
  return { dir, base };
}

test('clear: clearBase removes the selected annotations and their screenshots', () => {
  const { dir, base } = seedBase();
  const result = clearBase(base, { status: 'verified' });

  assert.equal(result.cleared, 2);
  assert.equal(result.remaining, 2);
  assert.deepEqual(result.ids, ['a2', 'a3']);
  assert.equal(result.slug, 'staging');

  const data = JSON.parse(fs.readFileSync(base.file, 'utf8'));
  assert.deepEqual(data.annotations.map(a => a.id), ['a1', 'a4']);
  assert.ok(!fs.existsSync(path.join(base.dir, 'shots', 'a2.png')), 'screenshot unlinked');
  assert.ok(fs.existsSync(path.join(base.dir, 'review.md')), 'derived files re-rendered');
  assert.equal(openWorkspace(dir).bases.length, 1, 'the base folder survives');
});

test('clear: an empty-out keeps review metadata and the base folder', () => {
  const { base } = seedBase();
  const result = clearBase(base, {});
  assert.equal(result.cleared, 4);
  assert.equal(result.remaining, 0);
  const data = JSON.parse(fs.readFileSync(base.file, 'utf8'));
  assert.deepEqual(data.annotations, []);
  assert.equal(data.review.url, 'https://staging.example.com');
  assert.deepEqual(data.review.authors, ['Kevin']);
});

test('clear: a dry run reports without writing', () => {
  const { base } = seedBase();
  const result = clearBase(base, { status: 'verified' }, { dryRun: true });
  assert.equal(result.cleared, 2);
  assert.equal(result.remaining, 2);
  const data = JSON.parse(fs.readFileSync(base.file, 'utf8'));
  assert.equal(data.annotations.length, 4, 'nothing removed');
  assert.ok(fs.existsSync(path.join(base.dir, 'shots', 'a2.png')), 'screenshot kept');
});
