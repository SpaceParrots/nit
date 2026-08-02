// SPDX-License-Identifier: AGPL-3.0-or-later
// resolveFeedbackSource: how `nit view` / `nit verify` find their annotations
// file (directory, file path, or the nit-review default) and the guidance each
// dead end produces — every error must name the next step.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolveFeedbackSource } from '../dist/cli/source.js';
import { ensureBase } from '../dist/store/workspace.js';
import { createStore } from '../dist/store/store.js';
import { tmpDir } from './helpers/tmp.js';

/** Write a review folder with the given annotations and return its dir. */
function makeReview(dir, annotations, url = 'https://example.com') {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'annotations.json'), JSON.stringify({
    review: { id: '2026-07-23-example.com', url, createdAt: '2026-07-23T08:00:00.000Z', authors: ['Kevin'] },
    annotations,
  }));
  return dir;
}

const CR = (id, status) => ({ id, type: 'change-request', comment: `${id} text`, status, author: 'Kevin', route: '/' });

test('source: a directory resolves to its annotations.json', () => {
  const dir = makeReview(tmpDir('nit-source-'), [CR('a1', 'fixed')]);
  const src = resolveFeedbackSource('verify', dir, true);
  assert.equal(src.file, path.join(dir, 'annotations.json'));
  assert.equal(src.dir, dir);
  assert.equal(src.annotations.length, 1);
});

test('source: a feedback file with an arbitrary name resolves as itself', () => {
  const dir = tmpDir('nit-source-');
  const file = path.join(dir, 'feedback-ann.json');
  fs.writeFileSync(file, JSON.stringify({ review: { url: 'https://x.test' }, annotations: [CR('a1', 'open')] }));
  const src = resolveFeedbackSource('view', file, true);
  assert.equal(src.file, file);
  assert.equal(src.dir, dir);
});

test('source: the defaulted lookup phrases not-found as "no review found" with next steps', () => {
  const missing = path.join(tmpDir('nit-source-'), 'nit-review');
  assert.throws(() => resolveFeedbackSource('verify', missing, false), e => {
    assert.match(e.message, /no review found — looked for/);
    assert.match(e.message, /nit review http/);
    assert.match(e.message, /nit verify <dir or annotations\.json>/);
    assert.match(e.message, /nit status/);
    return true;
  });
});

test('source: an explicit path that has no annotations file blames the path', () => {
  const missing = path.join(tmpDir('nit-source-'), 'nope');
  assert.throws(() => resolveFeedbackSource('view', missing, true), e => {
    assert.match(e.message, /no annotations file at/);
    assert.match(e.message, /nit view <dir or annotations\.json>/);
    return true;
  });
});

test('source: corrupt JSON reports the file instead of opening a browser on it', () => {
  const dir = tmpDir('nit-source-');
  fs.writeFileSync(path.join(dir, 'annotations.json'), '{not json');
  assert.throws(() => resolveFeedbackSource('view', dir, true), /is not readable as JSON/);
});

test('source: an empty review points back at nit review, with the stored url', () => {
  const dir = makeReview(tmpDir('nit-source-'), [], 'https://staging.example.com');
  assert.throws(() => resolveFeedbackSource('view', dir, true), e => {
    assert.match(e.message, /nothing to view/);
    assert.match(e.message, /nit review https:\/\/staging\.example\.com/);
    return true;
  });
});

test('source: verify with only open work suggests handing it to the agent first', () => {
  const dir = makeReview(tmpDir('nit-source-'), [CR('a1', 'open'), CR('a2', 'reopened')]);
  assert.throws(() => resolveFeedbackSource('verify', dir, true), e => {
    assert.match(e.message, /nothing to verify/);
    assert.match(e.message, /2 actionable change-requests are waiting/);
    assert.match(e.message, /nit mcp /);
    assert.match(e.message, /nit view /);
    return true;
  });
});

