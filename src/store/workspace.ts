// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A review folder holding more than one base URL — a *workspace*. Each base URL
 * gets a subfolder that is byte-for-byte a normal review folder, so everything
 * below this module (the store, the renderers, the overlay) stays single-review
 * and unchanged. This module owns the layer above: which bases exist, how one is
 * named, how a base-qualified id is read, and how a legacy flat folder becomes a
 * workspace.
 */
import { slugify } from '../util/slug.js';

/**
 * A slug is used as a directory name, so it is validated before it ever reaches
 * `path.join`. `bases.json` is hand-editable and travels inside shared zips: a
 * crafted `"slug": "../../.ssh"` must never resolve to a real path.
 */
export const SAFE_SLUG = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Whether a value is usable as a base slug (and therefore as a path segment).
 * @param value anything read from disk, an argument, or a tool call
 */
export function isSafeSlug(value: unknown): value is string {
  return typeof value === 'string' && SAFE_SLUG.test(value);
}

/**
 * The folder name for a base URL: hostname plus `-<port>` when the port is not
 * the scheme default (the WHATWG URL parser drops default ports for us).
 * @param url the site under review, e.g. `http://localhost:4200`
 * @returns a filesystem-safe slug; `'review'` for input that is not a url
 */
export function baseSlug(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'review';
  }
  if (!parsed.hostname) return 'review';
  return slugify(`${parsed.hostname}${parsed.port ? `-${parsed.port}` : ''}`);
}

/**
 * Namespace an annotation id with its base, for output that spans bases (MCP
 * results, `nit list`). Ids on disk are never rewritten.
 * @param slug the base's slug
 * @param id the annotation's own id, e.g. `a1` or a merged `kevin:a1`
 */
export function qualifyId(slug: string, id: string): string {
  return `${slug}:${id}`;
}

/**
 * Split a qualified id back into base and annotation id. The split is on the
 * **first** colon, so a base produced by `nit merge` keeps its author namespace
 * (`staging:kevin:a1` → base `staging`, id `kevin:a1`).
 *
 * A returned `slug` is a *candidate*: on a single-base workspace a bare merged
 * id (`kevin:a1`) parses as slug `kevin`, which resolves to no base. Callers
 * must fall back to treating the whole string as an id — see
 * `findAnnotation` in `src/mcp/aggregate.ts`.
 * @param qualified the id as it arrived from a caller
 */
export function parseQualifiedId(qualified: string): { slug: string | null; id: string } {
  const i = qualified.indexOf(':');
  if (i === -1) return { slug: null, id: qualified };
  return { slug: qualified.slice(0, i), id: qualified.slice(i + 1) };
}
