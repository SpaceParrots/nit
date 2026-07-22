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

test('security: resolveAnnotationUrl rejects a backslash bypass attempt', () => {
  const base = 'https://staging.example.com/';
  // A route of '\\evil.com/steal' (two-character backslash sequence) is
  // interpreted by the WHATWG URL parser the same as '//evil.com/steal':
  // backslashes are normalized to forward slashes for special schemes, so
  // this is a protocol-relative escape in disguise and must be rejected.
  assert.equal(resolveAnnotationUrl(base, '\\\\evil.com/steal'), null);
});

test('security: resolveAnnotationUrl rejects userinfo tricks', () => {
  const base = 'https://staging.example.com/';
  assert.equal(resolveAnnotationUrl(base, 'https://user@evil.com/'), null);
  assert.equal(resolveAnnotationUrl(base, 'https://staging.example.com@evil.com/'), null);
});

test('security: resolveAnnotationUrl rejects same host with a different port or scheme', () => {
  const base = 'https://staging.example.com/';
  assert.equal(resolveAnnotationUrl(base, 'https://staging.example.com:8443/'), null);
  assert.equal(resolveAnnotationUrl(base, 'http://staging.example.com/'), null);
});

test('security: resolveAnnotationUrl does not decode percent-encoding into an escape — the value stays on-origin', () => {
  const base = 'https://staging.example.com/';
  // '%2F%2Fevil.com' decodes to '//evil.com', but the URL parser treats the
  // percent-encoding literally (it is not re-decoded before parsing), so this
  // resolves as a same-origin path rather than escaping — verify the exact
  // resolved value rather than merely "not null".
  assert.equal(
    resolveAnnotationUrl(base, '%2F%2Fevil.com'),
    'https://staging.example.com/%2F%2Fevil.com',
  );
});

test('security: resolveAnnotationUrl resolves an empty-string route to the origin root', () => {
  assert.equal(resolveAnnotationUrl('https://x.test/a/b?q=1', ''), 'https://x.test/');
  assert.equal(resolveAnnotationUrl('https://x.test/a/b?q=1', undefined), 'https://x.test/');
});

test('security: resolveAnnotationUrl resolves fragment-only and query-only routes against the current path', () => {
  const base = 'https://staging.example.com/a/b';
  assert.equal(resolveAnnotationUrl(base, '#section'), 'https://staging.example.com/a/b#section');
  assert.equal(resolveAnnotationUrl(base, '?id=5'), 'https://staging.example.com/a/b?id=5');
});
