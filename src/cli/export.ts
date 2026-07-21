// SPDX-License-Identifier: AGPL-3.0-or-later
// nit export — pack a review folder (annotations.json + review.md + shots/) into
// a single shareable zip, so co-founders can hand reviews to each other.
import fs from 'node:fs';
import path from 'node:path';
import { zipSync } from 'fflate';
import { slugify } from '../util/slug.js';
import type { ReviewData } from '../types.js';

/** Options for {@link runExport}. */
export interface ExportOptions {
  /** output zip path (default: `<review.id>-<author>.nit.zip` in the cwd) */
  out?: string;
  /** log sink */
  log?: (line: string) => void;
}

/** What {@link runExport} wrote. */
export interface ExportResult {
  /** absolute path of the zip */
  file: string;
  /** number of files packed */
  files: number;
}

/**
 * Pack a review into a zip: annotations.json (required), review.md /
 * fix-annotations.md (when present) and every screenshot in shots/. The
 * counterpart is `nit import`.
 * @param input review directory, or the path of an annotations.json inside one
 * @throws when there is no annotations.json to export
 */
export function runExport(input = 'nit-review', { out, log = line => console.log(line) }: ExportOptions = {}): ExportResult {
  const inputPath = path.resolve(input);
  const isFile = fs.existsSync(inputPath) && fs.statSync(inputPath).isFile();
  const dir = isFile ? path.dirname(inputPath) : inputPath;
  const annotationsFile = isFile ? inputPath : path.join(dir, 'annotations.json');
  if (!fs.existsSync(annotationsFile)) {
    throw new Error(`no annotations.json in ${dir} — nothing to export (run: nit review <url>)`);
  }

  const entries: Record<string, Uint8Array> = {
    'annotations.json': fs.readFileSync(annotationsFile),
  };
  for (const extra of ['review.md', 'fix-annotations.md']) {
    const p = path.join(dir, extra);
    if (fs.existsSync(p)) entries[extra] = fs.readFileSync(p);
  }
  const shotsDir = path.join(dir, 'shots');
  if (fs.existsSync(shotsDir)) {
    for (const name of fs.readdirSync(shotsDir)) {
      const p = path.join(shotsDir, name);
      if (fs.statSync(p).isFile()) entries[`shots/${name}`] = fs.readFileSync(p);
    }
  }

  const file = path.resolve(out ?? defaultZipName(entries['annotations.json']));
  fs.writeFileSync(file, zipSync(entries, { level: 6 }));
  const count = Object.keys(entries).length;
  log(`exported ${count} file${count === 1 ? '' : 's'} -> ${file}`);
  log(`share it — the other side runs:  nit import ${path.basename(file)}`);
  return { file, files: count };
}

/** `<review.id>-<first author>.nit.zip`, sanitized for the filesystem. */
function defaultZipName(annotationsRaw: Uint8Array): string {
  let review: Partial<ReviewData['review']> | undefined;
  try {
    review = (JSON.parse(Buffer.from(annotationsRaw).toString('utf8')) as Partial<ReviewData>).review;
  } catch { /* corrupt file still exports; fall back to a generic name */ }
  const id = review?.id ?? 'nit-review';
  const author = review?.authors?.[0];
  const base = `${id}${author ? `-${slugify(author)}` : ''}`.replace(/[^a-zA-Z0-9._-]+/g, '-');
  return `${base}.nit.zip`;
}
