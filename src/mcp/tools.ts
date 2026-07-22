// SPDX-License-Identifier: AGPL-3.0-or-later
// The five nit tools, registered on an McpServer. Tool names carry a `nit_`
// prefix so they stay unambiguous next to other MCP servers' tools in an agent's
// combined tool list.
import fs from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createStore, safeShotPath } from '../store/store.js';
import type { Store } from '../store/store.js';
import { renderReviewMd, FIX_ANNOTATIONS_MD } from '../store/render.js';
import { isActionable } from '../store/stats.js';
import { errorMessage } from '../util/error.js';
import { routePath } from '../util/route.js';
import type { Annotation, AnnotationStatus } from '../types.js';
import {
  annotationOutputShape,
  idInputShape,
  listInputShape,
  listOutputShape,
  setIssueRefInputShape,
  setStatusInputShape,
} from './schema.js';

// Hints shared by every tool: nit only ever touches the local review folder, so
// nothing here reaches into an open world, and repeating a call is always safe.
const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

/**
 * Register the nit tools against a review directory. Handlers open the store per
 * call: the file is shared with humans (the panel) and other agents, so it is
 * re-read rather than cached.
 * @param server the MCP server to register on
 * @param dir review directory containing annotations.json
 */
export function registerTools(server: McpServer, dir: string): void {
  server.registerTool('nit_list_annotations', {
    title: 'List annotations',
    description: 'List the review\'s annotations as summaries (id, comment, status, route, component, selector, historyCount, ...). '
      + 'Start here: the result reports the actionable count, and actionable means type "change-request" with status "open" or "reopened". '
      + 'Comments are context, not tasks. Filter by status, type, or route (exact route or bare pathname). '
      + 'Follow up with nit_get_annotation for anything you intend to fix.',
    inputSchema: listInputShape,
    outputSchema: listOutputShape,
    annotations: READ_ONLY,
  }, args => guard(() => listAnnotations(createStore(dir), args)));

  server.registerTool('nit_get_annotation', {
    title: 'Get annotation',
    description: 'Get one annotation in full, including its screenshot(s) as images and the click history (the reviewer\'s clicks that led to the annotated state, oldest first) when present. '
      + 'Look at the screenshot: it shows the element in context and resolves most ambiguity. '
      + 'The target offers several ways to locate the element: component tag, Angular class name (ngComponent), a verified-unique CSS selector, an XPath, and the element text.',
    inputSchema: idInputShape,
    outputSchema: annotationOutputShape,
    annotations: READ_ONLY,
  }, ({ id }) => guard(() => getAnnotation(dir, createStore(dir), id)));

  server.registerTool('nit_mark_fixed', {
    title: 'Mark fixed',
    description: 'Mark an annotation as fixed. Call this once per annotation, after making the change it describes; a human verifies (or reopens) it later with nit verify.',
    inputSchema: idInputShape,
    outputSchema: annotationOutputShape,
    annotations: WRITE,
  }, ({ id }) => guard(() => setStatus(createStore(dir), id, 'fixed')));

  server.registerTool('nit_set_status', {
    title: 'Set status',
    description: 'Set an annotation status explicitly (open | fixed | wontfix | verified | reopened). '
      + 'Prefer nit_mark_fixed for the normal case. Use wontfix, with your reasoning in the conversation, when a requested change should not be made; leave verified/reopened rulings to humans.',
    inputSchema: setStatusInputShape,
    outputSchema: annotationOutputShape,
    annotations: WRITE,
  }, ({ id, status }) => guard(() => setStatus(createStore(dir), id, status)));

  server.registerTool('nit_set_issue_ref', {
    title: 'Set issue reference',
    description: 'Attach a tracker issue key (e.g. PROJ-123) or url to an annotation; an empty string clears it. Use it to link an annotation to the ticket or PR that covers it.',
    inputSchema: setIssueRefInputShape,
    outputSchema: annotationOutputShape,
    annotations: WRITE,
  }, ({ id, ref }) => guard(() => setIssueRef(createStore(dir), id, ref)));
}

/** Run a handler, reporting a thrown error to the agent instead of the client. */
function guard(run: () => CallToolResult): CallToolResult {
  try {
    return run();
  } catch (e) {
    return toolError(errorMessage(e));
  }
}

function listAnnotations(store: Store, { status, type, route }: {
  status?: AnnotationStatus;
  type?: Annotation['type'];
  route?: string;
}): CallToolResult {
  const all = store.annotations.filter(a =>
    (!status || a.status === status)
    && (!type || a.type === type)
    // routes now carry query strings: accept an exact match or a path-only filter
    && (!route || a.route === route || routePath(a.route) === route));
  const annotations = all.map(a => ({
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
  const actionable = all.filter(isActionable).length;
  return structured({ review: store.data.review, total: annotations.length, actionable, annotations });
}

function getAnnotation(dir: string, store: Store, id: string): CallToolResult {
  const ann = store.annotations.find(a => a.id === id);
  if (!ann) return toolError(`no annotation with id ${id}`);
  const result = structured({ annotation: ann });
  for (const rel of [ann.screenshot, ann.screenshotAfter]) {
    // annotations.json is shared/agent-editable — never read outside the review dir
    const abs = safeShotPath(dir, rel);
    if (!abs) continue;
    try {
      result.content.push({
        type: 'image',
        data: fs.readFileSync(abs).toString('base64'),
        mimeType: 'image/png',
      });
    } catch { /* screenshot file missing — text is still useful */ }
  }
  return result;
}

function setStatus(store: Store, id: string, status: AnnotationStatus): CallToolResult {
  const changes: Partial<Annotation> = { status };
  if (status === 'verified' || status === 'reopened') changes.verifiedAt = new Date().toISOString();
  return writeAnnotation(store, id, changes);
}

function setIssueRef(store: Store, id: string, ref: string): CallToolResult {
  const value = ref.trim().slice(0, 200);
  return writeAnnotation(store, id, { issueRef: value || undefined });
}

/** Apply a change as the agent, persist, and keep the derived files in sync. */
function writeAnnotation(store: Store, id: string, changes: Partial<Annotation>): CallToolResult {
  const ann = store.patch(id, changes, 'agent');
  if (!ann) return toolError(`no annotation with id ${id}`);
  store.flush();
  try {
    fs.writeFileSync(path.join(store.dir, 'review.md'), renderReviewMd(store.data), 'utf8');
    fs.writeFileSync(path.join(store.dir, 'fix-annotations.md'), FIX_ANNOTATIONS_MD, 'utf8');
  } catch { /* best effort */ }
  return structured({ annotation: ann });
}

/**
 * A result carrying the payload twice: as `structuredContent` for clients that
 * read tool output schemas, and as pretty JSON text for those that don't.
 */
function structured(payload: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
}

function toolError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: `error: ${message}` }], isError: true };
}
