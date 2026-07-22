// SPDX-License-Identifier: AGPL-3.0-or-later
// Milestone 11: the MCP stdio server wraps annotations.json without schema changes.
// A scripted JSON-RPC client drives initialize → tools/list → tools/call.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli', 'index.js');

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

// Options let a test override the a1 fixture annotation (e.g. a query-carrying
// route) without duplicating the whole fixture.
function makeReviewDir({ route = '/products' } = {}) {
  const dir = tmpDir('nit-mcp-');
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'shots', 'a1.png'), PNG_1PX);
  const data = {
    review: { id: 'mcp-fixture', url: 'https://example.com', createdAt: '2026-07-20T10:00:00Z', authors: ['Kevin'] },
    annotations: [
      {
        id: 'a1', type: 'change-request', comment: 'Make the badge yellow', status: 'open', author: 'Kevin',
        viewportScope: 'general', viewport: { mode: 'desktop', w: 1440, h: 900 }, route,
        target: { component: 'app-tile', ngComponent: null, selector: '.badge', xpath: '/html[1]', tag: 'div', classes: ['badge'], text: 'New', rect: { x: 0, y: 0, w: 10, h: 10 } },
        screenshot: 'shots/a1.png', createdAt: '2026-07-20T10:01:00Z',
      },
      {
        id: 'a2', type: 'comment', comment: 'Nice animation', status: 'open', author: 'Ann',
        viewportScope: 'general', viewport: { mode: 'desktop', w: 1440, h: 900 }, route: '/',
        target: { component: 'app-header', ngComponent: null, selector: '#logo', xpath: '/html[1]', tag: 'a', classes: [], text: '', rect: { x: 0, y: 0, w: 10, h: 10 } },
        screenshot: null, createdAt: '2026-07-20T10:02:00Z',
      },
    ],
  };
  fs.writeFileSync(path.join(dir, 'annotations.json'), JSON.stringify(data, null, 2));
  return dir;
}

function startClient(dir) {
  const child = spawn(process.execPath, [CLI, 'mcp', dir], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });
  let nextId = 1;
  return {
    child,
    request(method, params) {
      const id = nextId++;
      const promise = new Promise((resolve, reject) => {
        pending.set(id, resolve);
        setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10000);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return promise;
    },
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    },
    close() {
      child.stdin.end();
      child.kill();
    },
  };
}

// Fixture clients spawned by startFixtureMcp() are closed in bulk after the
// file's tests finish, since the brief's tests take no `t` to register per-test
// cleanup with.
const fixtureClients = [];
after(() => { for (const c of fixtureClients) c.close(); });

/**
 * Spin up a fixture review dir + MCP server, complete the initialize handshake,
 * and return a `call(name, args)` helper that resolves to the tool result
 * (`{ content, isError? }`) — the shape the brief's tests assert against.
 * @param {{ route?: string }} [annotationOverrides] forwarded to makeReviewDir
 */
async function startFixtureMcp(annotationOverrides = {}) {
  const dir = makeReviewDir(annotationOverrides);
  const client = startClient(dir);
  fixtureClients.push(client);
  await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'nit-test', version: '0' },
  });
  client.notify('notifications/initialized');
  return {
    dir,
    client,
    async call(name, args) {
      const res = await client.request('tools/call', { name, arguments: args });
      return res.result;
    },
  };
}

