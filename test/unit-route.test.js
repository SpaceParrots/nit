// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { currentRoute, routePath, routeKey } from '../dist/util/route.js';

test('route: currentRoute joins pathname, search and hash', () => {
  assert.equal(currentRoute({ pathname: '/p', search: '?id=5', hash: '#tab' }), '/p?id=5#tab');
  assert.equal(currentRoute({ pathname: '/', search: '', hash: '' }), '/');
});

test('route: routePath strips query and hash', () => {
  assert.equal(routePath('/products?id=5#tab'), '/products');
  assert.equal(routePath('/products#tab'), '/products');
  assert.equal(routePath('/products'), '/products');
});

test('route: routePath defaults empty and query-only values to /', () => {
  assert.equal(routePath(undefined), '/');
  assert.equal(routePath(''), '/');
  assert.equal(routePath('?id=5'), '/');
  assert.equal(routePath('#tab'), '/');
});

test('route: routeKey keeps the query but drops the hash', () => {
  assert.equal(routeKey('/products?id=5'), '/products?id=5', 'route with a query');
  assert.equal(routeKey('/products#tab'), '/products', 'route with a hash');
  assert.equal(routeKey('/products?id=5#tab'), '/products?id=5', 'route with both');
  assert.equal(routeKey('/products'), '/products', 'route with neither');
});

test('route: routeKey defaults an empty or undefined route to /', () => {
  assert.equal(routeKey(undefined), '/');
  assert.equal(routeKey(''), '/');
});
