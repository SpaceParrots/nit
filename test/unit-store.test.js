import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createStore } from '../src/store/store.js';
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
