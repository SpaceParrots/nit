// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createStore } from '../dist/store/store.js';
import { tmpDir } from './helpers/tmp.js';

test('store: fresh dir initializes review meta', () => {
  const dir = tmpDir('nit-store-');
  const store = createStore(dir, { url: 'https://example.com/x', author: 'Kevin' });
  assert.equal(store.data.review.url, 'https://example.com/x');
  assert.deepEqual(store.data.review.authors, ['Kevin']);
  assert.match(store.data.review.id, /^\d{4}-\d{2}-\d{2}-example\.com$/);
  assert.deepEqual(store.annotations, []);
  assert.ok(fs.existsSync(path.join(dir, 'shots')));
});

test('store: nextId counts only plain aN ids', () => {
  const dir = tmpDir('nit-store-');
  const store = createStore(dir, { url: 'https://x.test' });
  assert.equal(store.nextId(), 'a1');
  store.upsert({ id: 'a1' });
  store.upsert({ id: 'a7' });
  store.upsert({ id: 'kevin:a9' }); // namespaced ids don't affect numbering
  assert.equal(store.nextId(), 'a8');
});

test('store: upsert is idempotent (append same id replaces)', () => {
  const dir = tmpDir('nit-store-');
  const store = createStore(dir, { url: 'https://x.test' });
  store.upsert({ id: 'a1', comment: 'first' });
  store.upsert({ id: 'a1', comment: 'updated' });
  assert.equal(store.annotations.length, 1);
  assert.equal(store.annotations[0].comment, 'updated');
});

test('store: flush + reload round-trips and preserves annotations', () => {
  const dir = tmpDir('nit-store-');
  const store = createStore(dir, { url: 'https://x.test', author: 'Kevin' });
  store.upsert({ id: 'a1', comment: 'hello', status: 'open' });
  store.flush();

  const reloaded = createStore(dir, { author: 'Ann' });
  assert.equal(reloaded.annotations.length, 1);
  assert.equal(reloaded.annotations[0].comment, 'hello');
  assert.deepEqual(reloaded.data.review.authors, ['Kevin', 'Ann']);
  assert.equal(reloaded.nextId(), 'a2');
});

test('store: remove deletes the annotation and its screenshot file', () => {
  const dir = tmpDir('nit-store-');
  const store = createStore(dir, { url: 'https://x.test' });
  const shot = store.shotPath('a1');
  fs.writeFileSync(shot, Buffer.from('89504e47', 'hex'));
  store.upsert({ id: 'a1', screenshot: 'shots/a1.png' });
  assert.ok(store.remove('a1'));
  assert.equal(store.annotations.length, 0);
  assert.ok(!fs.existsSync(shot));
  assert.equal(store.remove('a1'), false);
});

test('store: afterShotPath suffixes the mode and sanitizes merged ids', () => {
  const dir = tmpDir('nit-store-');
  const store = createStore(dir, { url: 'https://x.test' });
  assert.ok(store.afterShotPath('a1').endsWith('a1-after.png'), 'no mode → legacy name');
  assert.ok(store.afterShotPath('a1', 'mobile').endsWith('a1-after-mobile.png'));
  assert.ok(store.afterShotPath('kevin:a1', 'mobile').endsWith('kevin_a1-after-mobile.png'),
    'merged ids go through fileSafeId like every other shot path');
});

test('store: remove deletes viewport-keyed after-shot files too', () => {
  const dir = tmpDir('nit-store-');
  const store = createStore(dir, { url: 'https://x.test' });
  const files = [store.shotPath('a1'), store.afterShotPath('a1'), store.afterShotPath('a1', 'mobile')];
  for (const f of files) fs.writeFileSync(f, Buffer.from('89504e47', 'hex'));
  store.upsert({
    id: 'a1', screenshot: 'shots/a1.png', screenshotAfter: 'shots/a1-after.png',
    screenshotsAfter: { desktop: 'shots/a1-after.png', mobile: 'shots/a1-after-mobile.png' },
  });
  assert.ok(store.remove('a1'));
  for (const f of files) assert.ok(!fs.existsSync(f), `${path.basename(f)} unlinked`);
});

test('store: corrupt annotations.json is backed up, store starts fresh', () => {
  const dir = tmpDir('nit-store-');
  fs.writeFileSync(path.join(dir, 'annotations.json'), '{not json');
  const store = createStore(dir, { url: 'https://x.test' });
  assert.deepEqual(store.annotations, []);
  assert.ok(fs.existsSync(path.join(dir, 'annotations.json.bak')));
});

test('store: shotPath sanitizes namespaced ids for the filesystem', () => {
  const dir = tmpDir('nit-store-');
  const store = createStore(dir, { url: 'https://x.test' });
  assert.ok(store.shotPath('kevin:a1').endsWith('kevin_a1.png'));
});

