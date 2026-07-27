// SPDX-License-Identifier: AGPL-3.0-or-later
// Read-only MCP resources over a review folder: the whole review, the rendered
// markdown, the agent instruction sheet, and one resource per annotation (plus
// its screenshots). A resource read is still a tool call in most clients (e.g.
// Claude Code's ReadMcpResourceTool), so these exist as a fallback for tools-off
// sessions and for humans browsing the folder — the tools stay the way to
// *change* anything, and nit_list_annotations/nit_get_annotation stay the
// leaner path when tools are available.
import fs from 'node:fs';
import path from 'node:path';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Variables } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';
import { createStore, safeShotPath } from '../store/store.js';
import { renderReviewMd, renderBriefMd, FIX_ANNOTATIONS_MD } from '../store/render.js';
import type { Annotation, BaseRef } from '../types.js';
import { basesOf, baseSummaries, displayId, findAnnotation, isMultiBase } from './aggregate.js';
import type { Located } from './aggregate.js';

const ANNOTATION_URI = 'nit://annotation/{id}';
const SHOT_URI = 'nit://annotation/{id}/screenshot';
const AFTER_SHOT_URI = 'nit://annotation/{id}/screenshot-after';
const BASE_FILE_URI = 'nit://base/{slug}/{file}';

/** The files a base exposes under `nit://base/{slug}/`. */
const BASE_FILES = ['annotations.json', 'review.md', 'brief.md'] as const;

/**
 * Register the review's resources. Every callback re-reads the folder: it is
 * shared with the panel and with other agents.
 *
 * A review covering several base URLs serves each of them under
 * `nit://base/{slug}/…` plus a `nit://review/bases.md` overview; the unprefixed
 * `nit://review/…` uris then refuse rather than guess an environment. A
 * single-base review is served exactly as it always was.
 * @param server the MCP server to register on
 * @param dir review directory, or a workspace of base folders
 */
export function registerResources(server: McpServer, dir: string): void {
  server.registerResource('annotations', 'nit://review/annotations.json', {
    title: 'annotations.json',
    description: 'The whole review as nit stores it: review metadata plus every annotation with its target, status and history.',
    mimeType: 'application/json',
  }, uri => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: read(soleBase(dir).file) }],
  }));

  server.registerResource('review-md', 'nit://review/review.md', {
    title: 'review.md',
    description: 'The human-readable review, grouped by route with status and screenshots — for humans; agents should prefer brief.md and the tools.',
    mimeType: 'text/markdown',
  }, uri => ({
    // rendered on the fly when the file has not been written yet
    contents: [{ uri: uri.href, mimeType: 'text/markdown', text: reviewMd(soleBase(dir)) }],
  }));

  server.registerResource('brief-md', 'nit://review/brief.md', {
    title: 'brief.md',
    description: 'One line per annotation — the token-lean overview for agents; read this before annotations.json or review.md.',
    mimeType: 'text/markdown',
  }, uri => ({
    // always rendered on the fly: unlike review.md, nothing ever writes this to disk
    contents: [{ uri: uri.href, mimeType: 'text/markdown', text: renderBriefMd(createStore(soleBase(dir).dir).data) }],
  }));

  server.registerResource('bases-md', 'nit://review/bases.md', {
    title: 'bases.md',
    description: 'Every base URL in this review (e.g. local, staging, production) with its annotation counts — read this first when a review covers more than one environment.',
    mimeType: 'text/markdown',
  }, uri => ({
    contents: [{ uri: uri.href, mimeType: 'text/markdown', text: renderBasesMd(dir) }],
  }));

  server.registerResource('base-file', new ResourceTemplate(BASE_FILE_URI, {
    list: () => ({
      resources: basesOf(dir).flatMap(b => BASE_FILES.map(file => ({
        uri: `nit://base/${b.slug}/${file}`,
        name: `${b.slug}/${file}`,
        title: `${b.slug}: ${file}`,
        description: `${file} for ${b.url}`,
        mimeType: file.endsWith('.json') ? 'application/json' : 'text/markdown',
      }))),
    }),
    complete: {
      slug: value => basesOf(dir).map(b => b.slug).filter(s => s.startsWith(value)),
      file: value => BASE_FILES.filter(f => f.startsWith(value)),
    },
  }), {
    title: 'Base file',
    description: 'annotations.json, review.md or brief.md for one base URL of this review.',
  }, (uri, variables) => {
    const base = baseByVariable(dir, variables.slug);
    const file = one(variables.file);
    // the template matches any {file}; only the three a base actually exposes
    // are served, so a crafted name can never reach the filesystem
    if (!isBaseFile(file)) {
      throw new Error(`no file "${file}" for base ${base.slug} — one of: ${BASE_FILES.join(', ')}`);
    }
    const json = file === 'annotations.json';
    return {
      contents: [{
        uri: uri.href,
        mimeType: json ? 'application/json' : 'text/markdown',
        text: json
          ? read(base.file)
          : file === 'brief.md' ? renderBriefMd(createStore(base.dir).data) : reviewMd(base),
      }],
    };
  });

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
      resources: everyAnnotation(dir).map(({ id, ann }) => ({
        uri: `nit://annotation/${encodeURIComponent(id)}`,
        name: id,
        title: `${id}: ${excerpt(ann.comment)}`,
        description: `${ann.type}, status ${ann.status}, on ${ann.route}`,
        mimeType: 'application/json',
      })),
    }),
    complete: { id: value => everyAnnotation(dir).map(a => a.id).filter(id => id.startsWith(value)) },
  }), {
    title: 'Annotation',
    description: 'One annotation in full, by id — qualified as <base>:<id> when the review covers several base URLs.',
    mimeType: 'application/json',
  }, (uri, variables) => ({
    // compact: a pretty-printed annotation costs ~35% more tokens once its
    // indentation and newlines are escaped into contents[].text
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(locate(dir, variables).annotation) }],
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
      resources: everyAnnotation(dir).filter(({ ann }) => shotOf(ann)).map(({ id, ann }) => ({
        uri: `nit://annotation/${encodeURIComponent(id)}${suffix}`,
        name: `${id}${suffix}`,
        title: `${id}: ${excerpt(ann.comment)}`,
        mimeType: 'image/png',
      })),
    }),
    complete: {
      id: value => everyAnnotation(dir).filter(({ ann }) => shotOf(ann)).map(a => a.id).filter(id => id.startsWith(value)),
    },
  }), { title, description, mimeType: 'image/png' }, (uri, variables) => {
    const { base, annotation } = locate(dir, variables);
    // annotations.json is shared/agent-editable — a crafted path must never
    // read a file outside the base's own review folder
    const abs = safeShotPath(base.dir, shotOf(annotation));
    if (!abs) throw new Error(`annotation ${annotation.id} has no ${suffix.slice(1)}`);
    return { contents: [{ uri: uri.href, mimeType: 'image/png', blob: fs.readFileSync(abs).toString('base64') }] };
  });
}

