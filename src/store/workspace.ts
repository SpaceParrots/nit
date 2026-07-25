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
import type { BaseRef, Workspace, WorkspaceLayout } from '../types.js';
import { errorMessage } from '../util/error.js';
import { slugify } from '../util/slug.js';
import { createStore } from './store.js';

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
 * Find the base a `--base` argument (or an MCP `base` parameter) names.
 *
 * Matching runs most-specific first — exact slug, exact url, same origin, then a
 * unique case-insensitive slug prefix — so an exact name always beats a prefix
 * of a longer one. One function serves the CLI and the MCP layer alike, so the
 * two can never drift apart.
 * @param ws the workspace to search
 * @param nameOrUrl a slug, a full url, or an unambiguous slug prefix
 * @returns the matching base
 * @throws when nothing matches, or when a same-origin match or a slug prefix
 *   matches several bases; the message always names the workspace's actual
 *   bases (or, for an ambiguous match, the candidates it matches)
 */
export function resolveBase(ws: Workspace, nameOrUrl: string): BaseRef {
  const query = nameOrUrl.trim().toLowerCase();
  const known = describeBases(ws);
  if (!query) throw new Error(`no base given — known bases: ${known}`);

  const bySlug = ws.bases.find(b => b.slug.toLowerCase() === query);
  if (bySlug) return bySlug;

  const byUrl = ws.bases.find(b => b.url.toLowerCase() === query);
  if (byUrl) return byUrl;

  const origin = safeOrigin(query);
  if (origin) {
    // .filter + length check, not .find: two bases can share an origin and
    // differ only by path (e.g. /admin vs /public), and silently returning
    // the first one would send the caller to the wrong base.
    const byOrigin = ws.bases.filter(b => safeOrigin(b.url) === origin);
    if (byOrigin.length === 1) return byOrigin[0];
    if (byOrigin.length > 1) {
      throw new Error(`base "${nameOrUrl}" is ambiguous — it matches ${byOrigin.map(b => b.slug).join(', ')}`);
    }
  }

  const prefixed = ws.bases.filter(b => b.slug.toLowerCase().startsWith(query));
  if (prefixed.length === 1) return prefixed[0];
  if (prefixed.length > 1) {
    throw new Error(`base "${nameOrUrl}" is ambiguous — it matches ${prefixed.map(b => b.slug).join(', ')}`);
  }
  throw new Error(`no base "${nameOrUrl}" in ${ws.dir} — known bases: ${known}`);
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

/** Files a flat review folder owns; everything else in the folder is left alone. */
const FLAT_ENTRIES = ['annotations.json', 'annotations.json.bak', 'review.md', 'fix-annotations.md', 'shots'];

/**
 * Find or create the base folder for a url, so a session can write into it.
 *
 * Migration is deliberately lazy: a flat review folder stays flat while it is
 * reviewed at the url it already holds, and only becomes a workspace when a
 * *second* base url actually arrives. Single-environment users therefore never
 * see their folder change shape.
 * @param dir the workspace directory (`--out`, default `nit-review`)
 * @param url the site about to be reviewed
 * @param alias optional short name for the base's folder (`--base staging`)
 * @returns the base to write into; its directory exists when this returns
 * @throws when a flat folder cannot be migrated (the move is rolled back first)
 */
export function ensureBase(dir: string, url: string, alias?: string): BaseRef {
  const abs = path.resolve(dir);
  const ws = openWorkspace(abs);
  const origin = safeOrigin(url);

  // Already known? Match on origin so /checkout and /?x=1 do not fork a base.
  const existing = origin ? ws.bases.find(b => safeOrigin(b.url) === origin) : undefined;
  if (existing) {
    if (ws.layout === 'multi') touchBase(abs, ws.bases, existing.slug);
    return existing;
  }

  // A flat folder holding a *different* url has to become a workspace first.
  if (ws.layout === 'flat') migrateFlat(abs, ws.bases[0].slug);

  const slug = uniqueSlug(abs, alias ? slugify(alias) : baseSlug(url));
  const baseDir = path.join(abs, slug);
  // openWorkspace's directory scan (baseDirNames) only recognizes a subfolder
  // as a base once it holds an annotations.json — that's the signal the rest
  // of this module treats as "this is really a base" (see its docblock). A
  // brand-new base must satisfy that immediately, or it would vanish from the
  // very next openWorkspace() call (breaking idempotency: a second ensureBase
  // for the same origin wouldn't find it and would create a duplicate). So an
  // empty review is flushed right away via the normal Store, the same file a
  // real annotation save would produce, instead of waiting for the caller to
  // save the first annotation.
  const store = createStore(baseDir, { url });
  store.flush();
  const now = new Date().toISOString();
  const base: BaseRef = {
    slug,
    url,
    dir: baseDir,
    file: store.file,
    createdAt: now,
    lastSeenAt: now,
  };
  writeIndex(abs, [...openWorkspace(abs).bases.filter(b => b.slug !== slug), base]);
  return base;
}

/**
 * Move a flat review folder's files into `<slug>/`. Every move is undone if any
 * one of them fails, so a failed migration never leaves a half-workspace.
 * @param wsDir the workspace directory
 * @param slug the folder name to move the flat review into
 * @throws when a move fails (after rolling back)
 */
function migrateFlat(wsDir: string, slug: string): void {
  const target = path.join(wsDir, slug);
  if (fs.existsSync(target)) {
    throw new Error(`cannot migrate ${wsDir}: ${slug}/ already exists`);
  }
  fs.mkdirSync(target, { recursive: true });
  const moved: [from: string, to: string][] = [];
  try {
    for (const name of FLAT_ENTRIES) {
      const from = path.join(wsDir, name);
      if (!fs.existsSync(from)) continue;
      const to = path.join(target, name);
      fs.renameSync(from, to);
      moved.push([from, to]);
    }
  } catch (e) {
    // If every reversal below succeeds, `target` is empty and safe to remove.
    // If even one doesn't, `target` still holds real files this function
    // moved out of `wsDir` — deleting it here would be a second, worse
    // failure on top of the first, so it is left in place instead.
    let rollbackFailed = false;
    for (const [from, to] of moved.reverse()) {
      try { fs.renameSync(to, from); } catch { rollbackFailed = true; /* best effort — report the original failure */ }
    }
    if (!rollbackFailed) {
      try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    throw new Error(`could not turn ${wsDir} into a multi-base workspace: ${errorMessage(e)}`, { cause: e });
  }
}

/**
 * Windows refuses to create a file or directory whose name (before any
 * extension) matches one of these legacy device names, case-insensitively —
 * a host like `con` or an alias of `nul` would otherwise slugify straight
 * into one of them. nit ships on Windows, so this has to be handled before a
 * slug reaches `fs.mkdirSync`. It deliberately lives in {@link fsSafeSlug}
 * (used only by {@link uniqueSlug}, the folder-creation path) rather than in
 * `SAFE_SLUG`/`isSafeSlug`: those guard *reading* a workspace, and a folder
 * named `nul` that already exists on disk (copied from another OS, or
 * created before this check existed) must still be readable as a base.
 */
const WINDOWS_RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/**
 * Longest a generated slug may be. Bounds how deep a base's own files nest
 * (`<slug>/shots/<id>-after-mobile.png`) so a very long hostname or alias
 * can't push a real file past Windows' path-length limit. Same reasoning as
 * `WINDOWS_RESERVED_NAMES` above for why this lives here and not in
 * `SAFE_SLUG`: an existing, longer folder must remain readable.
 */
const MAX_SLUG_LENGTH = 60;

/**
 * Adjust an `isSafeSlug`-valid candidate so it is also safe to actually
 * create as a directory: bounded length, and never a bare Windows reserved
 * device name.
 * @param slug a slug that has already passed `isSafeSlug`
 */
function fsSafeSlug(slug: string): string {
  const bounded = slug.length > MAX_SLUG_LENGTH ? slug.slice(0, MAX_SLUG_LENGTH) : slug;
  return WINDOWS_RESERVED_NAMES.has(bounded) ? `${bounded}-base` : bounded;
}

/** `staging`, or `staging-2` when that folder is already taken by another base. */
function uniqueSlug(wsDir: string, desired: string): string {
  const safe = fsSafeSlug(isSafeSlug(desired) ? desired : 'review');
  if (!fs.existsSync(path.join(wsDir, safe))) return safe;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${safe}-${n}`;
    if (!fs.existsSync(path.join(wsDir, candidate))) return candidate;
  }
  throw new Error(`cannot find a free folder name for base "${desired}" in ${wsDir}`);
}

/** Stamp `lastSeenAt` on one base, leaving the rest of the index alone. */
function touchBase(wsDir: string, bases: BaseRef[], slug: string): void {
  const now = new Date().toISOString();
  writeIndex(wsDir, bases.map(b => (b.slug === slug ? { ...b, lastSeenAt: now } : b)));
}

/**
 * Write bases.json. Only the fields the index owns are persisted — `dir` and
 * `file` are derived from the workspace path on every read, so a moved or
 * renamed workspace never carries stale absolute paths.
 *
 * Every caller today only ever passes slugs that are already safe — from
 * `uniqueSlug` (folder creation) or from an `openWorkspace` read (folder
 * names `baseDirNames` already filtered) — so this filter should never drop
 * anything in practice. It is kept anyway as the write-side half of the
 * defence-in-depth `isSafeSlug` guard inside `readIndex`: bases.json is
 * hand-editable and travels between machines, and an unsafe slug must never
 * round-trip through a write into something a later read could turn into a
 * path.
 * @param wsDir the workspace directory
 * @param bases every base the workspace should list
 */
export function writeIndex(wsDir: string, bases: BaseRef[]): void {
  const payload = {
    version: 1,
    bases: [...bases]
      .filter(b => isSafeSlug(b.slug))
      .sort((a, b) => a.slug.localeCompare(b.slug))
      .map(b => ({
        slug: b.slug,
        url: b.url,
        ...(b.createdAt ? { createdAt: b.createdAt } : {}),
        ...(b.lastSeenAt ? { lastSeenAt: b.lastSeenAt } : {}),
      })),
  };
  const file = path.join(wsDir, BASES_FILE);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}