test('source: verify with everything ruled says so instead of opening a dead queue', () => {
  const dir = makeReview(tmpDir('nit-source-'), [CR('a1', 'verified'), CR('a2', 'wontfix')]);
  assert.throws(() => resolveFeedbackSource('verify', dir, true), e => {
    assert.match(e.message, /nothing left to verify/);
    assert.match(e.message, /every change-request is ruled/);
    return true;
  });
});

/** A workspace with `slugs` bases, each holding one open change-request. */
function makeWorkspace(bases) {
  const dir = tmpDir('nit-source-ws-');
  for (const [url, alias] of bases) {
    const base = ensureBase(dir, url, alias);
    const store = createStore(base.dir, { url: base.url });
    store.upsert({ id: 'a1', type: 'change-request', status: 'open', comment: 'c', route: '/' });
    store.flush();
  }
  return dir;
}

test('source: several bases and no --base is an error naming them', () => {
  const dir = makeWorkspace([['https://staging.example.com', 'staging'], ['http://localhost:4200', undefined]]);
  assert.throws(() => resolveFeedbackSource('view', dir, true), /--base/);
  assert.throws(() => resolveFeedbackSource('view', dir, true), /staging/);
});

test('source: one base is used without asking', () => {
  const dir = makeWorkspace([['https://staging.example.com', 'staging']]);
  assert.equal(resolveFeedbackSource('view', dir, true).file, path.join(dir, 'staging', 'annotations.json'));
});

test('source: --base picks one of several', () => {
  const dir = makeWorkspace([['https://staging.example.com', 'staging'], ['http://localhost:4200', undefined]]);
  const src = resolveFeedbackSource('view', dir, true, 'staging');
  assert.equal(src.file, path.join(dir, 'staging', 'annotations.json'));
  assert.equal(src.dir, path.join(dir, 'staging'));
});

test('source: a base with nothing to verify still explains itself', () => {
  const dir = makeWorkspace([['https://staging.example.com', 'staging']]);
  assert.throws(() => resolveFeedbackSource('verify', dir, true), e => {
    assert.match(e.message, /nothing to verify/);
    assert.match(e.message, /1 actionable change-request is waiting/);
    return true;
  });
});

/** A project root whose ./nit-review holds `bases`, each with one open item. */
function makeProject(bases) {
  const cwd = tmpDir('nit-source-proj-');
  for (const [url, alias] of bases) {
    const base = ensureBase(path.join(cwd, 'nit-review'), url, alias);
    const store = createStore(base.dir, { url: base.url });
    store.upsert({ id: 'a1', type: 'change-request', status: 'open', comment: 'c', route: '/' });
    store.flush();
  }
  return cwd;
}

test('source: a bare base name resolves against the default review folder', () => {
  const cwd = makeProject([['https://staging.example.com', 'staging'], ['http://localhost:5273', undefined]]);
  const src = resolveFeedbackSource('view', 'localhost-5273', true, undefined, cwd);
  assert.equal(src.file, path.join(cwd, 'nit-review', 'localhost-5273', 'annotations.json'));
});

test('source: a bare base name takes a url or an unambiguous prefix too', () => {
  const cwd = makeProject([['https://staging.example.com', 'staging'], ['http://localhost:5273', undefined]]);
  const byPrefix = resolveFeedbackSource('view', 'stag', true, undefined, cwd);
  assert.equal(byPrefix.dir, path.join(cwd, 'nit-review', 'staging'));
  const byUrl = resolveFeedbackSource('view', 'http://localhost:5273', true, undefined, cwd);
  assert.equal(byUrl.dir, path.join(cwd, 'nit-review', 'localhost-5273'));
});

test('source: a bare base name works on a flat review folder as well', () => {
  const cwd = tmpDir('nit-source-flat-');
  makeReview(path.join(cwd, 'nit-review'), [CR('a1', 'fixed')], 'http://localhost:5273');
  const src = resolveFeedbackSource('verify', 'localhost-5273', true, undefined, cwd);
  assert.equal(src.file, path.join(cwd, 'nit-review', 'annotations.json'));
});

