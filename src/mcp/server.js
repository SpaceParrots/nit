// Minimal MCP (Model Context Protocol) stdio server wrapping a nit review directory.
// SPEC §3: stable ids + status are exactly what this thin wrapper needs — the schema
// ships unchanged. Newline-delimited JSON-RPC 2.0 over stdio, stdlib only.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createStore, safeShotPath } from '../store/store.js';
import { renderReviewMd, FIX_ANNOTATIONS_MD } from '../store/render.js';

const PROTOCOL_FALLBACK = '2024-11-05';
const STATUSES = ['open', 'fixed', 'wontfix', 'verified', 'reopened'];

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
];

/**
 * Start the MCP stdio server over a review directory. Speaks newline-delimited
 * JSON-RPC 2.0 on the given streams (never writes logs to stdout — that's the
 * protocol channel). The annotations file is re-read on every tool call so
 * humans and other agents can edit it concurrently.
 * @param {string} dir review directory containing annotations.json
 * @param {object} [opts]
 * @param {import('node:stream').Readable} [opts.input] protocol input (default process.stdin)
 * @param {import('node:stream').Writable} [opts.output] protocol output (default process.stdout)
 * @param {(msg: string) => void} [opts.log] diagnostics sink (default stderr)
 * @returns {{close: () => void}}
 * @throws when the directory has no annotations.json
 */
export function startMcpServer(dir, { input = process.stdin, output = process.stdout, log = msg => console.error(msg) } = {}) {
  const absDir = path.resolve(dir);
  if (!fs.existsSync(path.join(absDir, 'annotations.json'))) {
    throw new Error(`no annotations.json in ${absDir}`);
  }
  log(`nit mcp serving ${absDir}`);

  const rl = readline.createInterface({ input, terminal: false });
  const send = msg => output.write(JSON.stringify(msg) + '\n');
  rl.on('line', line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try { msg = JSON.parse(trimmed); } catch { return; }
    handleMessage(absDir, msg, send);
  });
  return { close: () => rl.close() };
}

function handleMessage(dir, msg, send) {
  const { id, method, params } = msg;
  const reply = result => { if (id !== undefined) send({ jsonrpc: '2.0', id, result }); };
  const fail = (code, message) => { if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code, message } }); };
  try {
    if (method === 'initialize') {
      reply({
        protocolVersion: (params && params.protocolVersion) || PROTOCOL_FALLBACK,
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
      reply(callTool(dir, params && params.name, (params && params.arguments) || {}));
    } else {
      fail(-32601, `method not found: ${method}`);
    }
  } catch (e) {
    fail(-32603, e.message);
  }
}

function callTool(dir, name, args) {
  // Reload per call: the file is shared with humans and other agents.
  const store = createStore(dir);
  try {
    if (name === 'list_annotations') return listAnnotations(store, args);
    if (name === 'get_annotation') return getAnnotation(dir, store, args);
    if (name === 'mark_fixed') return setStatus(store, { id: args.id, status: 'fixed' });
    if (name === 'set_status') return setStatus(store, args);
    return toolError(`unknown tool: ${name}`);
  } catch (e) {
    return toolError(e.message);
  }
}

function listAnnotations(store, { status, type, route }) {
  const all = store.annotations.filter(a =>
    (!status || a.status === status)
    && (!type || a.type === type)
    && (!route || a.route === route));
  const summary = all.map(a => ({
    id: a.id,
    type: a.type,
    status: a.status,
    comment: a.comment,
    route: a.route,
    author: a.author,
    viewportScope: a.viewportScope,
    component: a.target && a.target.component,
    ngComponent: a.target && a.target.ngComponent,
    selector: a.target && a.target.selector,
  }));
  const actionable = all.filter(a => a.type === 'change-request' && (a.status === 'open' || a.status === 'reopened')).length;
  return text(JSON.stringify({ review: store.data.review, total: summary.length, actionable, annotations: summary }, null, 2));
}

function getAnnotation(dir, store, { id }) {
  const ann = store.annotations.find(a => a.id === id);
  if (!ann) return toolError(`no annotation with id ${id}`);
  const content = [{ type: 'text', text: JSON.stringify(ann, null, 2) }];
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

function setStatus(store, { id, status }) {
  if (!STATUSES.includes(status)) return toolError(`invalid status: ${status}`);
  const ann = store.annotations.find(a => a.id === id);
  if (!ann) return toolError(`no annotation with id ${id}`);
  ann.status = status;
  if (status === 'verified' || status === 'reopened') ann.verifiedAt = new Date().toISOString();
  store.flush();
  // keep the human-readable artifacts in sync
  try {
    fs.writeFileSync(path.join(store.dir, 'review.md'), renderReviewMd(store.data), 'utf8');
    fs.writeFileSync(path.join(store.dir, 'fix-annotations.md'), FIX_ANNOTATIONS_MD, 'utf8');
  } catch { /* best effort */ }
  return text(JSON.stringify(ann, null, 2));
}

function text(t) {
  return { content: [{ type: 'text', text: t }] };
}

function toolError(message) {
  return { content: [{ type: 'text', text: `error: ${message}` }], isError: true };
}
