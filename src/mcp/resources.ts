// SPDX-License-Identifier: AGPL-3.0-or-later
// Read-only MCP resources over a review folder: the whole review, the rendered
// markdown, the agent instruction sheet, and one resource per annotation (plus
// its screenshots). Resources let an agent pull context by uri instead of
// spending a tool call — the tools stay the way to *change* anything.
import fs from 'node:fs';
import path from 'node:path';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Variables } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';
import { createStore, safeShotPath } from '../store/store.js';
import { renderReviewMd, FIX_ANNOTATIONS_MD } from '../store/render.js';
import type { Annotation } from '../types.js';

const ANNOTATION_URI = 'nit://annotation/{id}';
const SHOT_URI = 'nit://annotation/{id}/screenshot';
const AFTER_SHOT_URI = 'nit://annotation/{id}/screenshot-after';

/**
 * Register the review's resources. Every callback re-reads the folder: it is
 * shared with the panel and with other agents.
 * @param server the MCP server to register on
 * @param dir review directory containing annotations.json
 */
export function registerResources(server: McpServer, dir: string): void {
  server.registerResource('annotations', 'nit://review/annotations.json', {
    title: 'annotations.json',
    description: 'The whole review as nit stores it: review metadata plus every annotation with its target, status and history.',
    mimeType: 'application/json',
  }, uri => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: read(path.join(dir, 'annotations.json')) }],
  }));

  server.registerResource('review-md', 'nit://review/review.md', {
    title: 'review.md',
    description: 'The human-readable review: annotations grouped by route, with status and screenshots.',
    mimeType: 'text/markdown',
  }, uri => ({
    // rendered on the fly when the file has not been written yet
    contents: [{ uri: uri.href, mimeType: 'text/markdown', text: readOr(path.join(dir, 'review.md'), () => renderReviewMd(createStore(dir).data)) }],
  }));

  server.registerResource('fix-annotations-md', 'nit://review/fix-annotations.md', {
    title: 'fix-annotations.md',
    description: 'The instruction sheet for fixing this review from the files alone — the same text nit writes into the review folder.',
    mimeType: 'text/markdown',
  }, uri => ({
    // served from the constant, so it exists even for folders written by an older nit
    contents: [{ uri: uri.href, mimeType: 'text/markdown', text: FIX_ANNOTATIONS_MD }],
  }));

  server.registerResource('annotation', new ResourceTemplate(ANNOTATION_URI, {
    list: () => ({
      resources: annotationsOf(dir).map(a => ({
        uri: `nit://annotation/${encodeURIComponent(a.id)}`,
        name: a.id,
        title: `${a.id}: ${excerpt(a.comment)}`,
        description: `${a.type}, status ${a.status}, on ${a.route}`,
        mimeType: 'application/json',
      })),
    }),
    complete: { id: value => annotationsOf(dir).map(a => a.id).filter(id => id.startsWith(value)) },
  }), {
    title: 'Annotation',
    description: 'One annotation in full, by id.',
    mimeType: 'application/json',
  }, (uri, variables) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(annotationById(dir, variables), null, 2) }],
  }));

  registerShotResource(server, dir, {
    name: 'annotation-screenshot',
    template: SHOT_URI,
    suffix: '/screenshot',
    title: 'Annotation screenshot',
    description: 'The cropped screenshot of the annotated element, as captured during the review.',
    shotOf: a => a.screenshot,
  });

  registerShotResource(server, dir, {
    name: 'annotation-screenshot-after',
    template: AFTER_SHOT_URI,
    suffix: '/screenshot-after',
    title: 'Annotation after-shot',
    description: 'The "after" screenshot captured by nit verify, for annotations that have been through verification.',
    shotOf: a => a.screenshotAfter,
  });
}

/** How one of the two screenshot resource families is wired up. */
interface ShotResource {
  name: string;
  template: string;
  suffix: string;
  title: string;
  description: string;
  /** which screenshot field this family serves */
  shotOf: (a: Annotation) => string | null | undefined;
}

function registerShotResource(server: McpServer, dir: string, { name, template, suffix, title, description, shotOf }: ShotResource): void {
  server.registerResource(name, new ResourceTemplate(template, {
    // only annotations that actually have this shot are listed
    list: () => ({
      resources: annotationsOf(dir).filter(a => shotOf(a)).map(a => ({
        uri: `nit://annotation/${encodeURIComponent(a.id)}${suffix}`,
        name: `${a.id}${suffix}`,
        title: `${a.id}: ${excerpt(a.comment)}`,
        mimeType: 'image/png',
      })),
    }),
    complete: { id: value => annotationsOf(dir).filter(a => shotOf(a)).map(a => a.id).filter(id => id.startsWith(value)) },
  }), { title, description, mimeType: 'image/png' }, (uri, variables) => {
    const ann = annotationById(dir, variables);
    // annotations.json is shared/agent-editable — a crafted path must never
    // read a file outside the review folder
    const abs = safeShotPath(dir, shotOf(ann));
    if (!abs) throw new Error(`annotation ${ann.id} has no ${suffix.slice(1)}`);
    return { contents: [{ uri: uri.href, mimeType: 'image/png', blob: fs.readFileSync(abs).toString('base64') }] };
  });
}

function annotationsOf(dir: string): Annotation[] {
  return createStore(dir).annotations;
}

/** Resolve the `{id}` variable of a filled-in template to its annotation. */
function annotationById(dir: string, variables: Variables): Annotation {
  const raw = Array.isArray(variables.id) ? variables.id[0] : variables.id;
  const id = decodeId(raw ?? '');
  const ann = annotationsOf(dir).find(a => a.id === id);
  if (!ann) throw new Error(`no annotation with id ${id}`);
  return ann;
}

/** Template matching leaves the id percent-encoded (merged ids carry a `:`). */
function decodeId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function excerpt(comment: string): string {
  const line = comment.replace(/\s+/g, ' ').trim();
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

function readOr(file: string, fallback: () => string): string {
  try {
    return read(file);
  } catch {
    return fallback();
  }
}
