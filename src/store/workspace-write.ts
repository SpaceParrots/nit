// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The write half of the workspace layer — see `workspace.ts` for the read
 * half (`openWorkspace`, `resolveBase`, and the slug/id helpers), which this
 * module builds on and never the other way around. This module owns the two
 * operations that actually change what's on disk: creating a base folder and
 * registering it in `bases.json` (`ensureBase`), and lazily migrating a
 * legacy flat review folder into a multi-base workspace the moment a second,
 * genuinely different base url shows up (`migrateFlat`, called from
 * `ensureBase`). Split out of `workspace.ts` once that file crossed ~450
 * lines; `workspace.ts` re-exports `ensureBase`/`writeIndex` so every other
 * module keeps importing the single path `../store/workspace.js` regardless
 * of which half a given symbol actually lives in.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { BaseRef } from '../types.js';
import { errorMessage } from '../util/error.js';
import { slugify } from '../util/slug.js';
import { createStore } from './store.js';
import { BASES_FILE, baseSlug, isSafeSlug, openWorkspace, safeOrigin } from './workspace.js';

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
 * @throws when `url` is not an http(s) url (nit has nothing to review at a
 *   `file://`, `javascript:`, or unparseable url — see `resolveAnnotationUrl`
 *   in `src/store/url.ts` for the same restriction on the read side); when a
 *   flat folder cannot be migrated (the move is rolled back first, see
 *   {@link migrateFlat}); when {@link uniqueSlug} runs out of suffixes; or
 *   when the underlying file writes (`store.flush()`, {@link writeIndex}) fail
 */
export function ensureBase(dir: string, url: string, alias?: string): BaseRef {
  const abs = path.resolve(dir);

  // Reject before anything is created or moved. A non-http(s)/unparseable url
  // can never match an existing base by origin (safeOrigin returns null for
  // both sides), so without this guard it falls straight through to
  // "treat as a brand-new base" — migrating a flat folder it has no business
  // migrating, or minting a fresh, unbounded `review`/`review-2`/`review-3`/…
  // folder for every distinct bad url a caller happens to pass.
  const origin = safeOrigin(url);
  if (!origin) {
    throw new Error(`cannot review "${url}" — nit only reviews http(s) sites`);
  }

  const ws = openWorkspace(abs);

  // Already known? Match on origin so /checkout and /?x=1 do not fork a base.
  const existing = ws.bases.find(b => safeOrigin(b.url) === origin);
  if (existing) {
    if (ws.layout === 'multi') touchBase(abs, ws.bases, existing.slug);
    return existing;
  }

  // A flat folder holding a *different* url has to become a workspace first.
  // The existing base's slug goes through uniqueSlug too — it was computed by
  // baseSlug from the flat review's own url and never validated against the
  // filesystem-safety rules the create path below already applies.
  if (ws.layout === 'flat') migrateFlat(abs, uniqueSlug(abs, ws.bases[0].slug));

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
 * Move a flat review folder's files into `<slug>/`. Every move is undone if
 * any one of them fails, so a failed migration never leaves a half-workspace
 * — unless undoing itself fails partway, in which case the error says so
 * explicitly and names the directory still holding the stranded files,
 * rather than reporting the same message as a clean rollback and leaving the
 * caller to discover the mismatch by hand.
 * @param wsDir the workspace directory
 * @param slug the folder name to move the flat review into
 * @throws when a move fails; the message differs depending on whether the
 *   rollback that follows fully undid the partial move
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
    // If every reversal below succeeds, `target` is empty and safe to remove
    // — with a plain rmdirSync, which fails loudly instead of recursively
    // deleting anything unexpected, rather than the recursive+force removal
    // a "believed empty" directory doesn't actually need. If even one
    // reversal doesn't succeed, `target` still holds real files this
    // function moved out of `wsDir`: removing it would be a second, worse
    // failure stacked on the first, so it's left in place — and the thrown
    // message says exactly that and names it, instead of claiming nothing
    // happened while the folder tells a different story.
    let rollbackFailed = false;
    for (const [from, to] of [...moved].reverse()) {
      try { fs.renameSync(to, from); } catch { rollbackFailed = true; }
    }
    if (rollbackFailed) {
      throw new Error(
        `could not turn ${wsDir} into a multi-base workspace, and could not fully undo the partial move — `
        + `${target} still holds some of the flat review's files (annotations, screenshots, or both) that `
        + `were not moved back to ${wsDir}; check ${target} by hand before retrying. `
        + `Original error: ${errorMessage(e)}`,
        { cause: e },
      );
    }
    try { fs.rmdirSync(target); } catch { /* best effort */ }
    throw new Error(`could not turn ${wsDir} into a multi-base workspace: ${errorMessage(e)}`, { cause: e });
  }
}

/**
 * Windows' legacy DOS device names, matched case-insensitively. This guard is
 * not protecting `fs.mkdirSync` from refusing them — verified it doesn't, on
 * this project's own Windows 11 dev machine `fs.mkdirSync` happily creates
 * `con`, `nul`, `aux`, `com1`, and the rest. It protects what happens to
 * nit's output *after* creation: a zip/unzip round-trip, an older Windows
 * version, or third-party tooling (some editors, backup/AV software,
 * `cmd.exe`-driven scripts) that still treats these names as devices
 * regardless of who created the folder. nit's review folders travel between
 * machines, so a slug landing on one of these is redirected here rather than
 * risk a folder that's fine on the machine that made it and broken on the
 * next one. Lives in {@link fsSafeSlug} (used only by {@link uniqueSlug}, the
 * folder-creation path) rather than in `SAFE_SLUG`/`isSafeSlug`: those guard
 * *reading* a workspace, and a folder already named `nul` on disk (copied
 * from elsewhere, or created before this check existed) must still be
 * readable as a base.
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
 * path. Note this filter drops a bad entry silently — if a future caller
 * ever did pass one (a bug, not today's intended use), it would vanish from
 * `bases.json` rather than surface as an error; that's an acceptable
 * trade-off only because the index is disposable (see {@link openWorkspace}'s
 * docblock — a dropped entry is re-adopted from its directory on next read),
 * not because silent data loss is fine in general.
 * @param wsDir the workspace directory
 * @param bases every base the workspace should list
 * @throws when the write itself fails (disk full, permissions, …) —
 *   `writeFileSync`/`renameSync` errors propagate as-is
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