test('mcp server — list, get, mark_fixed, set_status over stdio JSON-RPC', async t => {
  const dir = makeReviewDir();
  const client = startClient(dir);
  t.after(() => client.close());

  const init = await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'nit-test', version: '0' },
  });
  assert.equal(init.result.serverInfo.name, 'nit');
  assert.equal(init.result.protocolVersion, '2025-06-18');
  client.notify('notifications/initialized');

  const tools = await client.request('tools/list');
  const names = tools.result.tools.map(x => x.name);
  assert.deepEqual(names.sort(), ['get_annotation', 'list_annotations', 'mark_fixed', 'set_issue_ref', 'set_status']);

  const list = await client.request('tools/call', { name: 'list_annotations', arguments: {} });
  const listed = JSON.parse(list.result.content[0].text);
  assert.equal(listed.total, 2);
  assert.equal(listed.actionable, 1); // only the open change-request
  assert.equal(listed.annotations[0].component, 'app-tile');

  const filtered = await client.request('tools/call', { name: 'list_annotations', arguments: { type: 'comment' } });
  assert.equal(JSON.parse(filtered.result.content[0].text).total, 1);

  const got = await client.request('tools/call', { name: 'get_annotation', arguments: { id: 'a1' } });
  const gotAnn = JSON.parse(got.result.content[0].text);
  assert.equal(gotAnn.comment, 'Make the badge yellow');
  const image = got.result.content.find(c => c.type === 'image');
  assert.ok(image, 'screenshot returned as image content');
  assert.equal(image.mimeType, 'image/png');
  assert.ok(image.data.length > 20);

  const fixed = await client.request('tools/call', { name: 'mark_fixed', arguments: { id: 'a1' } });
  assert.equal(JSON.parse(fixed.result.content[0].text).status, 'fixed');
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'annotations.json'), 'utf8'));
  assert.equal(onDisk.annotations.find(a => a.id === 'a1').status, 'fixed');

  const reopened = await client.request('tools/call', { name: 'set_status', arguments: { id: 'a1', status: 'reopened' } });
  const reopenedAnn = JSON.parse(reopened.result.content[0].text);
  assert.equal(reopenedAnn.status, 'reopened');
  assert.ok(reopenedAnn.verifiedAt);

  const missing = await client.request('tools/call', { name: 'get_annotation', arguments: { id: 'nope' } });
  assert.equal(missing.result.isError, true);

  const unknownMethod = await client.request('does/not/exist');
  assert.equal(unknownMethod.error.code, -32601);
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

  const client = startClient(dir);
  t.after(() => client.close());
  await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });

  const got = await client.request('tools/call', { name: 'get_annotation', arguments: { id: 'a1' } });
  // text record is returned, but the traversal path must NOT be read back as an image
  assert.ok(got.result.content.some(c => c.type === 'text'));
  const leaked = got.result.content.find(c => c.type === 'image' && Buffer.from(c.data, 'base64').toString().includes('TOP SECRET'));
  assert.equal(leaked, undefined, 'secret file must not be exfiltrated as an image');
});

test('mcp: set_issue_ref sets and clears the reference', async () => {
  const { call, dir } = await startFixtureMcp();
  const set = await call('set_issue_ref', { id: 'a1', ref: ' FAI-1234 ' });
  assert.equal(JSON.parse(set.content[0].text).issueRef, 'FAI-1234', 'trimmed and stored');

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'annotations.json'), 'utf8'));
  assert.equal(onDisk.annotations[0].issueRef, 'FAI-1234');
  assert.equal(onDisk.annotations[0].updatedBy, 'agent');

  const cleared = await call('set_issue_ref', { id: 'a1', ref: '' });
  assert.equal(JSON.parse(cleared.content[0].text).issueRef, undefined);
});

// The caller is a program, so a non-string `ref` is a type error to report — it
// used to be coerced to '' and silently WIPE a reference the agent had set.
test('mcp: set_issue_ref reports a non-string ref instead of clearing the reference', async () => {
  const { call, dir } = await startFixtureMcp();
  await call('set_issue_ref', { id: 'a1', ref: 'FAI-1234' });

  for (const ref of [42, null, { key: 'FAI-1' }, ['FAI-1'], true]) {
    const res = await call('set_issue_ref', { id: 'a1', ref });
    assert.equal(res.isError, true, `${JSON.stringify(ref)} is rejected`);
    assert.match(res.content[0].text, /ref must be a string/);
  }
  const missing = await call('set_issue_ref', { id: 'a1' });
  assert.equal(missing.isError, true, 'an omitted ref is rejected too');

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'annotations.json'), 'utf8'));
  assert.equal(onDisk.annotations[0].issueRef, 'FAI-1234', 'the stored reference is untouched');
});

test('mcp: set_status stamps updatedBy agent', async () => {
  const { call } = await startFixtureMcp();
  const res = await call('mark_fixed', { id: 'a1' });
  const ann = JSON.parse(res.content[0].text);
  assert.equal(ann.status, 'fixed');
  assert.equal(ann.updatedBy, 'agent');
  assert.match(ann.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('mcp: list_annotations route filter matches the full route and the path', async () => {
  const { call } = await startFixtureMcp({ route: '/products?id=5' });
  const byFull = JSON.parse((await call('list_annotations', { route: '/products?id=5' })).content[0].text);
  const byPath = JSON.parse((await call('list_annotations', { route: '/products' })).content[0].text);
  assert.equal(byFull.total, 1);
  assert.equal(byPath.total, 1, 'path-only filter still finds a query-carrying route');
  assert.equal(byFull.annotations[0].issueRef, undefined, 'summary carries the field');
});
