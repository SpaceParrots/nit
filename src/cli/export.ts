// SPDX-License-Identifier: AGPL-3.0-or-later
// nit export — pack a review folder (annotations.json + review.md + shots/) into
// a single shareable zip, so co-founders can hand reviews to each other.
import fs from 'node:fs';
import path from 'node:path';
import { zipSync } from 'fflate';
import { resolveReviewFile } from '../store/store.js';
import { BASES_FILE, openWorkspace, resolveBase } from '../store/workspace.js';
import { slugify } from '../util/slug.js';
import type { ReviewData, Workspace } from '../types.js';

/** Options for {@link runExport}. */
export interface ExportOptions {
  /** pack only this base — a slug, a url, or an unambiguous prefix */
  base?: string;
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
 *
 * A workspace covering several base URLs packs every base, each under its own
 * folder, plus `bases.json`. Naming one with `base` — or having only one —
 * produces the plain single-review zip nit has always written, so a shared zip
 * and the co-founder flow are unaffected by the workspace layout.
 * @param input review directory, workspace directory, or the path of an
 *   annotations.json inside one
 * @param opts see {@link ExportOptions}
 * @throws when there is no annotations.json to export, or when `base` names no
 *   base in the workspace (via {@link resolveBase})
 */
export function runExport(
  input = 'nit-review',
  { base, out, log = line => console.log(line) }: ExportOptions = {},
): ExportResult {
  const ws = openWorkspace(input);
  if (base) return packReview(resolveBase(ws, base).dir, out, log);
  // Several bases have to keep their folders apart in the zip; a single base is
  // unambiguous, so it travels in the flat shape every older nit can import.
  if (ws.layout === 'multi') {
    return ws.bases.length === 1 ? packReview(ws.bases[0].dir, out, log) : packWorkspace(ws, out, log);
  }
  return packReview(input, out, log);
}

/** Pack one review folder — the zip format `nit import` has always taken. */
function packReview(input: string, out: string | undefined, log: (line: string) => void): ExportResult {
  const { dir, file: annotationsFile, exists } = resolveReviewFile(input);
  if (!exists) {
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

/**
 * Pack a whole workspace: its base index plus every base's review folder, each
 * under its own slug. The counterpart is `nit import`, which recognises the
 * nested shape and restores the workspace as it was.
 * @param ws the workspace to pack
 * @param out output zip path, or undefined for the derived name
 * @param log log sink
 */
function packWorkspace(ws: Workspace, out: string | undefined, log: (line: string) => void): ExportResult {
  const entries: Record<string, Uint8Array> = {};
  const index = path.join(ws.dir, BASES_FILE);
  if (fs.existsSync(index)) entries[BASES_FILE] = fs.readFileSync(index);

  for (const base of ws.bases) {
    entries[`${base.slug}/annotations.json`] = fs.readFileSync(base.file);
    for (const extra of ['review.md', 'fix-annotations.md']) {
      const p = path.join(base.dir, extra);
      if (fs.existsSync(p)) entries[`${base.slug}/${extra}`] = fs.readFileSync(p);
    }
    const shotsDir = path.join(base.dir, 'shots');
    if (!fs.existsSync(shotsDir)) continue;
    for (const name of fs.readdirSync(shotsDir)) {
      const p = path.join(shotsDir, name);
      if (fs.statSync(p).isFile()) entries[`${base.slug}/shots/${name}`] = fs.readFileSync(p);
    }
  }

  const file = path.resolve(out ?? `${slugify(path.basename(ws.dir))}-workspace.nit.zip`);
  fs.writeFileSync(file, zipSync(entries, { level: 6 }));
  const count = Object.keys(entries).length;
  log(`exported ${count} file${count === 1 ? '' : 's'} from ${ws.bases.length} base URL${ws.bases.length === 1 ? '' : 's'} -> ${file}`);
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