test('store: flush merges a concurrent external status change instead of clobbering it', async () => {
  const dir = tmpDir('nit-store-');
  const store = createStore(dir, { url: 'https://x.test' });
  store.upsert({ id: 'a1', comment: 'one', status: 'open' });
  store.upsert({ id: 'a2', comment: 'two', status: 'open' });
  store.flush();

  // Another process (e.g. an agent via MCP) marks a1 fixed on disk…
  await new Promise(r => setTimeout(r, 10)); // ensure a newer mtime
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'annotations.json'), 'utf8'));
  onDisk.annotations.find(a => a.id === 'a1').status = 'fixed';
  fs.writeFileSync(path.join(dir, 'annotations.json'), JSON.stringify(onDisk));

  // …then our stale in-memory session changes a2 and flushes.
  store.annotations.find(a => a.id === 'a2').status = 'wontfix';
  store.flush();

  const result = JSON.parse(fs.readFileSync(path.join(dir, 'annotations.json'), 'utf8'));
  assert.equal(result.annotations.find(a => a.id === 'a1').status, 'fixed', 'external change preserved');
  assert.equal(result.annotations.find(a => a.id === 'a2').status, 'wontfix', 'local change kept');
});

// Regression coverage: the merge used to run only when `status` diverged, so the
// MCP tool `nit_set_issue_ref` — which touches issueRef and nothing else — was
// silently overwritten by the next local flush.
test('store: flush merges a concurrent external issueRef-only change', async () => {
  const dir = tmpDir('nit-store-');
  const store = createStore(dir, { url: 'https://x.test' });
  store.upsert({ id: 'a1', comment: 'one', status: 'open' });
  store.upsert({ id: 'a2', comment: 'two', status: 'open' });
  store.flush();

  // An agent attaches a tracker reference to a1 on disk — status untouched.
  await new Promise(r => setTimeout(r, 10)); // ensure a newer mtime
  const file = path.join(dir, 'annotations.json');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  const extA1 = onDisk.annotations.find(a => a.id === 'a1');
  extA1.issueRef = 'FAI-777';
  extA1.updatedAt = '2026-07-22T09:00:00.000Z';
  extA1.updatedBy = 'agent';
  fs.writeFileSync(file, JSON.stringify(onDisk));

  // …then our stale in-memory session changes a2 and flushes.
  store.annotations.find(a => a.id === 'a2').status = 'wontfix';
  store.flush();

  const result = JSON.parse(fs.readFileSync(file, 'utf8'));
  const a1 = result.annotations.find(a => a.id === 'a1');
  assert.equal(a1.issueRef, 'FAI-777', 'external issue ref preserved');
  assert.equal(a1.status, 'open', 'status untouched');
  assert.equal(a1.updatedBy, 'agent', 'the stamp of the adopted change comes with it');
  assert.equal(a1.updatedAt, '2026-07-22T09:00:00.000Z');
  assert.equal(result.annotations.find(a => a.id === 'a2').status, 'wontfix', 'local change kept');
});

test('store: a competing local issueRef edit wins over the external one', async () => {
  const dir = tmpDir('nit-store-');
  const store = createStore(dir, { url: 'https://x.test' });
  store.upsert({ id: 'a1', comment: 'one', status: 'open' });
  store.flush();

  // The agent writes one reference on disk…
  await new Promise(r => setTimeout(r, 10));
  const file = path.join(dir, 'annotations.json');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  onDisk.annotations[0].issueRef = 'AGENT-1';
  fs.writeFileSync(file, JSON.stringify(onDisk));

  // …while the reviewer typed a different one in the panel.
  store.patch('a1', { issueRef: 'HUMAN-2' }, 'Kevin');
  store.flush();

  const result = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(result.annotations[0].issueRef, 'HUMAN-2', 'our own unflushed edit wins');
  assert.equal(result.annotations[0].updatedBy, 'Kevin');
});

test('store: an external clear of issueRef is adopted when we did not touch it', async () => {
  const dir = tmpDir('nit-store-');
  const store = createStore(dir, { url: 'https://x.test' });
  store.upsert({ id: 'a1', comment: 'one', status: 'open', issueRef: 'FAI-1' });
  store.flush();

  await new Promise(r => setTimeout(r, 10));
  const file = path.join(dir, 'annotations.json');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete onDisk.annotations[0].issueRef;
  fs.writeFileSync(file, JSON.stringify(onDisk));

  store.flush();
  const result = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal('issueRef' in result.annotations[0], false, 'the clear survives our flush');
});

