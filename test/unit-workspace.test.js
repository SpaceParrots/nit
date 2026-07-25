// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { baseSlug, qualifyId, parseQualifiedId, isSafeSlug, openWorkspace, readIndex, resolveBase, ensureBase } from '../dist/store/workspace.js';
import { tmpDir } from './helpers/tmp.js';

test('workspace: baseSlug derives host + non-default port', () => {
  const cases = [
    ['http://localhost:4200', 'localhost-4200'],
    ['https://staging.example.com', 'staging-example-com'],
    ['https://fainin.dev/', 'fainin-dev'],
    ['https://example.com/deep/path?q=1', 'example-com'],
    ['http://example.com:80/', 'example-com'],      // URL strips default ports
    ['https://example.com:443/', 'example-com'],
    ['http://127.0.0.1:3000', '127-0-0-1-3000'],
    ['not a url', 'review'],                         // unparseable → same fallback as safeHost
    ['', 'review'],
  ];
  for (const [url, expected] of cases) {
    assert.equal(baseSlug(url), expected, url);
  }
});

test('workspace: qualifyId/parseQualifiedId round-trip, splitting on the first colon', () => {
  assert.equal(qualifyId('staging', 'a1'), 'staging:a1');
  assert.deepEqual(parseQualifiedId('staging:a1'), { slug: 'staging', id: 'a1' });
  // a merged base keeps its author namespace intact in the id half
  assert.equal(qualifyId('staging', 'kevin:a1'), 'staging:kevin:a1');
  assert.deepEqual(parseQualifiedId('staging:kevin:a1'), { slug: 'staging', id: 'kevin:a1' });
  // a bare id has no slug half
  assert.deepEqual(parseQualifiedId('a1'), { slug: null, id: 'a1' });
});

test('workspace: isSafeSlug rejects anything that could escape a path', () => {
  for (const ok of ['staging', 'localhost-4200', 'a', '127-0-0-1-3000']) {
    assert.ok(isSafeSlug(ok), ok);
  }
  for (const bad of ['..', '../etc', 'a/b', 'a\\b', '.hidden', '-lead', 'UPPER', 'a b', '', 'a\0b', 42, null, undefined]) {
    assert.ok(!isSafeSlug(bad), String(bad));
  }
});

/** Write a review folder at `dir` with the given url and annotation ids. */
function writeReview(dir, url, ids = []) {
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'annotations.json'), JSON.stringify({
    review: { id: 'fixture', url, createdAt: '2026-07-20T10:00:00Z', authors: ['Kevin'] },
    annotations: ids.map(id => ({
      id, type: 'change-request', comment: `c ${id}`, status: 'open', author: 'Kevin',
      viewportScope: 'general', viewport: { mode: 'desktop', w: 1440, h: 900 }, route: '/',
      target: { component: 'div', ngComponent: null, selector: '.x', xpath: '/html[1]', tag: 'div', classes: [], text: '', rect: { x: 0, y: 0, w: 1, h: 1 } },
      screenshot: null, createdAt: '2026-07-20T10:01:00Z',
    })),
  }, null, 2));
}

test('workspace: an empty dir has no bases', () => {
  const ws = openWorkspace(tmpDir('nit-ws-'));
  assert.equal(ws.layout, 'empty');
  assert.deepEqual(ws.bases, []);
});

test('workspace: a flat review folder is one base, slug from its own review.url', () => {
  const dir = tmpDir('nit-ws-');
  writeReview(dir, 'https://fainin.dev/', ['a1']);
  const ws = openWorkspace(dir);
  assert.equal(ws.layout, 'flat');
  assert.equal(ws.bases.length, 1);
  assert.equal(ws.bases[0].slug, 'fainin-dev');
  assert.equal(ws.bases[0].url, 'https://fainin.dev/');
  assert.equal(ws.bases[0].dir, dir);
  assert.equal(ws.bases[0].file, path.join(dir, 'annotations.json'));
});

