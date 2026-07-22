// SPDX-License-Identifier: AGPL-3.0-or-later
// The MCP resource surface: the review as files (annotations.json, review.md,
// fix-annotations.md) and per-annotation resources with their screenshots, all
// read-only. Writes stay tool-only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.js';
import { startFixtureMcp, startMcpClient, PNG_1PX } from './helpers/mcp.js';

test('mcp resources — the review is listed as files an agent can read', async t => {
  const { client } = await startFixtureMcp(t);
  const { resources } = await client.listResources();
  const uris = resources.map(r => r.uri);

  assert.ok(uris.includes('nit://review/annotations.json'));
  assert.ok(uris.includes('nit://review/review.md'));
  assert.ok(uris.includes('nit://review/fix-annotations.md'));
  // the per-annotation resources are enumerated from the live file
  assert.ok(uris.includes('nit://annotation/a1'), 'the change-request');
  assert.ok(uris.includes('nit://annotation/a2'), 'the comment');
  assert.ok(uris.includes('nit://annotation/a1/screenshot'), 'a1 has a shot');
  assert.ok(!uris.includes('nit://annotation/a2/screenshot'), 'a2 has none, so none is offered');

  const a1 = resources.find(r => r.uri === 'nit://annotation/a1');
  assert.match(a1.title, /Make the badge yellow/, 'the comment identifies it in a picker');

  const { resourceTemplates } = await client.listResourceTemplates();
  assert.ok(resourceTemplates.some(x => x.uriTemplate === 'nit://annotation/{id}'));
});

test('mcp resources — annotations.json, review.md and the instruction sheet read back', async t => {
  const { client, dir } = await startFixtureMcp(t);

  const json = await client.readResource({ uri: 'nit://review/annotations.json' });
  assert.equal(json.contents[0].mimeType, 'application/json');
  assert.equal(JSON.parse(json.contents[0].text).annotations.length, 2);

  // review.md has not been written yet — it is rendered on the fly
  assert.ok(!fs.existsSync(path.join(dir, 'review.md')));
  const md = await client.readResource({ uri: 'nit://review/review.md' });
  assert.match(md.contents[0].text, /Make the badge yellow/);
  assert.equal(md.contents[0].mimeType, 'text/markdown');

  const sheet = await client.readResource({ uri: 'nit://review/fix-annotations.md' });
  assert.match(sheet.contents[0].text, /^# \/fix-annotations/);
});

test('mcp resources — one annotation, its screenshot, and id completion', async t => {
  const { client } = await startFixtureMcp(t);

  const one = await client.readResource({ uri: 'nit://annotation/a1' });
  const ann = JSON.parse(one.contents[0].text);
  assert.equal(ann.id, 'a1');
  assert.equal(ann.target.selector, '.badge');

  const shot = await client.readResource({ uri: 'nit://annotation/a1/screenshot' });
  assert.equal(shot.contents[0].mimeType, 'image/png');
  assert.deepEqual(Buffer.from(shot.contents[0].blob, 'base64'), PNG_1PX);

  const completion = await client.complete({
    ref: { type: 'ref/resource', uri: 'nit://annotation/{id}' },
    argument: { name: 'id', value: 'a' },
  });
  assert.deepEqual(completion.completion.values.sort(), ['a1', 'a2']);

  await assert.rejects(
    () => client.readResource({ uri: 'nit://annotation/nope' }),
    /no annotation with id nope/,
    'an unknown id is a protocol error, not an empty resource',
  );
  await assert.rejects(
    () => client.readResource({ uri: 'nit://annotation/a2/screenshot' }),
    /screenshot/,
    'an annotation without a shot has no screenshot resource',
  );
});

// `nit merge` namespaces ids per author (kevin:a1), and `:` has to survive the
// trip through a uri template in both directions.
test('mcp resources — a merged, namespaced id round-trips through its uri', async t => {
  const dir = tmpDir('nit-mcp-merged-');
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'shots', 'kevin_a1.png'), PNG_1PX);
  fs.writeFileSync(path.join(dir, 'annotations.json'), JSON.stringify({
    review: { id: 'merged', url: 'https://example.com', createdAt: '2026-07-20T10:00:00Z', authors: ['Kevin'] },
    annotations: [{
      id: 'kevin:a1', type: 'change-request', comment: 'Merged nit', status: 'open', author: 'Kevin',
      viewportScope: 'general', viewport: { mode: 'desktop', w: 1440, h: 900 }, route: '/',
      target: { component: 'app-tile', ngComponent: null, selector: '.badge', xpath: '/html[1]', tag: 'div', classes: [], text: '', rect: { x: 0, y: 0, w: 1, h: 1 } },
      screenshot: 'shots/kevin_a1.png', createdAt: '2026-07-20T10:01:00Z',
    }],
  }));

  const client = await startMcpClient(dir);
  t.after(() => client.close());

  const { resources } = await client.listResources();
  const listed = resources.find(r => r.name === 'kevin:a1');
  assert.ok(listed, 'the annotation is listed');

  const one = await client.readResource({ uri: listed.uri });
  assert.equal(JSON.parse(one.contents[0].text).id, 'kevin:a1');

  const shot = await client.readResource({ uri: `${listed.uri}/screenshot` });
  assert.deepEqual(Buffer.from(shot.contents[0].blob, 'base64'), PNG_1PX);
});

test('mcp resources — a poisoned screenshot path is refused, like the tool refuses it', async t => {
  const dir = tmpDir('nit-mcp-res-evil-');
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  const secret = path.join(dir, '..', `nit-secret-${path.basename(dir)}.txt`);
  fs.writeFileSync(secret, 'TOP SECRET');
  t.after(() => { try { fs.unlinkSync(secret); } catch { /* ignore */ } });

  fs.writeFileSync(path.join(dir, 'annotations.json'), JSON.stringify({
    review: { id: 'evil', url: 'https://x', createdAt: '2026-07-20T10:00:00Z', authors: ['x'] },
    annotations: [{
      id: 'a1', type: 'change-request', comment: 'poisoned', status: 'open', author: 'x',
      viewportScope: 'general', viewport: { mode: 'desktop', w: 1, h: 1 }, route: '/',
      target: { component: 'x', ngComponent: null, selector: 'x', xpath: '/x', tag: 'x', classes: [], text: '', rect: { x: 0, y: 0, w: 1, h: 1 } },
      screenshot: `../nit-secret-${path.basename(dir)}.txt`, createdAt: '2026-07-20T10:00:00Z',
    }],
  }));

  const client = await startMcpClient(dir);
  t.after(() => client.close());

  await assert.rejects(
    () => client.readResource({ uri: 'nit://annotation/a1/screenshot' }),
    err => !String(err).includes('TOP SECRET'),
    'the traversal path must not be served as a blob',
  );
});
