// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A review folder holding more than one base URL — a *workspace*. Each base URL
 * gets a subfolder that is byte-for-byte a normal review folder, so everything
 * below this module (the store, the renderers, the overlay) stays single-review
 * and unchanged. This module owns the layer above: which bases exist, how one is
 * named, how a base-qualified id is read, and how a legacy flat folder becomes a
 * workspace.
 *
 * This is the *read* half — deriving slugs and ids, and opening/resolving an
 * existing workspace. The *write* half — creating a base folder and migrating
 * a flat review into one, see `workspace-write.ts` — builds on these
 * functions; `ensureBase`/`writeIndex` are re-exported below so callers keep
 * importing this one path regardless of which file a symbol lives in.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { BaseRef, Workspace, WorkspaceLayout } from '../types.js';
import { slugify } from '../util/slug.js';

export type { BaseRef, Workspace, WorkspaceLayout };
export { ensureBase, writeIndex } from './workspace-write.js';

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

/** The file that records slugs, their urls and when they were last used. */
export const BASES_FILE = 'bases.json';

/** One validated entry from bases.json. */
export interface IndexEntry {
  slug: string;
  url: string;
  createdAt?: string;
  lastSeenAt?: string;
}

/**
 * Read a review folder as a workspace.
 *
 * `bases.json` is an *index*, never the source of truth: a subfolder holding an
 * annotations.json is a base whether or not it is listed (it is adopted, taking
 * its url from its own `review.url`), and an entry naming a folder that is gone
 * is ignored. That keeps a workspace working after a `git clone`, an unzip, or a
 * hand-edit — the same tolerance the store applies to annotations.json.
 * @param dir the review folder
 * @returns the workspace; `layout: 'empty'` for a folder with no review in it
 */
export function openWorkspace(dir: string): Workspace {
  const abs = path.resolve(dir);

  // A flat review folder stays readable as a one-base workspace forever.
  const flatFile = path.join(abs, 'annotations.json');
  if (fs.existsSync(flatFile)) {
    const url = readReviewUrl(flatFile);
    return {
      dir: abs,
      layout: 'flat',
      bases: [{ slug: baseSlug(url), url, dir: abs, file: flatFile }],
    };
  }

  const index = readIndex(abs);
  const bases: BaseRef[] = [];
  for (const slug of baseDirNames(abs)) {
    const entry = index.get(slug);
    const file = path.join(abs, slug, 'annotations.json');
    bases.push({
      slug,
      // review.url is written by the store and always current; the index is the
      // fallback for a review that was created without a url. `||` is deliberate
      // over `??` — an empty string means "no url recorded", not "a url".
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      url: readReviewUrl(file) || entry?.url || '',
      dir: path.join(abs, slug),
      file,
      ...(entry?.createdAt ? { createdAt: entry.createdAt } : {}),
      ...(entry?.lastSeenAt ? { lastSeenAt: entry.lastSeenAt } : {}),
    });
  }
  bases.sort((a, b) => a.slug.localeCompare(b.slug));
  const layout: WorkspaceLayout = bases.length ? 'multi' : 'empty';
  return { dir: abs, layout, bases };
}

/** Immediate subdirectories that hold an annotations.json, safe-slug names only. */
function baseDirNames(wsDir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(wsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(e => e.isDirectory() && isSafeSlug(e.name))
    .map(e => e.name)
    .filter(name => fs.existsSync(path.join(wsDir, name, 'annotations.json')));
}

/**
 * Parse bases.json into slug → entry. Everything is validated: the file is
 * hand-editable and arrives inside shared zips. The slug check here is a
 * second layer, not the only one — `openWorkspace` never joins an index
 * slug into a path today, it only reads directory names that `baseDirNames`
 * has already filtered — but a later task writes this index back to disk,
 * at which point an entry surviving into that write becomes a path on the
 * next read. Anything unreadable or shape-invalid yields an empty index
 * rather than an error — the subfolders alone are enough to rebuild it.
 *
 * Exported for direct testing of the slug guard (see
 * `test/unit-workspace.test.js`), independent of how `openWorkspace` happens
 * to use the result today.
 */
export function readIndex(wsDir: string): Map<string, IndexEntry> {
  const out = new Map<string, IndexEntry>();
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(wsDir, BASES_FILE), 'utf8'));
  } catch {
    return out;
  }
  const list = (raw as { bases?: unknown } | null)?.bases;
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const { slug, url, createdAt, lastSeenAt } = item as Record<string, unknown>;
    if (!isSafeSlug(slug)) continue;
    out.set(slug, {
      slug,
      url: typeof url === 'string' ? url : '',
      ...(typeof createdAt === 'string' ? { createdAt } : {}),
      ...(typeof lastSeenAt === 'string' ? { lastSeenAt } : {}),
    });
  }
  return out;
}

