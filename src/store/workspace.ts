// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A review folder holding more than one base URL — a *workspace*. Each base URL
 * gets a subfolder that is byte-for-byte a normal review folder, so everything
 * below this module (the store, the renderers, the overlay) stays single-review
 * and unchanged. This module owns the layer above: which bases exist, how one is
 * named, how a base-qualified id is read, and how a legacy flat folder becomes a
 * workspace.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { BaseRef, ReviewData, Workspace, WorkspaceLayout } from '../types.js';
import { slugify } from '../util/slug.js';

export type { BaseRef, Workspace, WorkspaceLayout };

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
interface IndexEntry {
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
 * hand-editable and arrives inside shared zips, and a slug becomes a path
 * segment. Anything unreadable or shape-invalid yields an empty index rather
 * than an error — the subfolders alone are enough to rebuild it.
 */
function readIndex(wsDir: string): Map<string, IndexEntry> {
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
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ReviewData>;
    return typeof parsed.review?.url === 'string' ? parsed.review.url : '';
  } catch {
    return '';
  }
}
