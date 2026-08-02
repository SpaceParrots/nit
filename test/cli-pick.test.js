// SPDX-License-Identifier: AGPL-3.0-or-later
// The base pickers: the view/verify source fallback, and the --base fallback
// every other base-aware command uses. The prompts are injected, so these cover
// the whole flow — which dead ends offer a choice, what the rows say, and what
// a pick or an escape does — without a terminal.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolveFeedbackSourceOrPick, resolveBaseArg, baseChoices } from '../dist/cli/pick.js';
import { ensureBase, openWorkspace } from '../dist/store/workspace.js';
import { createStore } from '../dist/store/store.js';
import { tmpDir } from './helpers/tmp.js';
import { scripted, silent } from './helpers/prompts.js';

const CR = (id, status) => ({ id, type: 'change-request', comment: `${id} text`, status, route: '/' });

/**
 * A project root whose ./nit-review holds one base per entry.
 * @param bases [url, alias, annotations][]
 */
function makeProject(bases) {
  const cwd = tmpDir('nit-pick-');
  for (const [url, alias, annotations] of bases) {
    const base = ensureBase(path.join(cwd, 'nit-review'), url, alias);
    const store = createStore(base.dir, { url: base.url });
    for (const a of annotations) store.upsert(a);
    store.flush();
  }
  return cwd;
}

const TWO_BASES = [
  ['http://localhost:5273', undefined, [CR('a1', 'fixed'), CR('a2', 'open')]],
  ['https://staging.example.com', 'staging', [CR('b1', 'open')]],
];

const THREE_BASES = [
  ['http://localhost:5273', undefined, [CR('a1', 'fixed')]],
  ['http://localhost:4200', undefined, [CR('b1', 'fixed')]],
  ['https://staging.example.com', 'staging', [CR('c1', 'fixed')]],
];

// --- nit view / nit verify ------------------------------------------------

test('pick: several bases and no --base asks instead of failing', async () => {
  const cwd = makeProject(TWO_BASES);
  const prompts = scripted('localhost-5273');
  const src = await resolveFeedbackSourceOrPick('verify', 'nit-review', false, { cwd, interactive: true, prompts });
  assert.equal(src.file, path.join(cwd, 'nit-review', 'localhost-5273', 'annotations.json'));
  assert.equal(prompts.asked.length, 1);
  assert.match(prompts.asked[0].question, /holds 2 base URLs — which one\?/);
});

test('pick: every row shows the url and the work waiting in that base', async () => {
  const cwd = makeProject(TWO_BASES);
  const prompts = scripted('localhost-5273');
  await resolveFeedbackSourceOrPick('verify', 'nit-review', false, { cwd, interactive: true, prompts });
  assert.deepEqual(prompts.labels(), [
    'localhost-5273  http://localhost:5273        1 fixed · 1 actionable',
    'staging         https://staging.example.com  0 fixed · 1 actionable',
  ]);
  assert.equal(prompts.asked[0].initial, 'localhost-5273', 'the cursor starts on the base that has fixed items');
});

test('pick: nit view counts annotations, nit verify counts fixed ones', () => {
  const cwd = makeProject(TWO_BASES);
  const bases = openWorkspace(path.join(cwd, 'nit-review')).bases;
  assert.match(baseChoices('annotations', bases).choices[0].label, /2 annotations · 1 actionable$/);
  assert.equal(baseChoices('annotations', bases).initial, 'localhost-5273');
  assert.match(baseChoices('fixed', bases).choices[1].label, /0 fixed · 1 actionable$/);
});

test('pick: an empty base says so rather than showing a count of nothing', () => {
  const cwd = makeProject([['http://localhost:5273', undefined, []]]);
  const bases = openWorkspace(path.join(cwd, 'nit-review')).bases;
  assert.equal(baseChoices('fixed', bases).choices[0].label, 'localhost-5273  http://localhost:5273  empty');
});

test('pick: a url too long for a row is shortened, not wrapped', () => {
  const long = `https://staging.example.com/${'very-long-path/'.repeat(4)}`;
  const cwd = makeProject([[long, 'staging', [CR('a1', 'fixed')]]]);
  const bases = openWorkspace(path.join(cwd, 'nit-review')).bases;
  assert.equal(baseChoices('fixed', bases).choices[0].label,
    'staging  https://staging.example.com/very-long-path/…  1 fixed');
});

test('pick: a --base that matches nothing offers the bases there are', async () => {
  const cwd = makeProject(TWO_BASES);
  const prompts = scripted('localhost-5273');
  const src = await resolveFeedbackSourceOrPick('verify', 'nit-review', false, {
    cwd, interactive: true, prompts, base: 'stagign',
  });
  assert.equal(src.dir, path.join(cwd, 'nit-review', 'localhost-5273'));
  assert.match(prompts.asked[0].question, /"stagign" names no single base/);
  assert.deepEqual(prompts.asked[0].choices.map(c => c.value), ['localhost-5273', 'staging']);
});

test('pick: an ambiguous name offers only the bases it matched', async () => {
  const cwd = makeProject(THREE_BASES);
  const prompts = scripted('localhost-4200');
  const src = await resolveFeedbackSourceOrPick('verify', 'local', true, { cwd, interactive: true, prompts });
  assert.equal(src.dir, path.join(cwd, 'nit-review', 'localhost-4200'));
  assert.deepEqual(prompts.asked[0].choices.map(c => c.value), ['localhost-4200', 'localhost-5273']);
});

