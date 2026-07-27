// SPDX-License-Identifier: AGPL-3.0-or-later
// nit status — a quick read on a review folder: where the file is, when it last
// changed, how many annotations there are and how much work is left. Read-only:
// unlike the store, it never creates, normalizes or backs up anything.
import fs from 'node:fs';
import path from 'node:path';
import { resolveReviewFile } from '../store/store.js';
import { openWorkspace, resolveBase } from '../store/workspace.js';
import { reviewStats } from '../store/stats.js';
import type { ReviewStats } from '../store/stats.js';
import { errorMessage } from '../util/error.js';
import type {
  AnnotationStatus, AnnotationType, BaseRef, ReviewData, Workspace,
} from '../types.js';

/** Statuses in lifecycle order, so the report always reads the same way. */
const STATUS_ORDER: readonly AnnotationStatus[] = ['open', 'reopened', 'fixed', 'verified', 'wontfix'];
/** Routes listed inline before the rest is summarized as "+N more". */
const ROUTES_SHOWN = 4;

/** Options for {@link runStatus}. */
export interface StatusOptions {
  /** only this base — a slug, a url, or an unambiguous prefix */
  base?: string;
  /** print the stats as JSON instead of a report (for scripts and CI) */
  json?: boolean;
  /** log sink */
  log?: (line: string) => void;
  /** clock override for the relative "… ago" hint (default now) */
  now?: Date;
}

/**
 * Report on a review folder. The annotations file is only read, so running this
 * against a review someone else is editing is always safe.
 *
 * A workspace holding several base URLs reports one line per base plus the
 * totals; naming one with `base` reports that base exactly as a single review
 * has always been reported.
 * @param input review directory, workspace directory, or the path of an
 *   annotations.json inside one
 * @param opts see {@link StatusOptions}
 * @returns the same stats that were printed
 * @throws when there is no annotations.json, when it cannot be parsed, or when
 *   `base` names no base in the workspace (via {@link resolveBase})
 */
export function runStatus(
  input = 'nit-review',
  { base, json = false, log = line => console.log(line), now = new Date() }: StatusOptions = {},
): ReviewStats {
  // A workspace holds one review folder per base url. Resolve which review this
  // report is about before falling through to the single-review path below.
  const ws = openWorkspace(input);
  // A named base always reports as a plain single review — the same lines, for
  // one environment. It must resolve whatever the layout is, so a typo'd
  // `--base prod` fails by name instead of silently reporting everything.
  if (base) return runStatus(resolveBase(ws, base).dir, { json, log, now });
  if (ws.layout === 'multi') return reportWorkspace(ws, ws.bases, { json, log, now });

  const { dir, file, exists } = resolveReviewFile(input);
  if (!exists) {
    throw new Error(`no annotations.json in ${dir} — nothing to report (run: nit review <url>)`);
  }
  let data: ReviewData;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8')) as ReviewData;
  } catch (e) {
    throw new Error(`${file} is not readable as JSON (${errorMessage(e)})`, { cause: e });
  }

  const stats = reviewStats(data, file);
  if (json) {
    log(JSON.stringify(stats, null, 2));
  } else {
    for (const line of report(stats, now)) log(line);
  }
  return stats;
}

/**
 * Report on a workspace: one line per base, then the totals. The returned stats
 * carry the same fields a single review does — summed across the bases — plus a
 * `bases` breakdown, so a `--json` consumer sees one familiar object either way.
 * @param ws the workspace being reported on
 * @param bases the bases to report (every one of them today)
 * @param opts json/log/now, threaded from {@link runStatus}
 * @returns the aggregate stats that were printed
 */
function reportWorkspace(
  ws: Workspace,
  bases: BaseRef[],
  { json, log, now }: { json: boolean; log: (line: string) => void; now: Date },
): ReviewStats {
  const per = bases.map(ref => ({ ref, stats: reviewStats(readReviewData(ref.file), ref.file) }));
  const aggregate = aggregateStats(ws.dir, per);

  if (json) {
    log(JSON.stringify(aggregate, null, 2));
    return aggregate;
  }

  log(`nit status — ${displayPath(ws.dir)}`);
  log('');
  for (const { ref, stats } of per) {
    log(row(ref.slug, [
      ref.url,
      `${stats.total} annotation${stats.total === 1 ? '' : 's'}`,
      `${stats.actionable} actionable`,
      stats.lastChange ? ago(stats.lastChange.at, now) : null,
    ]));
  }
  log('');
  log(row('total', `${aggregate.total} annotation${aggregate.total === 1 ? '' : 's'} across `
    + `${per.length} base URL${per.length === 1 ? '' : 's'} · ${aggregate.actionable} actionable`));
  log('');
  for (const line of workspaceNextSteps(ws, per)) log(line);
  return aggregate;
}