test('workspace: subfolders with annotations.json are bases, listed or not', () => {
  const dir = tmpDir('nit-ws-');
  writeReview(path.join(dir, 'staging'), 'https://staging.example.com', ['a1']);
  writeReview(path.join(dir, 'localhost-4200'), 'http://localhost:4200', ['a1', 'a2']);
  // index mentions only one of them, and one that no longer exists
  fs.writeFileSync(path.join(dir, 'bases.json'), JSON.stringify({
    version: 1,
    bases: [
      { slug: 'staging', url: 'https://staging.example.com', createdAt: '2026-07-25T09:00:00Z' },
      { slug: 'gone', url: 'https://gone.example.com' },
    ],
  }));
  const ws = openWorkspace(dir);
  assert.equal(ws.layout, 'multi');
  assert.deepEqual(ws.bases.map(b => b.slug), ['localhost-4200', 'staging']); // sorted, stale entry dropped
  assert.equal(ws.bases[1].createdAt, '2026-07-25T09:00:00Z');               // index metadata adopted
  assert.equal(ws.bases[0].url, 'http://localhost:4200');                    // unlisted folder adopted
});

test('workspace: a malformed bases.json is ignored, not fatal', () => {
  const dir = tmpDir('nit-ws-');
  writeReview(path.join(dir, 'staging'), 'https://staging.example.com', ['a1']);
  fs.writeFileSync(path.join(dir, 'bases.json'), '{ this is not json');
  const ws = openWorkspace(dir);
  assert.equal(ws.layout, 'multi');
  assert.deepEqual(ws.bases.map(b => b.slug), ['staging']);
});

test('workspace: readIndex drops an unsafe slug and keeps a valid one', () => {
  const dir = tmpDir('nit-ws-');
  fs.writeFileSync(path.join(dir, 'bases.json'), JSON.stringify({
    version: 1,
    bases: [
      { slug: '../../escape', url: 'https://evil.test' },
      { slug: 'staging', url: 'https://staging.example.com' },
    ],
  }));
  const index = readIndex(dir);
  assert.equal(index.has('../../escape'), false, 'the unsafe slug never enters the index');
  assert.equal(index.size, 1);
  assert.equal(index.get('staging')?.url, 'https://staging.example.com');
});

test('workspace: bases.json content never reaches path.join — paths come only from enumerated directory names', () => {
  const dir = tmpDir('nit-ws-');
  writeReview(path.join(dir, 'staging'), 'https://staging.example.com', ['a1']);
  fs.writeFileSync(path.join(dir, 'bases.json'), JSON.stringify({
    version: 1,
    bases: [{ slug: '../../escape', url: 'https://evil.test' }],
  }));
  const ws = openWorkspace(dir);
  // 'staging' is a real subfolder; '../../escape' has no matching directory on
  // disk at all, so it can't appear here regardless of the readIndex guard —
  // see the 'readIndex drops an unsafe slug' test above for that guard itself.
  assert.deepEqual(ws.bases.map(b => b.slug), ['staging']);
  for (const b of ws.bases) assert.ok(b.dir.startsWith(dir), 'every base stays inside the workspace');
});

/** A three-base workspace, for resolution tests. */
function threeBaseWorkspace() {
  const dir = tmpDir('nit-ws-');
  writeReview(path.join(dir, 'staging'), 'https://staging.example.com', ['a1']);
  writeReview(path.join(dir, 'localhost-4200'), 'http://localhost:4200', ['a1']);
  writeReview(path.join(dir, 'stage-two'), 'https://stage-two.example.com', ['a1']);
  return openWorkspace(dir);
}

test('workspace: resolveBase matches slug, url, origin and unique prefix', () => {
  const ws = threeBaseWorkspace();
  assert.equal(resolveBase(ws, 'staging').slug, 'staging');
  assert.equal(resolveBase(ws, 'STAGING').slug, 'staging');                          // case-insensitive
  assert.equal(resolveBase(ws, 'https://staging.example.com').slug, 'staging');      // exact url
  assert.equal(resolveBase(ws, 'https://staging.example.com/checkout').slug, 'staging'); // same origin
  assert.equal(resolveBase(ws, 'localhost').slug, 'localhost-4200');                 // unique prefix
});

