// SPDX-License-Identifier: AGPL-3.0-or-later
// Re-rendering the files derived from annotations.json. Shared by every writer
// outside a browser session (the MCP tools, `nit clear`) so they cannot drift
// apart on which files a write is supposed to refresh.
import fs from 'node:fs';
import path from 'node:path';
import { renderReviewMd, FIX_ANNOTATIONS_MD } from './render.js';
import type { Store } from './store.js';

/**
 * Rewrite `review.md` and `fix-annotations.md` from the store's current data.
 * Best effort: a read-only or full disk must not fail the write that already
 * landed in annotations.json.
 * @param store a store whose data has already been flushed
 */
export function writeDerivedFiles(store: Store): void {
  try {
    fs.writeFileSync(path.join(store.dir, 'review.md'), renderReviewMd(store.data), 'utf8');
    fs.writeFileSync(path.join(store.dir, 'fix-annotations.md'), FIX_ANNOTATIONS_MD, 'utf8');
  } catch { /* best effort */ }
}
