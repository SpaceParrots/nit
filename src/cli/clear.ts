// SPDX-License-Identifier: AGPL-3.0-or-later
// nit clear — remove annotations from one base or from every base. Destructive,
// so a scope is mandatory (never guessed), the prompt names what is about to go,
// and --dry-run shows the same numbers without writing.
import { confirm, isCancel } from '@clack/prompts';
import { openWorkspace, resolveBase, describeBases } from '../store/workspace.js';
import { clearBase } from '../store/clear.js';
import type { ClearResult } from '../store/clear.js';
import { displayPath } from './status.js';
import type { AnnotationStatus, BaseRef } from '../types.js';

/** Options for {@link runClear}. */
export interface ClearOptions {
  /** clear this base only — a slug, a url, or an unambiguous prefix */
  base?: string;
  /** clear every base */
  all?: boolean;
  /** only annotations with this status (`--verified` maps to `'verified'`) */
  status?: AnnotationStatus;
  /** skip the confirmation prompt */
  yes?: boolean;
  /** report what would go, write nothing */
  dryRun?: boolean;
  /** log sink */
  log?: (line: string) => void;
}

/**
 * Clear annotations from a review workspace.
 *
 * A scope is mandatory: bare `nit clear` lists the bases and refuses, rather
 * than guessing which environment the user meant. The base folder and its review
 * metadata always survive — this clears annotations, not environments.
 * @param dir the workspace directory (default `nit-review`)
 * @param opts see {@link ClearOptions}
 * @returns one result per base that was cleared
 * @throws when no scope (or both scopes) are given, when the base does not
 *   exist, or when a confirmation is needed but stdin is not a terminal
 */
export async function runClear(
  dir = 'nit-review',
  { base, all, status, yes = false, dryRun = false, log = line => console.log(line) }: ClearOptions = {},
): Promise<ClearResult[]> {
  const ws = openWorkspace(dir);
  if (base && all) throw new Error('pass either --base <name> or --all, not both');
  if (!base && !all) {
    throw new Error('nit clear needs a scope — pass --base <name> or --all\n'
      + `  bases in ${displayPath(ws.dir)}: ${describeBases(ws)}\n`
      + `  e.g.  nit clear --base ${ws.bases[0]?.slug ?? '<name>'} --verified`);
  }
  if (!ws.bases.length) throw new Error(`no review in ${displayPath(ws.dir)} — nothing to clear`);

  const targets: BaseRef[] = base ? [resolveBase(ws, base)] : ws.bases;
  const scope = status ? { status } : {};

  // Count first, so the prompt (and a dry run) state exactly what is at stake.
  const preview = targets.map(t => clearBase(t, scope, { dryRun: true }));
  const total = preview.reduce((n, r) => n + r.cleared, 0);
  const what = status ? `${status} annotation` : 'annotation';
  const where = base ? `base ${targets[0].slug}` : `${targets.length} base${targets.length === 1 ? '' : 's'}`;

  if (!total) {
    log(`nothing to clear — no ${what}s in ${where}`);
    return preview;
  }
  if (dryRun) {
    log(`would clear ${total} ${what}${total === 1 ? '' : 's'} from ${where}:`);
    for (const r of preview.filter(r => r.cleared)) log(`  ${r.slug}  ${r.cleared} (${r.remaining} would remain)`);
    return preview;
  }
  if (!yes) {
    if (!process.stdin.isTTY) {
      throw new Error(`refusing to clear ${total} ${what}${total === 1 ? '' : 's'} without a confirmation — pass --yes for scripts`);
    }
    const ok = await confirm({ message: `Clear ${total} ${what}${total === 1 ? '' : 's'} from ${where}? This cannot be undone.` });
    if (isCancel(ok) || !ok) {
      log('cancelled — nothing was cleared');
      return [];
    }
  }

  // Re-run for real rather than reusing `preview`: clearBase re-opens the store
  // each call, and another writer (an agent via MCP, a second `nit` process) can
  // change the review in the window between the preview and this confirmation.
  // Reporting `preview`'s numbers here could tell the user something false —
  // always report what this run actually removed.
  const results = targets.map(t => clearBase(t, scope));
  const cleared = results.reduce((n, r) => n + r.cleared, 0);
  log(`cleared ${cleared} ${what}${cleared === 1 ? '' : 's'} from ${where}`);
  for (const r of results.filter(r => r.cleared)) log(`  ${r.slug}  -${r.cleared} (${r.remaining} left)`);
  return results;
}
