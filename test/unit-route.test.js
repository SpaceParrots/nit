// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { currentRoute, routePath } from '../dist/util/route.js';

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
