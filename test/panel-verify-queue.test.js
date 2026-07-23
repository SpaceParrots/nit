// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeVerifyQueue } from '../dist/panel/verify-queue.js';

const ann = (id, route, status) => ({ id, route, status, type: 'change-request' });

// Each case is a full input/output pair; the loop below asserts the whole
// result object so every field (queue, currentId, ruled, total, done) is
// pinned down by every case.
const CASES = [
  {
    name: 'current route first, then remaining routes in first-appearance order',
    annotations: [
      ann('a1', '/a', 'fixed'),
      ann('a2', '/b', 'fixed'),
      ann('a3', '/a', 'fixed'),
      ann('a4', '/c', 'fixed'),
    ],
    seenFixed: [],
    skipped: [],
    route: '/b',
    expect: {
      currentId: 'a2',
      queue: ['a2', 'a1', 'a3', 'a4'],
      ruled: { verified: 0, reopened: 0 },
      total: 4,
      done: false,
    },
  },
  {
    name: 'no group matches the current route: file first-appearance order, grouped',
    annotations: [
      ann('a1', '/a', 'fixed'),
      ann('a2', '/b', 'fixed'),
      ann('a3', '/a', 'fixed'),
    ],
    seenFixed: [],
    skipped: [],
    route: '/elsewhere',
    expect: {
      currentId: 'a1',
      queue: ['a1', 'a3', 'a2'],
      ruled: { verified: 0, reopened: 0 },
      total: 3,
      done: false,
    },
  },
  {
    name: 'routes group by routeKey: hash ignored, query respected',
    annotations: [
      ann('a1', '/p?id=1', 'fixed'),
      ann('a2', '/p?id=2', 'fixed'),
      ann('a3', '/p?id=1#tab', 'fixed'),
    ],
    seenFixed: [],
    skipped: [],
    route: '/p?id=2',
    expect: {
      currentId: 'a2',
      queue: ['a2', 'a1', 'a3'],
      ruled: { verified: 0, reopened: 0 },
      total: 3,
      done: false,
    },
  },
  {
    name: 'skipped ids sort behind all unskipped ids but stay in the queue',
    annotations: [
      ann('a1', '/a', 'fixed'),
      ann('a2', '/b', 'fixed'),
      ann('a3', '/a', 'fixed'),
    ],
    seenFixed: [],
    skipped: ['a1'],
    route: '/a',
    expect: {
      currentId: 'a3',
      queue: ['a3', 'a2', 'a1'],
      ruled: { verified: 0, reopened: 0 },
      total: 3,
      done: false,
    },
  },
  {
    name: 'progress counts ruled seenFixed ids without shrinking the total',
    annotations: [
      ann('a1', '/a', 'verified'),
      ann('a2', '/a', 'reopened'),
      ann('a3', '/a', 'fixed'),
    ],
    seenFixed: ['a1', 'a2', 'a3'],
    skipped: [],
    route: '/a',
    expect: {
      currentId: 'a3',
      queue: ['a3'],
      ruled: { verified: 1, reopened: 1 },
      total: 3,
      done: false,
    },
  },
  {
    name: 'done without skips: everything ruled, queue empty',
    annotations: [
      ann('a1', '/a', 'verified'),
      ann('a2', '/b', 'reopened'),
    ],
    seenFixed: ['a1', 'a2'],
    skipped: [],
    route: '/a',
    expect: {
      currentId: null,
      queue: [],
      ruled: { verified: 1, reopened: 1 },
      total: 2,
      done: true,
    },
  },
  {
    name: 'done with skips: only skipped fixed items remain',
    annotations: [
      ann('a1', '/a', 'verified'),
      ann('a2', '/a', 'fixed'),
    ],
    seenFixed: ['a1', 'a2'],
    skipped: ['a2'],
    route: '/a',
    expect: {
      currentId: null,
      queue: ['a2'],
      ruled: { verified: 1, reopened: 0 },
      total: 2,
      done: true,
    },
  },
  {
    name: 'empty review: nothing ever fixed is not "done"',
    annotations: [ann('a1', '/a', 'open')],
    seenFixed: [],
    skipped: [],
    route: '/a',
    expect: {
      currentId: null,
      queue: [],
      ruled: { verified: 0, reopened: 0 },
      total: 0,
      done: false,
    },
  },
  {
    name: 'a seenFixed id deleted from the file drops out of the counts',
    annotations: [ann('a1', '/a', 'verified')],
    seenFixed: ['a1', 'gone'],
    skipped: [],
    route: '/a',
    expect: {
      currentId: null,
      queue: [],
      ruled: { verified: 1, reopened: 0 },
      total: 1,
      done: true,
    },
  },
];

for (const c of CASES) {
  test('verify queue: ' + c.name, () => {
    const result = computeVerifyQueue({
      annotations: c.annotations,
      seenFixed: new Set(c.seenFixed),
      skipped: new Set(c.skipped),
      route: c.route,
    });
    assert.deepEqual(result, c.expect);
  });
}

test('verify queue: input annotations array is not mutated', () => {
  const annotations = [ann('a1', '/b', 'fixed'), ann('a2', '/a', 'fixed')];
  const before = annotations.map(a => a.id);
  computeVerifyQueue({ annotations, seenFixed: new Set(), skipped: new Set(), route: '/a' });
  assert.deepEqual(annotations.map(a => a.id), before);
});
