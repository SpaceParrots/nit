// SPDX-License-Identifier: AGPL-3.0-or-later
// nit import — unpack a review zip produced by `nit export` into a local folder,
// ready for `nit view`, `nit verify`, `nit merge` or `nit mcp`.
import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';

/** Options for {@link runImport}. */
export interface ImportOptions {
  /** target directory (default: derived from the zip file name) */
  out?: string;
  /** log sink */
  log?: (line: string) => void;
}

/** What {@link runImport} unpacked. */
export interface ImportResult {
  /** absolute path of the review directory */
  dir: string;
  /** number of files written */
  files: number;
}

/**
 * Unpack a nit export. The zip must contain an annotations.json — at its root
 * for a single review, or one per base folder for a whole workspace. Entries
 * that would escape the target directory (zip-slip) are skipped, and an existing
 * non-empty target is refused rather than overwritten.
 * @param zipFile a zip created by `nit export`
 * @param opts see {@link ImportOptions}
 * @throws when the file is not a nit export or the target dir is already in use
 */
export function runImport(zipFile: string, { out, log = line => console.log(line) }: ImportOptions = {}): ImportResult {
  const absZip = path.resolve(zipFile);
  if (!fs.existsSync(absZip)) throw new Error(`file not found: ${absZip}`);
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(fs.readFileSync(absZip));
  } catch (e) {
    throw new Error(`cannot read ${absZip} — not a valid zip file`, { cause: e });
  }
  // A workspace export nests one review folder per base, so the root file is
  // absent by design; anything with neither shape is not a nit export.
  const isWorkspace = Object.keys(entries).some(name => /^[^/]+\/annotations\.json$/.test(name));
  if (!entries['annotations.json'] && !isWorkspace) {
    throw new Error(`not a nit export: ${path.basename(absZip)} has no annotations.json`);
  }

  const target = path.resolve(out ?? defaultDirName(absZip));
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
    throw new Error(`${target} already exists and is not empty — pass --out <dir> to import elsewhere`);
  }
  fs.mkdirSync(target, { recursive: true });

  let files = 0;
  for (const [name, content] of Object.entries(entries)) {
    if (name.endsWith('/')) continue; // directory marker entries
    // The zip comes from someone else: never let an entry escape the target dir.
    const safe = safeEntryPath(target, name);
    if (!safe) {
      log(`! skipped unsafe zip entry: ${name}`);
      continue;
    }
    fs.mkdirSync(path.dirname(safe), { recursive: true });
    fs.writeFileSync(safe, content);
    files++;
  }

  const rel = path.relative(process.cwd(), target) || '.';
  log(`imported ${files} file${files === 1 ? '' : 's'} -> ${target}`);
  if (isWorkspace) {
    log(`see what is in it:  nit list ${rel}`);
    log(`view one base:      nit view ${rel} --base <name>`);
  } else {
    log(`view it:    nit view ${path.join(rel, 'annotations.json')}`);
    log(`merge it:   nit merge <your>/annotations.json ${path.join(rel, 'annotations.json')}`);
  }
  return { dir: target, files };
}

/**
 * Resolve a zip entry name under the target dir, or null when it is absolute,
 * contains `..`, or otherwise resolves outside the target (zip-slip).
 */
function safeEntryPath(targetDir: string, entryName: string): string | null {
  const normalized = entryName.replace(/\\/g, '/');
  if (normalized.includes('\0') || path.posix.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) return null;
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0 || segments.includes('..')) return null;
  const resolved = path.resolve(targetDir, ...segments);
  const prefix = targetDir.endsWith(path.sep) ? targetDir : targetDir + path.sep;
  return resolved.startsWith(prefix) ? resolved : null;
}

/** `feedback-ann.nit.zip` → `feedback-ann`; falls back to `nit-import`. */
function defaultDirName(absZip: string): string {
  return path.basename(absZip).replace(/\.zip$/i, '').replace(/\.nit$/i, '') || 'nit-import';
}
