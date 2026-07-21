// Milestone 8 (integration): nit merge combines files, copies shots, renders review.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runMerge } from '../src/cli/merge.js';
import { tmpDir } from './helpers/tmp.js';

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function writeReviewDir(author, annotations) {
  const dir = tmpDir(`nit-merge-${author.toLowerCase()}-`);
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  for (const a of annotations) {
    if (a.screenshot) fs.writeFileSync(path.join(dir, a.screenshot), PNG_1PX);
  }
  const data = {
    review: { id: `r-${author}`, url: 'https://example.com', createdAt: '2026-07-20T10:00:00Z', authors: [author] },
    annotations,
  };
  const file = path.join(dir, 'annotations.json');
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

function ann(id, author, comment, screenshot = null) {
  return {
    id, type: 'change-request', comment, status: 'open', author,
    viewportScope: 'general', viewport: { mode: 'desktop', w: 1440, h: 900 }, route: '/',
    target: { component: 'app-x', ngComponent: null, selector: '#x', xpath: '/html[1]', tag: 'div', classes: [], text: '', rect: { x: 0, y: 0, w: 10, h: 10 } },
    screenshot, createdAt: '2026-07-20T10:01:00Z',
  };
}

test('nit merge — two feedback files into one consolidated review', () => {
  const fileA = writeReviewDir('Kevin', [
    ann('a1', 'Kevin', 'Kevin issue one', 'shots/a1.png'),
    ann('a2', 'Kevin', 'Kevin issue two'),
  ]);
  const fileB = writeReviewDir('Ann', [
    ann('a1', 'Ann', 'Ann issue one', 'shots/a1.png'),
  ]);
  const out = tmpDir('nit-merged-');

  const { data } = runMerge([fileA, fileB], { out, log: () => {} });

  const ids = data.annotations.map(a => a.id);
  assert.deepEqual(ids, ['kevin:a1', 'kevin:a2', 'ann:a1']);
  assert.equal(new Set(ids).size, 3, 'no id collisions');
  assert.deepEqual(data.review.authors, ['Kevin', 'Ann']);

  const written = JSON.parse(fs.readFileSync(path.join(out, 'annotations.json'), 'utf8'));
  assert.equal(written.annotations.length, 3);
  assert.equal(written.annotations[0].author, 'Kevin');
  assert.equal(written.annotations[2].author, 'Ann');

  // shots copied into the shared shots/ under namespaced names
  assert.ok(fs.existsSync(path.join(out, 'shots', 'kevin_a1.png')));
  assert.ok(fs.existsSync(path.join(out, 'shots', 'ann_a1.png')));
  assert.equal(written.annotations[0].screenshot, 'shots/kevin_a1.png');

  assert.ok(fs.existsSync(path.join(out, 'review.md')));
  assert.ok(fs.existsSync(path.join(out, 'fix-annotations.md')));
  const md = fs.readFileSync(path.join(out, 'review.md'), 'utf8');
  assert.ok(md.includes('kevin:a1'));
  assert.ok(md.includes('ann:a1'));
});

test('nit merge — rejects non-feedback files', () => {
  const dir = tmpDir('nit-bad-');
  const bad = path.join(dir, 'nope.json');
  fs.writeFileSync(bad, '{"foo": 1}');
  assert.throws(() => runMerge([bad], { log: () => {} }), /not a nit feedback file/);
});
