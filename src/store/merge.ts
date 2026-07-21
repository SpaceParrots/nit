// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure merge of N feedback files into one consolidated review (SPEC §2.5, §8).
// Ids are namespaced by author (kevin:a1); screenshots are renamed into a shared shots/.
import { fileSafeId } from './store.js';
import { slugify } from '../util/slug.js';
import type { Annotation, ReviewData } from '../types.js';

/** One parsed feedback file plus the directory it was loaded from. */
export interface MergeInput {
  data: ReviewData;
  /** screenshot paths in `data` are relative to this directory */
  dir: string;
}

/** A screenshot file the caller must copy into the merged output dir. */
export interface ShotCopy {
  fromDir: string;
  from: string;
  to: string;
}

/** Result of {@link mergeReviews}: the merged review plus pending screenshot copies. */
export interface MergeResult {
  data: ReviewData;
  copies: ShotCopy[];
}

/**
 * Merge parsed feedback files into one consolidated review. Pure function — the
 * caller performs the returned screenshot copies.
 * @param inputs parsed feedback files (see {@link MergeInput})
 * @param opts injectable clock for the merged review's metadata (annotations
 *   keep their own `createdAt`)
 */
export function mergeReviews(inputs: MergeInput[], { now = new Date() }: { now?: Date } = {}): MergeResult {
  const authors: string[] = [];
  const annotations: Annotation[] = [];
  const copies: ShotCopy[] = [];
  const usedIds = new Set<string>();
  let url = '';

  for (const input of inputs) {
    const review: Partial<ReviewData['review']> = input.data?.review ?? {};
    if (!url && review.url) url = review.url;
    for (const a of review.authors ?? []) addUnique(authors, a);

    for (const ann of input.data?.annotations ?? []) {
      const author = ann.author || 'unknown';
      addUnique(authors, author);

      const base = ann.id.includes(':') ? ann.id : `${slugify(author)}:${ann.id}`;
      let id = base;
      for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
      usedIds.add(id);

      const merged: Annotation = { ...ann, id, author };
      if (ann.screenshot) {
        const to = `shots/${fileSafeId(id)}.png`;
        copies.push({ fromDir: input.dir, from: ann.screenshot, to });
        merged.screenshot = to;
      }
      if (ann.screenshotAfter) {
        const to = `shots/${fileSafeId(id)}-after.png`;
        copies.push({ fromDir: input.dir, from: ann.screenshotAfter, to });
        merged.screenshotAfter = to;
      }
      annotations.push(merged);
    }
  }

  return {
    data: {
      review: {
        id: `${now.toISOString().slice(0, 10)}-merged`,
        url,
        createdAt: now.toISOString(),
        authors,
      },
      annotations,
    },
    copies,
  };
}

function addUnique(arr: string[], v: string | undefined): void {
  if (v && !arr.includes(v)) arr.push(v);
}