/** One annotation, under the id an agent addresses it by (qualified when multi-base). */
interface ListedAnnotation {
  id: string;
  ann: Annotation;
}

/**
 * Every annotation in the review, across every base, under the same ids the
 * tools hand out — so a listed resource uri is always one a client can read
 * back.
 * @param dir the review directory or workspace
 */
function everyAnnotation(dir: string): ListedAnnotation[] {
  const multi = isMultiBase(dir);
  return basesOf(dir).flatMap(b =>
    createStore(b.dir).annotations.map(ann => ({ id: displayId(multi, b.slug, ann.id), ann })));
}

/**
 * Resolve the `{id}` variable of a filled-in template to its annotation and the
 * base that owns it. Ids may arrive qualified (`staging:a1`) or bare.
 * @param dir the review directory or workspace
 * @param variables the template variables the SDK matched
 * @throws when no annotation has that id
 */
function locate(dir: string, variables: Variables): Located {
  const id = decodeId(one(variables.id));
  const hit = findAnnotation(dir, id);
  if (!hit) throw new Error(`no annotation with id ${id}`);
  return hit;
}

/**
 * The one base an unprefixed `nit://review/…` uri refers to.
 * @param dir the review directory or workspace
 * @throws on a workspace with several bases, naming them and the base-scoped
 *   form to use instead; and on a folder holding no review at all
 */
function soleBase(dir: string): BaseRef {
  const bases = basesOf(dir);
  if (bases.length === 1) return bases[0];
  if (!bases.length) throw new Error(`no review in ${dir}`);
  throw new Error(`this review covers ${bases.length} base URLs (${bases.map(b => b.slug).join(', ')}) — `
    + 'read nit://base/<slug>/annotations.json instead, or nit://review/bases.md for the overview');
}

/**
 * Resolve a `{slug}` template variable to a base by matching the workspace's
 * *enumerated* bases. The slug is never joined into a path directly — it arrives
 * from a client and a crafted `../../` must not resolve to anything.
 * @param dir the review directory or workspace
 * @param raw the slug as the template matched it
 * @throws when no base has that slug
 */
function baseByVariable(dir: string, raw: string | string[] | undefined): BaseRef {
  const slug = decodeId(one(raw));
  const bases = basesOf(dir);
  const base = bases.find(b => b.slug === slug);
  if (!base) throw new Error(`no base "${slug}" — known bases: ${bases.map(b => b.slug).join(', ')}`);
  return base;
}

/** Whether a `{file}` variable names one of the files a base exposes. */
function isBaseFile(file: string): file is (typeof BASE_FILES)[number] {
  return (BASE_FILES as readonly string[]).includes(file);
}

/** Template variables arrive as a string or a single-element array. */
function one(raw: string | string[] | undefined): string {
  return (Array.isArray(raw) ? raw[0] : raw) ?? '';
}

/** A base's review.md — the written file, or rendered on the fly when absent. */
function reviewMd(base: BaseRef): string {
  return readOr(path.join(base.dir, 'review.md'), () => renderReviewMd(createStore(base.dir).data));
}

/** One markdown table row per base: slug, url, totals. */
function renderBasesMd(dir: string): string {
  const summaries = baseSummaries(dir);
  const lines = ['# Bases', '', '| base | url | annotations | actionable |', '| --- | --- | --- | --- |'];
  for (const b of summaries) lines.push(`| \`${b.slug}\` | ${b.url} | ${b.total} | ${b.actionable} |`);
  lines.push('', 'Read one with `nit://base/<base>/annotations.json`, `/review.md` or `/brief.md`.');
  lines.push('', 'Annotation ids are qualified as `<base>:<id>` (e.g. `staging:a1`) when a review covers more than one base.');
  return lines.join('\n') + '\n';
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
