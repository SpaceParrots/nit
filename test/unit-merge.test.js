// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeReviews } from '../dist/store/merge.js';

function review(author, annotations, url = 'https://example.com') {
  return {
    data: {
      review: { id: 'r', url, createdAt: '2026-07-20T10:00:00Z', authors: [author] },
      annotations,
    },
    dir: `/fake/${author.toLowerCase()}`,
  };
}

test('merge: namespaces ids by author, no collisions, authors preserved', () => {
  const kevin = review('Kevin', [
    { id: 'a1', author: 'Kevin', comment: 'k1', screenshot: 'shots/a1.png' },
    { id: 'a2', author: 'Kevin', comment: 'k2', screenshot: null },
  ]);
  const ann = review('Ann', [
    { id: 'a1', author: 'Ann', comment: 'ann1', screenshot: 'shots/a1.png' },
  ]);

  const { data, copies } = mergeReviews([kevin, ann], { now: new Date('2026-07-21T00:00:00Z') });

  const ids = data.annotations.map(a => a.id);
  assert.deepEqual(ids, ['kevin:a1', 'kevin:a2', 'ann:a1']);
  assert.equal(new Set(ids).size, ids.length, 'ids must be collision-free');
  assert.deepEqual(data.review.authors, ['Kevin', 'Ann']);
  assert.equal(data.review.id, '2026-07-21-merged');
  assert.equal(data.review.url, 'https://example.com');

  assert.deepEqual(copies, [
    { fromDir: '/fake/kevin', from: 'shots/a1.png', to: 'shots/kevin_a1.png' },
    { fromDir: '/fake/ann', from: 'shots/a1.png', to: 'shots/ann_a1.png' },
  ]);
  assert.equal(data.annotations[0].screenshot, 'shots/kevin_a1.png');
  assert.equal(data.annotations[1].screenshot, null);
});

test('merge: after-screenshots are copied and renamed too', () => {
  const kevin = review('Kevin', [
    { id: 'a1', author: 'Kevin', comment: 'k1', screenshot: 'shots/a1.png', screenshotAfter: 'shots/a1-after.png' },
  ]);
  const { data, copies } = mergeReviews([kevin]);
  assert.equal(data.annotations[0].screenshotAfter, 'shots/kevin_a1-after.png');
  assert.deepEqual(copies.map(c => c.to), ['shots/kevin_a1.png', 'shots/kevin_a1-after.png']);
});

test('merge: viewport-keyed after-shots are copied with mode suffixes, mirror stays on the primary copy', () => {
  const kevin = review('Kevin', [
    { id: 'a1', author: 'Kevin', comment: 'k1', screenshot: null,
      // screenshotAfter mirrors the primary (desktop) keyed entry — same source file
      screenshotAfter: 'shots/a1-after.png',
      screenshotsAfter: { desktop: 'shots/a1-after.png', mobile: 'shots/a1-after-mobile.png' } },
  ]);
  const { data, copies } = mergeReviews([kevin]);
  const merged = data.annotations[0];
  assert.deepEqual(merged.screenshotsAfter, {
    desktop: 'shots/kevin_a1-after-desktop.png',
    mobile: 'shots/kevin_a1-after-mobile.png',
  });
  // The mirror invariant survives the merge: screenshotAfter points at the copied
  // primary entry instead of scheduling a duplicate copy of the same source file.
  assert.equal(merged.screenshotAfter, 'shots/kevin_a1-after-desktop.png');
  assert.deepEqual(copies, [
    { fromDir: '/fake/kevin', from: 'shots/a1-after.png', to: 'shots/kevin_a1-after-desktop.png' },
    { fromDir: '/fake/kevin', from: 'shots/a1-after-mobile.png', to: 'shots/kevin_a1-after-mobile.png' },
  ]);
});

test('merge: junk screenshotsAfter entries are dropped, not carried into the merged file', () => {
  const kevin = review('Kevin', [
    { id: 'a1', author: 'Kevin', comment: 'k1', screenshot: null,
      screenshotsAfter: { desktop: 42, mobile: '' } },
  ]);
  const { data, copies } = mergeReviews([kevin]);
  assert.equal(data.annotations[0].screenshotsAfter, undefined, 'no valid entries → field removed');
  assert.deepEqual(copies, []);
});

test('merge: same file twice still yields unique ids', () => {
  const kevin = review('Kevin', [{ id: 'a1', author: 'Kevin', comment: 'k1' }]);
  const { data } = mergeReviews([kevin, kevin]);
  assert.deepEqual(data.annotations.map(a => a.id), ['kevin:a1', 'kevin:a1-2']);
});

test('merge: already-namespaced ids are kept (merging a merged file)', () => {
  const merged = review('Kevin', [{ id: 'kevin:a1', author: 'Kevin', comment: 'k1' }]);
  const ann = review('Ann', [{ id: 'a1', author: 'Ann', comment: 'a1' }]);
  const { data } = mergeReviews([merged, ann]);
  assert.deepEqual(data.annotations.map(a => a.id), ['kevin:a1', 'ann:a1']);
});

test('merge: annotation author wins over file author list', () => {
  const mixed = review('Kevin', [{ id: 'a1', author: 'Guest', comment: 'g1' }]);
  const { data } = mergeReviews([mixed]);
  assert.equal(data.annotations[0].id, 'guest:a1');
  assert.ok(data.review.authors.includes('Guest'));
  assert.ok(data.review.authors.includes('Kevin'));
});