test('workspace: resolveBase reports ambiguity and misses with the candidates', () => {
  const ws = threeBaseWorkspace();
  // "stag" prefixes both staging and stage-two
  assert.throws(() => resolveBase(ws, 'stag'), /ambiguous.*stage-two.*staging|ambiguous.*staging.*stage-two/s);
  assert.throws(() => resolveBase(ws, 'prod'), /no base.*prod/s);
  assert.throws(() => resolveBase(ws, 'prod'), /localhost-4200/s); // names what does exist
  assert.throws(() => resolveBase(ws, '   '), /no base/s);
});

test('workspace: an exact slug beats a prefix of another slug', () => {
  const dir = tmpDir('nit-ws-');
  writeReview(path.join(dir, 'stage'), 'https://stage.example.com', ['a1']);
  writeReview(path.join(dir, 'staging'), 'https://staging.example.com', ['a1']);
  const ws = openWorkspace(dir);
  assert.equal(resolveBase(ws, 'stage').slug, 'stage');
});

test('workspace: resolveBase reports ambiguity for two bases sharing an origin, but an exact slug still wins', () => {
  const dir = tmpDir('nit-ws-');
  writeReview(path.join(dir, 'admin-area'), 'https://shared.example.com/admin', ['a1']);
  writeReview(path.join(dir, 'public-area'), 'https://shared.example.com/public', ['a1']);
  const ws = openWorkspace(dir);
  // exact slug still resolves despite the origin collision
  assert.equal(resolveBase(ws, 'admin-area').slug, 'admin-area');
  // a same-origin query that isn't an exact slug/url match is ambiguous, not silently the first one
  assert.throws(
    () => resolveBase(ws, 'https://shared.example.com/somewhere-else'),
    /ambiguous.*admin-area.*public-area|ambiguous.*public-area.*admin-area/s,
  );
});

test('workspace: ensureBase creates and registers a base in an empty folder', () => {
  const dir = tmpDir('nit-ws-');
  const base = ensureBase(dir, 'http://localhost:4200');
  assert.equal(base.slug, 'localhost-4200');
  assert.equal(base.dir, path.join(dir, 'localhost-4200'));
  assert.ok(fs.existsSync(path.join(base.dir, 'shots')));
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'bases.json'), 'utf8'));
  assert.deepEqual(index.bases.map(b => b.slug), ['localhost-4200']);
  assert.equal(index.bases[0].url, 'http://localhost:4200');
});

test('workspace: an alias names the folder', () => {
  const dir = tmpDir('nit-ws-');
  const base = ensureBase(dir, 'https://staging.example.com', 'staging');
  assert.equal(base.slug, 'staging');
  assert.ok(fs.existsSync(path.join(dir, 'staging')));
});

test('workspace: ensureBase is idempotent and matches by origin', () => {
  const dir = tmpDir('nit-ws-');
  const first = ensureBase(dir, 'https://staging.example.com', 'staging');
  const again = ensureBase(dir, 'https://staging.example.com/checkout?x=1');
  assert.equal(again.slug, first.slug);
  assert.deepEqual(fs.readdirSync(dir).filter(n => n !== 'bases.json'), ['staging']);
});

test('workspace: the same url in a flat folder does NOT migrate', () => {
  const dir = tmpDir('nit-ws-');
  writeReview(dir, 'https://fainin.dev/', ['a1']);
  const base = ensureBase(dir, 'https://fainin.dev/');
  assert.equal(base.dir, dir, 'stays flat');
  assert.ok(fs.existsSync(path.join(dir, 'annotations.json')));
  assert.ok(!fs.existsSync(path.join(dir, 'bases.json')));
});

