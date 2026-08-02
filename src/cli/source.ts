// SPDX-License-Identifier: AGPL-3.0-or-later
// Resolving what `nit view` / `nit verify` were pointed at — a review directory,
// a feedback file, the name of a base in the default nit-review/, or nothing at
// all — into a real annotations file. The browser is expensive to open on
// nothing, so every dead end (missing file, empty review, no fixed items) is
// caught here first, with an error that always names the next step.
//
// This module never prompts: a dead end the user could still walk out of by
// naming a base is thrown as an AmbiguousSourceError carrying the bases, and
// `pick.ts` turns that into a @clack picker when there is a terminal to ask.
import fs from 'node:fs';
import path from 'node:path';
import { resolveReviewFile } from '../store/store.js';
import {
  openWorkspace, resolveBase, matchBases, describeBases, ambiguousBaseMessage,
} from '../store/workspace.js';
import { isActionable } from '../store/stats.js';
import { displayPath } from './status.js';
import { DEFAULT_REVIEW_DIR } from './setup.js';
import { errorMessage } from '../util/error.js';
import type { Annotation, BaseRef, ReviewData, Workspace } from '../types.js';

/** A resolved, readable feedback source for a view/verify session. */
export interface FeedbackSource {
  /** absolute path of the annotations file to load */
  file: string;
  /** its review directory */
  dir: string;
  /** the parsed file content (valid JSON, annotation-shaped entries only) */
  data: ReviewData;
  /** the file's annotations that are object-shaped (the file is hand-editable) */
  annotations: Annotation[];
}

/**
 * A dead end that naming a base would resolve — several bases and no pick, a
 * `--base` that matches nothing or too much, a source that is neither a path
 * nor a base. The `message` is the complete guidance a non-interactive run
 * prints, unchanged from what nit has always reported; the extra fields let an
 * interactive run offer the choice instead (see `resolveFeedbackSourceOrPick`).
 */
export class AmbiguousSourceError extends Error {
  /** the bases worth offering, in the order they should be shown */
  readonly bases: BaseRef[];
  /** one-line question for the picker */
  readonly question: string;
  /** the workspace the bases belong to — a pick re-resolves against this */
  readonly dir: string;

  constructor(message: string, question: string, bases: BaseRef[], dir: string) {
    super(message);
    this.name = 'AmbiguousSourceError';
    this.question = question;
    this.bases = bases;
    this.dir = dir;
  }
}

/**
 * Resolve the `[source]` argument of `nit view` / `nit verify` and check there
 * is actually something for the command to do.
 *
 * A workspace covering several base URLs has to narrow to one first: both
 * commands drive a browser at exactly one site. A workspace with a single base
 * is used silently; several bases require naming one rather than a guess about
 * which environment the human meant — either with `--base`, or by passing the
 * base's name as the source itself (`nit verify localhost-5273`), which is
 * resolved against the default review folder once it turns out to be no path.
 * @param cmd which command asks — each phrases its own suggestions
 * @param input what the user typed — a directory, a feedback file, a base name,
 *   or the default `nit-review`
 * @param explicit whether the user typed it — a defaulted lookup phrases the
 *   not-found error as "no review found" rather than blaming a path the user
 *   never gave
 * @param base optional base to work on — a slug, a url, or an unambiguous prefix
 * @param cwd the project root a relative `input` — and the default review
 *   folder a base name is looked up in — resolves against
 * @throws with a short suggestion list when the file is missing, unreadable,
 *   or holds no work for the command; when `base` names no base (via
 *   {@link resolveBase}); or when the workspace holds several bases and none
 *   was named
 */
export function resolveFeedbackSource(
  cmd: 'view' | 'verify',
  input: string,
  explicit: boolean,
  base?: string,
  cwd: string = process.cwd(),
): FeedbackSource {
  // Every path the user gives is read relative to the project root, the same
  // one the default review folder is looked up in.
  const target = path.resolve(cwd, input);
  const ws = openWorkspace(target);
  if (base) {
    // a flat review resolves to the folder itself, so this covers both layouts
    const ref = pickedBase(ws, base);
    return readSource(cmd, ref.file, `${input} --base ${ref.slug}`);
  }
  if (ws.layout === 'multi') {
    if (ws.bases.length === 1) return readSource(cmd, ws.bases[0].file, input);
    throw new AmbiguousSourceError(
      `${displayPath(ws.dir)} holds ${ws.bases.length} base URLs — pass --base to pick one\n`
        + `  bases: ${describeBases(ws)}\n`
        // In the default folder a bare base name is enough, and that is the
        // shorter thing to remember; elsewhere the folder has to be named too.
        + `  e.g.  nit ${cmd} ${isDefaultDir(target, cwd) ? ws.bases[0].slug : `${input} --base ${ws.bases[0].slug}`}`,
      `${displayPath(ws.dir)} holds ${ws.bases.length} base URLs — which one?`,
      ws.bases, ws.dir);
  }

  const { file, exists } = resolveReviewFile(target);
  if (!exists) {
    // Nothing at that path — but a name that is no path here is very likely a
    // *base* of the default review folder: `nit verify localhost-5273` is the
    // shorthand everyone reaches for after nit has printed those slugs.
    const fallback = defaultWorkspace(cwd);
    // Only a name that is no path at all may be read as a base. `exists` above
    // means "holds an annotations.json", so without the existsSync a plain
    // directory — an app folder called `staging` next to a `staging` base —
    // would be silently swapped for a review the user never pointed at.
    if (explicit && !isDefaultDir(target, cwd) && !fs.existsSync(target)) {
      const matches = matchBases(fallback, input);
      if (matches.length === 1) return readSource(cmd, matches[0].file, `--base ${matches[0].slug}`);
      if (matches.length > 1) {
        throw new AmbiguousSourceError(ambiguousBaseMessage(input, matches),
          `"${input}" matches ${matches.length} bases — which one?`, matches, fallback.dir);
      }
    }
    const where = displayPath(file);
    const message = (explicit
      ? `no annotations file at ${where}`
      : `no review found — looked for ${where}`) + '\n' + notFoundHints(cmd, fallback);
    // The name fits nothing, but the default folder does hold reviews — that is
    // still a choice worth offering rather than a plain dead end.
    if (fallback.bases.length) {
      throw new AmbiguousSourceError(message,
        `no review at "${input}" — which base of ${displayPath(fallback.dir)}?`,
        fallback.bases, fallback.dir);
    }
    throw new Error(message);
  }
  return readSource(cmd, file, explicit ? input : '');
}

