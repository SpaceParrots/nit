// SPDX-License-Identifier: AGPL-3.0-or-later
// The other interactive fallbacks: the scope `nit clear` refuses to guess, the
// url `nit review` needs, and the zip (and free target) `nit import` wants.
// Each one must be a no-op without a terminal — the command then fails exactly
// as it did before, naming the flag to pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pickClearScope, pickReviewUrl, pickImportZip, pickImportTarget } from '../dist/cli/pick.js';
import { ensureBase, writeIndex, openWorkspace } from '../dist/store/workspace.js';
import { createStore } from '../dist/store/store.js';
import { tmpDir } from './helpers/tmp.js';
import { scripted, silent } from './helpers/prompts.js';

const CR = (id, status) => ({ id, type: 'change-request', comment: `${id} text`, status, route: '/' });

/** A project root whose ./nit-review holds one base per `[url, alias, annotations]`. */
function makeProject(bases) {
  const cwd = tmpDir('nit-fallback-');
  for (const [url, alias, annotations] of bases) {
    const base = ensureBase(path.join(cwd, 'nit-review'), url, alias);
    const store = createStore(base.dir, { url: base.url });
    for (const a of annotations) store.upsert(a);
    store.flush();
  }
  return cwd;
}

const MIXED = [
  ['http://localhost:5273', undefined, [CR('a1', 'verified'), CR('a2', 'open')]],
  ['https://staging.example.com', 'staging', [CR('b1', 'verified'), CR('b2', 'verified'), CR('b3', 'open')]],
];

// --- nit clear -------------------------------------------------------------

test('clear scope: no scope asks which base, then what should go', async () => {
  const cwd = makeProject(MIXED);
  const prompts = scripted('staging', 'verified');
  const scope = await pickClearScope('nit-review', { cwd, interactive: true, prompts });
  assert.deepEqual({ ...scope }, { base: 'staging', status: 'verified' });
  assert.match(prompts.asked[0].question, /Clear which base of .*nit-review\?/);
  assert.equal(prompts.asked[1].question, 'What should go?');
});

test('clear scope: the rows count what each choice would remove', async () => {
  const cwd = makeProject(MIXED);
  const prompts = scripted('staging', 'verified');
  await pickClearScope('nit-review', { cwd, interactive: true, prompts });
  assert.deepEqual(prompts.asked[0].choices.map(c => c.label), [
    'localhost-5273  http://localhost:5273        1 verified · 2 total',
    'staging         https://staging.example.com  2 verified · 3 total',
    'every base  (5 annotations)',
  ]);
  assert.deepEqual(prompts.asked[1].choices.map(c => c.label), [
    'only what is already ruled  (2 verified annotations)',
    'everything  (3 annotations)',
  ]);
});

test('clear scope: every base is offered last and never preselected', async () => {
  const cwd = makeProject(MIXED);
  const prompts = scripted('*', '');
  const scope = await pickClearScope('nit-review', { cwd, interactive: true, prompts });
  assert.deepEqual({ ...scope }, { all: true, status: undefined });
  assert.equal(prompts.asked[0].initial, 'localhost-5273', 'the cursor starts on a single base, not on all of them');
  assert.equal(prompts.asked[1].choices.length, 2);
  assert.match(prompts.asked[1].choices[0].label, /3 verified annotations/, 'the counts cover every base');
});

test('clear scope: a single-base review still asks, without an every-base row', async () => {
  const cwd = makeProject([MIXED[0]]);
  const prompts = scripted('localhost-5273', 'verified');
  await pickClearScope('nit-review', { cwd, interactive: true, prompts });
  assert.deepEqual(prompts.asked[0].choices.map(c => c.value), ['localhost-5273']);
});

test('clear scope: --status already answers the second question', async () => {
  const cwd = makeProject(MIXED);
  const prompts = scripted('staging');
  const scope = await pickClearScope('nit-review', { cwd, interactive: true, prompts, status: 'open' });
  assert.deepEqual({ ...scope }, { base: 'staging', status: 'open' });
  assert.equal(prompts.asked.length, 1, 'what goes was already decided');
});

test('clear scope: a scope on the command line is never second-guessed', async () => {
  const cwd = makeProject(MIXED);
  const scope = await pickClearScope('nit-review', { cwd, interactive: true, prompts: silent(), all: true });
  assert.deepEqual(scope, { base: undefined, all: true, status: undefined });
});

