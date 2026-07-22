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

// Tool names carry a `nit_` prefix so they stay unambiguous next to other MCP
// servers' tools in an agent's combined tool list.
const TOOLS = [
  {
    name: 'nit_list_annotations',
    description: 'List the review\'s annotations as summaries (id, comment, status, route, component, selector, historyCount, ...). '
      + 'Start here: the result reports the actionable count, and actionable means type "change-request" with status "open" or "reopened". '
      + 'Comments are context, not tasks. Filter by status, type, or route (exact route or bare pathname). '
      + 'Follow up with nit_get_annotation for anything you intend to fix.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: STATUSES, description: 'only annotations with this status' },
        type: { type: 'string', enum: ['change-request', 'comment'], description: 'only this annotation type' },
        route: { type: 'string', description: 'only annotations on this route; an exact route or a bare pathname like /products' },
      },
    },
  },
  {
    name: 'nit_get_annotation',
    description: 'Get one annotation in full, including its screenshot(s) as images and the click history (the reviewer\'s clicks that led to the annotated state, oldest first) when present. '
      + 'Look at the screenshot: it shows the element in context and resolves most ambiguity. '
      + 'The target offers several ways to locate the element: component tag, Angular class name (ngComponent), a verified-unique CSS selector, an XPath, and the element text.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'annotation id, e.g. a1' } },
      required: ['id'],
    },
  },
  {
    name: 'nit_mark_fixed',
    description: 'Mark an annotation as fixed. Call this once per annotation, after making the change it describes; a human verifies (or reopens) it later with nit verify.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'annotation id, e.g. a1' } },
      required: ['id'],
    },
  },
  {
    name: 'nit_set_status',
    description: 'Set an annotation status explicitly (open | fixed | wontfix | verified | reopened). '
      + 'Prefer nit_mark_fixed for the normal case. Use wontfix, with your reasoning in the conversation, when a requested change should not be made; leave verified/reopened rulings to humans.',
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
    name: 'nit_set_issue_ref',
    description: 'Attach a tracker issue key (e.g. PROJ-123) or url to an annotation; an empty string clears it. Use it to link an annotation to the ticket or PR that covers it.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        ref: { type: 'string', description: 'tracker key or url; empty string clears' },
      },
      required: ['id', 'ref'],
    },
  },
];

// Sent with the initialize result; MCP clients surface this to the agent as
// standing guidance for the whole server.
const INSTRUCTIONS = 'This server exposes a nit review: UI annotations a human reviewer made on a live website, '
  + 'each pinned to a concrete element. Typical flow: nit_list_annotations to see what is actionable '
  + '(change-requests with status open or reopened), nit_get_annotation for each one you work on '
  + '(read the screenshot and, when present, the click history to reproduce the state), make the fix '
  + 'in the source code, then nit_mark_fixed. Treat comment-type annotations as context, never as tasks. '
  + 'If a change should not be made, set status wontfix instead of forcing it. '
  + 'Humans verify fixes afterwards; reopened items come back as actionable.';

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
        serverInfo: { name: 'nit', version: '1.0.0' },
        instructions: INSTRUCTIONS,
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
    if (name === 'nit_list_annotations') return listAnnotations(store, args);
    if (name === 'nit_get_annotation') return getAnnotation(dir, store, args);
    if (name === 'nit_mark_fixed') return setStatus(store, { id: args.id, status: 'fixed' });
    if (name === 'nit_set_status') return setStatus(store, args);
    if (name === 'nit_set_issue_ref') return setIssueRef(store, args);
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
    // reproduction-trail length; the full trail comes with nit_get_annotation
    historyCount: a.history?.length,
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
