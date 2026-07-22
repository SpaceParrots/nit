// SPDX-License-Identifier: AGPL-3.0-or-later
// Minimal MCP (Model Context Protocol) stdio server wrapping a nit review directory.
// SPEC §3: stable ids + status are exactly what this thin wrapper needs — the schema
// ships unchanged. Newline-delimited JSON-RPC 2.0 over stdio, stdlib only.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { createStore, safeShotPath } from '../store/store.js';
import type { Store } from '../store/store.js';
import { renderReviewMd, FIX_ANNOTATIONS_MD } from '../store/render.js';
import { errorMessage } from '../util/error.js';
import { routePath } from '../util/route.js';
import type { Annotation, AnnotationStatus } from '../types.js';

const PROTOCOL_FALLBACK = '2024-11-05';
const STATUSES: readonly AnnotationStatus[] = ['open', 'fixed', 'wontfix', 'verified', 'reopened'];

function isAnnotationStatus(v: unknown): v is AnnotationStatus {
  return typeof v === 'string' && (STATUSES as readonly string[]).includes(v);
}

/** An incoming JSON-RPC 2.0 message (already parsed, structurally unverified). */
interface JsonRpcMessage {
  id?: number | string | null;
  method?: unknown;
  params?: { protocolVersion?: unknown; name?: unknown; arguments?: Record<string, unknown> };
}

/** MCP tool-call result content: text and/or images. */
interface ToolContent {
  type: 'text' | 'image';
  text?: string;
  data?: string;
  mimeType?: string;
}

interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

type SendFn = (msg: object) => void;

const TOOLS = [
  {
    name: 'list_annotations',
    description: 'List annotations of the nit review, optionally filtered. Actionable = type "change-request" with status "open" or "reopened".',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: STATUSES },
        type: { type: 'string', enum: ['change-request', 'comment'] },
        route: { type: 'string' },
      },
    },
  },
  {
    name: 'get_annotation',
    description: 'Get one annotation in full, including its screenshot(s) as images.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'mark_fixed',
    description: 'Mark an annotation as fixed after making the change it describes.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'set_status',
    description: 'Set an annotation status explicitly (open | fixed | wontfix | verified | reopened).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        status: { type: 'string', enum: STATUSES },
      },
      required: ['id', 'status'],
    },
  },
  {
    name: 'set_issue_ref',
    description: 'Attach a tracker issue key or url to an annotation (empty string clears it).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        ref: { type: 'string' },
      },
      required: ['id', 'ref'],
    },
  },
];

/** Options for {@link startMcpServer}. */
export interface McpServerOptions {
  /** protocol input (default process.stdin) */
  input?: Readable;
  /** protocol output (default process.stdout) */
  output?: Writable;
  /** diagnostics sink (default stderr) */
  log?: (msg: string) => void;
}

/**
 * Start the MCP stdio server over a review directory. Speaks newline-delimited
 * JSON-RPC 2.0 on the given streams (never writes logs to stdout — that's the
 * protocol channel). The annotations file is re-read on every tool call so
 * humans and other agents can edit it concurrently.
 * @param dir review directory containing annotations.json
 * @throws when the directory has no annotations.json
 */
export function startMcpServer(
  dir: string,
  { input = process.stdin, output = process.stdout, log = msg => console.error(msg) }: McpServerOptions = {},
): { close: () => void } {
  const absDir = path.resolve(dir);
  if (!fs.existsSync(path.join(absDir, 'annotations.json'))) {
    throw new Error(`no annotations.json in ${absDir}`);
  }
  log(`nit mcp serving ${absDir}`);

  const rl = readline.createInterface({ input, terminal: false });
  const send: SendFn = msg => output.write(JSON.stringify(msg) + '\n');
  rl.on('line', line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: unknown;
    try { msg = JSON.parse(trimmed); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    handleMessage(absDir, msg, send);
  });
  return { close: () => rl.close() };
}

function handleMessage(dir: string, msg: JsonRpcMessage, send: SendFn): void {
  const { id, method, params } = msg;
  const reply = (result: object): void => { if (id !== undefined) send({ jsonrpc: '2.0', id, result }); };
  const fail = (code: number, message: string): void => { if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code, message } }); };
  try {
    if (method === 'initialize') {
      reply({
        protocolVersion: (typeof params?.protocolVersion === 'string' && params.protocolVersion) || PROTOCOL_FALLBACK,
        capabilities: { tools: {} },
        serverInfo: { name: 'nit', version: '0.2.0' },
      });
    } else if (typeof method === 'string' && method.startsWith('notifications/')) {
      // notifications need no response
    } else if (method === 'ping') {
      reply({});
    } else if (method === 'tools/list') {
      reply({ tools: TOOLS });
    } else if (method === 'tools/call') {
      reply(callTool(dir, params?.name, params?.arguments ?? {}));
    } else {
      fail(-32601, `method not found: ${String(method)}`);
    }
  } catch (e) {
    fail(-32603, errorMessage(e));
  }
}

