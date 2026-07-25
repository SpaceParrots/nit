// SPDX-License-Identifier: AGPL-3.0-or-later
// Removing annotations from a base: which ones a scope matches (pure), and the
// single operation that applies it. Deletion goes through Store.remove so
// screenshots are unlinked with the existing path-traversal guard rather than by
// a second, less careful path.
import fs from 'node:fs';
import { createStore } from './store.js';
import { writeDerivedFiles } from './derived.js';
import type { Annotation, AnnotationStatus, BaseRef, ReviewData } from '../types.js';

/** What a clear should remove; an empty scope means every annotation. */
export interface ClearScope {
  /** only annotations with this status (`--verified` is `status: 'verified'`) */
  status?: AnnotationStatus;
}

/** What one base's clear removed. */
export interface ClearResult {
  slug: string;
  url: string;
  /** how many annotations were removed */
  cleared: number;
  /** how many are left afterwards */
  remaining: number;
  /** the ids that were (or, on a dry run, would be) removed, in file order */
  ids: string[];
}

/**
 * The annotations a scope matches. Pure — the caller decides what to do with
 * them, so a dry run and a real clear can never disagree about the set.
 * @param annotations the base's annotations
 * @param scope see {@link ClearScope}
 */
export function selectForClear(annotations: Annotation[], scope: ClearScope): Annotation[] {
  return annotations.filter(a => !scope.status || a.status === scope.status);
}

/**
 * Remove the matching annotations from one base and refresh its derived files,
 * or (`dryRun`) report what would be removed without writing anything.
 *
 * The base folder and its review metadata (`id`, `url`, `authors`, `createdAt`)
 * survive even a total empty-out: the request is to clear annotations, not to
 * forget the environment, and keeping the folder means the next review of that
 * url reuses its review id.
 *
 * The dry-run path never calls {@link createStore}: `createStore` creates
 * `shots/` as a side effect (`mkdirSync`), which would make even a
 * `--dry-run` write to a base that has no `shots/` yet — normal right after a
 * `git clone` or an unzip, since git does not track empty directories. The
 * two paths still can't disagree about *what* matches, because both run
 * {@link selectForClear} over the annotations they read.
 * @param base the base to clear
 * @param scope see {@link ClearScope}
 * @param opts `dryRun` reports the same numbers without writing anything
 * @returns what was removed, or would be
 */
export function clearBase(base: BaseRef, scope: ClearScope, { dryRun = false } = {}): ClearResult {
  if (dryRun) {
    const annotations = readAnnotationsForPreview(base.file);
    const doomed = selectForClear(annotations, scope);
    const ids = doomed.map(a => a.id);
    return { slug: base.slug, url: base.url, cleared: ids.length, remaining: annotations.length - ids.length, ids };
  }

  const store = createStore(base.dir);
  const doomed = selectForClear(store.annotations, scope);
  const ids = doomed.map(a => a.id);
  const remaining = store.annotations.length - ids.length;

  if (ids.length) {
    for (const id of ids) store.remove(id);
    store.flush();
    writeDerivedFiles(store);
  }
  return { slug: base.slug, url: base.url, cleared: ids.length, remaining, ids };
}

/**
 * A base's annotations for a dry run only — read-only, same tolerant shape
 * check `src/cli/list.ts` uses (unreadable or shape-invalid input becomes no
 * annotations rather than an error, since a preview's job is to report, not
 * to validate or normalize). Deliberately not {@link createStore}: see
 * {@link clearBase}.
 * @param file the base's annotations.json path
 */
function readAnnotationsForPreview(file: string): Annotation[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ReviewData>;
    return (Array.isArray(parsed.annotations) ? parsed.annotations : [])
      .filter((a): a is Annotation => Boolean(a) && typeof a === 'object');
  } catch {
    return [];
  }
}
