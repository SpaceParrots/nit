// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { baseSlug, qualifyId, parseQualifiedId, isSafeSlug } from '../dist/store/workspace.js';

test('workspace: baseSlug derives host + non-default port', () => {
  const cases = [
    ['http://localhost:4200', 'localhost-4200'],
    ['https://staging.example.com', 'staging-example-com'],
    ['https://fainin.dev/', 'fainin-dev'],
    ['https://example.com/deep/path?q=1', 'example-com'],
    ['http://example.com:80/', 'example-com'],      // URL strips default ports
    ['https://example.com:443/', 'example-com'],
    ['http://127.0.0.1:3000', '127-0-0-1-3000'],
    ['not a url', 'review'],                         // unparseable → same fallback as safeHost
    ['', 'review'],
  ];
  for (const [url, expected] of cases) {
    assert.equal(baseSlug(url), expected, url);
  }
});

test('workspace: qualifyId/parseQualifiedId round-trip, splitting on the first colon', () => {
  assert.equal(qualifyId('staging', 'a1'), 'staging:a1');
  assert.deepEqual(parseQualifiedId('staging:a1'), { slug: 'staging', id: 'a1' });
  // a merged base keeps its author namespace intact in the id half
  assert.equal(qualifyId('staging', 'kevin:a1'), 'staging:kevin:a1');
  assert.deepEqual(parseQualifiedId('staging:kevin:a1'), { slug: 'staging', id: 'kevin:a1' });
  // a bare id has no slug half
  assert.deepEqual(parseQualifiedId('a1'), { slug: null, id: 'a1' });
});

test('workspace: isSafeSlug rejects anything that could escape a path', () => {
  for (const ok of ['staging', 'localhost-4200', 'a', '127-0-0-1-3000']) {
    assert.ok(isSafeSlug(ok), ok);
  }
  for (const bad of ['..', '../etc', 'a/b', 'a\\b', '.hidden', '-lead', 'UPPER', 'a b', '', 'a\0b', 42, null, undefined]) {
    assert.ok(!isSafeSlug(bad), String(bad));
  }
});
