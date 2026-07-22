// SPDX-License-Identifier: AGPL-3.0-or-later
// The MCP stdio server wraps annotations.json without schema changes. The SDK's
// own client drives the real `nit mcp` process: initialize → tools/list →
// tools/call, plus the tool annotations clients rely on. Tool results carry
// their payload only as compact JSON text — there is no `structuredContent`
// (no `outputSchema` is declared; see `src/mcp/schema.ts`).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, readAnnotations } from './helpers/tmp.js';
import { startFixtureMcp, startMcpClient, payload } from './helpers/mcp.js';

const TOOL_NAMES = ['nit_get_annotation', 'nit_list_annotations', 'nit_mark_fixed', 'nit_set_issue_ref', 'nit_set_status'];

test('mcp server — handshake announces nit, its instructions and its capabilities', async t => {
  const { client } = await startFixtureMcp(t);

  const info = client.getServerVersion();
  assert.equal(info.name, 'nit');
  // the real package version, not a hardcoded one
  assert.equal(info.version, JSON.parse(fs.readFileSync('package.json', 'utf8')).version);

  const capabilities = client.getServerCapabilities();
  assert.ok(capabilities.tools, 'tools capability');
  assert.ok(capabilities.resources, 'resources capability');

  const instructions = client.getInstructions();
  assert.match(instructions, /nit_list_annotations/);
  assert.match(instructions, /wontfix/);
});

test('mcp server — tools carry titles and annotations, but no output schema', async t => {
  const { client } = await startFixtureMcp(t);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(x => x.name).sort(), TOOL_NAMES);

  for (const tool of tools) {
    assert.ok(tool.title, `${tool.name} has a title`);
    assert.equal(tool.outputSchema, undefined, `${tool.name} declares no output schema`);
    assert.equal(tool.annotations.openWorldHint, false, `${tool.name} is closed-world`);
  }

  const byName = Object.fromEntries(tools.map(x => [x.name, x]));
  assert.equal(byName.nit_list_annotations.annotations.readOnlyHint, true);
  assert.equal(byName.nit_get_annotation.annotations.readOnlyHint, true);
  assert.equal(byName.nit_mark_fixed.annotations.readOnlyHint, false);
  assert.equal(byName.nit_mark_fixed.annotations.destructiveHint, false, 'a status change is reversible');
  // the enum reaches the client, so an agent knows the legal statuses up front
  assert.deepEqual(byName.nit_set_status.inputSchema.properties.status.enum,
    ['open', 'fixed', 'wontfix', 'verified', 'reopened']);
});

test('mcp server — result text is compact JSON, not pretty-printed', async t => {
  const { call } = await startFixtureMcp(t);
  const list = await call('nit_list_annotations', {});
  const text = list.content[0].text;
  assert.equal(text, JSON.stringify(JSON.parse(text)), 'no indentation/newlines added');

  const got = await call('nit_get_annotation', { id: 'a1' });
  const gotText = got.content[0].text;
  assert.equal(gotText, JSON.stringify(JSON.parse(gotText)));
});

