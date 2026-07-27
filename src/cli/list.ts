// SPDX-License-Identifier: AGPL-3.0-or-later
// nit list — what base urls a workspace holds, and which urls were annotated
// inside one. Read-only: nothing is created, normalized or backed up, so running
// it against a review someone else is editing is always safe.
import { openWorkspace, resolveBase } from '../store/workspace.js';
import { readAnnotations } from '../store/read.js';
import { isActionable } from '../store/stats.js';
import { resolveAnnotationUrl } from '../store/url.js';
import { routePath } from '../util/route.js';
import { displayPath, ago } from './status.js';
import type {
  Annotation, AnnotationStatus, AnnotationType, BaseRef, WorkspaceLayout,
} from '../types.js';

/** Which annotations a listing should count. */
export interface ListFilter {
  status?: AnnotationStatus;
  type?: AnnotationType;
  /** an exact route, or a bare pathname that matches routes carrying a query */
  route?: string;
  /** case-insensitive author match */
  author?: string;
  /** only open/reopened change-requests */
  actionable?: boolean;
}

/** One annotated url inside a base. */
export interface UrlRow {
  /** the navigable url: the base's url with the annotation's route applied */
  url: string;
  route: string;
  count: number;
  actionable: number;
  byStatus: Partial<Record<AnnotationStatus, number>>;
}

/** One base and what is annotated inside it. */
export interface BaseRow {
  slug: string;
  url: string;
  total: number;
  actionable: number;
  byStatus: Partial<Record<AnnotationStatus, number>>;
  /** ISO timestamp of the newest annotation change, or null */
  lastChange: string | null;
  /** annotated urls, busiest first */
  urls: UrlRow[];
}

/** What {@link buildListResult} computed. */
export interface ListResult {
  dir: string;
  layout: WorkspaceLayout;
  /** bases that still have annotations after filtering, busiest first */
  bases: BaseRow[];
  total: number;
  actionable: number;
}

/** Options for {@link runList} and {@link buildListResult}. */
export interface ListOptions {
  /** only this base (slug, url or unique prefix); also switches the report to url rows */
  base?: string;
  /** show url rows for every base */
  all?: boolean;
  filter?: ListFilter;
  /** print the result as JSON instead of a report */
  json?: boolean;
  /** log sink */
  log?: (line: string) => void;
  /** clock override for the relative "… ago" column */
  now?: Date;
}

/**
 * Whether one annotation passes a filter. Pure and table-tested — the CLI and
 * any future consumer agree on what `--status open --route /cart` means.
 * @param a the annotation
 * @param filter see {@link ListFilter}
 */
export function matchesFilter(a: Annotation, filter: ListFilter): boolean {
  if (filter.status && a.status !== filter.status) return false;
  if (filter.type && a.type !== filter.type) return false;
  if (filter.actionable && !isActionable(a)) return false;
  if (filter.author && (a.author ?? '').toLowerCase() !== filter.author.toLowerCase()) return false;
  // routes carry query strings: accept an exact match or a path-only filter
  if (filter.route && a.route !== filter.route && routePath(a.route) !== filter.route) return false;
  return true;
}

/**
 * Aggregate a workspace into base rows and url rows.
 * @param dir the workspace directory (or a flat review folder)
 * @param opts see {@link ListOptions}
 * @returns the aggregated counts
 * @throws when `base` names no base in the workspace
 */
export function buildListResult(dir: string, { base, filter = {} }: ListOptions): ListResult {
  const ws = openWorkspace(dir);
  const scope = base ? [resolveBase(ws, base)] : ws.bases;

  // A filtered listing answers "where is the work matching this?", so a base
  // with no match is noise and drops out. An unfiltered one answers "what does
  // this review cover?" — there, hiding a base that exists on disk (freshly
  // created, or just emptied by `nit clear`) would contradict `nit status`,
  // `nit doctor` and the folder itself.
  const filtered = hasFilter(filter);
  const bases = scope.map(ref => buildBaseRow(ref, filter)).filter(row => !filtered || row.total > 0);
  bases.sort((a, b) => b.total - a.total || a.slug.localeCompare(b.slug));
  return {
    dir: ws.dir,
    layout: ws.layout,
    bases,
    total: bases.reduce((n, b) => n + b.total, 0),
    actionable: bases.reduce((n, b) => n + b.actionable, 0),
  };
}

/**
 * Whether a listing was narrowed at all. `actionable: false` is not a filter —
 * it is the flag's own default, and treating it as one would silently hide
 * every empty base again.
 * @param filter see {@link ListFilter}
 */
function hasFilter(filter: ListFilter): boolean {
  return Boolean(filter.status ?? filter.type ?? filter.route ?? filter.author ?? filter.actionable);
}

