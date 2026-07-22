// SPDX-License-Identifier: AGPL-3.0-or-later
// nit status: the read-only report over a review folder — counts, last change,
// routes, next steps, --json, and the failure modes (missing / corrupt file).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runStatus, ago } from '../dist/cli/status.js';
import { tmpDir } from './helpers/tmp.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli', 'index.js');

/** A review with one annotation per status plus a comment, on two routes. */
function makeReview(dir, annotations = defaultAnnotations()) {
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'shots', 'a1.png'), Buffer.alloc(2048, 7));
  fs.writeFileSync(path.join(dir, 'annotations.json'), JSON.stringify({
    review: {
      id: '2026-07-21-example.com', url: 'https://example.com',
      createdAt: '2026-07-21T08:00:00.000Z', authors: ['Kevin', 'Ann'],
    },
    annotations,
  }, null, 2));
  return dir;
}

function defaultAnnotations() {
  const base = { type: 'change-request', author: 'Kevin', route: '/products', createdAt: '2026-07-21T08:10:00.000Z' };
  return [
    { ...base, id: 'a1', comment: 'open one', status: 'open', screenshot: 'shots/a1.png' },
    { ...base, id: 'a2', comment: 'reopened one', status: 'reopened' },
    { ...base, id: 'a3', comment: 'fixed one', status: 'fixed', updatedAt: '2026-07-22T09:00:00.000Z', updatedBy: 'agent' },
    { ...base, id: 'a4', comment: 'verified one', status: 'verified', route: '/products?tab=2' },
    { ...base, id: 'a5', type: 'comment', comment: 'just context', status: 'open', route: '/' },
  ];
}

/** Run the report and hand back both the lines and the stats. */
function report(dir, opts = {}) {
  const lines = [];
  const stats = runStatus(dir, { log: l => lines.push(l), now: new Date('2026-07-22T11:00:00.000Z'), ...opts });
  return { lines, text: lines.join('\n'), stats };
}

test('status: counts annotations by status, type and route', () => {
  const dir = makeReview(tmpDir('nit-status-'));
  const { stats, text } = report(dir);

  assert.equal(stats.total, 5);
  assert.equal(stats.actionable, 2, 'open + reopened change-requests; the comment does not count');
  assert.deepEqual(stats.byStatus, { open: 2, reopened: 1, fixed: 1, verified: 1 });
  assert.deepEqual(stats.byType, { 'change-request': 4, comment: 1 });
  // routes group by pathname, so ?tab=2 lands on /products with the rest
  assert.deepEqual(stats.routes, [{ route: '/products', count: 4 }, { route: '/', count: 1 }]);

  assert.match(text, /5 total · 2 actionable/);
  assert.match(text, /open 2 · reopened 1 · fixed 1 · verified 1/);
  assert.match(text, /\/products 4 · \/ 1/);
});

test('status: reports the file, the review meta and the newest change', () => {
  const dir = makeReview(tmpDir('nit-status-'));
  const { stats, text } = report(dir);

  assert.equal(stats.file, path.join(dir, 'annotations.json'));
  assert.deepEqual(stats.lastChange, { at: '2026-07-22T09:00:00.000Z', by: 'agent' });
  assert.match(text, /nit status — .*annotations\.json/);
  assert.match(text, /2026-07-21-example\.com/);
  assert.match(text, /authors: Kevin, Ann/);
  assert.match(text, /last change\s+2026-07-22 \(2 hours ago\) · by agent/);
  assert.match(text, /screenshots\s+1 file · 2\.0 KB/);
});

test('status: points at the next step for each state a review can be in', () => {
  const withWork = makeReview(tmpDir('nit-status-'));
  assert.match(report(withWork).text, /2 actionable change-requests — hand them to an agent: {2}nit mcp /);
  assert.match(report(withWork).text, /1 fixed, waiting on you to rule: {2}nit verify /);

  const allDone = makeReview(tmpDir('nit-status-'), [
    { id: 'a1', type: 'change-request', comment: 'done', status: 'verified', author: 'Kevin', route: '/', createdAt: '2026-07-21T08:10:00.000Z' },
  ]);
  assert.match(report(allDone).text, /Nothing actionable/);

  const empty = makeReview(tmpDir('nit-status-'), []);
  const emptyReport = report(empty);
  assert.equal(emptyReport.stats.total, 0);
  assert.match(emptyReport.text, /No annotations yet — capture some: {2}nit review https:\/\/example\.com/);
});

