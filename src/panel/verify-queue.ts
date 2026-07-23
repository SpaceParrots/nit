// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure queue logic for verify mode: which fixed item to rule next, in what
// order, and how far the session has progressed. Kept free of DOM access so it
// can be unit-tested — the same reason filter.ts is a separate module.
import { routeKey } from '../util/route.js';
import type { Annotation } from '../types.js';

/** Everything the queue computation needs from the panel's session state. */
export interface VerifyQueueInput {
  /** the polled annotations, in file order */
  annotations: readonly Annotation[];
  /** ids the panel has ever seen with status 'fixed' this session */
  seenFixed: ReadonlySet<string>;
  /** session-local skips — skipped ids stay in the queue but sort last */
  skipped: ReadonlySet<string>;
  /** the route the site page is currently on (`PanelState.route`) */
  route: string;
}

/** The computed queue snapshot the verify card renders from. */
export interface VerifyQueueResult {
  /** the item to rule next: the first unskipped queue entry, or `null` */
  currentId: string | null;
  /** every still-'fixed' id — current route first, grouped by route, skips last */
  queue: string[];
  /** how many ever-fixed ids now carry a verdict */
  ruled: { verified: number; reopened: number };
  /** the session denominator: ids ever seen 'fixed' that still exist */
  total: number;
  /** true once there was work and no unskipped 'fixed' item remains */
  done: boolean;
}

/**
 * Compute the verify queue from a state snapshot. The queue holds every id
 * whose status is still `fixed`, ordered to minimize navigation: the current
 * route's group first (compared via `routeKey`, the same page-identity rule
 * `__nitGoTo` and the goto button use), then the remaining routes in first-
 * appearance order, stable within each route by annotation order. Skipped ids
 * drop behind all unskipped ids — they stay rulable, but the tour never parks
 * on them again unless nothing else is left.
 */
export function computeVerifyQueue(input: VerifyQueueInput): VerifyQueueResult {
  const { annotations, seenFixed, skipped, route } = input;
  const fixed = annotations.filter(a => a.status === 'fixed');

  const here = routeKey(route);
  const groups = new Map<string, string[]>();
  for (const a of fixed) {
    const key = routeKey(a.route);
    const group = groups.get(key);
    if (group) group.push(a.id);
    else groups.set(key, [a.id]);
  }
  // Map iteration preserves insertion order, so the non-current groups walk the
  // review in the order its routes first appear — a stable, predictable tour.
  const orderedKeys = [...groups.keys()].sort((a, b) =>
    Number(b === here) - Number(a === here));
  const grouped = orderedKeys.flatMap(key => groups.get(key) ?? []);
  const queue = [
    ...grouped.filter(id => !skipped.has(id)),
    ...grouped.filter(id => skipped.has(id)),
  ];

  // Progress counts over every id ever seen fixed this session, so ruling an
  // item moves the numerator without shrinking the denominator. Ids that no
  // longer exist in the file are dropped from both — counting a deleted id
  // would freeze the bar short of 100% forever.
  const byId = new Map(annotations.map(a => [a.id, a] as const));
  const everFixed = new Set([...seenFixed, ...fixed.map(a => a.id)]);
  let verified = 0;
  let reopened = 0;
  let total = 0;
  for (const id of everFixed) {
    const a = byId.get(id);
    if (!a) continue;
    total += 1;
    if (a.status === 'verified') verified += 1;
    else if (a.status === 'reopened') reopened += 1;
  }

  // Skipped items keep status 'fixed', so "queue empty" is the wrong done test:
  // done means nothing unskipped remains (the summary reports skips separately).
  const currentId = queue.find(id => !skipped.has(id)) ?? null;
  const done = total > 0 && currentId === null;
  return { currentId, queue, ruled: { verified, reopened }, total, done };
}
