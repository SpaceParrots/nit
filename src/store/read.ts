// SPDX-License-Identifier: AGPL-3.0-or-later
// The one tolerant reader for annotations.json, shared by every read-only
// consumer (`nit status`, `nit list`, a `nit clear` dry run). The file is shared
// between people, hand-editable and agent-written, so a *report* must never
// crash on it — but it must not be trusted either: nothing here casts parsed
// JSON into a nit type, every field is narrowed on the way in.
//
// Writers do not use this module: they go through `createStore`, which owns
// normalization, the corrupt-file backup and the atomic write.
import fs from 'node:fs';
import type { Annotation, Review, ReviewData } from '../types.js';

/**
 * Narrow parsed JSON into a {@link ReviewData} without casting: anything the
 * wrong shape becomes its empty equivalent rather than flowing inward.
 * @param parsed the result of `JSON.parse` on an annotations file
 * @returns a review that is always safe to read — no missing `review` block,
 *   no non-object entries in `annotations`
 */
export function asReviewData(parsed: unknown): ReviewData {
  const source = isRecord(parsed) ? parsed : {};
  return { review: asReview(source.review), annotations: asAnnotations(source.annotations) };
}

/**
 * Read a review file for reporting. An unreadable, missing or corrupt file
 * reads as an empty review — a report's job is to describe what is there, not
 * to validate or repair it (that is `createStore`'s job, on the write path).
 * @param file absolute path of an annotations.json
 */
export function readReviewData(file: string): ReviewData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return asReviewData(undefined);
  }
  return asReviewData(parsed);
}

/**
 * Just the annotations of a review file, same tolerance as
 * {@link readReviewData}.
 * @param file absolute path of an annotations.json
 */
export function readAnnotations(file: string): Annotation[] {
  return readReviewData(file).annotations;
}

/** The review block, with every field narrowed; unknown extras are dropped. */
function asReview(value: unknown): Review {
  const r = isRecord(value) ? value : {};
  return {
    id: asString(r.id),
    url: asString(r.url),
    createdAt: asString(r.createdAt),
    authors: Array.isArray(r.authors) ? r.authors.filter(a => typeof a === 'string') : [],
  };
}

/**
 * Object-shaped entries only. The fields inside one annotation stay as they
 * were read: every consumer already treats them as optional (see
 * `reviewStats`), and dropping an annotation because one field is odd would
 * hide real feedback from the report.
 */
function asAnnotations(value: unknown): Annotation[] {
  if (!Array.isArray(value)) return [];
  return value.filter((a): a is Annotation => isRecord(a));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