test('store: patch stamps updatedAt/updatedBy and returns the new annotation', () => {
  const dir = tmpDir('nit-store-');
  const store = createStore(dir, { url: 'https://x.test' });
  store.upsert({ id: 'a1', comment: 'hello', status: 'open' });
  store.upsert({ id: 'a2', comment: 'other', status: 'open' });

  const before = store.annotations[0];
  const patched = store.patch('a1', { status: 'fixed' }, 'agent');

  assert.equal(patched.status, 'fixed');
  assert.equal(patched.updatedBy, 'agent');
  assert.match(patched.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(patched.comment, 'hello', 'untouched fields survive');
  assert.notEqual(store.annotations[0], before, 'entry is replaced, not mutated in place');
  assert.equal(store.annotations[1].updatedAt, undefined, 'other annotations untouched');
});

test('store: patch returns null for an unknown id', () => {
  const dir = tmpDir('nit-store-');
  const store = createStore(dir, { url: 'https://x.test' });
  assert.equal(store.patch('nope', { status: 'fixed' }, 'Kevin'), null);
});

test('store: patch with an undefined value clears the field on disk', () => {
  const dir = tmpDir('nit-store-');
  const store = createStore(dir, { url: 'https://x.test' });
  store.upsert({ id: 'a1', comment: 'hello', status: 'open', issueRef: 'FAI-1' });
  store.patch('a1', { issueRef: undefined }, 'Kevin');
  store.flush();

  const written = JSON.parse(fs.readFileSync(path.join(dir, 'annotations.json'), 'utf8'));
  assert.equal('issueRef' in written.annotations[0], false);
});

test('store: loading sanitizes an oversized dialog context (selector/label capped)', () => {
  const dir = tmpDir('nit-store-');
  const file = path.join(dir, 'annotations.json');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    review: { id: 'r', url: 'https://x.test', createdAt: new Date().toISOString(), authors: [] },
    annotations: [
      { id: 'a1', comment: 'hi', status: 'open', context: { kind: 'dialog', selector: 'x'.repeat(500), label: 'y'.repeat(100) } },
    ],
  }));
  const store = createStore(dir, { url: 'https://x.test' });
  const ann = store.annotations[0];
  assert.equal(ann.context.kind, 'dialog');
  assert.equal(ann.context.selector.length, 300);
  assert.equal(ann.context.label.length, 60);
});

test('store: loading drops an invalid context entirely (no context key survives)', () => {
  const dir = tmpDir('nit-store-');
  const file = path.join(dir, 'annotations.json');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    review: { id: 'r', url: 'https://x.test', createdAt: new Date().toISOString(), authors: [] },
    annotations: [
      { id: 'a1', comment: 'one', status: 'open', context: { kind: 'page' } },
      { id: 'a2', comment: 'two', status: 'open', context: 'garbage' },
      { id: 'a3', comment: 'three', status: 'open', context: { kind: 'dialog', selector: 42 } },
    ],
  }));
  const store = createStore(dir, { url: 'https://x.test' });
  const [a1, a2, a3] = store.annotations;
  assert.ok(!('context' in a1), 'kind: page is not a valid stored context');
  assert.ok(!('context' in a2), 'non-object context dropped');
  // a non-string selector is dropped, but kind: 'dialog' alone is still valid —
  // it survives as a bare dialog context with no members.
  assert.deepEqual(a3.context, { kind: 'dialog' });
});

test('store: loading leaves a valid dialog context untouched', () => {
  const dir = tmpDir('nit-store-');
  const file = path.join(dir, 'annotations.json');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    review: { id: 'r', url: 'https://x.test', createdAt: new Date().toISOString(), authors: [] },
    annotations: [
      { id: 'a1', comment: 'hi', status: 'open', context: { kind: 'dialog', selector: '#dlg', label: 'Checkout' } },
    ],
  }));
  const store = createStore(dir, { url: 'https://x.test' });
  assert.deepEqual(store.annotations[0].context, { kind: 'dialog', selector: '#dlg', label: 'Checkout' });
});

test('store: flush adopts an external updatedAt/updatedBy with the status it belongs to', () => {
  const dir = tmpDir('nit-store-');
  const store = createStore(dir, { url: 'https://x.test' });
  store.upsert({ id: 'a1', comment: 'hello', status: 'open' });
  store.flush();

  // another writer (an agent via MCP) marks it fixed while we hold the file
  const file = path.join(dir, 'annotations.json');
  const external = JSON.parse(fs.readFileSync(file, 'utf8'));
  external.annotations[0].status = 'fixed';
  external.annotations[0].updatedAt = '2026-07-22T09:00:00.000Z';
  external.annotations[0].updatedBy = 'agent';
  fs.writeFileSync(file, JSON.stringify(external, null, 2));
  fs.utimesSync(file, new Date(Date.now() + 2000), new Date(Date.now() + 2000));

  store.flush();
  assert.equal(store.annotations[0].status, 'fixed');
  assert.equal(store.annotations[0].updatedBy, 'agent');
  assert.equal(store.annotations[0].updatedAt, '2026-07-22T09:00:00.000Z');
});
