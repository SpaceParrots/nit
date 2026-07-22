// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Zod schemas for the MCP tool **inputs** (validated by the SDK before a
 * handler runs). Inputs are strict: a wrong status or a non-string issue
 * reference is a caller bug, and rejecting it keeps garbage out of
 * annotations.json.
 *
 * There is deliberately no output schema. Tool results are plain JSON text
 * (see `structured()` in `tools.ts`) rather than `structuredContent`, so they
 * are forgiving by construction: annotations.json is shared between people
 * and edited by agents (SPEC §3), and a record with a field missing or an
 * unknown status still has to come back readable. A schema-validated output
 * would fail the whole tool call over one odd record and strand the agent
 * instead of showing it the review.
 *
 * The hand-written types in `../types.ts` stay canonical for the rest of nit;
 * zod lives in the MCP layer only.
 */
import { z } from 'zod';

export const STATUSES = ['open', 'fixed', 'wontfix', 'verified', 'reopened'] as const;

export const statusSchema = z.enum(STATUSES);
export const annotationTypeSchema = z.enum(['change-request', 'comment']);

// --- tool input shapes (the form registerTool() takes) ----------------------

export const listInputShape = {
  status: statusSchema.optional().describe('only annotations with this status'),
  type: annotationTypeSchema.optional().describe('only this annotation type'),
  route: z.string().optional().describe('only annotations on this route; an exact route or a bare pathname like /products'),
};

export const getAnnotationInputShape = {
  id: z.union([z.string(), z.array(z.string()).min(1)])
    .describe('one annotation id, e.g. a1, or an array to fetch several in one call'),
  includeXpath: z.boolean().default(false)
    .describe('include target.xpath — the most fragile locator (last-resort fallback), omitted by default'),
  includeScreenshot: z.boolean().default(true)
    .describe('include the screenshot(s) as image content; set false to skip re-sending images already seen'),
};

export const markFixedInputShape = {
  id: z.string().describe('annotation id, e.g. a1'),
  reason: z.string().optional().describe('why — persisted on the annotation as statusReason'),
};

export const setStatusInputShape = {
  id: z.string().describe('annotation id, e.g. a1'),
  status: statusSchema.describe('the new status'),
  reason: z.string().optional()
    .describe('why this status — required in spirit for wontfix; persisted on the annotation as statusReason'),
};

export const setIssueRefInputShape = {
  id: z.string().describe('annotation id, e.g. a1'),
  // Not `.max(200)`: the handler trims and truncates rather than rejecting, so a
  // long url still attaches instead of failing the call.
  ref: z.string().describe('tracker key or url; empty string clears'),
};