test('clear scope: --base is resolved like anywhere else', async () => {
  const cwd = makeProject(MIXED);
  const prompts = scripted('staging');
  const scope = await pickClearScope('nit-review', { cwd, interactive: true, prompts, base: 'prod' });
  assert.equal(scope.base, 'staging');
  assert.match(prompts.asked[0].question, /no base "prod"/);
});

test('clear scope: --yes means no questions, so a missing scope stays an error', async () => {
  const cwd = makeProject(MIXED);
  const scope = await pickClearScope('nit-review', { cwd, interactive: true, prompts: silent(), yes: true });
  assert.deepEqual(scope, { base: undefined, all: undefined, status: undefined });
});

test('clear scope: without a terminal the scope is left for runClear to refuse', async () => {
  const cwd = makeProject(MIXED);
  const scope = await pickClearScope('nit-review', { cwd, prompts: silent() });
  assert.deepEqual(scope, { base: undefined, all: undefined, status: undefined });
});

test('clear scope: escaping clears nothing', async () => {
  const cwd = makeProject(MIXED);
  const prompts = scripted(null);
  assert.equal(await pickClearScope('nit-review', { cwd, interactive: true, prompts }), null);
  assert.equal(prompts.cancels.length, 1);
});

test('clear scope: escaping what-should-go stops, it does not fall through to everything', async () => {
  const cwd = makeProject(MIXED);
  const prompts = scripted('staging', null);
  assert.equal(await pickClearScope('nit-review', { cwd, interactive: true, prompts }), null);
  assert.equal(prompts.cancels.length, 1);
});

// --- nit review ------------------------------------------------------------

/** Stamp explicit lastSeenAt values on a workspace's index. */
function stampSeen(wsDir, seen) {
  const ws = openWorkspace(wsDir);
  writeIndex(wsDir, ws.bases.map(b => ({ ...b, lastSeenAt: seen[b.slug] ?? b.lastSeenAt })));
}

test('review url: the urls already reviewed are offered, most recent first', async () => {
  const cwd = makeProject(MIXED);
  const wsDir = path.join(cwd, 'nit-review');
  stampSeen(wsDir, { 'localhost-5273': '2026-07-01T00:00:00.000Z', staging: '2026-08-01T00:00:00.000Z' });
  const prompts = scripted('https://staging.example.com');
  const url = await pickReviewUrl('nit-review', { cwd, interactive: true, prompts });
  assert.equal(url, 'https://staging.example.com');
  assert.deepEqual(prompts.asked[0].choices.map(c => c.value), [
    'https://staging.example.com', 'http://localhost:5273', '+another',
  ]);
  assert.equal(prompts.asked[0].initial, 'https://staging.example.com');
  assert.match(prompts.asked[0].choices[0].label, /3 annotations · 1 actionable$/);
});

test('review url: the last row types a new url', async () => {
  const cwd = makeProject(MIXED);
  const prompts = scripted('+another', 'localhost:4200');
  const url = await pickReviewUrl('nit-review', { cwd, interactive: true, prompts });
  assert.equal(url, 'localhost:4200', 'normalizing the scheme is the caller\'s job');
  assert.equal(prompts.asked[1].kind, 'text');
});

test('review url: an empty workspace goes straight to typing one', async () => {
  const cwd = tmpDir('nit-fallback-fresh-');
  const prompts = scripted('http://localhost:3000');
  assert.equal(await pickReviewUrl('nit-review', { cwd, interactive: true, prompts }), 'http://localhost:3000');
  assert.equal(prompts.asked.length, 1);
  assert.equal(prompts.asked[0].kind, 'text');
});

test('review url: what cannot be a url is rejected before the browser opens', async () => {
  const cwd = tmpDir('nit-fallback-fresh-');
  const prompts = scripted('http://localhost:3000');
  await pickReviewUrl('nit-review', { cwd, interactive: true, prompts });
  const { validate } = prompts.asked[0].opts;
  assert.equal(validate('http://localhost:3000'), undefined);
  assert.equal(validate('example.com'), undefined, 'a bare host is a url once the scheme is filled in');
  assert.match(validate('not a url'), /not a url/);
  assert.match(validate(''), /not a url/);
});

test('review url: without a terminal there is no url to offer', async () => {
  const cwd = makeProject(MIXED);
  assert.equal(await pickReviewUrl('nit-review', { cwd, prompts: silent() }), undefined);
});

