// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { sortAnnotations, groupAnnotations, defaultExpanded, distinctAuthors, filterByAuthor } from '../dist/panel/filter.js';

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
  assert.deepEqual(groups.map(g => g.key), ['/products', '/about']);
  assert.deepEqual(
    groups[0].items.map(a => a.id).sort(),
    ['a1', 'a3'],
    '/products and /products?id=5 merge into one pathname-keyed group',
  );
  assert.deepEqual(groups[1].items.map(a => a.id), ['a2', 'a4'], 'sort applies inside groups');
});

test('panel filter: standing on a third query variant, exactly one group is current', () => {
  const groups = groupAnnotations(SET, { sort: 'time', group: 'page' }, '/products?id=9');
  const opts = { sort: 'time', group: 'page' };
  const currentFlags = groups.map(g => ({
    key: g.key,
    expanded: defaultExpanded(g.key, opts, '/products?id=9'),
  }));
  const current = currentFlags.filter(g => g.expanded);
  assert.equal(current.length, 1, 'exactly one group is current-and-expanded');
  assert.equal(current[0].key, '/products');
  assert.equal(groups[0].key, '/products', 'the current group also sorts first');
});

test('panel filter: group by state uses the actionable-first order and skips empty states', () => {
  const groups = groupAnnotations(SET, { sort: 'time', group: 'state' }, '/');
  assert.deepEqual(groups.map(g => g.key), ['open', 'reopened', 'fixed', 'verified']);
});

test('panel filter: only the current route group is expanded by default', () => {
  const opts = { sort: 'time', group: 'page' };
  // Group keys are now bare pathnames (as produced by groupAnnotations), so the
  // current route's query string is stripped before comparing.
  assert.equal(defaultExpanded('/products', opts, '/products?id=5'), true, 'query on currentRoute is ignored');
  assert.equal(defaultExpanded('/about', opts, '/products'), false);
  assert.equal(defaultExpanded('open', { sort: 'time', group: 'state' }, '/products'), true);
});

test('panel filter: empty input yields no groups', () => {
  assert.deepEqual(groupAnnotations([], { sort: 'time', group: 'page' }, '/'), []);
});

test('panel filter: state sorting puts a status outside STATE_ORDER last, without crashing', () => {
  const withUnknown = [...SET, ann('a6', '/misc', 'archived', '2026-07-21T13:00:00Z')];
  assert.deepEqual(
    sortAnnotations(withUnknown, 'state').map(a => a.id),
    ['a2', 'a4', 'a1', 'a3', 'a6'],
    '"archived" is not in STATE_ORDER, so it ranks after every known status regardless of recency',
  );
});

test('panel filter: time sorting handles a missing createdAt without crashing', () => {
  const withMissing = [...SET, ann('a7', '/misc', 'open', undefined)];
  assert.deepEqual(
    sortAnnotations(withMissing, 'time').map(a => a.id),
    ['a2', 'a3', 'a1', 'a4', 'a7'],
    'a missing createdAt coerces to the empty string, which sorts as the oldest',
  );
});

test('panel filter: distinctAuthors dedupes, sorts, and ignores missing/empty authors', () => {
  const items = [
    { id: 'a1', author: 'Bob' },
    { id: 'a2', author: 'Ann' },
    { id: 'a3', author: 'Bob' },
    { id: 'a4', author: '' },
    { id: 'a5' },
  ];
  assert.deepEqual(distinctAuthors(items), ['Ann', 'Bob']);
});

test('panel filter: filterByAuthor(items, null) returns everything', () => {
  const items = [{ id: 'a1', author: 'Ann' }, { id: 'a2', author: 'Bob' }];
  assert.deepEqual(filterByAuthor(items, null), items);
});

test('panel filter: filterByAuthor(items, "Ann") keeps only Ann\'s annotations', () => {
  const items = [
    { id: 'a1', author: 'Ann' },
    { id: 'a2', author: 'Bob' },
    { id: 'a3', author: 'Ann' },
  ];
  assert.deepEqual(filterByAuthor(items, 'Ann').map(a => a.id), ['a1', 'a3']);
});
