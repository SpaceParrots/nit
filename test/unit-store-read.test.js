// SPDX-License-Identifier: AGPL-3.0-or-later
// The one tolerant reader every read-only report goes through: annotations.json
// is shared, hand-editable and agent-written, so a report must degrade to "no
// annotations" rather than crash — and must never hand a caller a value it did
// not actually validate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { asReviewData, readReviewData, readAnnotations } from '../dist/store/read.js';
import { tmpDir } from './helpers/tmp.js';

/** Write `content` (a string, or JSON-stringified) to a fresh annotations.json. */
function reviewFile(content) {
  const file = path.join(tmpDir('nit-read-'), 'annotations.json');
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

test('read: a well-formed review keeps its metadata and annotations', () => {
  const data = asReviewData({
    review: { id: 'r1', url: 'https://example.com', createdAt: '2026-07-20T10:00:00Z', authors: ['Kevin', 'Ann'] },
    annotations: [{ id: 'a1', comment: 'c' }],
  });
  assert.equal(data.review.id, 'r1');
  assert.equal(data.review.url, 'https://example.com');
  assert.deepEqual(data.review.authors, ['Kevin', 'Ann']);
  assert.deepEqual(data.annotations.map(a => a.id), ['a1']);
});

test('read: junk of every shape degrades to an empty review, never throws', () => {
  for (const junk of [null, undefined, 42, 'nope', [], { annotations: 'not an array' }]) {
    const data = asReviewData(junk);
    assert.deepEqual(data.annotations, [], String(junk));
    assert.equal(data.review.url, '', String(junk));
    assert.deepEqual(data.review.authors, [], String(junk));
  }
});

test('read: non-object annotation entries and non-string authors are dropped', () => {
  const data = asReviewData({
    review: { id: 1, url: null, authors: ['Kevin', 7, null] },
    annotations: [{ id: 'a1' }, null, 'junk', 42, { id: 'a2' }],
  });
  assert.deepEqual(data.annotations.map(a => a.id), ['a1', 'a2']);
  assert.deepEqual(data.review.authors, ['Kevin'], 'a non-string author is not an author');
  assert.equal(data.review.id, '', 'a non-string id reads as absent, not as "1"');
  assert.equal(data.review.url, '');
});

test('read: an unreadable or corrupt file reads as an empty review', () => {
  assert.deepEqual(readAnnotations(path.join(tmpDir('nit-read-'), 'gone.json')), []);
  assert.deepEqual(readAnnotations(reviewFile('{ not json')), []);
  const data = readReviewData(reviewFile('{ not json'));
  assert.deepEqual(data.annotations, []);
  assert.equal(data.review.url, '');
});

test('read: readAnnotations and readReviewData agree on the same file', () => {
  const file = reviewFile({
    review: { id: 'r1', url: 'https://example.com', createdAt: '2026-07-20T10:00:00Z', authors: ['Kevin'] },
    annotations: [{ id: 'a1' }, null, { id: 'a2' }],
  });
  assert.deepEqual(readAnnotations(file).map(a => a.id), ['a1', 'a2']);
  assert.deepEqual(readReviewData(file).annotations.map(a => a.id), ['a1', 'a2']);
});
