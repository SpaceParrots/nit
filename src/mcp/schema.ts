// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Zod schemas for the MCP surface: tool inputs (validated by the SDK before a
 * handler runs) and tool outputs (validated against `structuredContent`).
 *
 * The two directions are deliberately asymmetric:
 *
 * - **Inputs are strict.** A wrong status or a non-string issue reference is a
 *   caller bug, and rejecting it keeps garbage out of annotations.json.
 * - **Outputs are forgiving.** annotations.json is shared between people and
 *   edited by agents (SPEC §3), so a record with a field missing or an unknown
 *   status still has to come back readable — a schema that rejected it would
 *   fail the whole tool call and strand the agent instead of showing it the
 *   review. The shapes below therefore document every field an annotation
 *   normally carries, without requiring any of them.
 *
 * The hand-written types in `../types.ts` stay canonical for the rest of nit;
 * zod lives in the MCP layer only.
 */
import { z } from 'zod';
import type { Annotation } from '../types.js';

export const STATUSES = ['open', 'fixed', 'wontfix', 'verified', 'reopened'] as const;

export const statusSchema = z.enum(STATUSES);
export const annotationTypeSchema = z.enum(['change-request', 'comment']);

const STATUS_DOC = 'open | fixed | wontfix | verified | reopened';
const TYPE_DOC = 'change-request (actionable) | comment (context only)';

// --- tool inputs (raw zod shapes, the form registerTool() takes) -------------

export const listInputShape = {
  status: statusSchema.optional().describe('only annotations with this status'),
  type: annotationTypeSchema.optional().describe('only this annotation type'),
  route: z.string().optional().describe('only annotations on this route; an exact route or a bare pathname like /products'),
};

export const idInputShape = {
  id: z.string().describe('annotation id, e.g. a1'),
};

export const setStatusInputShape = {
  id: z.string().describe('annotation id, e.g. a1'),
  status: statusSchema.describe('the new status'),
};

export const setIssueRefInputShape = {
  id: z.string().describe('annotation id, e.g. a1'),
  // Not `.max(200)`: the handler trims and truncates rather than rejecting, so a
  // long url still attaches instead of failing the call.
  ref: z.string().describe('tracker key or url; empty string clears'),
};

// --- tool outputs -----------------------------------------------------------

const rectSchema = z.object({
  x: z.number().optional(),
  y: z.number().optional(),
  w: z.number().optional(),
  h: z.number().optional(),
}).describe('element bounding box in absolute page coordinates');

const viewportSchema = z.object({
  mode: z.string().optional().describe('desktop | mobile'),
  w: z.number().optional(),
  h: z.number().optional(),
});

const targetSchema = z.object({
  component: z.string().optional().describe('nearest custom-element tag, e.g. app-product-tile'),
  ngComponent: z.string().nullish().describe('Angular component class name; null on production builds'),
  selector: z.string().optional().describe('short CSS selector, verified unique at capture time'),
  xpath: z.string().optional(),
  tag: z.string().optional(),
  classes: z.array(z.string()).optional(),
  text: z.string().optional().describe('normalized element text, capped at 80 chars'),
  rect: rectSchema.optional(),
}).describe('layered reference to the annotated element: several ways to find it again');

const clickStepSchema = z.object({
  selector: z.string().optional(),
  tag: z.string().optional(),
  component: z.string().optional(),
  text: z.string().optional(),
  at: z.string().optional().describe('ISO timestamp'),
});

export const reviewSchema = z.object({
  id: z.string().optional(),
  url: z.string().optional().describe('the site under review'),
  createdAt: z.string().optional(),
  authors: z.array(z.string()).optional(),
});

export const annotationSchema = z.object({
  id: z.string().describe('stable annotation id, e.g. a1 (merged reviews use kevin:a1)'),
  type: z.string().optional().describe(TYPE_DOC),
  comment: z.string().optional().describe('what the reviewer wants changed (or remarked)'),
  status: z.string().optional().describe(STATUS_DOC),
  author: z.string().optional(),
  viewportScope: z.string().optional().describe('general | desktop | mobile'),
  viewport: viewportSchema.optional(),
  route: z.string().optional().describe('the route the annotation was captured on'),
  target: targetSchema.optional(),
  screenshot: z.string().nullish().describe('cropped element screenshot, relative to the review dir'),
  screenshotAfter: z.string().nullish().describe('"after" screenshot captured by nit verify'),
  createdAt: z.string().optional(),
  verifiedAt: z.string().optional(),
  issueRef: z.string().optional().describe('tracker key or url'),
  updatedAt: z.string().optional(),
  updatedBy: z.string().optional().describe('the session author, or "agent" for a change made through these tools'),
  history: z.array(clickStepSchema).optional().describe('the reviewer\'s last clicks before capture, oldest first'),
});

/** The projection `nit_list_annotations` returns per annotation. */
export const annotationSummarySchema = z.object({
  id: z.string(),
  type: z.string().optional().describe(TYPE_DOC),
  status: z.string().optional().describe(STATUS_DOC),
  comment: z.string().optional(),
  route: z.string().optional(),
  author: z.string().optional(),
  viewportScope: z.string().optional(),
  issueRef: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  updatedBy: z.string().optional(),
  component: z.string().optional(),
  ngComponent: z.string().nullish(),
  selector: z.string().optional(),
  historyCount: z.number().optional().describe('reproduction-trail length; the trail itself comes with nit_get_annotation'),
});

export const listOutputShape = {
  review: reviewSchema,
  total: z.number().describe('how many annotations matched the filter'),
  actionable: z.number().describe('matched change-requests with status open or reopened'),
  annotations: z.array(annotationSummarySchema),
};

export const annotationOutputShape = {
  annotation: annotationSchema,
};

/**
 * Drift guard, in the direction that matters: everything nit itself writes must
 * satisfy {@link annotationSchema}, or `nit_get_annotation` would reject records
 * produced by the capture session. Fails to compile if {@link Annotation} grows
 * a field whose type the schema cannot accept.
 */
const _writesValidate: z.input<typeof annotationSchema> = {} as Annotation;
void _writesValidate;
