// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { baseSlug, qualifyId, parseQualifiedId, isSafeSlug, openWorkspace, readIndex } from '../dist/store/workspace.js';
import { tmpDir } from './helpers/tmp.js';

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

/** Write a review folder at `dir` with the given url and annotation ids. */
function writeReview(dir, url, ids = []) {
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'annotations.json'), JSON.stringify({
    review: { id: 'fixture', url, createdAt: '2026-07-20T10:00:00Z', authors: ['Kevin'] },
    annotations: ids.map(id => ({
      id, type: 'change-request', comment: `c ${id}`, status: 'open', author: 'Kevin',
      viewportScope: 'general', viewport: { mode: 'desktop', w: 1440, h: 900 }, route: '/',
      target: { component: 'div', ngComponent: null, selector: '.x', xpath: '/html[1]', tag: 'div', classes: [], text: '', rect: { x: 0, y: 0, w: 1, h: 1 } },
      screenshot: null, createdAt: '2026-07-20T10:01:00Z',
    })),
  }, null, 2));
}

test('workspace: an empty dir has no bases', () => {
  const ws = openWorkspace(tmpDir('nit-ws-'));
  assert.equal(ws.layout, 'empty');
  assert.deepEqual(ws.bases, []);
});

test('workspace: a flat review folder is one base, slug from its own review.url', () => {
  const dir = tmpDir('nit-ws-');
  writeReview(dir, 'https://fainin.dev/', ['a1']);
  const ws = openWorkspace(dir);
  assert.equal(ws.layout, 'flat');
  assert.equal(ws.bases.length, 1);
  assert.equal(ws.bases[0].slug, 'fainin-dev');
  assert.equal(ws.bases[0].url, 'https://fainin.dev/');
  assert.equal(ws.bases[0].dir, dir);
  assert.equal(ws.bases[0].file, path.join(dir, 'annotations.json'));
});

test('workspace: subfolders with annotations.json are bases, listed or not', () => {
  const dir = tmpDir('nit-ws-');
  writeReview(path.join(dir, 'staging'), 'https://staging.example.com', ['a1']);
  writeReview(path.join(dir, 'localhost-4200'), 'http://localhost:4200', ['a1', 'a2']);
  // index mentions only one of them, and one that no longer exists
  fs.writeFileSync(path.join(dir, 'bases.json'), JSON.stringify({
    version: 1,
    bases: [
      { slug: 'staging', url: 'https://staging.example.com', createdAt: '2026-07-25T09:00:00Z' },
      { slug: 'gone', url: 'https://gone.example.com' },
    ],
  }));
  const ws = openWorkspace(dir);
  assert.equal(ws.layout, 'multi');
  assert.deepEqual(ws.bases.map(b => b.slug), ['localhost-4200', 'staging']); // sorted, stale entry dropped
  assert.equal(ws.bases[1].createdAt, '2026-07-25T09:00:00Z');               // index metadata adopted
  assert.equal(ws.bases[0].url, 'http://localhost:4200');                    // unlisted folder adopted
});

test('workspace: a malformed bases.json is ignored, not fatal', () => {
  const dir = tmpDir('nit-ws-');
  writeReview(path.join(dir, 'staging'), 'https://staging.example.com', ['a1']);
  fs.writeFileSync(path.join(dir, 'bases.json'), '{ this is not json');
  const ws = openWorkspace(dir);
  assert.equal(ws.layout, 'multi');
  assert.deepEqual(ws.bases.map(b => b.slug), ['staging']);
});

test('workspace: readIndex drops an unsafe slug and keeps a valid one', () => {
  const dir = tmpDir('nit-ws-');
  fs.writeFileSync(path.join(dir, 'bases.json'), JSON.stringify({
    version: 1,
    bases: [
      { slug: '../../escape', url: 'https://evil.test' },
      { slug: 'staging', url: 'https://staging.example.com' },
    ],
  }));
  const index = readIndex(dir);
  assert.equal(index.has('../../escape'), false, 'the unsafe slug never enters the index');
  assert.equal(index.size, 1);
  assert.equal(index.get('staging')?.url, 'https://staging.example.com');
});

test('workspace: bases.json content never reaches path.join — paths come only from enumerated directory names', () => {
  const dir = tmpDir('nit-ws-');
  writeReview(path.join(dir, 'staging'), 'https://staging.example.com', ['a1']);
  fs.writeFileSync(path.join(dir, 'bases.json'), JSON.stringify({
    version: 1,
    bases: [{ slug: '../../escape', url: 'https://evil.test' }],
  }));
  const ws = openWorkspace(dir);
  // 'staging' is a real subfolder; '../../escape' has no matching directory on
  // disk at all, so it can't appear here regardless of the readIndex guard —
  // see the 'readIndex drops an unsafe slug' test above for that guard itself.
  assert.deepEqual(ws.bases.map(b => b.slug), ['staging']);
  for (const b of ws.bases) assert.ok(b.dir.startsWith(dir), 'every base stays inside the workspace');
});
