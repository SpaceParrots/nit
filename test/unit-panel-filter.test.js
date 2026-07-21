// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { sortAnnotations, groupAnnotations, defaultExpanded } from '../dist/panel/filter.js';

const ann = (id, route, status, createdAt) => ({ id, route, status, createdAt, type: 'change-request' });

const SET = [
  ann('a1', '/products', 'fixed', '2026-07-21T10:00:00Z'),
  ann('a2', '/about', 'open', '2026-07-21T12:00:00Z'),
  ann('a3', '/products?id=5', 'verified', '2026-07-21T11:00:00Z'),
  ann('a4', '/about', 'reopened', '2026-07-21T09:00:00Z'),
];

test('panel filter: time sorts newest first', () => {
  assert.deepEqual(sortAnnotations(SET, 'time').map(a => a.id), ['a2', 'a3', 'a1', 'a4']);
});

test('panel filter: page sorts by path then full route, newest first within a route', () => {
  assert.deepEqual(sortAnnotations(SET, 'page').map(a => a.id), ['a2', 'a4', 'a1', 'a3']);
});

test('panel filter: state sorts actionable first', () => {
  assert.deepEqual(sortAnnotations(SET, 'state').map(a => a.id), ['a2', 'a4', 'a1', 'a3']);
});

test('panel filter: sorting does not mutate the input', () => {
  const input = [...SET];
  sortAnnotations(input, 'time');
  assert.deepEqual(input.map(a => a.id), ['a1', 'a2', 'a3', 'a4']);
});

test('panel filter: group none returns a single unlabelled group', () => {
  const groups = groupAnnotations(SET, { sort: 'time', group: 'none' }, '/about');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, '');
  assert.equal(groups[0].items.length, 4);
});

test('panel filter: group by page puts the current route first', () => {
  const groups = groupAnnotations(SET, { sort: 'time', group: 'page' }, '/products?id=9');
  assert.deepEqual(groups.map(g => g.key), ['/products', '/products?id=5', '/about']);
  assert.deepEqual(groups[2].items.map(a => a.id), ['a2', 'a4'], 'sort applies inside groups');
});

test('panel filter: group by state uses the actionable-first order and skips empty states', () => {
  const groups = groupAnnotations(SET, { sort: 'time', group: 'state' }, '/');
  assert.deepEqual(groups.map(g => g.key), ['open', 'reopened', 'fixed', 'verified']);
});

test('panel filter: only the current route group is expanded by default', () => {
  const opts = { sort: 'time', group: 'page' };
  assert.equal(defaultExpanded('/products?id=5', opts, '/products'), true, 'query difference still matches');
  assert.equal(defaultExpanded('/about', opts, '/products'), false);
  assert.equal(defaultExpanded('open', { sort: 'time', group: 'state' }, '/products'), true);
});

test('panel filter: empty input yields no groups', () => {
  assert.deepEqual(groupAnnotations([], { sort: 'time', group: 'page' }, '/'), []);
});
