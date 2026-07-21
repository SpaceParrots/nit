// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure sorting and grouping for the panel list. Kept free of DOM access so it can
// be unit-tested — the reason the panel is bundled TypeScript rather than an
// inline script string.
import { routePath } from '../util/route.js';
import type { Annotation, AnnotationStatus } from '../types.js';

export type SortKey = 'page' | 'time' | 'state';
export type GroupKey = 'none' | 'page' | 'state';

export interface FilterOptions {
  sort: SortKey;
  group: GroupKey;
}

/**
 * One rendered section of the list. `key` is '' for the ungrouped case, a
 * status for state grouping, or a bare pathname (via `routePath`) for page
 * grouping — `/products` and `/products?id=5` share one group's `key`.
 */
export interface AnnotationGroup {
  key: string;
  label: string;
  items: Annotation[];
}

/** Actionable first — the order a reviewer works through a list in. */
export const STATE_ORDER: readonly AnnotationStatus[] =
  ['open', 'reopened', 'fixed', 'verified', 'wontfix'];

/**
 * Order annotations by the chosen key. Returns a new array; the input is never
 * mutated (it is the live store array polled from Node).
 */
export function sortAnnotations(items: readonly Annotation[], sort: SortKey): Annotation[] {
  const copy = [...items];
  if (sort === 'page') return copy.sort((a, b) => byRoute(a, b) || byNewest(a, b));
  if (sort === 'state') return copy.sort((a, b) => stateRank(a) - stateRank(b) || byNewest(a, b));
  return copy.sort(byNewest);
}

/**
 * Split annotations into rendered sections, sorted inside each. Page groups
 * bucket by pathname only, via `routePath` — `/products` and `/products?id=5`
 * land in the same group, so exactly one group can ever be "the page you're
 * on". Individual annotations are unaffected and keep their full stored route
 * (`item.route`); only the grouping key is path-only. Groups themselves are
 * ordered by the grouping key — pathnames alphabetically with the current one
 * first, statuses actionable-first — never by the sort key.
 * @param currentRoute the route the site page is on (`PanelState.route`)
 */
export function groupAnnotations(
  items: readonly Annotation[],
  opts: FilterOptions,
  currentRoute: string,
): AnnotationGroup[] {
  const sorted = sortAnnotations(items, opts.sort);
  if (!sorted.length) return [];
  if (opts.group === 'none') return [{ key: '', label: '', items: sorted }];

  const buckets = new Map<string, Annotation[]>();
  for (const a of sorted) {
    const key = opts.group === 'state' ? a.status : routePath(a.route);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(a);
    else buckets.set(key, [a]);
  }

  const keys = [...buckets.keys()];
  if (opts.group === 'state') {
    keys.sort((a, b) => rankOf(a) - rankOf(b));
  } else {
    // Keys are already bare pathnames (see the bucketing above), so "is this
    // the current group" is a direct equality check — at most one key can
    // ever match.
    const here = routePath(currentRoute);
    keys.sort((a, b) => {
      const aHere = a === here;
      const bHere = b === here;
      if (aHere !== bHere) return aHere ? -1 : 1;
      return a.localeCompare(b);
    });
  }
  return keys.map(key => ({ key, label: key, items: buckets.get(key) ?? [] }));
}

/**
 * Whether a group starts open. Grouped by page, `groupKey` is the pathname
 * produced by `groupAnnotations` (e.g. `/products`, merged across its query
 * variants), so comparing it against the current route's pathname matches
 * exactly one group — that group is what makes "Go to page" the way you reach
 * the rest.
 */
export function defaultExpanded(groupKey: string, opts: FilterOptions, currentRoute: string): boolean {
  if (opts.group !== 'page') return true;
  return groupKey === routePath(currentRoute);
}

function byNewest(a: Annotation, b: Annotation): number {
  return String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''));
}

function byRoute(a: Annotation, b: Annotation): number {
  return routePath(a.route).localeCompare(routePath(b.route))
    || String(a.route || '/').localeCompare(String(b.route || '/'));
}

function stateRank(a: Annotation): number {
  return rankOf(a.status);
}

function rankOf(status: string): number {
  const i = (STATE_ORDER as readonly string[]).indexOf(status);
  return i === -1 ? STATE_ORDER.length : i;
}
