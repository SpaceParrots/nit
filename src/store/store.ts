// SPDX-License-Identifier: AGPL-3.0-or-later
// Read/write annotations.json (SPEC §3): stable ids, idempotent append, atomic writes.
import fs from 'node:fs';
import path from 'node:path';
import type { Annotation, AnnotationStatus, ReviewData } from '../types.js';

/** Options for {@link createStore}. */
export interface StoreOptions {
  /** site under review (recorded on a fresh review) */
  url?: string;
  /** appended to `review.authors` if not present */
  author?: string;
  /**
   * explicit annotations file path, for feedback files with arbitrary names
   * (`nit view feedback-ann.json`)
   */
  file?: string;
}

/** The annotation store owned by a session (or opened per MCP tool call). */
export interface Store {
  /** review directory */
  dir: string;
  /** screenshot directory inside `dir` */
  shotsDir: string;
  /** path of the annotations.json being managed */
  file: string;
  /** the live review data (mutated in place, persisted via {@link Store.flush}) */
  readonly data: ReviewData;
  /** shortcut for `data.annotations` */
  readonly annotations: Annotation[];
  /** next free plain id (`a1`, `a2`, …; namespaced ids don't count) */
  nextId(): string;
  /** idempotent append — an existing id is replaced */
  upsert(ann: Annotation): void;
  /**
   * Apply changes to one annotation, stamping `updatedAt`/`updatedBy`. The entry
   * is replaced rather than mutated, so callers holding the old object see no
   * surprise writes. A change value of `undefined` clears that field.
   * @param id annotation id
   * @param changes fields to overwrite
   * @param by who is making the change (session author, or `agent`)
   * @returns the new annotation, or null when the id is unknown
   */
  patch(id: string, changes: Partial<Annotation>, by: string): Annotation | null;
  /** delete an annotation and its screenshot files */
  remove(id: string): boolean;
  /** absolute path for an annotation's screenshot */
  shotPath(id: string): string;
  /** absolute path for an annotation's verify after-shot */
  afterShotPath(id: string): string;
  /** atomically write annotations.json (tmp file + rename) */
  flush(): void;
}

/**
 * Open (or initialize) the annotation store for a review directory. Loads an
 * existing annotations.json when present — a corrupt file is backed up to
 * `.bak` and the store starts fresh instead of crashing.
 * @param dir review directory (holds annotations.json + shots/)
 * @param opts see {@link StoreOptions}
 */
export function createStore(dir: string, { url, author, file }: StoreOptions = {}): Store {
  const filePath = file ? path.resolve(file) : path.join(dir, 'annotations.json');
  const shotsDir = path.join(dir, 'shots');
  fs.mkdirSync(shotsDir, { recursive: true });

  const data = loadOrInitData(filePath, url);
  if (author && !data.review.authors.includes(author)) data.review.authors.push(author);
  if (url && !data.review.url) data.review.url = url;

  let lastMtimeMs = mtimeMsOf(filePath);
  let lastStatuses = snapshotStatuses(data);

  return {
    dir,
    shotsDir,
    file: filePath,
    get data(): ReviewData { return data; },
    get annotations(): Annotation[] { return data.annotations; },

    nextId(): string {
      let max = 0;
      for (const a of data.annotations) {
        const m = /^a(\d+)$/.exec(a.id);
        if (m) max = Math.max(max, Number(m[1]));
      }
      return `a${max + 1}`;
    },

    upsert(ann: Annotation): void {
      const i = data.annotations.findIndex(a => a.id === ann.id);
      if (i === -1) data.annotations.push(ann);
      else data.annotations[i] = ann;
    },

    patch(id: string, changes: Partial<Annotation>, by: string): Annotation | null {
      const i = data.annotations.findIndex(a => a.id === id);
      if (i === -1) return null;
      const next: Annotation = {
        ...data.annotations[i],
        ...changes,
        updatedAt: new Date().toISOString(),
        updatedBy: by,
      };
      data.annotations[i] = next;
      return next;
    },

    remove(id: string): boolean {
      const i = data.annotations.findIndex(a => a.id === id);
      if (i === -1) return false;
      const [ann] = data.annotations.splice(i, 1);
      for (const rel of [ann.screenshot, ann.screenshotAfter]) {
        const abs = safeShotPath(dir, rel);
        if (abs) {
          try { fs.unlinkSync(abs); } catch { /* already gone */ }
        }
      }
      return true;
    },

    shotPath(id: string): string {
      return path.join(shotsDir, `${fileSafeId(id)}.png`);
    },

    afterShotPath(id: string): string {
      return path.join(shotsDir, `${fileSafeId(id)}-after.png`);
    },

    flush(): void {
      // Detect a concurrent writer (another nit process or an agent via MCP)
      // touching the file since we last read/wrote it, and merge their annotation
      // status changes in rather than clobbering them (last-writer-wins otherwise).
      const current = mtimeMsOf(filePath);
      if (current !== null && lastMtimeMs !== null && current > lastMtimeMs) {
        mergeExternalStatuses(filePath, data, lastStatuses);
      }
      const tmp = filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, filePath);
      lastMtimeMs = mtimeMsOf(filePath);
      lastStatuses = snapshotStatuses(data);
    },
  };
}

