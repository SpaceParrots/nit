// SPDX-License-Identifier: AGPL-3.0-or-later
// Resolving what `nit view` / `nit verify` were pointed at — a review directory,
// a feedback file, or nothing at all (the default nit-review/) — into a real
// annotations file. The browser is expensive to open on nothing, so every dead
// end (missing file, empty review, no fixed items) is caught here first, with
// an error that always names the next step.
import fs from 'node:fs';
import { resolveReviewFile } from '../store/store.js';
import { isActionable } from '../store/stats.js';
import { displayPath } from './status.js';
import { errorMessage } from '../util/error.js';
import type { Annotation, ReviewData } from '../types.js';

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
 * Resolve the `[source]` argument of `nit view` / `nit verify` and check there
 * is actually something for the command to do.
 * @param cmd which command asks — each phrases its own suggestions
 * @param input what the user typed, or the default `nit-review`
 * @param explicit whether the user typed it — a defaulted lookup phrases the
 *   not-found error as "no review found" rather than blaming a path the user
 *   never gave
 * @throws with a short suggestion list when the file is missing, unreadable,
 *   or holds no work for the command
 */
export function resolveFeedbackSource(cmd: 'view' | 'verify', input: string, explicit: boolean): FeedbackSource {
  const { dir, file, exists } = resolveReviewFile(input);
  const where = displayPath(file);
  if (!exists) {
    throw new Error((explicit
      ? `no annotations file at ${where}`
      : `no review found — looked for ${where}`) + '\n' + notFoundHints(cmd));
  }

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
      const view = `  Look at the review any time:  nit view ${explicit ? input : ''}`.trimEnd();
      throw new Error(actionable
        ? `nothing to verify in ${where} — no annotation is marked fixed yet\n`
          + `  ${actionable} actionable change-request${actionable === 1 ? ' is' : 's are'} waiting — hand them to your agent:  nit mcp ${displayPath(dir)}\n`
          + view
        : `nothing left to verify in ${where} — every change-request is ruled\n` + view);
    }
  }

  return { file, dir, data, annotations };
}

/** The next steps when there is no annotations file where we looked. */
function notFoundHints(cmd: 'view' | 'verify'): string {
  return '  Start a review:      nit review http://localhost:3000\n'
    + `  Point nit at one:    nit ${cmd} <dir or annotations.json>\n`
    + '  See what is where:   nit status';
}
