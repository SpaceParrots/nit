// SPDX-License-Identifier: AGPL-3.0-or-later
// Path-traversal guards: annotation files are shared between people and edited by
// agents, so screenshot paths must never escape the review directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { safeShotPath } from '../dist/store/store.js';
import { resolveAnnotationUrl } from '../dist/store/url.js';

test('safeShotPath: accepts normal relative shot paths inside the dir', () => {
  const base = path.resolve('/reviews/x');
  assert.equal(safeShotPath(base, 'shots/a1.png'), path.join(base, 'shots', 'a1.png'));
  assert.equal(safeShotPath(base, 'shots/kevin_a1-after.png'), path.join(base, 'shots', 'kevin_a1-after.png'));
});

test('safeShotPath: rejects parent-directory traversal', () => {
  const base = path.resolve('/reviews/x');
  assert.equal(safeShotPath(base, '../../../../etc/passwd'), null);
  assert.equal(safeShotPath(base, 'shots/../../secret'), null);
  assert.equal(safeShotPath(base, '..\\..\\Windows\\System32'), process.platform === 'win32' ? null : safeShotPath(base, '..\\..\\Windows\\System32'));
});

test('safeShotPath: rejects absolute paths, null bytes and non-strings', () => {
  const base = path.resolve('/reviews/x');
  assert.equal(safeShotPath(base, path.resolve('/etc/passwd')), null);
  assert.equal(safeShotPath(base, 'shots/a\0.png'), null);
  assert.equal(safeShotPath(base, null), null);
  assert.equal(safeShotPath(base, undefined), null);
  assert.equal(safeShotPath(base, 42), null);
  assert.equal(safeShotPath(base, ''), null);
});

test('safeShotPath: a sibling dir sharing a name prefix is not "inside"', () => {
  const base = path.resolve('/reviews/x');
  // /reviews/x-evil starts with "/reviews/x" as a string but is a different dir
  assert.equal(safeShotPath(base, '../x-evil/shots/a.png'), null);
});

test('security: resolveAnnotationUrl resolves a relative route against the review origin', () => {
  assert.equal(
    resolveAnnotationUrl('https://staging.example.com/', '/products?id=5#tab'),
    'https://staging.example.com/products?id=5#tab',
  );
  assert.equal(resolveAnnotationUrl('http://localhost:4200/', '/'), 'http://localhost:4200/');
  assert.equal(resolveAnnotationUrl('http://localhost:4200/x', undefined), 'http://localhost:4200/');
});

test('security: resolveAnnotationUrl rejects routes that escape the review origin', () => {
  const base = 'https://staging.example.com/';
  assert.equal(resolveAnnotationUrl(base, 'https://evil.com/steal'), null, 'absolute other-origin');
  assert.equal(resolveAnnotationUrl(base, '//evil.com/steal'), null, 'protocol-relative');
  assert.equal(resolveAnnotationUrl(base, 'javascript:alert(1)'), null, 'javascript: scheme');
  assert.equal(resolveAnnotationUrl(base, 'data:text/html,<script>1</script>'), null, 'data: scheme');
  assert.equal(resolveAnnotationUrl(base, 'file:///etc/passwd'), null, 'file: scheme');
  assert.equal(resolveAnnotationUrl(base, 'https://staging.example.com.evil.com/'), null, 'suffix lookalike');
});

test('security: resolveAnnotationUrl rejects an unusable review url', () => {
  assert.equal(resolveAnnotationUrl('', '/x'), null);
  assert.equal(resolveAnnotationUrl('not a url', '/x'), null);
  assert.equal(resolveAnnotationUrl('file:///tmp/page.html', '/x'), null);
});