/** One base and what {@link reviewStats} made of it. */
interface BaseReport {
  ref: BaseRef;
  stats: ReviewStats;
}

/**
 * Sum per-base stats into one workspace-wide {@link ReviewStats}. Every
 * countable field is summed rather than taken from one base, so the totals and
 * the breakdowns can never disagree; `review` is left empty because a workspace
 * has no single review block.
 * @param dir the workspace directory
 * @param per one entry per base, in report order
 */
function aggregateStats(dir: string, per: BaseReport[]): ReviewStats {
  const byStatus: Partial<Record<AnnotationStatus, number>> = {};
  const byType: Partial<Record<AnnotationType, number>> = {};
  const routes = new Map<string, number>();
  let lastChange: ReviewStats['lastChange'] = null;
  let fileUpdatedAt: string | null = null;
  const screenshots = { files: 0, bytes: 0 };

  for (const { stats } of per) {
    for (const [status, count] of Object.entries(stats.byStatus)) {
      byStatus[status as AnnotationStatus] = (byStatus[status as AnnotationStatus] ?? 0) + count;
    }
    for (const [type, count] of Object.entries(stats.byType)) {
      byType[type as AnnotationType] = (byType[type as AnnotationType] ?? 0) + count;
    }
    // the same route (`/checkout`) exists on several environments — one row
    for (const r of stats.routes) routes.set(r.route, (routes.get(r.route) ?? 0) + r.count);
    if (stats.lastChange && (!lastChange || stats.lastChange.at > lastChange.at)) lastChange = stats.lastChange;
    if (stats.fileUpdatedAt && (!fileUpdatedAt || stats.fileUpdatedAt > fileUpdatedAt)) fileUpdatedAt = stats.fileUpdatedAt;
    screenshots.files += stats.screenshots.files;
    screenshots.bytes += stats.screenshots.bytes;
  }

  return {
    file: dir,
    dir,
    review: {},
    total: per.reduce((n, p) => n + p.stats.total, 0),
    actionable: per.reduce((n, p) => n + p.stats.actionable, 0),
    byStatus,
    byType,
    routes: [...routes].map(([route, count]) => ({ route, count }))
      .sort((a, b) => b.count - a.count || a.route.localeCompare(b.route)),
    lastChange,
    fileUpdatedAt,
    screenshots,
    bases: per.map(p => ({
      slug: p.ref.slug,
      url: p.ref.url,
      total: p.stats.total,
      actionable: p.stats.actionable,
    })),
  };
}

/** What to do with this workspace right now, given what is in it. */
function workspaceNextSteps(ws: Workspace, per: BaseReport[]): string[] {
  const dir = displayPath(ws.dir);
  const steps: string[] = [];
  const waiting = per.find(p => p.stats.actionable);
  if (waiting) {
    steps.push(`${waiting.stats.actionable} actionable on ${waiting.ref.slug} — hand them to an agent:  nit mcp ${dir}`);
  }
  const fixed = per.find(p => p.stats.byStatus.fixed);
  if (fixed) {
    steps.push(`${fixed.stats.byStatus.fixed} fixed on ${fixed.ref.slug}, waiting on you:  nit verify ${dir} --base ${fixed.ref.slug}`);
  }
  const verified = per.find(p => p.stats.byStatus.verified);
  if (verified) {
    steps.push(`${verified.stats.byStatus.verified} already ruled on ${verified.ref.slug} — tidy up:  nit clear ${dir} --base ${verified.ref.slug} --verified`);
  }
  if (!steps.length) steps.push(`Nothing actionable — see what is where:  nit list ${dir}`);
  return steps;
}

/** Parse a review file for stats; an unreadable one counts as empty rather than fatal. */
function readReviewData(file: string): ReviewData {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ReviewData;
  } catch {
    return { review: { id: '', url: '', createdAt: '', authors: [] }, annotations: [] };
  }
}

