// nit merge <file...> — combine feedback files into one consolidated review.
import fs from 'node:fs';
import path from 'node:path';
import { mergeReviews } from '../store/merge.js';
import { renderReviewMd, FIX_ANNOTATIONS_MD } from '../store/render.js';

export function runMerge(files, { out = 'nit-review-merged', log = line => console.log(line) } = {}) {
  if (files.length < 1) throw new Error('nit merge needs at least one feedback file');

  const inputs = files.map(f => {
    const filePath = path.resolve(f);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      throw new Error(`cannot read feedback file ${filePath}: ${e.message}`);
    }
    if (!data || !Array.isArray(data.annotations)) {
      throw new Error(`not a nit feedback file (missing annotations array): ${filePath}`);
    }
    return { data, dir: path.dirname(filePath) };
  });

  const { data, copies } = mergeReviews(inputs);
  const outDir = path.resolve(out);
  fs.mkdirSync(path.join(outDir, 'shots'), { recursive: true });

  let missingShots = 0;
  for (const c of copies) {
    try {
      fs.copyFileSync(path.join(c.fromDir, c.from), path.join(outDir, c.to));
    } catch {
      missingShots++;
      log(`! screenshot missing: ${path.join(c.fromDir, c.from)}`);
    }
  }

  fs.writeFileSync(path.join(outDir, 'annotations.json'), JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(outDir, 'review.md'), renderReviewMd(data), 'utf8');
  fs.writeFileSync(path.join(outDir, 'fix-annotations.md'), FIX_ANNOTATIONS_MD, 'utf8');
  log(`merged ${files.length} file${files.length === 1 ? '' : 's'} -> ${outDir} (${data.annotations.length} annotations, ${data.review.authors.join(', ')})${missingShots ? ` — ${missingShots} shots missing` : ''}`);
  return { outDir, data };
}