test('workspace: a second url migrates the flat folder, preserving ids and shots', () => {
  const dir = tmpDir('nit-ws-');
  writeReview(dir, 'https://fainin.dev/', ['a1', 'a2']);
  fs.writeFileSync(path.join(dir, 'review.md'), '# old review');
  fs.writeFileSync(path.join(dir, 'shots', 'a1.png'), 'png-bytes');

  const fresh = ensureBase(dir, 'http://localhost:4200');

  assert.equal(fresh.slug, 'localhost-4200');
  assert.ok(!fs.existsSync(path.join(dir, 'annotations.json')), 'flat file moved away');
  const moved = JSON.parse(fs.readFileSync(path.join(dir, 'fainin-dev', 'annotations.json'), 'utf8'));
  assert.deepEqual(moved.annotations.map(a => a.id), ['a1', 'a2']);
  assert.equal(moved.review.url, 'https://fainin.dev/');
  assert.equal(fs.readFileSync(path.join(dir, 'fainin-dev', 'review.md'), 'utf8'), '# old review');
  assert.equal(fs.readFileSync(path.join(dir, 'fainin-dev', 'shots', 'a1.png'), 'utf8'), 'png-bytes');

  const ws = openWorkspace(dir);
  assert.equal(ws.layout, 'multi');
  assert.deepEqual(ws.bases.map(b => b.slug), ['fainin-dev', 'localhost-4200']);
});

test('workspace: a slug collision from a different origin gets a suffix', () => {
  const dir = tmpDir('nit-ws-');
  ensureBase(dir, 'https://staging.example.com', 'staging');
  const second = ensureBase(dir, 'https://staging.other.test', 'staging');
  assert.equal(second.slug, 'staging-2');
});

test('workspace: an alias matching a Windows reserved device name is not used as the folder name', () => {
  const dir = tmpDir('nit-ws-');
  const base = ensureBase(dir, 'https://example.com', 'nul');
  assert.notEqual(base.slug, 'nul');
  assert.ok(fs.existsSync(base.dir));
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'bases.json'), 'utf8'));
  assert.deepEqual(index.bases.map(b => b.slug), [base.slug]);
});

test('workspace: a bare hostname matching a Windows reserved device name is not used as the folder name', () => {
  const dir = tmpDir('nit-ws-');
  // sanity: baseSlug itself is OS-agnostic and would happily return 'con'
  assert.equal(baseSlug('http://con'), 'con');
  const base = ensureBase(dir, 'http://con');
  assert.notEqual(base.slug, 'con');
  assert.ok(fs.existsSync(base.dir));
});

test('workspace: a very long alias is bounded to a safe directory-name length', () => {
  const dir = tmpDir('nit-ws-');
  const longAlias = 'a'.repeat(200);
  const base = ensureBase(dir, 'https://example.com', longAlias);
  assert.ok(base.slug.length <= 60, `slug length ${base.slug.length} should be bounded, got ${base.slug.length}`);
  assert.ok(fs.existsSync(base.dir));
});

test('workspace: a migration that fails partway rolls back completed renames, losing nothing', () => {
  const dir = tmpDir('nit-ws-');
  writeReview(dir, 'https://fainin.dev/', ['a1']);
  fs.writeFileSync(path.join(dir, 'review.md'), '# old review');
  fs.writeFileSync(path.join(dir, 'shots', 'a1.png'), 'png-bytes');

  // Fail the *second* real rename (annotations.json succeeds, review.md
  // doesn't) so migrateFlat has exactly one completed move to undo. Both
  // the test and dist/store/workspace.js resolve 'node:fs' to the same
  // cached module object, so patching the method here reaches the code
  // under test without any mocking library.
  const realRename = fs.renameSync;
  let calls = 0;
  fs.renameSync = (from, to) => {
    calls++;
    if (calls === 2) throw new Error('simulated rename failure');
    return realRename(from, to);
  };
  try {
    assert.throws(
      () => ensureBase(dir, 'http://localhost:4200'),
      /could not turn .* into a multi-base workspace/,
    );
  } finally {
    fs.renameSync = realRename;
  }

  // Fully reverted: the flat folder looks exactly like it did before, and
  // the half-created target directory is gone.
  assert.ok(!fs.existsSync(path.join(dir, 'fainin-dev')), 'target dir cleaned up');
  assert.ok(fs.existsSync(path.join(dir, 'annotations.json')));
  assert.ok(fs.existsSync(path.join(dir, 'review.md')));
  assert.ok(fs.existsSync(path.join(dir, 'shots', 'a1.png')));
  const survived = JSON.parse(fs.readFileSync(path.join(dir, 'annotations.json'), 'utf8'));
  assert.deepEqual(survived.annotations.map(a => a.id), ['a1']);
});