/** Count one base's annotations, grouped by the url they sit on. */
function buildBaseRow(ref: BaseRef, filter: ListFilter): BaseRow {
  const annotations = readAnnotations(ref.file).filter(a => matchesFilter(a, filter));
  const byStatus: Partial<Record<AnnotationStatus, number>> = {};
  const urls = new Map<string, UrlRow>();
  let lastChange: string | null = null;

  for (const a of annotations) {
    if (a.status) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
    const at = a.updatedAt ?? a.createdAt;
    if (typeof at === 'string' && (!lastChange || at > lastChange)) lastChange = at;

    const route = a.route ?? '/';
    // resolveAnnotationUrl already rejects anything that would leave the base's
    // own origin, so a crafted route cannot fabricate a url in the report
    const url = resolveAnnotationUrl(ref.url, route) ?? route;
    const row = urls.get(url) ?? { url, route, count: 0, actionable: 0, byStatus: {} };
    row.count += 1;
    if (isActionable(a)) row.actionable += 1;
    if (a.status) row.byStatus[a.status] = (row.byStatus[a.status] ?? 0) + 1;
    urls.set(url, row);
  }

  return {
    slug: ref.slug,
    url: ref.url,
    total: annotations.length,
    actionable: annotations.filter(isActionable).length,
    byStatus,
    lastChange,
    urls: [...urls.values()].sort((a, b) => b.count - a.count || a.url.localeCompare(b.url)),
  };
}

/**
 * Report on a workspace, or on one base's annotated urls.
 * @param dir the workspace directory (default `nit-review`)
 * @param opts see {@link ListOptions}
 * @returns the same result that was printed
 * @throws when the folder holds no review, or `base` names no base
 */
export function runList(
  dir = 'nit-review',
  { log = line => console.log(line), now = new Date(), ...opts }: ListOptions = {},
): ListResult {
  const result = buildListResult(dir, opts);
  if (opts.json) {
    log(JSON.stringify(result, null, 2));
    return result;
  }
  if (!result.bases.length) {
    log(`nit list — ${displayPath(result.dir)}`);
    log('');
    log(result.layout === 'empty'
      ? '  No review here yet — capture one:  nit review <url>'
      : '  Nothing matches that filter.');
    return result;
  }
  // naming a base, or asking for --all, switches the report to url rows
  const urlShape = Boolean(opts.base) || Boolean(opts.all);
  for (const line of urlShape ? urlReport(result, Boolean(opts.all)) : baseReport(result, now)) log(line);
  return result;
}

/** The base table: one row per base url. */
function baseReport(result: ListResult, now: Date): string[] {
  const lines = [`nit list — ${displayPath(result.dir)}`, ''];
  const slugWidth = Math.max(4, ...result.bases.map(b => b.slug.length));
  const urlWidth = Math.max(3, ...result.bases.map(b => b.url.length));
  lines.push(`  ${'base'.padEnd(slugWidth)}  ${'url'.padEnd(urlWidth)}  total  actionable  last change`);
  for (const b of result.bases) {
    lines.push(`  ${b.slug.padEnd(slugWidth)}  ${b.url.padEnd(urlWidth)}  ${String(b.total).padStart(5)}  ${String(b.actionable).padStart(10)}  ${b.lastChange ? ago(b.lastChange, now) : '—'}`);
  }
  lines.push('');
  lines.push(`  ${result.total} annotation${result.total === 1 ? '' : 's'} across ${result.bases.length} base URL${result.bases.length === 1 ? '' : 's'} · ${result.actionable} actionable`);
  lines.push('');
  lines.push(`  Urls in one of them:  nit list --base ${result.bases[0].slug}`);
  return lines;
}

/** The url table: one row per annotated url, optionally grouped by base. */
function urlReport(result: ListResult, grouped: boolean): string[] {
  const lines: string[] = [];
  for (const b of result.bases) {
    lines.push(`nit list — ${b.slug} (${b.url})`, '');
    const urlWidth = Math.max(3, ...b.urls.map(u => u.url.length));
    lines.push(`  ${'url'.padEnd(urlWidth)}  n   status`);
    for (const u of b.urls) {
      const statuses = Object.entries(u.byStatus).map(([s, n]) => `${s} ${n}`).join(' · ');
      lines.push(`  ${u.url.padEnd(urlWidth)}  ${String(u.count).padStart(2)}  ${statuses || '—'}`);
    }
    lines.push('');
    lines.push(`  ${b.total} annotation${b.total === 1 ? '' : 's'} on ${b.urls.length} url${b.urls.length === 1 ? '' : 's'} · ${b.actionable} actionable`);
    if (grouped) lines.push('');
  }
  return lines;
}
