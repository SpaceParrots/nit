// SPDX-License-Identifier: AGPL-3.0-or-later
// Workspace-aware lookup for the MCP layer. A review folder may hold several
// base urls, each its own review folder; the tools present them as one review
// with base-qualified ids. Ids on disk are never rewritten — qualification
// happens here, on the way out, and is undone here, on the way in.
import { openWorkspace, resolveBase, qualifyId, parseQualifiedId } from '../store/workspace.js';
import { createStore } from '../store/store.js';
import type { Store } from '../store/store.js';
import { isActionable } from '../store/stats.js';
import type { Annotation, BaseRef } from '../types.js';

/** One base's headline numbers, as reported by nit_list_annotations. */
export interface BaseSummary {
  slug: string;
  url: string;
  total: number;
  actionable: number;
}

/** An annotation found in a workspace, with the base and store it came from. */
export interface Located {
  base: BaseRef;
  store: Store;
  annotation: Annotation;
}

/**
 * Every base in the workspace, or just the one a `base` argument names.
 * @param dir the workspace directory
 * @param base optional slug, url or unambiguous prefix
 * @returns the matching bases, slug-sorted
 * @throws when `base` names no base, or names several (via {@link resolveBase})
 */
export function basesOf(dir: string, base?: string): BaseRef[] {
  const ws = openWorkspace(dir);
  return base ? [resolveBase(ws, base)] : ws.bases;
}

/**
 * Whether ids need qualifying. A single-base workspace keeps plain `a1` ids and
 * the original `review` envelope, so existing .mcp.json registrations and
 * single-environment users see byte-identical output.
 * @param dir the workspace directory
 */
export function isMultiBase(dir: string): boolean {
  return openWorkspace(dir).bases.length > 1;
}

/**
 * An id as the agent should see it: qualified only when there is more than one
 * base.
 * @param multi whether the review covers several bases ({@link isMultiBase})
 * @param slug the owning base's slug
 * @param id the annotation's own id, as it is stored on disk
 */
export function displayId(multi: boolean, slug: string, id: string): string {
  return multi ? qualifyId(slug, id) : id;
}

/**
 * Headline counts per base.
 * @param dir the workspace directory
 * @param base optional filter, see {@link basesOf}
 * @throws when `base` names no base
 */
export function baseSummaries(dir: string, base?: string): BaseSummary[] {
  return basesOf(dir, base).map(ref => {
    const annotations = createStore(ref.dir).annotations;
    return {
      slug: ref.slug,
      url: ref.url,
      total: annotations.length,
      actionable: annotations.filter(isActionable).length,
    };
  });
}

/**
 * Resolve an id a caller supplied — qualified (`staging:a1`) or bare (`a1`) —
 * to the annotation and the store that owns it.
 *
 * The qualified form is tried first, then the whole string as a plain id across
 * every base. That fallback matters: on a single-base workspace a merged id like
 * `kevin:a1` parses as slug `kevin`, which is not a base.
 * @param dir the workspace directory
 * @param wanted the id as it arrived
 * @returns the located annotation, or null when nothing matches
 */
export function findAnnotation(dir: string, wanted: string): Located | null {
  const bases = basesOf(dir);
  const { slug, id } = parseQualifiedId(wanted);

  if (slug) {
    const ref = bases.find(b => b.slug === slug);
    if (ref) {
      const store = createStore(ref.dir);
      const annotation = store.annotations.find(a => a.id === id);
      if (annotation) return { base: ref, store, annotation };
    }
  }
  for (const ref of bases) {
    const store = createStore(ref.dir);
    const annotation = store.annotations.find(a => a.id === wanted);
    if (annotation) return { base: ref, store, annotation };
  }
  return null;
}