test('status: a fresh review dates itself by its annotations, not by a change', () => {
  const dir = makeReview(tmpDir('nit-status-'), [
    { id: 'a1', type: 'change-request', comment: 'new', status: 'open', author: 'Ann', route: '/', createdAt: '2026-07-22T10:30:00.000Z' },
  ]);
  const { stats, text } = report(dir);
  assert.deepEqual(stats.lastChange, { at: '2026-07-22T10:30:00.000Z', by: 'Ann' });
  assert.match(text, /30 minutes ago/);
});

test('status: --json prints the stats verbatim', () => {
  const dir = makeReview(tmpDir('nit-status-'));
  const { lines, stats } = report(dir, { json: true });
  assert.equal(lines.length, 1, 'one JSON document, nothing else');
  assert.deepEqual(JSON.parse(lines[0]), JSON.parse(JSON.stringify(stats)));
});

test('status: reads a feedback file by name, and never writes anything', () => {
  const dir = makeReview(tmpDir('nit-status-'));
  const feedback = path.join(dir, 'feedback-ann.json');
  fs.renameSync(path.join(dir, 'annotations.json'), feedback);
  const before = fs.readdirSync(dir).sort();

  const { stats } = report(feedback);
  assert.equal(stats.file, feedback);
  assert.equal(stats.total, 5);
  assert.deepEqual(fs.readdirSync(dir).sort(), before, 'no files created, nothing normalized');
});

test('status: fails clearly on a missing or corrupt review', () => {
  const base = tmpDir('nit-status-');
  assert.throws(() => runStatus(path.join(base, 'missing'), { log: () => {} }), /no annotations\.json/);

  const broken = path.join(base, 'broken');
  fs.mkdirSync(broken);
  fs.writeFileSync(path.join(broken, 'annotations.json'), '{ not json');
  assert.throws(() => runStatus(broken, { log: () => {} }), /not readable as JSON/);
});

test('status: a hand-edited file with odd entries still reports', () => {
  const dir = makeReview(tmpDir('nit-status-'), [
    { id: 'a1', type: 'change-request', comment: 'fine', status: 'open', route: '/' },
    null,
    'nonsense',
    { id: 'a2' },
  ]);
  const { stats } = report(dir);
  assert.equal(stats.total, 2, 'non-object entries are skipped');
  assert.equal(stats.actionable, 1);
  assert.deepEqual(stats.routes, [{ route: '/', count: 2 }], 'a missing route counts as /');
});

test('status: CLI prints the report and defaults to nit-review', () => {
  const base = tmpDir('nit-status-');
  makeReview(path.join(base, 'nit-review'));

  const res = spawnSync(process.execPath, [CLI, 'status'], { cwd: base, encoding: 'utf8', timeout: 30000 });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /nit status — nit-review/);
  assert.match(res.stdout, /5 total · 2 actionable/);

  const json = spawnSync(process.execPath, [CLI, 'stats', 'nit-review', '--json'], { cwd: base, encoding: 'utf8', timeout: 30000 });
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).total, 5, 'the alias and --json work together');
});

test('status: relative time reads naturally at every scale', () => {
  const now = new Date('2026-07-22T12:00:00.000Z');
  assert.equal(ago('2026-07-22T11:59:59.000Z', now), 'just now');
  assert.equal(ago('2026-07-22T11:59:00.000Z', now), '1 minute ago');
  assert.equal(ago('2026-07-22T09:00:00.000Z', now), '3 hours ago');
  assert.equal(ago('2026-07-21T12:00:00.000Z', now), '1 day ago');
  assert.equal(ago('2026-05-22T12:00:00.000Z', now), '2 months ago');
  assert.equal(ago('2024-07-22T12:00:00.000Z', now), '2 years ago');
  assert.equal(ago('2026-07-22T12:00:30.000Z', now), 'just now', 'a clock skew into the future is not negative');
  assert.equal(ago('not a date', now), 'unknown');
});
