// SPDX-License-Identifier: AGPL-3.0-or-later
// MCP (Model Context Protocol) stdio server wrapping a nit review directory,
// built on the official SDK. SPEC §3: stable ids + status are exactly what this
// thin wrapper needs — the annotations schema ships unchanged.
import fs from 'node:fs';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './tools.js';
import { registerResources } from './resources.js';
import { pkgVersion } from '../util/version.js';

// Sent with the initialize result; MCP clients surface this to the agent as
// standing guidance for the whole server.
const INSTRUCTIONS = 'This server exposes a nit review: UI annotations a human reviewer made on a live website, '
  + 'each pinned to a concrete element. Typical flow: nit_list_annotations to see what is actionable '
  + '(change-requests with status open or reopened), nit_get_annotation for each one you work on '
  + '(read the screenshot and, when present, the click history to reproduce the state), make the fix '
  + 'in the source code, then nit_mark_fixed. Treat comment-type annotations as context, never as tasks. '
  + 'If a change should not be made, set status wontfix instead of forcing it. '
  + 'Humans verify fixes afterwards; reopened items come back as actionable. '
  + 'The same review is also readable as resources (nit://review/annotations.json, nit://review/review.md, '
  + 'nit://review/fix-annotations.md, nit://annotation/{id} and its screenshots) when you want context '
  + 'without spending a tool call; every change still goes through the tools.';

/** Options for {@link startMcpServer}. */
export interface McpServerOptions {
  /** protocol input (default process.stdin) */
  input?: Readable;
  /** protocol output (default process.stdout) */
  output?: Writable;
  /** diagnostics sink (default stderr) */
  log?: (msg: string) => void;
}

/** A running server; closing it tears the transport down too. */
export interface RunningMcpServer {
  close: () => Promise<void>;
  /** run when the client disconnects (stdin closed) */
  onClose: (fn: () => void) => void;
}

/**
 * Start the MCP stdio server over a review directory. The SDK owns the JSON-RPC
 * framing and the handshake; nothing but protocol traffic ever reaches stdout.
 * The annotations file is re-read on every tool call and resource read, so humans
 * and other agents can edit it concurrently.
 * @param dir review directory containing annotations.json
 * @param opts see {@link McpServerOptions}
 * @throws when the directory has no annotations.json
 */
export async function startMcpServer(
  dir: string,
  { input = process.stdin, output = process.stdout, log = msg => console.error(msg) }: McpServerOptions = {},
): Promise<RunningMcpServer> {
  const absDir = path.resolve(dir);
  if (!fs.existsSync(path.join(absDir, 'annotations.json'))) {
    throw new Error(`no annotations.json in ${absDir}`);
  }

  const server = new McpServer({ name: 'nit', version: pkgVersion() }, { instructions: INSTRUCTIONS });
  registerTools(server, absDir);
  registerResources(server, absDir);

  await server.connect(new StdioServerTransport(input, output));
  log(`nit mcp serving ${absDir}`);

  return {
    close: () => server.close(),
    onClose: fn => { server.server.onclose = fn; },
  };
}
