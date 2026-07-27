// SPDX-License-Identifier: AGPL-3.0-or-later
// The five nit tools, registered on an McpServer. Tool names carry a `nit_`
// prefix so they stay unambiguous next to other MCP servers' tools in an agent's
// combined tool list.
import fs from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createStore, safeShotPath } from '../store/store.js';
import { writeDerivedFiles } from '../store/derived.js';
import { clearBase } from '../store/clear.js';
import { isActionable } from '../store/stats.js';
import { resolveAnnotationUrl } from '../store/url.js';
import { errorMessage } from '../util/error.js';
import { routePath } from '../util/route.js';
import type { Annotation, AnnotationStatus } from '../types.js';
import { basesOf, baseSummaries, displayId, isMultiBase, resolveAnnotation } from './aggregate.js';
import type { Located } from './aggregate.js';
import { compressHistory } from './history.js';
import {
  clearVerifiedInputShape,
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
// The one tool that deletes. Clearing *unruled* feedback stays CLI-only, behind
// a confirmation prompt: an agent must not be able to remove human feedback
// nobody has ruled on yet.
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;

/** How long a `statusReason` / `reason` may be before it is truncated. */
const REASON_MAX_LEN = 500;

/**
 * Register the nit tools against a review directory. Handlers open the store per
 * call: the file is shared with humans (the panel) and other agents, so it is
 * re-read rather than cached.
 *
 * The directory may be a plain review folder or a workspace holding one review
 * folder per base URL; the tools present both as one review, qualifying ids as
 * `<base>:<id>` only when there really is more than one base (see
 * `aggregate.ts`).
 * @param server the MCP server to register on
 * @param dir review directory, or a workspace of base folders
 */
export function registerTools(server: McpServer, dir: string): void {
  server.registerTool('nit_list_annotations', {
    title: 'List annotations',
    description: 'List the review\'s annotations as (nearly) full rows: id, type, status, comment, route, viewportScope, '
      + 'issueRef, statusReason, updatedAt, updatedBy, component, ngComponent, selector, classes, text, historyCount. '
      + 'historyCount is omitted when the annotation has no recorded history. '
      + 'Start here: the result reports the actionable count, and actionable means type "change-request" with status "open" or "reopened". '
      + 'Comments are context, not tasks. Filter by status, type, route (exact route or bare pathname), or base. '
      + 'When the review covers several base URLs, every row carries its base and the navigable url, ids come back '
      + 'qualified as "<base>:<id>", and the result lists the bases with their counts. '
      + 'nit_get_annotation is only needed beyond this for the screenshot, the click history, or the xpath.',
    inputSchema: listInputShape,
    annotations: READ_ONLY,
  }, args => guard(() => listAnnotations(dir, args)));

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
    guard(() => getAnnotation(dir, id, includeXpath, includeScreenshot)));

  server.registerTool('nit_mark_fixed', {
    title: 'Mark fixed',
    description: 'Mark an annotation as fixed. Call this once per annotation, after making the change it describes; a human '
      + 'verifies (or reopens) it later with nit verify. An optional reason is persisted on the annotation as statusReason.',
    inputSchema: markFixedInputShape,
    annotations: WRITE,
  }, ({ id, reason }) => guard(() => setStatus(dir, id, 'fixed', reason)));

  server.registerTool('nit_set_status', {
    title: 'Set status',
    description: 'Set an annotation status explicitly (open | fixed | wontfix | verified | reopened). '
      + 'Prefer nit_mark_fixed for the normal case. Use wontfix, with your reasoning in `reason`, when a requested change should '
      + 'not be made; leave verified/reopened rulings to humans. `reason` is persisted on the annotation as statusReason so the '
      + 'next session does not re-litigate it — every status change replaces it, and omitting `reason` clears it.',
    inputSchema: setStatusInputShape,
    annotations: WRITE,
  }, ({ id, status, reason }) => guard(() => setStatus(dir, id, status, reason)));

  server.registerTool('nit_set_issue_ref', {
    title: 'Set issue reference',
    description: 'Attach a tracker issue key (e.g. PROJ-123) or url to an annotation; an empty string clears it. Use it to link an annotation to the ticket or PR that covers it.',
    inputSchema: setIssueRefInputShape,
    annotations: WRITE,
  }, ({ id, ref }) => guard(() => setIssueRef(dir, id, ref)));

  server.registerTool('nit_clear_verified', {
    title: 'Clear verified annotations',
    description: 'Delete the annotations a human has already ruled "verified" — housekeeping after a fix round, once the '
      + 'work they describe is done and confirmed. Their screenshots are deleted with them. Everything else is left alone: '
      + 'open, reopened, fixed and wontfix annotations are never touched, and the review folder and its metadata survive. '
      + 'Omit `base` to sweep every base URL, or name one to clear a single environment. This cannot be undone.',
    inputSchema: clearVerifiedInputShape,
    annotations: DESTRUCTIVE,
  }, ({ base }) => guard(() => clearVerified(dir, base)));
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
  /** the owning base's slug; only on a review that covers several base URLs */
  base?: string;
  /** the navigable page this annotation sits on; alongside {@link AnnotationRow.base} */
  url?: string;
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

/** One annotation as a list row; base-specific columns are added by the caller. */
function toRow(a: Annotation): AnnotationRow {
  return {
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
  };
}

/**
 * List the review's annotations, across every base or within one.
 * @param dir the review directory or workspace
 * @param filters status/type/route narrow the annotations; base narrows the
 *   environments (a slug, a url, or an unambiguous prefix)
 * @throws when `base` names no base — reported to the agent by {@link guard}
 */
function listAnnotations(dir: string, { status, type, route, base }: {
  status?: AnnotationStatus;
  type?: Annotation['type'];
  route?: string;
  base?: string;
}): CallToolResult {
  const multi = isMultiBase(dir);
  const refs = basesOf(dir, base);
  // No filter given → the caller is reading the whole review, so the envelope
  // is worth the review metadata; a filtered call already knows what it asked
  // for, and repeating `review` on every page of results is pure waste.
  const unfiltered = !status && !type && !route && !base;

  const annotations: AnnotationRow[] = [];
  let actionable = 0;
  for (const ref of refs) {
    for (const a of createStore(ref.dir).annotations) {
      if (status && a.status !== status) continue;
      if (type && a.type !== type) continue;
      // routes carry query strings: accept an exact match or a path-only filter
      if (route && a.route !== route && routePath(a.route) !== route) continue;
      if (isActionable(a)) actionable += 1;
      annotations.push({
        ...toRow(a),
        id: displayId(multi, ref.slug, a.id),
        // the base and the navigable page, so an agent never has to reassemble
        // them; resolveAnnotationUrl keeps a crafted route on the base's origin
        ...(multi ? { base: ref.slug, url: resolveAnnotationUrl(ref.url, a.route) ?? a.route } : {}),
      });
    }
  }

  return structured({
    // A single-base review keeps the review envelope it has always had; a
    // workspace reports its bases instead, since there is no single review.
    ...(multi
      ? { bases: baseSummaries(dir, base) }
      : unfiltered && refs.length ? { review: createStore(refs[0].dir).data.review } : {}),
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

/**
 * Fetch one or more annotations in full. Ids may be qualified (`staging:a1`) or
 * bare; each is resolved to the base that owns it, and screenshots are read from
 * that base's own folder.
 * @param dir the review directory or workspace
 * @param id one id, or an array to batch
 * @param includeXpath keep the fragile `target.xpath` locator
 * @param includeScreenshot attach the before/after shots as image content
 */
function getAnnotation(
  dir: string,
  id: string | string[],
  includeXpath: boolean,
  includeScreenshot: boolean,
): CallToolResult {
  const multi = isMultiBase(dir);
  const ids = Array.isArray(id) ? dedupe(id) : [id];
  const found: Located[] = [];
  const missing: string[] = [];
  // one line per unresolved id, so a batch says *why* each one failed rather
  // than lumping "ambiguous" in with "no such id"
  const problems: string[] = [];
  for (const oneId of ids) {
    const resolved = resolveAnnotation(dir, oneId);
    if (resolved.ok) found.push(resolved.hit);
    else {
      missing.push(oneId);
      problems.push(resolved.error);
    }
  }

  if (found.length === 0) return toolError(problems.join('; '));

  const records = found.map(({ base, annotation }) => ({
    ...buildAnnotationRecord(annotation, includeXpath),
    id: displayId(multi, base.slug, annotation.id),
    ...(multi ? { base: base.slug, url: resolveAnnotationUrl(base.url, annotation.route) ?? annotation.route } : {}),
  }));
  const payload: Record<string, unknown> = Array.isArray(id)
    ? { annotations: records, ...(missing.length ? { missing } : {}) }
    : { annotation: records[0] };
  const result = structured(payload);

  if (includeScreenshot) {
    for (const { base, annotation } of found) {
      for (const rel of [annotation.screenshot, annotation.screenshotAfter]) {
        // annotations.json is shared/agent-editable — never read outside the
        // base's own review dir
        const abs = safeShotPath(base.dir, rel);
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

function setStatus(dir: string, id: string, status: AnnotationStatus, reason: string | undefined): CallToolResult {
  // Every status change replaces statusReason outright (an absent reason clears
  // it), so a stale wontfix rationale never survives a later reopen/fix.
  const changes: Partial<Annotation> = { status, statusReason: normalizeReason(reason) };
  if (status === 'verified' || status === 'reopened') changes.verifiedAt = new Date().toISOString();
  return writeAnnotation(dir, id, changes);
}

function setIssueRef(dir: string, id: string, ref: string): CallToolResult {
  const value = ref.trim().slice(0, 200);
  return writeAnnotation(dir, id, { issueRef: value || undefined });
}

/**
 * Apply a change as the agent, persist it in the base that owns the annotation,
 * and keep that base's derived files in sync. The echoed id is qualified exactly
 * as the list rows are, so an agent can feed it straight back.
 * @param dir the review directory or workspace
 * @param id the id as it arrived — qualified or bare
 * @param changes the fields to overwrite
 */
function writeAnnotation(dir: string, id: string, changes: Partial<Annotation>): CallToolResult {
  const resolved = resolveAnnotation(dir, id);
  // an id matching several bases is refused, not guessed — see resolveAnnotation
  if (!resolved.ok) return toolError(resolved.error);
  const hit = resolved.hit;
  // patch by the id on disk, never by the qualified form the caller passed
  const ann = hit.store.patch(hit.annotation.id, changes, 'agent');
  if (!ann) return toolError(`no annotation with id ${id}`);
  hit.store.flush();
  writeDerivedFiles(hit.store);
  return structured({ annotation: { ...ann, id: displayId(isMultiBase(dir), hit.base.slug, ann.id) } });
}

/**
 * Clear the verified annotations of one base, or of every base. Only `verified`
 * is ever removed here — an agent must not be able to delete feedback a human
 * has not ruled on yet; that is what `nit clear` (with its prompt) is for.
 * @param dir the review directory or workspace
 * @param base optional base to limit the sweep to
 * @throws when `base` names no base — reported to the agent by {@link guard}
 */
function clearVerified(dir: string, base: string | undefined): CallToolResult {
  const results = basesOf(dir, base).map(ref => clearBase(ref, { status: 'verified' }));
  return structured({
    cleared: results.reduce((n, r) => n + r.cleared, 0),
    remaining: results.reduce((n, r) => n + r.remaining, 0),
    bases: results.map(r => ({ slug: r.slug, cleared: r.cleared, remaining: r.remaining })),
  });
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