/**
 * The base a `--base` argument names, as an {@link AmbiguousSourceError} when
 * it names none: a mistyped or half-typed environment is exactly the moment an
 * interactive run should show the list instead of stopping.
 */
function pickedBase(ws: Workspace, base: string): BaseRef {
  try {
    return resolveBase(ws, base);
  } catch (e) {
    if (!ws.bases.length) throw e;
    // an ambiguous name already narrowed the field — offer only those
    const matches = matchBases(ws, base);
    throw new AmbiguousSourceError(errorMessage(e),
      `"${base}" names no single base — which one?`,
      matches.length > 1 ? matches : ws.bases, ws.dir);
  }
}

/** Whether a resolved path is just the default review folder of `cwd`. */
function isDefaultDir(target: string, cwd: string): boolean {
  return target === path.resolve(cwd, DEFAULT_REVIEW_DIR);
}

/** The default review folder of `cwd`, as a workspace. */
function defaultWorkspace(cwd: string): Workspace {
  return openWorkspace(path.resolve(cwd, DEFAULT_REVIEW_DIR));
}

/**
 * Read one annotations file and check it holds work for `cmd`.
 * @param cmd which command asks
 * @param file an annotations file that exists
 * @param viewTarget what a "look at it with nit view" hint should point at;
 *   empty when the caller defaulted its way here and has no path to echo back
 * @throws when the file is not readable as JSON, has no annotations, or (for
 *   `verify`) holds nothing marked fixed
 */
function readSource(cmd: 'view' | 'verify', file: string, viewTarget: string): FeedbackSource {
  const dir = path.dirname(file);
  const where = displayPath(file);

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${where} is not readable as JSON (${errorMessage(e)})`, { cause: e });
  }
  const data = (raw && typeof raw === 'object' ? raw : { annotations: [] }) as ReviewData;
  // The file is shared and hand-editable — keep only object-shaped entries, the
  // same tolerance the stats module applies.
  const annotations = (Array.isArray(data.annotations) ? data.annotations : [])
    .filter((a): a is Annotation => Boolean(a) && typeof a === 'object');

  if (!annotations.length) {
    throw new Error(`nothing to ${cmd} — ${where} has no annotations yet\n`
      + `  Capture some first:  nit review ${data.review?.url || '<url>'}`);
  }

  if (cmd === 'verify') {
    const fixed = annotations.filter(a => a.status === 'fixed').length;
    if (!fixed) {
      const actionable = annotations.filter(isActionable).length;
      const view = `  Look at the review any time:  nit view ${viewTarget}`.trimEnd();
      throw new Error(actionable
        ? `nothing to verify in ${where} — no annotation is marked fixed yet\n`
          + `  ${actionable} actionable change-request${actionable === 1 ? ' is' : 's are'} waiting — hand them to your agent:  nit mcp ${displayPath(dir)}\n`
          + view
        : `nothing left to verify in ${where} — every change-request is ruled\n` + view);
    }
  }

  return { file, dir, data, annotations };
}

/**
 * The next steps when there is no annotations file where we looked. A default
 * review folder that does hold bases is listed first: the name the user typed
 * was close to one of these, and seeing the real slugs beats guessing again.
 */
function notFoundHints(cmd: 'view' | 'verify', ws: Workspace): string {
  const only = ws.bases.length === 1;
  const bases = ws.bases.length
    ? hint(`In ${displayPath(ws.dir)}`, describeBases(ws))
      // a single base needs no name at all — the bare command finds it
      + hint(only ? 'Open it' : 'Open one of them', `nit ${cmd}${only ? '' : ` ${ws.bases[0].slug}`}`)
    : '';
  return (bases
    + hint('Start a review', 'nit review http://localhost:3000')
    + hint('Point nit at one', `nit ${cmd} <dir or annotations.json>`)
    + hint('See what is where', 'nit status')).trimEnd();
}

/** One `  label:   value` suggestion line. The column fits the longest label. */
function hint(label: string, value: string): string {
  return `${`  ${label}:`.padEnd(HINT_COLUMN)}${value}\n`;
}

/** Where the value column of {@link hint} starts. */
const HINT_COLUMN = 23;