function callTool(dir: string, name: unknown, args: Record<string, unknown>): ToolResult {
  // Reload per call: the file is shared with humans and other agents.
  const store = createStore(dir);
  try {
    if (name === 'list_annotations') return listAnnotations(store, args);
    if (name === 'get_annotation') return getAnnotation(dir, store, args);
    if (name === 'mark_fixed') return setStatus(store, { id: args.id, status: 'fixed' });
    if (name === 'set_status') return setStatus(store, args);
    if (name === 'set_issue_ref') return setIssueRef(store, args);
    return toolError(`unknown tool: ${String(name)}`);
  } catch (e) {
    return toolError(errorMessage(e));
  }
}

function listAnnotations(store: Store, { status, type, route }: Record<string, unknown>): ToolResult {
  const all = store.annotations.filter(a =>
    (!status || a.status === status)
    && (!type || a.type === type)
    // routes now carry query strings: accept an exact match or a path-only filter
    && (!route || a.route === route || routePath(a.route) === route));
  const summary = all.map(a => ({
    id: a.id,
    type: a.type,
    status: a.status,
    comment: a.comment,
    route: a.route,
    author: a.author,
    viewportScope: a.viewportScope,
    issueRef: a.issueRef,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    updatedBy: a.updatedBy,
    component: a.target?.component,
    ngComponent: a.target?.ngComponent,
    selector: a.target?.selector,
  }));
  const actionable = all.filter(a => a.type === 'change-request' && (a.status === 'open' || a.status === 'reopened')).length;
  return text(JSON.stringify({ review: store.data.review, total: summary.length, actionable, annotations: summary }, null, 2));
}

function getAnnotation(dir: string, store: Store, { id }: Record<string, unknown>): ToolResult {
  const ann = store.annotations.find(a => a.id === id);
  if (!ann) return toolError(`no annotation with id ${String(id)}`);
  const content: ToolContent[] = [{ type: 'text', text: JSON.stringify(ann, null, 2) }];
  for (const rel of [ann.screenshot, ann.screenshotAfter]) {
    // annotations.json is shared/agent-editable — never read outside the review dir
    const abs = safeShotPath(dir, rel);
    if (!abs) continue;
    try {
      content.push({
        type: 'image',
        data: fs.readFileSync(abs).toString('base64'),
        mimeType: 'image/png',
      });
    } catch { /* screenshot file missing — text is still useful */ }
  }
  return { content };
}

function setStatus(store: Store, { id, status }: Record<string, unknown>): ToolResult {
  if (!isAnnotationStatus(status)) return toolError(`invalid status: ${String(status)}`);
  if (typeof id !== 'string') return toolError('id must be a string');
  const changes: Partial<Annotation> = { status };
  if (status === 'verified' || status === 'reopened') changes.verifiedAt = new Date().toISOString();
  return writeAnnotation(store, id, changes);
}

function setIssueRef(store: Store, { id, ref }: Record<string, unknown>): ToolResult {
  if (typeof id !== 'string') return toolError('id must be a string');
  // The caller is a program over JSON-RPC, so a wrong type is a bug worth
  // reporting — coercing it would silently CLEAR the reference instead. Only the
  // documented empty string clears it.
  if (typeof ref !== 'string') return toolError('ref must be a string (use "" to clear it)');
  const value = ref.trim().slice(0, 200);
  return writeAnnotation(store, id, { issueRef: value || undefined });
}

/** Apply a change as the agent, persist, and keep the derived files in sync. */
function writeAnnotation(store: Store, id: string, changes: Partial<Annotation>): ToolResult {
  const ann = store.patch(id, changes, 'agent');
  if (!ann) return toolError(`no annotation with id ${id}`);
  store.flush();
  try {
    fs.writeFileSync(path.join(store.dir, 'review.md'), renderReviewMd(store.data), 'utf8');
    fs.writeFileSync(path.join(store.dir, 'fix-annotations.md'), FIX_ANNOTATIONS_MD, 'utf8');
  } catch { /* best effort */ }
  return text(JSON.stringify(ann, null, 2));
}

function text(t: string): ToolResult {
  return { content: [{ type: 'text', text: t }] };
}

function toolError(message: string): ToolResult {
  return { content: [{ type: 'text', text: `error: ${message}` }], isError: true };
}
