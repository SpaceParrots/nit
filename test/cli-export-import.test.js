// SPDX-License-Identifier: AGPL-3.0-or-later
// nit export / import: pack a review into a zip, unpack it elsewhere — round-trip
// fidelity, derived names, refusal to overwrite, and zip-slip protection.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { runExport } from '../dist/cli/export.js';
import { runImport } from '../dist/cli/import.js';
import { tmpDir } from './helpers/tmp.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli', 'index.js');
const noLog = () => {};

/** A minimal but realistic review folder with one screenshot. */
function makeReview(dir, { author = 'ann' } = {}) {
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  const data = {
    review: { id: '2026-07-21-example.com', url: 'https://example.com', createdAt: '2026-07-21T00:00:00.000Z', authors: [author] },
    annotations: [{ id: 'a1', type: 'change-request', comment: 'fix me', status: 'open', author, screenshot: 'shots/a1.png' }],
  };
  fs.writeFileSync(path.join(dir, 'annotations.json'), JSON.stringify(data, null, 2));
  fs.writeFileSync(path.join(dir, 'review.md'), '# review\n');
  fs.writeFileSync(path.join(dir, 'shots', 'a1.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  return data;
}

test('export/import: round-trips a review folder byte-for-byte', () => {
  const base = tmpDir('nit-exim-');
  const reviewDir = path.join(base, 'nit-review');
  makeReview(reviewDir);

  const zip = path.join(base, 'out.zip');
  const exported = runExport(reviewDir, { out: zip, log: noLog });
  assert.equal(exported.files, 3, 'annotations.json + review.md + 1 shot');
  assert.ok(fs.existsSync(zip));

  const target = path.join(base, 'imported');
  const imported = runImport(zip, { out: target, log: noLog });
  assert.equal(imported.files, 3);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(target, 'annotations.json'), 'utf8')),
    JSON.parse(fs.readFileSync(path.join(reviewDir, 'annotations.json'), 'utf8')),
  );
  assert.deepEqual(
    fs.readFileSync(path.join(target, 'shots', 'a1.png')),
    fs.readFileSync(path.join(reviewDir, 'shots', 'a1.png')),
  );
});

test('export: accepts an annotations.json path and derives the zip name from id + author', () => {
  const base = tmpDir('nit-exim-');
  const reviewDir = path.join(base, 'r');
  makeReview(reviewDir, { author: 'Ann Müller' });

  const res = spawnSync(process.execPath, [CLI, 'export', path.join('r', 'annotations.json')],
    { cwd: base, encoding: 'utf8', timeout: 30000 });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(fs.existsSync(path.join(base, '2026-07-21-example.com-ann-m-ller.nit.zip')), res.stdout);
});

test('export: fails clearly when there is nothing to export', () => {
  const base = tmpDir('nit-exim-');
  assert.throws(() => runExport(path.join(base, 'missing'), { log: noLog }), /no annotations\.json/);
});

test('import: derives the target dir from the zip name (CLI)', () => {
  const base = tmpDir('nit-exim-');
  const reviewDir = path.join(base, 'nit-review');
  makeReview(reviewDir);
  runExport(reviewDir, { out: path.join(base, 'feedback-ann.nit.zip'), log: noLog });

  const res = spawnSync(process.execPath, [CLI, 'import', 'feedback-ann.nit.zip'],
    { cwd: base, encoding: 'utf8', timeout: 30000 });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(fs.existsSync(path.join(base, 'feedback-ann', 'annotations.json')));
  assert.ok(res.stdout.includes('nit view'), 'prints the next step');
});

test('import: refuses a non-empty target and non-nit zips', () => {
  const base = tmpDir('nit-exim-');
  const reviewDir = path.join(base, 'nit-review');
  makeReview(reviewDir);
  const zip = path.join(base, 'out.zip');
  runExport(reviewDir, { out: zip, log: noLog });

  const target = path.join(base, 'taken');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'existing.txt'), 'x');
  assert.throws(() => runImport(zip, { out: target, log: noLog }), /not empty/);

  const notNit = path.join(base, 'other.zip');
  fs.writeFileSync(notNit, Buffer.from(zipSync({ 'readme.txt': new TextEncoder().encode('hi') })));
  assert.throws(() => runImport(notNit, { out: path.join(base, 'x'), log: noLog }), /not a nit export/);
});

test('import: skips zip-slip entries instead of writing outside the target', () => {
  const base = tmpDir('nit-exim-');
  const evil = zipSync({
    'annotations.json': new TextEncoder().encode('{"review":{},"annotations":[]}'),
    '../evil.txt': new TextEncoder().encode('escaped'),
    '/abs.txt': new TextEncoder().encode('absolute'),
    'shots/../../evil2.txt': new TextEncoder().encode('escaped'),
  });
  const zip = path.join(base, 'evil.zip');
  fs.writeFileSync(zip, Buffer.from(evil));

  const logs = [];
  const target = path.join(base, 'safe', 'target');
  const res = runImport(zip, { out: target, log: l => logs.push(l) });

  assert.equal(res.files, 1, 'only annotations.json was written');
  assert.ok(fs.existsSync(path.join(target, 'annotations.json')));
  assert.equal(fs.existsSync(path.join(base, 'safe', 'evil.txt')), false);
  assert.equal(fs.existsSync(path.join(base, 'evil2.txt')), false);
  assert.ok(logs.some(l => l.includes('skipped unsafe zip entry')));
});
