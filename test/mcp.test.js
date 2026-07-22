// SPDX-License-Identifier: AGPL-3.0-or-later
// The MCP stdio server wraps annotations.json without schema changes. The SDK's
// own client drives the real `nit mcp` process: initialize → tools/list →
// tools/call, plus the structured output and tool annotations clients rely on.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, readAnnotations } from './helpers/tmp.js';
import { startFixtureMcp, startMcpClient } from './helpers/mcp.js';

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

test('mcp server — tools carry titles, annotations and output schemas', async t => {
  const { client } = await startFixtureMcp(t);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(x => x.name).sort(), TOOL_NAMES);

  for (const tool of tools) {
    assert.ok(tool.title, `${tool.name} has a title`);
    assert.ok(tool.outputSchema, `${tool.name} declares an output schema`);
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

test('mcp server — list, get, mark_fixed, set_status', async t => {
  const { dir, call } = await startFixtureMcp(t);

  const list = await call('nit_list_annotations', {});
  assert.equal(list.structuredContent.total, 2);
  assert.equal(list.structuredContent.actionable, 1); // only the open change-request
  assert.equal(list.structuredContent.annotations[0].component, 'app-tile');
  assert.equal(list.structuredContent.review.id, 'mcp-fixture');
  // the same payload is mirrored as text for clients that ignore structured content
  assert.deepEqual(JSON.parse(list.content[0].text), list.structuredContent);

  const filtered = await call('nit_list_annotations', { type: 'comment' });
  assert.equal(filtered.structuredContent.total, 1);

  const got = await call('nit_get_annotation', { id: 'a1' });
  assert.equal(got.structuredContent.annotation.comment, 'Make the badge yellow');
  const image = got.content.find(c => c.type === 'image');
  assert.ok(image, 'screenshot returned as image content');
  assert.equal(image.mimeType, 'image/png');
  assert.ok(image.data.length > 20);

  const fixed = await call('nit_mark_fixed', { id: 'a1' });
  assert.equal(fixed.structuredContent.annotation.status, 'fixed');
  assert.equal(readAnnotations(dir).annotations.find(a => a.id === 'a1').status, 'fixed');

  const reopened = await call('nit_set_status', { id: 'a1', status: 'reopened' });
  assert.equal(reopened.structuredContent.annotation.status, 'reopened');
  assert.ok(reopened.structuredContent.annotation.verifiedAt);

  const missing = await call('nit_get_annotation', { id: 'nope' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /no annotation with id nope/);

  const unknown = await call('nit_does_not_exist', {});
  assert.equal(unknown.isError, true, 'an unknown tool is an error the agent can read');
});

test('mcp server — a poisoned screenshot path cannot read files outside the review dir', async t => {
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
  assert.ok(got.structuredContent.annotation, 'text record is still served');
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
  assert.equal(list.structuredContent.total, 2);

  const got = await client.callTool({ name: 'nit_get_annotation', arguments: { id: 'a1' } });
  assert.ok(!got.isError);
  assert.equal(got.structuredContent.annotation.comment, 'partial record');

  // writes still go through, and are still validated on the way in
  const fixed = await client.callTool({ name: 'nit_mark_fixed', arguments: { id: 'a2' } });
  assert.equal(fixed.structuredContent.annotation.status, 'fixed');
});

test('mcp: set_issue_ref sets and clears the reference', async t => {
  const { call, dir } = await startFixtureMcp(t);
  const set = await call('nit_set_issue_ref', { id: 'a1', ref: ' FAI-1234 ' });
  assert.equal(set.structuredContent.annotation.issueRef, 'FAI-1234', 'trimmed and stored');

  const onDisk = readAnnotations(dir);
  assert.equal(onDisk.annotations[0].issueRef, 'FAI-1234');
  assert.equal(onDisk.annotations[0].updatedBy, 'agent');

  const cleared = await call('nit_set_issue_ref', { id: 'a1', ref: '' });
  assert.equal(cleared.structuredContent.annotation.issueRef, undefined);
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
  const { annotation } = (await call('nit_mark_fixed', { id: 'a1' })).structuredContent;
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
  const byFull = (await call('nit_list_annotations', { route: '/products?id=5' })).structuredContent;
  const byPath = (await call('nit_list_annotations', { route: '/products' })).structuredContent;
  assert.equal(byFull.total, 1);
  assert.equal(byPath.total, 1, 'path-only filter still finds a query-carrying route');
  assert.equal(byFull.annotations[0].issueRef, undefined, 'summary carries the field');
});

test('mcp: list summaries carry historyCount and get_annotation returns the trail', async t => {
  const history = [
    { selector: 'button.menu', tag: 'button', component: 'app-nav', text: 'Menu', at: '2026-07-20T10:00:30Z' },
    { selector: '#tab-2', tag: 'a', component: 'app-tabs', text: 'Details', at: '2026-07-20T10:00:40Z' },
  ];
  const { call } = await startFixtureMcp(t, { history });

  const list = (await call('nit_list_annotations', {})).structuredContent;
  const a1 = list.annotations.find(a => a.id === 'a1');
  const a2 = list.annotations.find(a => a.id === 'a2');
  assert.equal(a1.historyCount, 2);
  assert.equal(a2.historyCount, undefined, 'absent history has no count');

  const full = (await call('nit_get_annotation', { id: 'a1' })).structuredContent.annotation;
  assert.deepEqual(full.history, history, 'full record carries the trail verbatim');
});
