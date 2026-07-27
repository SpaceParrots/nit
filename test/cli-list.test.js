// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesFilter, buildListResult, runList } from '../dist/cli/list.js';
import { ensureBase } from '../dist/store/workspace.js';
import { createStore } from '../dist/store/store.js';
import { tmpDir } from './helpers/tmp.js';

/** One annotation, with the fields list cares about. */
function ann(id, over = {}) {
  return {
    id, type: 'change-request', comment: `c ${id}`, status: 'open', author: 'Kevin',
    viewportScope: 'general', viewport: { mode: 'desktop', w: 1440, h: 900 }, route: '/',
    target: { component: 'div', ngComponent: null, selector: '.x', xpath: '/html[1]', tag: 'div', classes: [], text: '', rect: { x: 0, y: 0, w: 1, h: 1 } },
    screenshot: null, createdAt: '2026-07-20T10:00:00Z', ...over,
  };
}

/** A workspace: staging (3 annotations, 2 routes) and localhost-4200 (1). */
function seedWorkspace() {
  const dir = tmpDir('nit-list-');
  const staging = ensureBase(dir, 'https://staging.example.com', 'staging');
  const s = createStore(staging.dir, { url: staging.url, author: 'Kevin' });
  s.upsert(ann('a1', { route: '/checkout' }));
  s.upsert(ann('a2', { route: '/checkout', status: 'verified' }));
  s.upsert(ann('a3', { route: '/', type: 'comment', author: 'Ann' }));
  s.flush();
  const local = ensureBase(dir, 'http://localhost:4200');
  const l = createStore(local.dir, { url: local.url, author: 'Kevin' });
  l.upsert(ann('a1', { route: '/cart' }));
  l.flush();
  return dir;
}

test('list: matchesFilter combines status, type, route, author and actionable', () => {
  const open = ann('a1', { route: '/checkout?tab=1' });
  assert.ok(matchesFilter(open, {}));
  assert.ok(matchesFilter(open, { status: 'open' }));
  assert.ok(!matchesFilter(open, { status: 'verified' }));
  assert.ok(matchesFilter(open, { type: 'change-request' }));
  assert.ok(!matchesFilter(open, { type: 'comment' }));
  assert.ok(matchesFilter(open, { route: '/checkout' }), 'bare pathname matches a route with a query');
  assert.ok(matchesFilter(open, { route: '/checkout?tab=1' }), 'exact route matches');
  assert.ok(!matchesFilter(open, { route: '/cart' }));
  assert.ok(matchesFilter(open, { author: 'kevin' }), 'author is case-insensitive');
  assert.ok(matchesFilter(open, { actionable: true }));
  assert.ok(!matchesFilter(ann('a2', { status: 'verified' }), { actionable: true }));
});

test('list: bases are counted and sorted busiest first', () => {
  const result = buildListResult(seedWorkspace(), {});
  assert.equal(result.layout, 'multi');
  assert.equal(result.total, 4);
  assert.equal(result.actionable, 2); // staging a1 + localhost a1; a2 verified, a3 is a comment
  assert.deepEqual(result.bases.map(b => b.slug), ['staging', 'localhost-4200']);
  assert.equal(result.bases[0].total, 3);
  assert.equal(result.bases[0].byStatus.verified, 1);
});

test('list: --base yields url rows built from base + route', () => {
  const result = buildListResult(seedWorkspace(), { base: 'staging' });
  assert.deepEqual(result.bases.map(b => b.slug), ['staging']);
  assert.deepEqual(result.bases[0].urls.map(u => u.url), [
    'https://staging.example.com/checkout',
    'https://staging.example.com/',
  ]);
  assert.equal(result.bases[0].urls[0].count, 2);
});

test('list: filters narrow the counts and drop empty bases', () => {
  const result = buildListResult(seedWorkspace(), { filter: { status: 'verified' } });
  assert.deepEqual(result.bases.map(b => b.slug), ['staging']);
  assert.equal(result.total, 1);
});

test('list: an unfiltered listing keeps a base that has no annotations yet', () => {
  const dir = seedWorkspace();
  ensureBase(dir, 'https://prod.example.com', 'prod');   // created, nothing captured yet

  const all = buildListResult(dir, {});
  assert.ok(all.bases.some(b => b.slug === 'prod'), 'a base with 0 annotations is still part of the review');
  assert.equal(all.bases.find(b => b.slug === 'prod').total, 0);
  assert.equal(all.total, 4, 'an empty base adds nothing to the totals');

  const lines = [];
  runList(dir, { log: l => lines.push(l) });
  assert.match(lines.join('\n'), /prod/, 'and it is visible in the report');

  const filtered = buildListResult(dir, { filter: { actionable: true } });
  assert.ok(!filtered.bases.some(b => b.slug === 'prod'), 'a filtered listing still drops what does not match');
});

test('list: --base on an empty base reports the base, not "nothing matches"', () => {
  const dir = seedWorkspace();
  ensureBase(dir, 'https://prod.example.com', 'prod');
  const lines = [];
  runList(dir, { base: 'prod', log: l => lines.push(l) });
  const text = lines.join('\n');
  assert.match(text, /prod/);
  assert.doesNotMatch(text, /Nothing matches/);
});

test('list: a flat review folder lists as one base', () => {
  const dir = tmpDir('nit-list-');
  const store = createStore(dir, { url: 'https://fainin.dev/', author: 'Kevin' });
  store.upsert(ann('a1'));
  store.flush();
  const result = buildListResult(dir, {});
  assert.equal(result.layout, 'flat');
  assert.deepEqual(result.bases.map(b => b.slug), ['fainin-dev']);
});

test('list: --json prints the result and the report prints a table', () => {
  const dir = seedWorkspace();
  const json = [];
  runList(dir, { json: true, log: l => json.push(l) });
  const parsed = JSON.parse(json.join('\n'));
  assert.equal(parsed.total, 4);

  const lines = [];
  runList(dir, { log: l => lines.push(l) });
  const text = lines.join('\n');
  assert.match(text, /staging/);
  assert.match(text, /https:\/\/staging\.example\.com/);
  assert.match(text, /4 annotations across 2 base URLs/);
});