/** The human-readable report, as lines. */
function report(stats: ReviewStats, now: Date): string[] {
  const { review, total, actionable } = stats;
  const lines = [`nit status — ${displayPath(stats.file)}`, ''];

  if (review.id) lines.push(row('review', review.id));
  if (review.url) lines.push(row('url', review.url));
  lines.push(row('created', [
    review.createdAt ? day(review.createdAt) : null,
    review.authors?.length ? `authors: ${review.authors.join(', ')}` : null,
  ]));
  lines.push(row('last change', stats.lastChange
    ? [`${day(stats.lastChange.at)} (${ago(stats.lastChange.at, now)})`, stats.lastChange.by ? `by ${stats.lastChange.by}` : null]
    : stats.fileUpdatedAt ? [`file written ${ago(stats.fileUpdatedAt, now)}`] : ['—']));

  lines.push('');
  lines.push(row('annotations', `${total} total · ${actionable} actionable`));
  const statuses = STATUS_ORDER.filter(s => stats.byStatus[s]).map(s => `${s} ${stats.byStatus[s]}`);
  if (statuses.length) lines.push(row('by status', statuses.join(' · ')));
  const types = Object.entries(stats.byType).map(([type, count]) => `${type} ${count}`);
  if (types.length) lines.push(row('by type', types.join(' · ')));
  if (stats.routes.length) lines.push(row('routes', routeSummary(stats)));
  if (stats.screenshots.files) {
    lines.push(row('screenshots', `${stats.screenshots.files} file${stats.screenshots.files === 1 ? '' : 's'} · ${size(stats.screenshots.bytes)}`));
  }

  lines.push('', ...nextSteps(stats));
  return lines;
}

/** What to do with this review right now, given what is in it. */
function nextSteps(stats: ReviewStats): string[] {
  const dir = displayPath(stats.dir);
  if (!stats.total) return [`No annotations yet — capture some:  nit review ${stats.review.url ?? '<url>'}`];

  const steps: string[] = [];
  if (stats.actionable) {
    steps.push(`${stats.actionable} actionable change-request${stats.actionable === 1 ? '' : 's'} — hand them to an agent:  nit mcp ${dir}`);
  }
  if (stats.byStatus.fixed) {
    steps.push(`${stats.byStatus.fixed} fixed, waiting on you to rule:  nit verify ${displayPath(stats.file)}`);
  }
  if (!steps.length) steps.push(`Nothing actionable — review it any time:  nit view ${displayPath(stats.file)}`);
  return steps;
}

function routeSummary(stats: ReviewStats): string {
  const shown = stats.routes.slice(0, ROUTES_SHOWN).map(r => `${r.route} ${r.count}`);
  const rest = stats.routes.length - shown.length;
  return shown.join(' · ') + (rest > 0 ? ` · +${rest} more` : '');
}

/** One aligned `label  value` line; empty parts are dropped. */
function row(label: string, value: string | (string | null)[]): string {
  const text = Array.isArray(value) ? value.filter(Boolean).join(' · ') : value;
  return `  ${label.padEnd(12)}${text || '—'}`;
}

/** Paths relative to the cwd when they live under it — shorter, still pasteable. */
export function displayPath(target: string): string {
  const rel = path.relative(process.cwd(), target);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : target;
}

/** The date part of an ISO timestamp; anything unparseable is passed through. */
function day(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : iso;
}

/**
 * Coarse relative time ("3 hours ago"): enough to tell a review from this
 * morning from one from last month at a glance.
 */
export function ago(iso: string, now: Date = new Date()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'unknown';
  const seconds = Math.round((now.getTime() - then) / 1000);
  // anything inside the last minute (or a clock skewed into the future) is "now"
  if (seconds < 60) return 'just now';
  const units: [limit: number, per: number, name: string][] = [
    [3600, 60, 'minute'],
    [86400, 3600, 'hour'],
    [2592000, 86400, 'day'],
    [31536000, 2592000, 'month'],
  ];
  for (const [limit, per, name] of units) {
    if (seconds < limit) {
      const value = Math.floor(seconds / per);
      if (value < 1) return 'just now';
      return `${value} ${name}${value === 1 ? '' : 's'} ago`;
    }
  }
  const years = Math.floor(seconds / 31536000);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