/**
 * Load an existing annotations.json, or initialize a fresh review. A corrupt or
 * shape-invalid file is backed up to `.bak` and replaced by a fresh review.
 */
function loadOrInitData(filePath: string, url: string | undefined): ReviewData {
  if (fs.existsSync(filePath)) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch { /* corrupt file → keep a backup, start fresh */ }
    if (isReviewDataLike(parsed)) {
      // Files are shared and hand-editable: normalize a missing review block
      // instead of crashing on it.
      if (!parsed.review || typeof parsed.review !== 'object') parsed.review = freshReview(url);
      if (!Array.isArray(parsed.review.authors)) parsed.review.authors = [];
      return parsed;
    }
    try { fs.copyFileSync(filePath, filePath + '.bak'); } catch { /* best effort */ }
  }
  return { review: freshReview(url), annotations: [] };
}

/** Loose structural check for an annotations file; deeper validity is per-field. */
function isReviewDataLike(v: unknown): v is ReviewData {
  return typeof v === 'object' && v !== null && Array.isArray((v as ReviewData).annotations);
}

function freshReview(url: string | undefined): ReviewData['review'] {
  const now = new Date();
  return {
    id: `${now.toISOString().slice(0, 10)}-${safeHost(url)}`,
    url: url ?? '',
    createdAt: now.toISOString(),
    authors: [],
  };
}

function mtimeMsOf(file: string): number | null {
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
}

function snapshotStatuses(data: ReviewData): Map<string, AnnotationStatus> {
  return new Map(data.annotations.map(a => [a.id, a.status]));
}

/**
 * Pull `status`/`verifiedAt` changes from the on-disk file into the in-memory
 * data for annotations this session did *not* change since its last flush — so a
 * concurrent status write (e.g. an agent marking `fixed` via MCP) isn't lost,
 * while our own unflushed edits still win. New annotations added externally are
 * left alone — the live session owns creation.
 * @param filePath the annotations.json path
 * @param data live in-memory data (mutated)
 * @param lastStatuses id → status at our last flush/load
 */
function mergeExternalStatuses(
  filePath: string,
  data: ReviewData,
  lastStatuses: Map<string, AnnotationStatus>,
): void {
  let onDisk: unknown;
  try { onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return; }
  if (!isReviewDataLike(onDisk)) return;
  const byId = new Map(data.annotations.map(a => [a.id, a]));
  for (const ext of onDisk.annotations) {
    const local = byId.get(ext.id);
    if (!local || !ext.status || ext.status === local.status) continue;
    const localUnchanged = local.status === lastStatuses.get(ext.id);
    // Only adopt the external status where we haven't made a competing local edit.
    if (localUnchanged) {
      local.status = ext.status;
      if (ext.verifiedAt) local.verifiedAt = ext.verifiedAt;
      // the stamp belongs to the status we just adopted — take it too, or the
      // record would claim our author made the other writer's change
      if (ext.updatedAt) local.updatedAt = ext.updatedAt;
      if (ext.updatedBy) local.updatedBy = ext.updatedBy;
    }
  }
}

/**
 * Turn an annotation id into a safe filename fragment — merged ids contain `:`
 * which is illegal on Windows (`kevin:a1` → `kevin_a1`).
 */
export function fileSafeId(id: string): string {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Resolve a screenshot path from (untrusted) annotation data safely: it must be
 * a relative path that stays inside `baseDir`. Annotation files are shared between
 * people and edited by agents, so a crafted `../../.env` must never escape.
 * @param baseDir directory the relative path is anchored to
 * @param rel the `screenshot`/`screenshotAfter` value from the file
 * @returns the absolute path when safe, else null
 */
export function safeShotPath(baseDir: string, rel: unknown): string | null {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel)) return null;
  if (rel.includes('\0')) return null;
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, rel);
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  return resolved === base || resolved.startsWith(prefix) ? resolved : null;
}

/**
 * Hostname of a url for use in review ids; falls back to `'review'` for
 * unparseable input instead of throwing.
 */
export function safeHost(url: string | undefined): string {
  try { return new URL(url ?? '').hostname || 'review'; } catch { return 'review'; }
}