test('workspace: ensureBase rejects a url it cannot classify, creating nothing', () => {
  const dir = tmpDir('nit-ws-');
  for (const bad of ['not a url', 'file:///etc/passwd', '']) {
    assert.throws(() => ensureBase(dir, bad), /http\(s\)/, JSON.stringify(bad));
    assert.deepEqual(fs.readdirSync(dir), [], `nothing created for ${JSON.stringify(bad)}`);
  }
});

test('workspace: ensureBase rejects a url it cannot classify without touching an existing flat review', () => {
  const dir = tmpDir('nit-ws-');
  writeReview(dir, 'https://fainin.dev/', ['a1']);
  for (const bad of ['not a url', 'file:///etc/passwd', '']) {
    assert.throws(() => ensureBase(dir, bad), /http\(s\)/, JSON.stringify(bad));
  }
  assert.ok(fs.existsSync(path.join(dir, 'annotations.json')), 'flat file untouched');
  assert.ok(!fs.existsSync(path.join(dir, 'bases.json')), 'still flat, no index written');
  const survived = JSON.parse(fs.readFileSync(path.join(dir, 'annotations.json'), 'utf8'));
  assert.deepEqual(survived.annotations.map(a => a.id), ['a1']);
});

test('workspace: migrating a flat review whose own url is a reserved device name gets a safe folder name', () => {
  const dir = tmpDir('nit-ws-');
  writeReview(dir, 'http://con', ['a1']);
  // sanity: baseSlug itself is OS-agnostic and would happily return 'con'
  assert.equal(baseSlug('http://con'), 'con');

  const fresh = ensureBase(dir, 'https://fainin.dev/');
  assert.equal(fresh.slug, 'fainin-dev');

  const ws = openWorkspace(dir);
  const migratedSlug = ws.bases.map(b => b.slug).find(s => s !== 'fainin-dev');
  assert.notEqual(migratedSlug, 'con');
  assert.ok(!fs.existsSync(path.join(dir, 'con')), 'no literal "con" folder was created');
});

test('workspace: migrating a flat review with a very long host gets a length-bounded folder name', () => {
  const dir = tmpDir('nit-ws-');
  const longHost = `${'a'.repeat(60)}.${'b'.repeat(60)}.example.com`;
  writeReview(dir, `http://${longHost}`, ['a1']);

  const fresh = ensureBase(dir, 'https://fainin.dev/');
  assert.equal(fresh.slug, 'fainin-dev');

  const ws = openWorkspace(dir);
  const migratedSlug = ws.bases.map(b => b.slug).find(s => s !== 'fainin-dev');
  assert.ok(migratedSlug.length <= 60, `slug length ${migratedSlug.length} should be bounded`);
});

test('workspace: migrateFlat refuses to migrate onto a directory that already exists (TOCTOU-safe even when uniqueSlug just checked it was free)', () => {
  const dir = tmpDir('nit-ws-');
  writeReview(dir, 'https://fainin.dev/', ['a1']);
  const abs = path.resolve(dir);
  const target = path.join(abs, 'fainin-dev');

  // Simulate something else claiming the directory between uniqueSlug's
  // "is it free?" check and migrateFlat's own "does it exist?" guard: the
  // first existsSync(target) call (uniqueSlug's) reports free, every one
  // after (migrateFlat's own guard, and any later check) reports taken.
  const realExistsSync = fs.existsSync;
  let firstCheckDone = false;
  fs.existsSync = p => {
    if (p === target) {
      if (!firstCheckDone) { firstCheckDone = true; return false; }
      return true;
    }
    return realExistsSync(p);
  };
  try {
    assert.throws(() => ensureBase(dir, 'https://staging.example.com'), /already exists/);
  } finally {
    fs.existsSync = realExistsSync;
  }

  // migrateFlat's guard threw before any mkdir/rename — the flat review is untouched.
  assert.ok(fs.existsSync(path.join(dir, 'annotations.json')));
  const survived = JSON.parse(fs.readFileSync(path.join(dir, 'annotations.json'), 'utf8'));
  assert.deepEqual(survived.annotations.map(a => a.id), ['a1']);
});

