// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure annotations → review.md renderer (SPEC §5) + the /fix-annotations contract file.
import type { Annotation, ReviewData } from '../types.js';

/**
 * Render a review as human/agent-readable markdown (SPEC §5). Pure function.
 * Open and reopened change-requests are flagged **ACTIONABLE**; comments are
 * marked context-only so a fixing agent never acts on them.
 * @param data the full review data
 * @returns the complete review.md content
 */
export function renderReviewMd(data: ReviewData): string {
  const review = data.review ?? {} as Partial<ReviewData['review']>;
  const annotations = data.annotations ?? [];
  const openCrs = annotations.filter(isActionable).length;

  const lines: string[] = [];
  lines.push(`# Nit review — ${review.url || 'unknown url'} — ${(review.createdAt ?? '').slice(0, 10)}`);
  lines.push('');
  lines.push(`Authors: ${(review.authors ?? []).join(', ') || '—'} · ${annotations.length} annotation${annotations.length === 1 ? '' : 's'} · ${openCrs} actionable (open/reopened change-requests)`);

  for (const a of annotations) {
    const t = a.target ?? {} as Partial<Annotation['target']>;
    lines.push('');
    lines.push(`## ${a.id} · ${a.type} · ${a.status} · ${a.viewport ? a.viewport.mode : 'general'} — ${oneLine(a.comment)}`);
    if (isActionable(a)) {
      lines.push(a.status === 'reopened'
        ? '**ACTIONABLE (reopened)** — the previous fix did not hold; fix again, then set `status` to `"fixed"`.'
        : '**ACTIONABLE** — make this change, then set `status` to `"fixed"` in annotations.json.');
    } else if (a.type === 'comment') {
      lines.push('*Context only — do not change code for this.*');
    } else {
      lines.push(`*Not actionable — status: ${a.status}.*`);
    }
    if (a.screenshot) lines.push(`![${a.id}](${a.screenshot})`);
    if (a.screenshotAfter) lines.push(`![${a.id} after](${a.screenshotAfter})`);
    lines.push(`- component: \`${t.component ?? '?'}\`${t.ngComponent ? ` (${t.ngComponent})` : ''}`);
    if (t.selector) lines.push(`- selector: \`${t.selector}\``);
    lines.push(`- route: \`${a.route || '/'}\` · author: ${a.author || '—'} · scope: ${a.viewportScope || 'general'}${a.viewport ? ` · captured at ${a.viewport.w}×${a.viewport.h}` : ''}`);
    const extra: string[] = [];
    if (a.issueRef) extra.push(`issue: ${issueMd(a.issueRef)}`);
    if (a.updatedAt) extra.push(`updated ${a.updatedAt.slice(0, 10)}${a.updatedBy ? ` by ${a.updatedBy}` : ''}`);
    if (extra.length) lines.push(`- ${extra.join(' · ')}`);
  }
  lines.push('');
  return lines.join('\n');
}

function isActionable(a: Annotation): boolean {
  return a.type === 'change-request' && (a.status === 'open' || a.status === 'reopened');
}

function oneLine(s: string | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

/**
 * Collapses all whitespace runs (including newlines/tabs) to a single space and trims.
 * `issueRef` is untrusted free-form text (human panel input, MCP tool, or hand-edited JSON), so
 * this is the first line of defense: a stored value can never introduce block-level markdown
 * (headings, blank-line paragraph breaks, etc.) into review.md.
 */
function normalizeIssueRef(ref: string): string {
  return ref.replace(/\s+/g, ' ').trim();
}

/**
 * True only for a value that is safe to embed verbatim as both link text and href: it must look
 * like an http(s) URL and contain none of the characters that could break out of `[text](href)`
 * boundaries (whitespace, backtick, parens, brackets).
 */
function isSafeUrl(ref: string): boolean {
  return /^https?:\/\//i.test(ref) && !/[\s`()[\]]/.test(ref);
}

/**
 * A tracker url becomes a markdown link; anything else becomes an inline code span. The value is
 * normalized first (see `normalizeIssueRef`), and backticks are stripped from the code-span form
 * so the value can never terminate the span early.
 */
function issueMd(ref: string): string {
  const normalized = normalizeIssueRef(ref);
  if (isSafeUrl(normalized)) return `[${normalized}](${normalized})`;
  return `\`${normalized.replace(/`/g, '')}\``;
}

export const FIX_ANNOTATIONS_MD = `# /fix-annotations

Read \`annotations.json\` in this directory. For each annotation of \`type: "change-request"\` whose
\`status\` is \`"open"\` **or** \`"reopened"\` (a fix that did not hold), make the change described in
\`comment\` at the referenced element, then set that annotation's \`status\` to \`"fixed"\`. Treat
\`type: "comment"\` annotations as context — do not change code for them; surface them to the user
instead.

Locating each spot: use \`target.component\` (custom-element tag ≈ Angular component selector) and
\`route\` first. \`target.ngComponent\` is the Angular class name when the build exposed it —
grep for it directly. \`selector\`, \`classes\` and \`text\` pin down the exact element, and the
cropped screenshot in \`shots/\` shows it visually.

Note: the target marks where the reviewer SAW the problem — the defect may live in a neighboring
component (spacing/overflow issues especially). Verify the root cause before editing.

Optional metadata: if you file or resolve a tracker issue for a nit, record its key or url in that
annotation's \`issueRef\`. Do not hand-edit \`updatedAt\`/\`updatedBy\` — nit stamps them whenever a
status or issue reference changes.
`;