/** A review file's `review.url`, or `''` when it cannot be read. */
function readReviewUrl(file: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return '';
  }
  return hasReviewUrl(parsed) ? parsed.review.url : '';
}

/** Narrows unknown JSON to the one field `readReviewUrl` needs, without casting. */
function hasReviewUrl(v: unknown): v is { review: { url: string } } {
  if (!v || typeof v !== 'object') return false;
  const review = (v as Record<string, unknown>).review;
  if (!review || typeof review !== 'object') return false;
  return typeof (review as Record<string, unknown>).url === 'string';
}

/**
 * Every base a name could mean, without deciding whether that is good enough.
 *
 * Matching runs most-specific first — exact slug, exact url, same origin, then
 * case-insensitive slug prefix — so an exact name always beats a prefix of a
 * longer one, and the first tier that matches at all wins. More than one result
 * means the name only narrows to a set: callers that must land on one base
 * (see {@link resolveBase}) treat that as ambiguous, callers that are guessing
 * (`nit verify <base>` with no `--base`) can back off instead.
 * @param ws the workspace to search
 * @param nameOrUrl a slug, a full url, or a slug prefix
 * @returns the matches, empty when the name fits no base
 */
export function matchBases(ws: Workspace, nameOrUrl: string): BaseRef[] {
  const query = nameOrUrl.trim().toLowerCase();
  if (!query) return [];

  const bySlug = ws.bases.find(b => b.slug.toLowerCase() === query);
  if (bySlug) return [bySlug];

  const byUrl = ws.bases.find(b => b.url.toLowerCase() === query);
  if (byUrl) return [byUrl];

  // Two bases can share an origin and differ only by path (e.g. /admin vs
  // /public), so this tier can legitimately return several.
  const origin = safeOrigin(query);
  if (origin) {
    const byOrigin = ws.bases.filter(b => safeOrigin(b.url) === origin);
    if (byOrigin.length) return byOrigin;
  }

  return ws.bases.filter(b => b.slug.toLowerCase().startsWith(query));
}

/**
 * Find the one base a `--base` argument (or an MCP `base` parameter) names.
 * One function serves the CLI and the MCP layer alike, so the two can never
 * drift apart.
 * @param ws the workspace to search
 * @param nameOrUrl a slug, a full url, or an unambiguous slug prefix
 * @returns the matching base
 * @throws when nothing matches, or when the name matches several bases; the
 *   message always names the workspace's actual bases (or, for an ambiguous
 *   match, the candidates it matches)
 */
export function resolveBase(ws: Workspace, nameOrUrl: string): BaseRef {
  const known = describeBases(ws);
  if (!nameOrUrl.trim()) throw new Error(`no base given — known bases: ${known}`);

  const matches = matchBases(ws, nameOrUrl);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(ambiguousBaseMessage(nameOrUrl, matches));
  throw new Error(`no base "${nameOrUrl}" in ${ws.dir} — known bases: ${known}`);
}

/**
 * How a name that narrows to several bases but decides none is reported. One
 * function so `resolveBase` and callers that recover from the ambiguity
 * themselves (the `nit verify <base>` shorthand) phrase it identically.
 * @param nameOrUrl what the caller asked for
 * @param matches the bases it matched
 */
export function ambiguousBaseMessage(nameOrUrl: string, matches: BaseRef[]): string {
  return `base "${nameOrUrl}" is ambiguous — it matches ${matches.map(b => b.slug).join(', ')}`;
}

/**
 * The workspace's base slugs as a comma-separated list, for error messages.
 * @param ws the workspace to describe
 * @returns the slugs joined with `', '`, or `'(none yet)'` when there are none
 */
export function describeBases(ws: Workspace): string {
  return ws.bases.length ? ws.bases.map(b => b.slug).join(', ') : '(none yet)';
}

/**
 * A url's origin, or null when it is not an http(s) url. Used to treat
 * `https://x.test` and `https://x.test/checkout` as the same base. Rejecting
 * every other scheme up front means a `javascript:` or `data:` value can
 * never be coerced into matching a base by origin — the same http(s)-only
 * rule `resolveAnnotationUrl` in `src/store/url.ts` applies when resolving an
 * annotation's route.
 * @param url the value to parse — a base's stored url, or a caller's query
 * @returns the url's origin, or null when it is unparseable or not http(s)
 */
export function safeOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}
