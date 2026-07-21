// Pure merge of N feedback files into one consolidated review (SPEC §2.5, §8).
// Ids are namespaced by author (kevin:a1); screenshots are renamed into a shared shots/.
import { fileSafeId } from './store.js';

/**
 * Merge parsed feedback files into one consolidated review. Pure function — the
 * caller performs the returned screenshot copies.
 * @param {Array<{data: import('../types.js').ReviewData, dir: string}>} inputs
 *   parsed feedback files plus the directory each was loaded from (screenshot
 *   paths are relative to it)
 * @param {{now?: Date}} [opts] injectable clock for the merged review's metadata
 *   (annotations keep their own `createdAt`)
 * @returns {{data: import('../types.js').ReviewData, copies: Array<{fromDir: string, from: string, to: string}>}}
 *   the merged review plus the list of screenshot files to copy into the output dir
 */
export function mergeReviews(inputs, { now = new Date() } = {}) {
  const authors = [];
  const annotations = [];
  const copies = [];
  const usedIds = new Set();
  let url = '';

  for (const input of inputs) {
    const review = (input.data && input.data.review) || {};
    if (!url && review.url) url = review.url;
    for (const a of review.authors || []) addUnique(authors, a);

    for (const ann of (input.data && input.data.annotations) || []) {
      const author = ann.author || 'unknown';
      addUnique(authors, author);

      const base = ann.id.includes(':') ? ann.id : `${slug(author)}:${ann.id}`;
      let id = base;
      for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
      usedIds.add(id);

      const merged = { ...ann, id, author };
      if (ann.screenshot) {
        const to = `shots/${fileSafeId(id)}.png`;
        copies.push({ fromDir: input.dir, from: ann.screenshot, to });
        merged.screenshot = to;
      }
      if (ann.screenshotAfter) {
        const to = `shots/${fileSafeId(id)}-after.png`;
        copies.push({ fromDir: input.dir, from: ann.screenshotAfter, to });
        merged.screenshotAfter = to;
      }
      annotations.push(merged);
    }
  }

  return {
    data: {
      review: {
        id: `${now.toISOString().slice(0, 10)}-merged`,
        url,
        createdAt: now.toISOString(),
        authors,
      },
      annotations,
    },
    copies,
  };
}

function addUnique(arr, v) {
  if (v && !arr.includes(v)) arr.push(v);
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}