test('mcp server — list, get, mark_fixed, set_status', async t => {
  const { dir, call } = await startFixtureMcp(t);

  const list = payload(await call('nit_list_annotations', {}));
  assert.equal(list.total, 2);
  assert.equal(list.actionable, 1); // only the open change-request
  assert.equal(list.annotations[0].component, 'app-tile');
  assert.equal(list.review.id, 'mcp-fixture');

  const filtered = payload(await call('nit_list_annotations', { type: 'comment' }));
  assert.equal(filtered.total, 1);

  const got = payload(await call('nit_get_annotation', { id: 'a1' }));
  assert.equal(got.annotation.comment, 'Make the badge yellow');
  const gotRes = await call('nit_get_annotation', { id: 'a1' });
  const image = gotRes.content.find(c => c.type === 'image');
  assert.ok(image, 'screenshot returned as image content');
  assert.equal(image.mimeType, 'image/png');
  assert.ok(image.data.length > 20);

  const fixed = payload(await call('nit_mark_fixed', { id: 'a1' }));
  assert.equal(fixed.annotation.status, 'fixed');
  assert.equal(readAnnotations(dir).annotations.find(a => a.id === 'a1').status, 'fixed');

  const reopened = payload(await call('nit_set_status', { id: 'a1', status: 'reopened' }));
  assert.equal(reopened.annotation.status, 'reopened');
  assert.ok(reopened.annotation.verifiedAt);

  const missing = await call('nit_get_annotation', { id: 'nope' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /no annotation with id nope/);

  const unknown = await call('nit_does_not_exist', {});
  assert.equal(unknown.isError, true, 'an unknown tool is an error the agent can read');
});

test('mcp: list rows carry classes/text/statusReason, drop author/createdAt', async t => {
  const { call } = await startFixtureMcp(t);
  const list = payload(await call('nit_list_annotations', {}));
  const a1 = list.annotations.find(a => a.id === 'a1');
  assert.deepEqual(a1.classes, ['badge']);
  assert.equal(a1.text, 'New');
  assert.equal('statusReason' in a1, false, 'never set on this fixture, so absent rather than null/undefined-in-JSON');
  assert.equal('author' in a1, false, 'one author per review is already in the envelope');
  assert.equal('createdAt' in a1, false, 'never used, dropped');
});

test('mcp: list envelope carries review only on an unfiltered call; total/actionable always', async t => {
  const { call } = await startFixtureMcp(t);
  const unfiltered = payload(await call('nit_list_annotations', {}));
  assert.ok(unfiltered.review, 'unfiltered call reports review metadata');
  assert.equal(typeof unfiltered.total, 'number');
  assert.equal(typeof unfiltered.actionable, 'number');

  const filtered = payload(await call('nit_list_annotations', { status: 'open' }));
  assert.equal('review' in filtered, false, 'filtered call already knows what it asked for');
  assert.equal(typeof filtered.total, 'number');
  assert.equal(typeof filtered.actionable, 'number');
});

test('mcp: a poisoned screenshot path cannot read files outside the review dir', async t => {
  const dir = tmpDir('nit-mcp-evil-');
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  // secret sits next to (outside) the review dir
  const secret = path.join(dir, '..', `nit-secret-${path.basename(dir)}.txt`);
  fs.writeFileSync(secret, 'TOP SECRET');
  t.after(() => { try { fs.unlinkSync(secret); } catch { /* ignore */ } });

  const data = {
    review: { id: 'evil', url: 'https://x', createdAt: '2026-07-20T10:00:00Z', authors: ['x'] },
    annotations: [{
      id: 'a1', type: 'change-request', comment: 'poisoned', status: 'open', author: 'x',
      viewportScope: 'general', viewport: { mode: 'desktop', w: 1, h: 1 }, route: '/',
      target: { component: 'x', ngComponent: null, selector: 'x', xpath: '/x', tag: 'x', classes: [], text: '', rect: { x: 0, y: 0, w: 1, h: 1 } },
      screenshot: `../nit-secret-${path.basename(dir)}.txt`, createdAt: '2026-07-20T10:00:00Z',
    }],
  };
  fs.writeFileSync(path.join(dir, 'annotations.json'), JSON.stringify(data));

  const client = await startMcpClient(dir);
  t.after(() => client.close());

  const got = await client.callTool({ name: 'nit_get_annotation', arguments: { id: 'a1' } });
  // the record is returned, but the traversal path must NOT be read back as an image
  assert.ok(payload(got).annotation, 'text record is still served');
  const leaked = got.content.find(c => c.type === 'image' && Buffer.from(c.data, 'base64').toString().includes('TOP SECRET'));
  assert.equal(leaked, undefined, 'secret file must not be exfiltrated as an image');
});

// annotations.json is shared and hand-editable, so a trimmed or odd record must
// still come back readable: validating tool output strictly would fail the whole
// call and leave the agent with nothing to work from.
test('mcp: a hand-trimmed annotations.json is still served, not rejected', async t => {
  const dir = tmpDir('nit-mcp-partial-');
  fs.writeFileSync(path.join(dir, 'annotations.json'), JSON.stringify({
    review: { id: 'partial', url: 'https://example.com', createdAt: '2026-07-20T10:00:00Z', authors: [] },
    annotations: [
      // no target, no viewport, no author — someone edited the file by hand
      { id: 'a1', type: 'change-request', comment: 'partial record', status: 'open', route: '/' },
      // and a status nit itself would never write
      { id: 'a2', type: 'change-request', comment: 'odd status', status: 'done', route: '/' },
    ],
  }));
  const client = await startMcpClient(dir);
  t.after(() => client.close());

  const list = await client.callTool({ name: 'nit_list_annotations', arguments: {} });
  assert.ok(!list.isError, 'the entry point never fails over one odd record');
  assert.equal(payload(list).total, 2);

  const got = await client.callTool({ name: 'nit_get_annotation', arguments: { id: 'a1' } });
  assert.ok(!got.isError);
  assert.equal(payload(got).annotation.comment, 'partial record');

  // writes still go through, and are still validated on the way in
  const fixed = await client.callTool({ name: 'nit_mark_fixed', arguments: { id: 'a2' } });
  assert.equal(payload(fixed).annotation.status, 'fixed');
});

test('mcp: set_issue_ref sets and clears the reference', async t => {
  const { call, dir } = await startFixtureMcp(t);
  const set = payload(await call('nit_set_issue_ref', { id: 'a1', ref: ' FAI-1234 ' }));
  assert.equal(set.annotation.issueRef, 'FAI-1234', 'trimmed and stored');

  const onDisk = readAnnotations(dir);
  assert.equal(onDisk.annotations[0].issueRef, 'FAI-1234');
  assert.equal(onDisk.annotations[0].updatedBy, 'agent');

  const cleared = payload(await call('nit_set_issue_ref', { id: 'a1', ref: '' }));
  assert.equal(cleared.annotation.issueRef, undefined);
});

// The caller is a program, so a non-string `ref` is a type error to report — it
// used to be coerced to '' and silently WIPE a reference the agent had set. The
// SDK now rejects it against the tool's zod schema before the handler runs.
test('mcp: set_issue_ref reports a non-string ref instead of clearing the reference', async t => {
  const { call, dir } = await startFixtureMcp(t);
  await call('nit_set_issue_ref', { id: 'a1', ref: 'FAI-1234' });

  for (const ref of [42, null, { key: 'FAI-1' }, ['FAI-1'], true]) {
    const res = await call('nit_set_issue_ref', { id: 'a1', ref });
    assert.equal(res.isError, true, `${JSON.stringify(ref)} is rejected`);
    assert.match(res.content[0].text, /Invalid arguments/);
  }
  const missing = await call('nit_set_issue_ref', { id: 'a1' });
  assert.equal(missing.isError, true, 'an omitted ref is rejected too');

  assert.equal(readAnnotations(dir).annotations[0].issueRef, 'FAI-1234', 'the stored reference is untouched');
});

test('mcp: an invalid status is rejected before anything is written', async t => {
  const { call, dir } = await startFixtureMcp(t);
  const res = await call('nit_set_status', { id: 'a1', status: 'done' });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Invalid arguments/);
  assert.equal(readAnnotations(dir).annotations[0].status, 'open', 'untouched');
});

