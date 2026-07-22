// SPDX-License-Identifier: AGPL-3.0-or-later
// nit status — a quick read on a review folder: where the file is, when it last
// changed, how many annotations there are and how much work is left. Read-only:
// unlike the store, it never creates, normalizes or backs up anything.
import fs from 'node:fs';
import path from 'node:path';
import { resolveReviewFile } from '../store/store.js';
import { reviewStats } from '../store/stats.js';
import type { ReviewStats } from '../store/stats.js';
import { errorMessage } from '../util/error.js';
import type { AnnotationStatus, ReviewData } from '../types.js';

/** Statuses in lifecycle order, so the report always reads the same way. */
const STATUS_ORDER: readonly AnnotationStatus[] = ['open', 'reopened', 'fixed', 'verified', 'wontfix'];
/** Routes listed inline before the rest is summarized as "+N more". */
const ROUTES_SHOWN = 4;

/** Options for {@link runStatus}. */
export interface StatusOptions {
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
 * @param input review directory, or the path of an annotations.json inside one
 * @returns the same stats that were printed
 * @throws when there is no annotations.json, or it cannot be parsed
 */
export function runStatus(
  input = 'nit-review',
  { json = false, log = line => console.log(line), now = new Date() }: StatusOptions = {},
): ReviewStats {
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
function displayPath(target: string): string {
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