test('review url: escaping opens no browser', async () => {
  const cwd = makeProject(MIXED);
  const prompts = scripted(null);
  assert.equal(await pickReviewUrl('nit-review', { cwd, interactive: true, prompts }), null);
  assert.equal(prompts.cancels.length, 1);
});

// --- nit import ------------------------------------------------------------

/** A directory holding the named files, newest last. */
function withFiles(names) {
  const cwd = tmpDir('nit-fallback-zip-');
  let when = Date.now() - names.length * 60_000;
  for (const name of names) {
    fs.writeFileSync(path.join(cwd, name), 'x');
    when += 60_000;
    fs.utimesSync(path.join(cwd, name), new Date(when), new Date(when));
  }
  return cwd;
}

test('import zip: nit exports come first, newest first, and other zips after', async () => {
  const cwd = withFiles(['old.nit.zip', 'other.zip', 'new.nit.zip', 'notes.txt']);
  const prompts = scripted(path.join(cwd, 'new.nit.zip'));
  const zip = await pickImportZip({ cwd, interactive: true, prompts });
  assert.equal(zip, path.join(cwd, 'new.nit.zip'));
  assert.deepEqual(prompts.asked[0].choices.map(c => c.label), ['new.nit.zip', 'old.nit.zip', 'other.zip']);
});

test('import zip: nothing to offer is the command\'s error, not a question', async () => {
  const cwd = withFiles(['notes.txt']);
  assert.equal(await pickImportZip({ cwd, interactive: true, prompts: silent() }), undefined);
});

test('import zip: without a terminal nothing is offered', async () => {
  const cwd = withFiles(['a.nit.zip']);
  assert.equal(await pickImportZip({ cwd, prompts: silent() }), undefined);
});

test('import zip: escaping imports nothing', async () => {
  const cwd = withFiles(['a.nit.zip']);
  const prompts = scripted(null);
  assert.equal(await pickImportZip({ cwd, interactive: true, prompts }), null);
  assert.equal(prompts.cancels.length, 1);
});

test('import target: a free target is used without a word', async () => {
  const cwd = withFiles(['review.nit.zip']);
  assert.equal(await pickImportTarget('review.nit.zip', undefined, {
    cwd, interactive: true, prompts: silent(),
  }), undefined);
});

test('import target: an occupied target offers a free name next to it', async () => {
  const cwd = withFiles(['review.nit.zip']);
  fs.mkdirSync(path.join(cwd, 'review'));
  fs.writeFileSync(path.join(cwd, 'review', 'annotations.json'), '{}');
  const prompts = scripted('yes');
  const out = await pickImportTarget('review.nit.zip', undefined, { cwd, interactive: true, prompts });
  assert.equal(out, path.join(cwd, 'review-2'));
  assert.match(prompts.asked[0].question, /is not empty — unpack into .*review-2 instead\?/);
});

test('import target: the free name skips every folder already in use', async () => {
  const cwd = withFiles(['review.nit.zip']);
  for (const name of ['review', 'review-2', 'review-3']) {
    fs.mkdirSync(path.join(cwd, name));
    fs.writeFileSync(path.join(cwd, name, 'annotations.json'), '{}');
  }
  const out = await pickImportTarget('review.nit.zip', undefined, {
    cwd, interactive: true, prompts: scripted('yes'),
  });
  assert.equal(out, path.join(cwd, 'review-4'));
});

test('import target: declining imports nothing and never overwrites', async () => {
  const cwd = withFiles(['review.nit.zip']);
  fs.mkdirSync(path.join(cwd, 'review'));
  fs.writeFileSync(path.join(cwd, 'review', 'annotations.json'), '{}');
  const prompts = scripted('no');
  assert.equal(await pickImportTarget('review.nit.zip', undefined, { cwd, interactive: true, prompts }), null);
  assert.match(prompts.cancels[0], /nit import <zip> --out <dir>/);
  assert.equal(fs.readdirSync(path.join(cwd, 'review')).length, 1, 'the folder that was there is untouched');
});

test('import target: without a terminal runImport keeps the refusal', async () => {
  const cwd = withFiles(['review.nit.zip']);
  fs.mkdirSync(path.join(cwd, 'review'));
  fs.writeFileSync(path.join(cwd, 'review', 'annotations.json'), '{}');
  assert.equal(await pickImportTarget('review.nit.zip', undefined, { cwd, prompts: silent() }), undefined);
});
