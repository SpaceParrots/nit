// Read/write annotations.json (SPEC §3): stable ids, idempotent append, atomic writes.
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string} dir output directory (contains annotations.json + shots/)
 * @param {{url?: string, author?: string, file?: string}} opts
 *   file: explicit annotations file path (nit view <file> with arbitrary names)
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
      if (ann.screenshot) {
        try { fs.unlinkSync(path.join(dir, ann.screenshot)); } catch { /* already gone */ }
      }
      return true;
    },

    shotPath(id) {
      return path.join(shotsDir, `${fileSafeId(id)}.png`);
    },

    flush() {
      const tmp = filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, filePath);
    },
  };
}

export function fileSafeId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function safeHost(url) {
  try { return new URL(url).hostname; } catch { return 'review'; }
}