test('source: a real directory wins over a base of the same name', () => {
  const cwd = makeProject([['http://localhost:5273', undefined]]);
  makeReview(path.join(cwd, 'localhost-5273'), [CR('b1', 'fixed')]);
  const src = resolveFeedbackSource('verify', 'localhost-5273', true, undefined, cwd);
  assert.equal(src.file, path.join(cwd, 'localhost-5273', 'annotations.json'), 'the folder in the cwd, not the base');
});

test('source: a directory that is no review still wins over a base of that name', () => {
  // The app folder you happen to have called `staging`, next to a `staging`
  // base: reading the name as the base would open a review nobody pointed at.
  const cwd = makeProject([['https://staging.example.com', 'staging']]);
  fs.mkdirSync(path.join(cwd, 'staging', 'src'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'staging', 'package.json'), '{}');
  assert.throws(() => resolveFeedbackSource('verify', 'staging', true, undefined, cwd), e => {
    assert.match(e.message, /no annotations file at/, 'the path the user named is what gets reported');
    assert.match(e.message, /staging/);
    return true;
  }, 'the base is never resolved silently — picking it is still offered, but only as a deliberate choice');
});

test('source: a file that is no review is reported, not read as a base', () => {
  const cwd = makeProject([['https://staging.example.com', 'staging']]);
  fs.writeFileSync(path.join(cwd, 'staging'), 'not a review');
  assert.throws(() => resolveFeedbackSource('view', 'staging', true, undefined, cwd), /is not readable as JSON/);
});

test('source: a base name matching several bases says which ones', () => {
  const cwd = makeProject([['http://localhost:5273', undefined], ['http://localhost:4200', undefined]]);
  assert.throws(() => resolveFeedbackSource('view', 'local', true, undefined, cwd), e => {
    assert.match(e.message, /ambiguous/);
    assert.match(e.message, /localhost-4200, localhost-5273/);
    return true;
  });
});

test('source: a name that is neither a path nor a base lists the bases there are', () => {
  const cwd = makeProject([['https://staging.example.com', 'staging'], ['http://localhost:5273', undefined]]);
  assert.throws(() => resolveFeedbackSource('verify', 'localhost-1234', true, undefined, cwd), e => {
    assert.match(e.message, /no annotations file at/);
    assert.match(e.message, /localhost-5273, staging/);
    assert.match(e.message, /nit verify localhost-5273/);
    return true;
  });
});

test('source: a wrong name next to a single-base review points at the bare command', () => {
  const cwd = tmpDir('nit-source-flat-');
  makeReview(path.join(cwd, 'nit-review'), [CR('a1', 'fixed')], 'http://localhost:5273');
  assert.throws(() => resolveFeedbackSource('verify', 'localhost-1234', true, undefined, cwd), e => {
    assert.match(e.message, /localhost-5273/);
    assert.match(e.message, /Open it: +nit verify$/m);
    return true;
  });
});

test('source: several bases and no pick suggests the bare-name form for nit-review', () => {
  const cwd = makeProject([['https://staging.example.com', 'staging'], ['http://localhost:5273', undefined]]);
  assert.throws(() => resolveFeedbackSource('verify', 'nit-review', true, undefined, cwd), e => {
    assert.match(e.message, /pass --base to pick one/);
    assert.match(e.message, /e\.g\. {2}nit verify localhost-5273$/m);
    return true;
  });
});

test('source: hand-edited junk entries are tolerated, not crashed on', () => {
  const dir = makeReview(tmpDir('nit-source-'), [null, 'junk', 42, CR('a1', 'fixed')]);
  const src = resolveFeedbackSource('verify', dir, true);
  assert.equal(src.annotations.length, 1, 'only the object-shaped entry survives');
});