test('mcp: set_status stamps updatedBy agent', async t => {
  const { call } = await startFixtureMcp(t);
  const { annotation } = payload(await call('nit_mark_fixed', { id: 'a1' }));
  assert.equal(annotation.status, 'fixed');
  assert.equal(annotation.updatedBy, 'agent');
  assert.match(annotation.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('mcp: a write re-renders review.md next to annotations.json', async t => {
  const { call, dir } = await startFixtureMcp(t);
  await call('nit_mark_fixed', { id: 'a1' });
  const md = fs.readFileSync(path.join(dir, 'review.md'), 'utf8');
  assert.match(md, /Make the badge yellow/);
  assert.ok(fs.existsSync(path.join(dir, 'fix-annotations.md')), 'the instruction sheet is written too');
});

test('mcp: list_annotations route filter matches the full route and the path', async t => {
  const { call } = await startFixtureMcp(t, { route: '/products?id=5' });
  const byFull = payload(await call('nit_list_annotations', { route: '/products?id=5' }));
  const byPath = payload(await call('nit_list_annotations', { route: '/products' }));
  assert.equal(byFull.total, 1);
  assert.equal(byPath.total, 1, 'path-only filter still finds a query-carrying route');
  assert.equal(byFull.annotations[0].issueRef, undefined, 'summary carries the field');
});

test('mcp: list summaries carry historyCount (raw length); get_annotation compresses the trail', async t => {
  const history = [
    { selector: 'button.menu', tag: 'button', component: 'app-nav', text: 'Menu', at: '2026-07-20T10:00:30Z' },
    { selector: '#tab-2', tag: 'a', component: 'app-tabs', text: 'Details', at: '2026-07-20T10:00:40Z' },
  ];
  const { call } = await startFixtureMcp(t, { history });

  const list = payload(await call('nit_list_annotations', {}));
  const a1 = list.annotations.find(a => a.id === 'a1');
  const a2 = list.annotations.find(a => a.id === 'a2');
  assert.equal(a1.historyCount, 2);
  assert.equal(a2.historyCount, undefined, 'absent history has no count');

  const full = payload(await call('nit_get_annotation', { id: 'a1' })).annotation;
  assert.deepEqual(full.history, history, 'nothing to compress: no self-clicks, dupes, or overflow');
});

test('mcp: get_annotation — a trail of only self-clicks has no history field but keeps the original historyCount', async t => {
  const selfClicks = [
    { selector: '.badge', tag: 'span', component: 'app-tile', text: 'Badge', at: '2026-07-20T09:00:00Z' },
    { selector: '.badge', tag: 'span', component: 'app-tile', text: 'Badge again', at: '2026-07-20T09:00:10Z' },
  ];
  const { call } = await startFixtureMcp(t, { history: selfClicks });

  const full = payload(await call('nit_get_annotation', { id: 'a1' })).annotation;
  assert.equal('history' in full, false, 'compression drops every step — all are self-clicks on the target');
  assert.equal(full.historyCount, selfClicks.length, 'historyCount stays the original, uncompressed length');
});

test('mcp: list omits historyCount for a hand-edited empty history array, matching get_annotation', async t => {
  const { call } = await startFixtureMcp(t, { history: [] });

  const list = payload(await call('nit_list_annotations', {}));
  const a1 = list.annotations.find(a => a.id === 'a1');
  assert.equal('historyCount' in a1, false, 'an empty array reads the same as no history at all');

  const full = payload(await call('nit_get_annotation', { id: 'a1' })).annotation;
  assert.equal('historyCount' in full, false, 'get_annotation already treated [] this way');
});

test('mcp: get_annotation dedupes duplicate ids in a batch request', async t => {
  const { call } = await startFixtureMcp(t);

  const res = await call('nit_get_annotation', { id: ['a1', 'a1'] });
  const body = payload(res);
  assert.equal(body.annotations.length, 1, 'the repeated id collapses to one entry');
  assert.equal(body.annotations[0].id, 'a1');
  const images = res.content.filter(c => c.type === 'image');
  assert.equal(images.length, 1, 'the screenshot is not base64-encoded twice for the same id');
});

test('mcp: get_annotation batches ids, reports missing ones, still errors when none are found', async t => {
  const { call } = await startFixtureMcp(t, { a2Screenshot: true });

  const both = await call('nit_get_annotation', { id: ['a1', 'a2'] });
  const bothPayload = payload(both);
  assert.equal(bothPayload.annotations.length, 2);
  assert.deepEqual(bothPayload.annotations.map(a => a.id), ['a1', 'a2'], 'request order preserved');
  assert.equal(bothPayload.missing, undefined);
  const images = both.content.filter(c => c.type === 'image');
  assert.equal(images.length, 2, 'both screenshots come back as image content');

  const partial = payload(await call('nit_get_annotation', { id: ['a1', 'nope'] }));
  assert.equal(partial.annotations.length, 1);
  assert.equal(partial.annotations[0].id, 'a1');
  assert.deepEqual(partial.missing, ['nope']);

  const none = await call('nit_get_annotation', { id: ['nope', 'also-nope'] });
  assert.equal(none.isError, true, 'nothing found at all is still an error');
});

test('mcp: get_annotation omits target.xpath unless includeXpath is set', async t => {
  const { call } = await startFixtureMcp(t);
  const byDefault = payload(await call('nit_get_annotation', { id: 'a1' })).annotation;
  assert.equal('xpath' in byDefault.target, false);

  const withXpath = payload(await call('nit_get_annotation', { id: 'a1' , includeXpath: true })).annotation;
  assert.equal(withXpath.target.xpath, '/html[1]');
});

test('mcp: get_annotation skips image content when includeScreenshot is false', async t => {
  const { call } = await startFixtureMcp(t);
  const res = await call('nit_get_annotation', { id: 'a1', includeScreenshot: false });
  assert.equal(res.content.filter(c => c.type === 'image').length, 0);
  assert.ok(payload(res).annotation, 'text record still comes back');
});

test('mcp: history compression drops self-clicks, collapses dup selectors, caps at 5, dedupes text', async t => {
  const rawHistory = [
    { note: 'malformed — missing selector/text/component' },
    { selector: '.badge', tag: 'span', component: 'app-tile', text: 'Badge', at: '2026-07-20T09:00:00Z' }, // self-click on the target
    { selector: 'x1', tag: 'div', component: 'c', text: 'X1', at: '2026-07-20T09:00:10Z' },
    { selector: 'x2', tag: 'div', component: 'c', text: 'X2', at: '2026-07-20T09:00:20Z' },
    { selector: 'x3', tag: 'div', component: 'c', text: 'X3', at: '2026-07-20T09:00:30Z' },
    { selector: 'x4', tag: 'div', component: 'c', text: 'X4', at: '2026-07-20T09:00:40Z' },
    { selector: 'a.nav', tag: 'a', component: 'app-nav', text: 'Nav', at: '2026-07-20T09:00:50Z' },
    { selector: 'a.nav', tag: 'a', component: 'app-nav', text: 'Nav again', at: '2026-07-20T09:01:00Z' }, // consecutive dup selector
    { selector: 'b.item', tag: 'button', component: 'app-list', text: 'Same', at: '2026-07-20T09:01:10Z' },
    { selector: 'c.item', tag: 'button', component: 'app-list', text: 'Same', at: '2026-07-20T09:01:20Z' }, // repeats prior kept text
  ];
  const { call } = await startFixtureMcp(t, { history: rawHistory });

  const full = payload(await call('nit_get_annotation', { id: 'a1' })).annotation;
  assert.equal(full.historyCount, rawHistory.length, 'historyCount is the ORIGINAL length, including the malformed entry');
  assert.deepEqual(full.history, [
    { selector: 'x3', tag: 'div', component: 'c', text: 'X3', at: '2026-07-20T09:00:30Z' },
    { selector: 'x4', tag: 'div', component: 'c', text: 'X4', at: '2026-07-20T09:00:40Z' },
    { selector: 'a.nav', tag: 'a', component: 'app-nav', text: 'Nav', at: '2026-07-20T09:00:50Z' },
    { selector: 'b.item', tag: 'button', component: 'app-list', text: 'Same', at: '2026-07-20T09:01:10Z' },
    { selector: 'c.item', tag: 'button', component: 'app-list', at: '2026-07-20T09:01:20Z' },
  ], 'malformed + self-click dropped, dup selector collapsed, capped at 5, repeated text omitted');
});

test('mcp: reason is persisted as statusReason and cleared/replaced on every status change', async t => {
  const { call, dir } = await startFixtureMcp(t);

  const wontfix = payload(await call('nit_set_status', { id: 'a1', status: 'wontfix', reason: 'by design' }));
  assert.equal(wontfix.annotation.statusReason, 'by design');
  assert.equal(readAnnotations(dir).annotations[0].statusReason, 'by design', 'persisted on disk');

  const fixedNoReason = payload(await call('nit_mark_fixed', { id: 'a1' }));
  assert.equal(fixedNoReason.annotation.statusReason, undefined, 'a later change without a reason clears the stale one');
  assert.equal('statusReason' in readAnnotations(dir).annotations[0], false);

  const fixedWithReason = payload(await call('nit_mark_fixed', { id: 'a1', reason: '  trimmed  ' }));
  assert.equal(fixedWithReason.annotation.statusReason, 'trimmed', 'mark_fixed also accepts and trims a reason');

  const longReason = 'x'.repeat(600);
  const capped = payload(await call('nit_set_status', { id: 'a1', status: 'open', reason: longReason }));
  assert.equal(capped.annotation.statusReason.length, 500, 'capped at 500 chars');
});
