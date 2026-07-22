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
import { compressHistory } from './history.js';
import {
  getAnnotationInputShape,
  listInputShape,
  markFixedInputShape,
  setIssueRefInputShape,
  setStatusInputShape,
} from './schema.js';

// Hints shared by every tool: nit only ever touches the local review folder, so
// nothing here reaches into an open world, and repeating a call is always safe.
const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

/** How long a `statusReason` / `reason` may be before it is truncated. */
const REASON_MAX_LEN = 500;

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
    description: 'List the review\'s annotations as (nearly) full rows: id, type, status, comment, route, viewportScope, '
      + 'issueRef, statusReason, updatedAt, updatedBy, component, ngComponent, selector, classes, text, historyCount. '
      + 'historyCount is omitted when the annotation has no recorded history. '
      + 'Start here: the result reports the actionable count, and actionable means type "change-request" with status "open" or "reopened". '
      + 'Comments are context, not tasks. Filter by status, type, or route (exact route or bare pathname). '
      + 'nit_get_annotation is only needed beyond this for the screenshot, the click history, or the xpath.',
    inputSchema: listInputShape,
    annotations: READ_ONLY,
  }, args => guard(() => listAnnotations(createStore(dir), args)));

  server.registerTool('nit_get_annotation', {
    title: 'Get annotation',
    description: 'Get one or more annotations in full, including screenshot(s) as images and the click history (the reviewer\'s '
      + 'clicks that led to the annotated state, oldest first) when present. `id` accepts a single id or an array to batch several '
      + 'annotations in one call — for an array, unresolved ids come back in a `missing` field alongside whatever was found. '
      + 'Look at the screenshot: it shows the element in context and resolves most ambiguity. '
      + 'The target offers several ways to locate the element: component tag, Angular class name (ngComponent), a short CSS '
      + 'selector (verified unique at capture time, except its last-resort nth-of-type fallback form — treat it as a strong hint), '
      + 'and the element text. `target.xpath` is the most fragile locator and is omitted unless `includeXpath` is set. '
      + 'History is compressed for this call: self-clicks on the target and consecutive duplicate-selector clicks are removed, '
      + 'and it is capped at the last 5 steps; `historyCount` on the record is the original, uncompressed length.',
    inputSchema: getAnnotationInputShape,
    annotations: READ_ONLY,
  }, ({ id, includeXpath, includeScreenshot }) =>
    guard(() => getAnnotation(dir, createStore(dir), id, includeXpath, includeScreenshot)));

  server.registerTool('nit_mark_fixed', {
    title: 'Mark fixed',
    description: 'Mark an annotation as fixed. Call this once per annotation, after making the change it describes; a human '
      + 'verifies (or reopens) it later with nit verify. An optional reason is persisted on the annotation as statusReason.',
    inputSchema: markFixedInputShape,
    annotations: WRITE,
  }, ({ id, reason }) => guard(() => setStatus(createStore(dir), id, 'fixed', reason)));

  server.registerTool('nit_set_status', {
    title: 'Set status',
    description: 'Set an annotation status explicitly (open | fixed | wontfix | verified | reopened). '
      + 'Prefer nit_mark_fixed for the normal case. Use wontfix, with your reasoning in `reason`, when a requested change should '
      + 'not be made; leave verified/reopened rulings to humans. `reason` is persisted on the annotation as statusReason so the '
      + 'next session does not re-litigate it — every status change replaces it, and omitting `reason` clears it.',
    inputSchema: setStatusInputShape,
    annotations: WRITE,
  }, ({ id, status, reason }) => guard(() => setStatus(createStore(dir), id, status, reason)));

  server.registerTool('nit_set_issue_ref', {
    title: 'Set issue reference',
    description: 'Attach a tracker issue key (e.g. PROJ-123) or url to an annotation; an empty string clears it. Use it to link an annotation to the ticket or PR that covers it.',
    inputSchema: setIssueRefInputShape,
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

/** The row `nit_list_annotations` returns per annotation. */
interface AnnotationRow {
  id: string;
  type: Annotation['type'];
  status: Annotation['status'];
  comment: string;
  route: string;
  viewportScope: Annotation['viewportScope'];
  issueRef: string | undefined;
  statusReason: string | undefined;
  updatedAt: string | undefined;
  updatedBy: string | undefined;
  component: string | undefined;
  ngComponent: string | null | undefined;
  selector: string | undefined;
  classes: string[] | undefined;
  text: string | undefined;
  historyCount: number | undefined;
}

/**
 * The list summary's historyCount: the raw trail length, or omitted for no/empty history.
 * A hand-edited `history: []` must read the same as absent history — matching
 * nit_get_annotation, which never emits `historyCount: 0` (see `buildAnnotationRecord`).
 */
function summaryHistoryCount(history: Annotation['history']): number | undefined {
  if (!history || history.length === 0) return undefined;
  return history.length;
}

function listAnnotations(store: Store, { status, type, route }: {
  status?: AnnotationStatus;
  type?: Annotation['type'];
  route?: string;
}): CallToolResult {
  // No filter given → the caller is reading the whole review, so the envelope
  // is worth the review metadata; a filtered call already knows what it asked
  // for, and repeating `review` on every page of results is pure waste.
  const unfiltered = !status && !type && !route;
  const all = store.annotations.filter(a =>
    (!status || a.status === status)
    && (!type || a.type === type)
    // routes now carry query strings: accept an exact match or a path-only filter
    && (!route || a.route === route || routePath(a.route) === route));
  const annotations: AnnotationRow[] = all.map(a => ({
    id: a.id,
    type: a.type,
    status: a.status,
    comment: a.comment,
    route: a.route,
    viewportScope: a.viewportScope,
    issueRef: a.issueRef,
    statusReason: a.statusReason,
    updatedAt: a.updatedAt,
    updatedBy: a.updatedBy,
    component: a.target?.component,
    ngComponent: a.target?.ngComponent,
    selector: a.target?.selector,
    classes: a.target?.classes,
    text: a.target?.text,
    // reproduction-trail length; the (compressed) trail comes with nit_get_annotation
    historyCount: summaryHistoryCount(a.history),
  }));
  const actionable = all.filter(isActionable).length;
  return structured({
    ...(unfiltered ? { review: store.data.review } : {}),
    total: annotations.length,
    actionable,
    annotations,
  });
}

/** An annotation as returned to the client: `target` lean, `history` compressed. */
type AnnotationRecord = Omit<Annotation, 'target' | 'history'> & {
  target?: Partial<Annotation['target']>;
  history?: ReturnType<typeof compressHistory>;
  historyCount?: number;
};

/**
 * Copy an annotation for the wire: drop `target.xpath` unless requested, and
 * replace `history` with its compressed form, keeping the original length as
 * `historyCount` when there was history to begin with. Never mutates `a`.
 */
function buildAnnotationRecord(a: Annotation, includeXpath: boolean): AnnotationRecord {
  const { target, history, ...rest } = a;
  const compressed = compressHistory(history, target?.selector);
  return {
    ...rest,
    target: target ? (includeXpath ? { ...target } : omitXpath(target)) : target,
    history: compressed.length ? compressed : undefined,
    historyCount: Array.isArray(history) && history.length > 0 ? history.length : undefined,
  };
}

/** Drop the most fragile locator — `target.xpath` — from a copy of the target. */
function omitXpath(target: Annotation['target']): Partial<Annotation['target']> {
  return {
    component: target.component,
    ngComponent: target.ngComponent,
    selector: target.selector,
    tag: target.tag,
    classes: target.classes,
    text: target.text,
    rect: target.rect,
  };
}

/** Drop repeats, keeping first-occurrence order — a batch get must not double-charge tokens (and screenshot bytes) for a repeated id. */
function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}

function getAnnotation(
  dir: string,
  store: Store,
  id: string | string[],
  includeXpath: boolean,
  includeScreenshot: boolean,
): CallToolResult {
  const ids = Array.isArray(id) ? dedupe(id) : [id];
  const found: Annotation[] = [];
  const missing: string[] = [];
  for (const oneId of ids) {
    const ann = store.annotations.find(a => a.id === oneId);
    if (ann) found.push(ann);
    else missing.push(oneId);
  }

  if (found.length === 0) {
    return toolError(`no annotation with id ${Array.isArray(id) ? missing.join(', ') : id}`);
  }

  const records = found.map(a => buildAnnotationRecord(a, includeXpath));
  const payload: Record<string, unknown> = Array.isArray(id)
    ? { annotations: records, ...(missing.length ? { missing } : {}) }
    : { annotation: records[0] };
  const result = structured(payload);

  if (includeScreenshot) {
    for (const ann of found) {
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
    }
  }
  return result;
}

/** Trim and cap a persisted free-form reason; empty/absent input clears the field. */
function normalizeReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined;
  const trimmed = reason.trim().slice(0, REASON_MAX_LEN);
  return trimmed || undefined;
}

function setStatus(store: Store, id: string, status: AnnotationStatus, reason: string | undefined): CallToolResult {
  // Every status change replaces statusReason outright (an absent reason clears
  // it), so a stale wontfix rationale never survives a later reopen/fix.
  const changes: Partial<Annotation> = { status, statusReason: normalizeReason(reason) };
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
 * A result carrying the payload as compact JSON text. MCP clients (Claude Code
 * included) render the text, not `structuredContent` — shipping both doubles
 * the wire cost for nothing, and the spec only calls for `structuredContent`
 * when the tool declares an `outputSchema`, which these tools deliberately do
 * not (see schema.ts).
 */
function structured(payload: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function toolError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: `error: ${message}` }], isError: true };
}
