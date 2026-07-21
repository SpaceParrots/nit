// SPDX-License-Identifier: AGPL-3.0-or-later
// nit merge <file...> — combine feedback files into one consolidated review.
import fs from 'node:fs';
import path from 'node:path';
import { mergeReviews } from '../store/merge.js';
import type { MergeInput } from '../store/merge.js';
import { safeShotPath } from '../store/store.js';
import { renderReviewMd, FIX_ANNOTATIONS_MD } from '../store/render.js';
import { errorMessage } from '../util/error.js';
import type { ReviewData } from '../types.js';

/** Options for {@link runMerge}. */
export interface RunMergeOptions {
  /** output directory (default `nit-review-merged`) */
  out?: string;
  /** log sink */
  log?: (line: string) => void;
}

/**
 * Read feedback files, merge them ({@link mergeReviews}), copy screenshots into
 * the shared output dir and write annotations.json + review.md + fix-annotations.md.
 * @param files paths of nit feedback files (one per author)
 * @throws when a file is missing, unreadable, or not a nit feedback file
 */
export function runMerge(
  files: string[],
  { out = 'nit-review-merged', log = line => console.log(line) }: RunMergeOptions = {},
): { outDir: string; data: ReviewData } {
  if (files.length < 1) throw new Error('nit merge needs at least one feedback file');

  const inputs: MergeInput[] = files.map(f => {
    const filePath = path.resolve(f);
    let data: unknown;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      throw new Error(`cannot read feedback file ${filePath}: ${errorMessage(e)}`, { cause: e });
    }
    if (!data || typeof data !== 'object' || !Array.isArray((data as ReviewData).annotations)) {
      throw new Error(`not a nit feedback file (missing annotations array): ${filePath}`);
    }
    return { data: data as ReviewData, dir: path.dirname(filePath) };
  });

  const { data, copies } = mergeReviews(inputs);
  const outDir = path.resolve(out);
  fs.mkdirSync(path.join(outDir, 'shots'), { recursive: true });

  let missingShots = 0;
  for (const c of copies) {
    // Input feedback files come from other people — never copy a screenshot path
    // that escapes the file's own directory.
    const from = safeShotPath(c.fromDir, c.from);
    if (!from) {
      missingShots++;
      log(`! skipped unsafe screenshot path: ${c.from}`);
      continue;
    }
    try {
      fs.copyFileSync(from, path.join(outDir, c.to));
    } catch {
      missingShots++;
      log(`! screenshot missing: ${from}`);
    }
  }

  fs.writeFileSync(path.join(outDir, 'annotations.json'), JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(outDir, 'review.md'), renderReviewMd(data), 'utf8');
  fs.writeFileSync(path.join(outDir, 'fix-annotations.md'), FIX_ANNOTATIONS_MD, 'utf8');
  log(`merged ${files.length} file${files.length === 1 ? '' : 's'} -> ${outDir} (${data.annotations.length} annotations, ${data.review.authors.join(', ')})${missingShots ? ` — ${missingShots} shots missing` : ''}`);
  return { outDir, data };
}
