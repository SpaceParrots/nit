// SPDX-License-Identifier: AGPL-3.0-or-later
// MCP (Model Context Protocol) stdio server wrapping a nit review directory,
// built on the official SDK. SPEC §3: stable ids + status are exactly what this
// thin wrapper needs — the annotations schema ships unchanged.
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './tools.js';
import { registerResources } from './resources.js';
import { openWorkspace } from '../store/workspace.js';
import { pkgVersion } from '../util/version.js';

// Sent with the initialize result; MCP clients surface this to the agent as
// standing guidance for the whole server.
const INSTRUCTIONS = 'This server exposes a nit review: UI annotations a human reviewer made on a live website, '
  + 'each pinned to a concrete element. Typical flow: nit_list_annotations to see everything (rows carry '
  + 'the full record minus click history and xpath; actionable means type change-request with status open '
  + 'or reopened), then nit_get_annotation — it accepts one id or an array — for the screenshot and click '
  + 'history of anything you work on, make the fix in the source code, then nit_mark_fixed. Treat '
  + 'comment-type annotations as context, never as tasks. If a change should not be made, set status '
  + 'wontfix via nit_set_status and record why in its reason parameter. Humans verify fixes afterwards; '
  + 'reopened items come back as actionable. Every change goes through the tools. '
  + 'A review may cover several base URLs (e.g. local, staging, production). When it does, every row '
  + 'carries its base slug and ids are qualified as "<base>:<id>" (e.g. staging:a1) — pass ids back in '
  + 'that exact form, and use the base parameter to work on one environment at a time. A single-base '
  + 'review keeps plain ids. If you cannot call tools, '
  + 'the review is also readable as resources: nit://review/brief.md (one line per annotation), '
  + 'nit://review/fix-annotations.md (how to work file-only), nit://review/annotations.json, and '
  + 'nit://annotation/{id} plus its screenshots; a multi-base review adds nit://review/bases.md and '
  + 'nit://base/{slug}/annotations.json.';

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
  // A review folder is either flat (annotations.json in it) or a workspace of
  // base folders; both are served, and either shape must hold at least one.
  if (!openWorkspace(absDir).bases.length) {
    throw new Error(`no review in ${absDir} — no annotations.json and no base folders`);
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
