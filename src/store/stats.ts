// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure statistics over a review: what `nit status` reports, and the one place
// that decides what "actionable" means.
import fs from 'node:fs';
import path from 'node:path';
import { routePath } from '../util/route.js';
import type { Annotation, AnnotationStatus, AnnotationType, Review, ReviewData } from '../types.js';

/**
 * The rule every part of nit agrees on: a change-request that is open, or one
 * whose fix did not hold. Comments are context and never actionable.
 */
export function isActionable(a: Pick<Annotation, 'type' | 'status'>): boolean {
  return a.type === 'change-request' && (a.status === 'open' || a.status === 'reopened');
}

/** One route and how many annotations sit on it. */
export interface RouteCount {
  /** the pathname, without query or hash */
  route: string;
  count: number;
}

/** The newest change anyone made to an annotation in this review. */
export interface LastChange {
  /** ISO timestamp */
  at: string;
  /** the session author, or `agent` for a change made through the MCP tools */
  by?: string;
}

/** What `nit status` reports about a review. */
export interface ReviewStats {
  /** absolute path of the annotations file */
  file: string;
  /** absolute path of the review directory */
  dir: string;
  review: Partial<Review>;
  total: number;
  actionable: number;
  /** counts per status, omitting statuses no annotation has */
  byStatus: Partial<Record<AnnotationStatus, number>>;
  byType: Partial<Record<AnnotationType, number>>;
  /** routes with annotations, busiest first */
  routes: RouteCount[];
  /** newest annotation change, or null for a review nothing has touched */
  lastChange: LastChange | null;
  /** ISO mtime of annotations.json, or null when it cannot be read */
  fileUpdatedAt: string | null;
  screenshots: { files: number; bytes: number };
}

/**
 * Summarize a review. Pure apart from reading the shots directory: the file is
 * shared and hand-editable, so entries that are not annotation-shaped are
 * skipped rather than crashing the report.
 * @param data parsed annotations.json content
 * @param file absolute path of that file (its directory holds shots/)
 */
export function reviewStats(data: ReviewData, file: string): ReviewStats {
  const dir = path.dirname(file);
  const annotations = (Array.isArray(data.annotations) ? data.annotations : [])
    .filter((a): a is Annotation => Boolean(a && typeof a === 'object'));

  const byStatus: Partial<Record<AnnotationStatus, number>> = {};
  const byType: Partial<Record<AnnotationType, number>> = {};
  const routes = new Map<string, number>();
  let lastChange: LastChange | null = null;

  for (const a of annotations) {
    if (a.status) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
    if (a.type) byType[a.type] = (byType[a.type] ?? 0) + 1;
    const route = routePath(a.route);
    routes.set(route, (routes.get(route) ?? 0) + 1);

    // updatedAt is stamped on every change; a never-touched annotation still
    // dates itself through createdAt, so a fresh review reports its capture time
    const at = a.updatedAt ?? a.createdAt;
    if (typeof at === 'string' && (!lastChange || at > lastChange.at)) {
      lastChange = { at, by: a.updatedBy ?? a.author };
    }
  }

  return {
    file,
    dir,
    review: data.review ?? {},
    total: annotations.length,
    actionable: annotations.filter(isActionable).length,
    byStatus,
    byType,
    routes: [...routes].map(([route, count]) => ({ route, count }))
      .sort((a, b) => b.count - a.count || a.route.localeCompare(b.route)),
    lastChange,
    fileUpdatedAt: mtimeIso(file),
    screenshots: measureShots(path.join(dir, 'shots')),
  };
}

function mtimeIso(file: string): string | null {
  try {
    return fs.statSync(file).mtime.toISOString();
  } catch {
    return null;
  }
}

/** File count and total size of the shots directory (missing dir → zeroes). */
function measureShots(shotsDir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  let names: string[];
  try {
    names = fs.readdirSync(shotsDir);
  } catch {
    return { files, bytes };
  }
  for (const name of names) {
    try {
      const stat = fs.statSync(path.join(shotsDir, name));
      if (!stat.isFile()) continue;
      files += 1;
      bytes += stat.size;
    } catch { /* vanished mid-scan */ }
  }
  return { files, bytes };
}