test('pick: a name that is neither a path nor a base still offers the review', async () => {
  const cwd = makeProject(TWO_BASES);
  const prompts = scripted('staging');
  const src = await resolveFeedbackSourceOrPick('view', 'nope', true, { cwd, interactive: true, prompts });
  assert.equal(src.dir, path.join(cwd, 'nit-review', 'staging'));
  assert.match(prompts.asked[0].question, /no review at "nope" — which base of/);
});

test('pick: escaping the source picker opens nothing and names the flag instead', async () => {
  const cwd = makeProject(TWO_BASES);
  const prompts = scripted(null);
  const src = await resolveFeedbackSourceOrPick('verify', 'nit-review', false, { cwd, interactive: true, prompts });
  assert.equal(src, null);
  assert.match(prompts.cancels[0], /nit verify --base <name>/);
});

test('pick: a picked base with nothing to rule still explains itself', async () => {
  const cwd = makeProject(TWO_BASES);
  await assert.rejects(
    () => resolveFeedbackSourceOrPick('verify', 'nit-review', false, {
      cwd, interactive: true, prompts: scripted('staging'),
    }),
    /nothing to verify/,
  );
});

test('pick: without a terminal nothing is asked and the guidance is printed', async () => {
  const cwd = makeProject(TWO_BASES);
  await assert.rejects(
    () => resolveFeedbackSourceOrPick('verify', 'nit-review', false, { cwd, prompts: silent() }),
    e => {
      assert.match(e.message, /pass --base to pick one/);
      assert.match(e.message, /bases: localhost-5273, staging/);
      return true;
    },
  );
});

test('pick: a dead end no base can fix is thrown, not asked about', async () => {
  const cwd = tmpDir('nit-pick-none-');
  fs.mkdirSync(path.join(cwd, 'nit-review'), { recursive: true });
  await assert.rejects(
    () => resolveFeedbackSourceOrPick('verify', 'nit-review', false, {
      cwd, interactive: true, prompts: silent(),
    }),
    /no review found/,
  );
});

test('pick: a source that resolves on its own never prompts', async () => {
  const cwd = makeProject([['http://localhost:5273', undefined, [CR('a1', 'fixed')]]]);
  const src = await resolveFeedbackSourceOrPick('verify', 'nit-review', false, {
    cwd, interactive: true, prompts: silent(),
  });
  assert.equal(src.dir, path.join(cwd, 'nit-review', 'localhost-5273'));
});

// --- --base, for status / list / export / clear ----------------------------

test('base arg: a base that resolves is handed back without a question', async () => {
  const cwd = makeProject(TWO_BASES);
  const base = await resolveBaseArg('nit-review', 'stag', { cwd, interactive: true, prompts: silent() });
  assert.equal(base, 'staging', 'the prefix is resolved to the real slug');
});

test('base arg: no --base at all is nothing to ask about', async () => {
  const cwd = makeProject(TWO_BASES);
  assert.equal(await resolveBaseArg('nit-review', undefined, { cwd, interactive: true, prompts: silent() }), undefined);
});

test('base arg: a base that matches nothing offers the ones that exist', async () => {
  const cwd = makeProject(TWO_BASES);
  const prompts = scripted('staging');
  const base = await resolveBaseArg('nit-review', 'prod', { cwd, interactive: true, prompts });
  assert.equal(base, 'staging');
  assert.match(prompts.asked[0].question, /no base "prod" in .*nit-review — which one\?/);
  assert.deepEqual(prompts.asked[0].choices.map(c => c.value), ['localhost-5273', 'staging']);
});

test('base arg: an ambiguous base narrows the question to the matches', async () => {
  const cwd = makeProject(THREE_BASES);
  const prompts = scripted('localhost-5273');
  const base = await resolveBaseArg('nit-review', 'local', { cwd, interactive: true, prompts });
  assert.equal(base, 'localhost-5273');
  assert.match(prompts.asked[0].question, /"local" matches 2 bases/);
  assert.deepEqual(prompts.asked[0].choices.map(c => c.value), ['localhost-4200', 'localhost-5273']);
});

test('base arg: without a terminal the base is passed through for the command to reject', async () => {
  const cwd = makeProject(TWO_BASES);
  assert.equal(await resolveBaseArg('nit-review', 'prod', { cwd, prompts: silent() }), 'prod');
});

test('base arg: a workspace with no bases is the command\'s error to report, not a question', async () => {
  const cwd = tmpDir('nit-pick-empty-');
  fs.mkdirSync(path.join(cwd, 'nit-review'), { recursive: true });
  assert.equal(await resolveBaseArg('nit-review', 'prod', { cwd, interactive: true, prompts: silent() }), 'prod');
});

test('base arg: escaping stops the command instead of running it on a guess', async () => {
  const cwd = makeProject(TWO_BASES);
  const prompts = scripted(null);
  assert.equal(await resolveBaseArg('nit-review', 'prod', { cwd, interactive: true, prompts }), null);
  assert.equal(prompts.cancels.length, 1);
});
