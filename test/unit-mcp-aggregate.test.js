// SPDX-License-Identifier: AGPL-3.0-or-later
// The MCP layer's view of a workspace: which bases exist, how a qualified id
// resolves back to the base that owns it, and how ids are presented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { basesOf, baseSummaries, isMultiBase, resolveAnnotation, displayId } from '../dist/mcp/aggregate.js';
import { makeWorkspaceDir, makeReviewDir, startMcpClient } from './helpers/mcp.js';

test('aggregate: basesOf lists every base, or the one a filter names', () => {
  const dir = makeWorkspaceDir();
  assert.deepEqual(basesOf(dir).map(b => b.slug), ['localhost-4200', 'staging']);
  assert.deepEqual(basesOf(dir, 'staging').map(b => b.slug), ['staging']);
  assert.deepEqual(basesOf(dir, 'https://staging.example.com').map(b => b.slug), ['staging']);
  assert.deepEqual(basesOf(dir, 'stag').map(b => b.slug), ['staging']);
  assert.throws(() => basesOf(dir, 'nope'), /nope/);
});

test('aggregate: isMultiBase distinguishes a workspace from a single review', () => {
  assert.equal(isMultiBase(makeWorkspaceDir()), true);
  assert.equal(isMultiBase(makeReviewDir()), false);
});

test('aggregate: displayId qualifies only when there is more than one base', () => {
  assert.equal(displayId(true, 'staging', 'a1'), 'staging:a1');
  assert.equal(displayId(false, 'staging', 'a1'), 'a1');
});

test('aggregate: baseSummaries counts each base', () => {
  const summaries = baseSummaries(makeWorkspaceDir());
  const staging = summaries.find(s => s.slug === 'staging');
  assert.equal(staging.total, 2);
  assert.equal(staging.actionable, 1);  // a1 is an open change-request; a2 is a comment
  assert.equal(summaries.find(s => s.slug === 'localhost-4200').actionable, 0); // verified
});

test('aggregate: resolveAnnotation resolves qualified ids to the owning base', () => {
  const dir = makeWorkspaceDir();
  const res = resolveAnnotation(dir, 'staging:a1');
  assert.ok(res.ok);
  assert.equal(res.hit.base.slug, 'staging');
  assert.equal(res.hit.annotation.id, 'a1', 'the id on disk is never rewritten');
  assert.equal(resolveAnnotation(dir, 'localhost-4200:a1').hit.base.slug, 'localhost-4200');
  for (const miss of ['staging:a99', 'nosuchbase:a1']) {
    const r = resolveAnnotation(dir, miss);
    assert.equal(r.ok, false, miss);
    assert.match(r.error, new RegExp(miss.replace(':', ':')), 'the error names the id that missed');
  }
});

test('aggregate: an id that exists in several bases is refused, never guessed', () => {
  const dir = makeWorkspaceDir();   // both bases number their own annotations from a1
  const res = resolveAnnotation(dir, 'a1');
  assert.equal(res.ok, false, 'a bare id must not silently pick one environment');
  assert.match(res.error, /ambiguous/);
  assert.match(res.error, /staging/);
  assert.match(res.error, /localhost-4200/);
  assert.match(res.error, /staging:a1|localhost-4200:a1/, 'and shows the qualified form to use');
});

test('aggregate: a bare id resolves when only one base holds it', () => {
  const dir = makeWorkspaceDir();   // a2 exists on staging only
  const res = resolveAnnotation(dir, 'a2');
  assert.ok(res.ok);
  assert.equal(res.hit.base.slug, 'staging');
});

test('aggregate: a bare id still resolves, so merged ids work on a single base', () => {
  const dir = makeReviewDir();
  assert.equal(resolveAnnotation(dir, 'a1').hit.annotation.id, 'a1');
  const miss = resolveAnnotation(dir, 'a99');
  assert.equal(miss.ok, false);
  assert.match(miss.error, /no annotation with id a99/);
});

test('aggregate: the MCP server starts on a workspace with no root annotations.json', async t => {
  const client = await startMcpClient(makeWorkspaceDir());
  t.after(() => client.close());
  const { tools } = await client.listTools();
  assert.ok(tools.some(x => x.name === 'nit_list_annotations'), 'the server came up and registered its tools');
});