test('workspace: touchBase advances lastSeenAt on a re-reviewed base while createdAt survives', async () => {
  const dir = tmpDir('nit-ws-');
  ensureBase(dir, 'https://staging.example.com', 'staging');
  const before = JSON.parse(fs.readFileSync(path.join(dir, 'bases.json'), 'utf8')).bases[0];

  await new Promise(r => setTimeout(r, 5)); // ensure a distinguishable timestamp

  const again = ensureBase(dir, 'https://staging.example.com/checkout?x=1');
  assert.equal(again.slug, 'staging');

  const after = JSON.parse(fs.readFileSync(path.join(dir, 'bases.json'), 'utf8')).bases[0];
  assert.equal(after.createdAt, before.createdAt, 'createdAt is untouched');
  assert.notEqual(after.lastSeenAt, before.lastSeenAt, 'lastSeenAt advances on disk');
  assert.equal(again.lastSeenAt, after.lastSeenAt, 'the returned BaseRef matches what was just persisted, not the pre-touch copy');
});

test('workspace: a failed rollback produces a different, more specific error than a clean rollback, naming the stranded folder', () => {
  const realRename = fs.renameSync;

  const dir1 = tmpDir('nit-ws-');
  writeReview(dir1, 'https://fainin.dev/', ['a1']);
  fs.writeFileSync(path.join(dir1, 'review.md'), '# old review');
  let calls = 0;
  fs.renameSync = (from, to) => {
    calls++;
    if (calls === 2) throw new Error('simulated rename failure');
    return realRename(from, to);
  };
  let cleanMessage;
  try {
    ensureBase(dir1, 'http://localhost:4200');
    assert.fail('expected ensureBase to throw');
  } catch (e) {
    cleanMessage = e.message;
  } finally {
    fs.renameSync = realRename;
  }

  const dir2 = tmpDir('nit-ws-');
  writeReview(dir2, 'https://fainin.dev/', ['a1']);
  fs.writeFileSync(path.join(dir2, 'review.md'), '# old review');
  calls = 0;
  fs.renameSync = (from, to) => {
    calls++;
    if (calls === 2 || calls === 3) throw new Error('simulated rename failure');
    return realRename(from, to);
  };
  let strandedMessage;
  try {
    ensureBase(dir2, 'http://localhost:4200');
    assert.fail('expected ensureBase to throw');
  } catch (e) {
    strandedMessage = e.message;
  } finally {
    fs.renameSync = realRename;
  }

  assert.notEqual(cleanMessage, strandedMessage, 'a stranded rollback must not read like a clean one');
  assert.ok(!cleanMessage.includes('could not fully undo'), cleanMessage);
  assert.ok(strandedMessage.includes('could not fully undo'), strandedMessage);
  assert.ok(strandedMessage.includes(path.join(path.resolve(dir2), 'fainin-dev')), strandedMessage);
});

test('workspace: if rolling back itself fails, the half-moved data is kept, not deleted', () => {
  const dir = tmpDir('nit-ws-');
  writeReview(dir, 'https://fainin.dev/', ['a1']);
  fs.writeFileSync(path.join(dir, 'review.md'), '# old review');

  // Fail the second forward rename (as above) AND the reversal that follows
  // it, so migrateFlat can't put annotations.json back where it found it.
  const realRename = fs.renameSync;
  let calls = 0;
  fs.renameSync = (from, to) => {
    calls++;
    if (calls === 2 || calls === 3) throw new Error('simulated rename failure');
    return realRename(from, to);
  };
  try {
    assert.throws(() => ensureBase(dir, 'http://localhost:4200'));
  } finally {
    fs.renameSync = realRename;
  }

  // The failed rollback must NOT have deleted the moved file: it is still
  // sitting in the half-migrated target directory, not lost.
  assert.ok(!fs.existsSync(path.join(dir, 'annotations.json')), 'not reverted (rollback itself failed)');
  const stranded = JSON.parse(fs.readFileSync(path.join(dir, 'fainin-dev', 'annotations.json'), 'utf8'));
  assert.deepEqual(stranded.annotations.map(a => a.id), ['a1'], 'moved data survives intact, not wiped');
  assert.ok(fs.existsSync(path.join(dir, 'review.md')), 'never-moved file untouched');
});
