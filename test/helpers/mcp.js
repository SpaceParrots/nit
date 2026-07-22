// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixture review folders + an MCP client for the server tests. The client is the
// SDK's own `Client` over stdio, spawning the built CLI exactly as a real MCP
// host would — so the tests exercise protocol conformance, not a hand-rolled
// approximation of it. `process.execPath` is spawned directly rather than the
// `nit` shim, which on Windows is a .cmd only cmd.exe can execute.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { tmpDir } from './tmp.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'cli', 'index.js');

/** A 1×1 png — enough to prove screenshots travel as image content / blobs. */
export const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * A review dir with one open change-request (a1, with a screenshot) and one
 * comment (a2). Options override the a1 fixture (e.g. a query-carrying route)
 * without duplicating the whole thing.
 * @param {{route?: string, history?: object[], a2Screenshot?: boolean}} [options]
 * @returns {string} the review directory
 */
export function makeReviewDir({ route = '/products', history, a2Screenshot = false } = {}) {
  const dir = tmpDir('nit-mcp-');
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'shots', 'a1.png'), PNG_1PX);
  if (a2Screenshot) fs.writeFileSync(path.join(dir, 'shots', 'a2.png'), PNG_1PX);
  const data = {
    review: { id: 'mcp-fixture', url: 'https://example.com', createdAt: '2026-07-20T10:00:00Z', authors: ['Kevin'] },
    annotations: [
      {
        id: 'a1', type: 'change-request', comment: 'Make the badge yellow', status: 'open', author: 'Kevin',
        viewportScope: 'general', viewport: { mode: 'desktop', w: 1440, h: 900 }, route,
        target: { component: 'app-tile', ngComponent: null, selector: '.badge', xpath: '/html[1]', tag: 'div', classes: ['badge'], text: 'New', rect: { x: 0, y: 0, w: 10, h: 10 } },
        screenshot: 'shots/a1.png', createdAt: '2026-07-20T10:01:00Z',
        ...(history ? { history } : {}),
      },
      {
        id: 'a2', type: 'comment', comment: 'Nice animation', status: 'open', author: 'Ann',
        viewportScope: 'general', viewport: { mode: 'desktop', w: 1440, h: 900 }, route: '/',
        target: { component: 'app-header', ngComponent: null, selector: '#logo', xpath: '/html[1]', tag: 'a', classes: [], text: '', rect: { x: 0, y: 0, w: 10, h: 10 } },
        screenshot: a2Screenshot ? 'shots/a2.png' : null, createdAt: '2026-07-20T10:02:00Z',
      },
    ],
  };
  fs.writeFileSync(path.join(dir, 'annotations.json'), JSON.stringify(data, null, 2));
  return dir;
}

/**
 * Connect an MCP client to `nit mcp <dir>`; the handshake is complete when this
 * resolves.
 * @param {string} dir review directory to serve
 * @returns {Promise<Client>}
 */
export async function startMcpClient(dir) {
  const client = new Client({ name: 'nit-test', version: '0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'mcp', dir],
    stderr: 'ignore',
  }));
  return client;
}

/**
 * Fixture review dir + connected client + a `call(name, args)` shortcut that
 * resolves to the tool result (`{ content, isError? }`) — there is no
 * `structuredContent` any more (see `structured()` in `src/mcp/tools.ts`), so
 * a payload is read back with {@link payload}.
 * @param {import('node:test').TestContext} t closes the client when the test ends
 * @param {{route?: string, history?: object[], a2Screenshot?: boolean}} [options] forwarded to makeReviewDir
 */
export async function startFixtureMcp(t, options = {}) {
  const dir = makeReviewDir(options);
  const client = await startMcpClient(dir);
  t.after(() => client.close());
  return {
    dir,
    client,
    call: (name, args) => client.callTool({ name, arguments: args }),
  };
}

/**
 * Parse a tool result's compact JSON text body — the sole way results carry
 * data now that `structuredContent` is gone.
 * @param {{content: {type: string, text?: string}[]}} res a tool call result
 * @returns {unknown}
 */
export function payload(res) {
  return JSON.parse(res.content[0].text);
}
