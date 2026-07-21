// Read/write annotations.json (SPEC §3): stable ids, idempotent append, atomic writes.
import fs from 'node:fs';
import path from 'node:path';

/**
 * Open (or initialize) the annotation store for a review directory. Loads an
 * existing annotations.json when present — a corrupt file is backed up to
 * `.bak` and the store starts fresh instead of crashing.
 * @param {string} dir review directory (holds annotations.json + shots/)
 * @param {object} [opts]
 * @param {string} [opts.url] site under review (recorded on a fresh review)
 * @param {string} [opts.author] appended to `review.authors` if not present
 * @param {string} [opts.file] explicit annotations file path, for feedback files
 *   with arbitrary names (`nit view feedback-ann.json`)
 * @returns {Store}
 */
export function createStore(dir, { url, author, file } = {}) {
  const filePath = file ? path.resolve(file) : path.join(dir, 'annotations.json');
  const shotsDir = path.join(dir, 'shots');
  fs.mkdirSync(shotsDir, { recursive: true });

  let data = null;
  if (fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed && Array.isArray(parsed.annotations)) data = parsed;
    } catch { /* corrupt file → keep a backup, start fresh */ }
    if (!data) {
      try { fs.copyFileSync(filePath, filePath + '.bak'); } catch { /* best effort */ }
    }
  }
  if (!data) {
    const now = new Date();
    data = {
      review: {
        id: `${now.toISOString().slice(0, 10)}-${safeHost(url)}`,
        url: url || '',
        createdAt: now.toISOString(),
        authors: [],
      },
      annotations: [],
    };
  }
  if (!Array.isArray(data.review.authors)) data.review.authors = [];
  if (author && !data.review.authors.includes(author)) data.review.authors.push(author);
  if (url && !data.review.url) data.review.url = url;

  let lastMtimeMs = mtimeMsOf(filePath);
  let lastStatuses = snapshotStatuses(data);

  /**
   * @typedef {object} Store
   * @property {string} dir review directory
   * @property {string} shotsDir screenshot directory inside `dir`
   * @property {string} file path of the annotations.json being managed
   * @property {import('../types.js').ReviewData} data the live review data (mutated in place, persisted via {@link Store#flush})
   * @property {import('../types.js').Annotation[]} annotations shortcut for `data.annotations`
   * @property {() => string} nextId next free plain id (`a1`, `a2`, …; namespaced ids don't count)
   * @property {(ann: import('../types.js').Annotation) => void} upsert idempotent append — an existing id is replaced
   * @property {(id: string) => boolean} remove delete an annotation and its screenshot files
   * @property {(id: string) => string} shotPath absolute path for an annotation's screenshot
   * @property {(id: string) => string} afterShotPath absolute path for an annotation's verify after-shot
   * @property {() => void} flush atomically write annotations.json (tmp file + rename)
   */
  return {
    dir,
    shotsDir,
    file: filePath,
    get data() { return data; },
    get annotations() { return data.annotations; },

    nextId() {
      let max = 0;
      for (const a of data.annotations) {
        const m = /^a(\d+)$/.exec(a.id);
        if (m) max = Math.max(max, Number(m[1]));
      }
      return `a${max + 1}`;
    },

    /** Idempotent append: same id replaces instead of duplicating. */
    upsert(ann) {
      const i = data.annotations.findIndex(a => a.id === ann.id);
      if (i === -1) data.annotations.push(ann);
      else data.annotations[i] = ann;
    },

    remove(id) {
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

    shotPath(id) {
      return path.join(shotsDir, `${fileSafeId(id)}.png`);
    },

    afterShotPath(id) {
      return path.join(shotsDir, `${fileSafeId(id)}-after.png`);
    },

    flush() {
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

function mtimeMsOf(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
}

function snapshotStatuses(data) {
  return new Map(data.annotations.map(a => [a.id, a.status]));
}

/**
 * Pull `status`/`verifiedAt` changes from the on-disk file into the in-memory
 * data for annotations this session did *not* change since its last flush — so a
 * concurrent status write (e.g. an agent marking `fixed` via MCP) isn't lost,
 * while our own unflushed edits still win. New annotations added externally are
 * left alone — the live session owns creation.
 * @param {string} filePath
 * @param {import('../types.js').ReviewData} data live in-memory data (mutated)
 * @param {Map<string, string>} lastStatuses id → status at our last flush/load
 */
function mergeExternalStatuses(filePath, data, lastStatuses) {
  let onDisk;
  try { onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return; }
  if (!onDisk || !Array.isArray(onDisk.annotations)) return;
  const byId = new Map(data.annotations.map(a => [a.id, a]));
  for (const ext of onDisk.annotations) {
    const local = byId.get(ext.id);
    if (!local || !ext.status || ext.status === local.status) continue;
    const localUnchanged = local.status === lastStatuses.get(ext.id);
    // Only adopt the external status where we haven't made a competing local edit.
    if (localUnchanged) {
      local.status = ext.status;
      if (ext.verifiedAt) local.verifiedAt = ext.verifiedAt;
    }
  }
}

/**
 * Turn an annotation id into a safe filename fragment — merged ids contain `:`
 * which is illegal on Windows (`kevin:a1` → `kevin_a1`).
 * @param {string} id
 * @returns {string}
 */
export function fileSafeId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Resolve a screenshot path from (untrusted) annotation data safely: it must be
 * a relative path that stays inside `baseDir`. Annotation files are shared between
 * people and edited by agents, so a crafted `../../.env` must never escape.
 * @param {string} baseDir directory the relative path is anchored to
 * @param {unknown} rel the `screenshot`/`screenshotAfter` value from the file
 * @returns {string | null} the absolute path when safe, else null
 */
export function safeShotPath(baseDir, rel) {
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
 * @param {string | undefined} url
 * @returns {string}
 */
export function safeHost(url) {
  try { return new URL(url).hostname; } catch { return 'review'; }
}
