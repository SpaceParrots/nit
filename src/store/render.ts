// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure annotations → review.md renderer (SPEC §5) + the /fix-annotations contract file.
import { isActionable } from './stats.js';
import type { Annotation, ClickStep, ReviewData } from '../types.js';

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
    // the header shows the semantic scope (viewportScope), not the capture
    // viewport — a general-scope issue captured on mobile must not read "mobile"
    lines.push(`## ${inline(a.id)} · ${inline(a.type)} · ${inline(a.status)} · ${inline(a.viewportScope || 'general')} — ${oneLine(a.comment)}`);
    if (isActionable(a)) {
      lines.push(a.status === 'reopened'
        ? '**ACTIONABLE (reopened)** — the previous fix did not hold; fix again, then set `status` to `"fixed"`.'
        : '**ACTIONABLE** — make this change, then set `status` to `"fixed"` in annotations.json.');
    } else if (a.type === 'comment') {
      lines.push('*Context only — do not change code for this.*');
    } else {
      lines.push(`*Not actionable — status: ${inline(a.status)}.*`);
    }
    if (a.statusReason) lines.push(`- reason: ${oneLine(a.statusReason)}`);
    if (a.screenshot) lines.push(`![${a.id}](${a.screenshot})`);
    if (a.screenshotAfter) lines.push(`![${a.id} after](${a.screenshotAfter})`);
    lines.push(`- component: \`${t.component ?? '?'}\`${t.ngComponent ? ` (${t.ngComponent})` : ''}`);
    if (t.selector) lines.push(`- selector: \`${inline(t.selector).replace(/`/g, '')}\``);
    const route = inline(a.route || '/').replace(/`/g, '');
    const capturedAt = a.viewport
      ? ` · captured at ${inline(a.viewport.w)}×${inline(a.viewport.h)} (${inline(a.viewport.mode)})`
      : '';
    lines.push(`- route: \`${route}\` · author: ${inline(a.author || '—')} · scope: ${inline(a.viewportScope || 'general')}${capturedAt}`);
    const extra: string[] = [];
    const issueFragment = a.issueRef ? issueMd(a.issueRef) : null;
    if (issueFragment) extra.push(`issue: ${issueFragment}`);
    if (a.updatedAt) extra.push(`updated ${a.updatedAt.slice(0, 10)}${a.updatedBy ? ` by ${a.updatedBy}` : ''}`);
    if (extra.length) lines.push(`- ${extra.join(' · ')}`);
    lines.push(...historyMd(a.history));
  }
  lines.push('');
  return lines.join('\n');
}

/** brief.md is one line per annotation — a single hand-edited free-text field must never grow past this. */
const BRIEF_FIELD_CAP = 100;

/**
 * Coerce a hand-edited JSON value to text without ever risking Object's default
 * `[object Object]` stringification: only string/number/boolean pass through (numbers
 * and booleans via `String`, which is safe for them); an object, array, `null` or
 * `undefined` becomes `''` — the same "nothing useful here" outcome as an absent field.
 */
function toText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

/**
 * Render the token-lean agent overview (SPEC-adjacent, but not part of SPEC §5):
 * a one-line header plus one line per annotation, carrying just enough to triage
 * without reading annotations.json or review.md. Pure function.
 * @param data the full review data
 * @returns the complete brief.md content
 */
export function renderBriefMd(data: ReviewData): string {
  const review = data.review ?? {} as Partial<ReviewData['review']>;
  const annotations = data.annotations ?? [];
  const actionable = annotations.filter(isActionable).length;

  const lines = [
    `# Nit brief — ${review.url || 'unknown url'} — ${annotations.length} annotations, ${actionable} actionable`,
    '',
    ...annotations.map(briefLine),
  ];
  return `${lines.join('\n')}\n`;
}

/** One `- id · type · status · scope · route — comment [component]` line, plus optional reason/issue tails. */
function briefLine(a: Annotation): string {
  const t = a.target ?? {} as Partial<Annotation['target']>;
  const id = briefField(a.id ?? '?');
  const type = briefField(a.type ?? '?');
  const status = briefField(a.status ?? '?');
  const scope = briefField(a.viewportScope || 'general');
  const route = briefField(a.route || '/');
  const comment = briefField(a.comment ?? '');
  const component = briefField(t.component ?? '?');
  let line = `- ${id} · ${type} · ${status} · ${scope} · ${route} — ${comment} [${component}]`;
  const reason = a.statusReason ? briefField(a.statusReason) : '';
  if (reason) line += ` · reason: ${reason}`;
  const issue = a.issueRef ? briefField(a.issueRef) : '';
  if (issue) line += ` · issue: ${issue}`;
  return line;
}

/**
 * Whitespace-collapse and strip backticks from an untrusted brief.md field, then cap it at
 * {@link BRIEF_FIELD_CAP}. This file is a token-lean, one-line-per-annotation overview: a single
 * hand-edited comment, component, reason, issueRef, or any of the id/type/status/scope/route enum-ish
 * fields must never be able to inject a newline that turns one annotation into two lines (or a fake
 * extra one), or grow the resource past its whole reason for existing. Every field on `Annotation` is
 * typed as a string (or a narrow string union), but the file is hand-editable — a non-string value
 * is coerced to text (see {@link toText}) rather than thrown on.
 */
function briefField(s: unknown): string {
  const line = toText(s).replace(/\s+/g, ' ').trim().replace(/`/g, '');
  return line.length > BRIEF_FIELD_CAP ? `${line.slice(0, BRIEF_FIELD_CAP - 1)}…` : line;
}

/**
 * Render an annotation's click trail as a numbered steps list. The file may be
 * hand-edited, so every entry is re-checked and re-flattened here even though the
 * bridge already sanitized what it stored: malformed entries are dropped, fields
 * are whitespace-collapsed, and backticks are stripped from code spans — the same
 * discipline `issueRef` rendering applies.
 */
function historyMd(history: Annotation['history']): string[] {
  if (!Array.isArray(history)) return [];
  const steps = history
    .filter((s): s is ClickStep => Boolean(
      s && typeof s === 'object'
      && typeof s.selector === 'string' && typeof s.text === 'string'
      && typeof s.component === 'string' && typeof s.tag === 'string' && typeof s.at === 'string',
    ))
    .slice(0, 10);
  if (!steps.length) return [];
  const lines = ['', 'Steps on this page before this annotation (oldest first):', ''];
  steps.forEach((s, i) => {
    const selector = inline(s.selector).replace(/`/g, '');
    const text = inline(s.text);
    const component = inline(s.component);
    lines.push(`${i + 1}. click \`${selector}\`${text ? ` — "${text}"` : ''}${component ? ` (${component})` : ''}`);
  });
  return lines;
}

/**
 * Whitespace-collapse an untrusted fragment so it cannot open a markdown block.
 * The field is typed as `string` (or a narrow union) but annotations.json is
 * hand-editable, so a non-string value must not throw — it is coerced to text
 * first (see {@link toText}).
 */
function inline(s: unknown): string {
  return toText(s).replace(/\s+/g, ' ').trim();
}

function oneLine(s: string | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

/**
 * Collapses all whitespace runs (including newlines/tabs) to a single space, trims, and caps the
 * result at 200 characters (the same cap the write-side bindings apply, see `src/browser/bridge.ts`).
 * `issueRef` is untrusted free-form text (human panel input, MCP tool, or hand-edited JSON), so
 * this is the first line of defense: a stored value can never introduce block-level markdown
 * (headings, blank-line paragraph breaks, etc.) into review.md, and can never grow unbounded.
 * The cap is applied here, before any safe-URL decision, so a truncated value is never
 * misclassified as a link based on characters that no longer make it to the rendered output.
 */
function normalizeIssueRef(ref: string): string {
  return ref.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * True only for a value that is safe to embed verbatim as both link text and href: it must look
 * like an http(s) URL and contain none of the characters that could break out of `[text](href)`
 * boundaries (whitespace, backtick, parens, brackets, backslash) or out of the surrounding markup
 * once review.md is rendered to HTML (`<`, `>`, `"`, `'`). None of those are legal in a url that
 * has not been percent-encoded, so rejecting them costs no legitimate tracker link — it only sends
 * a value like `https://x.test/<svg/onload=alert(1)>` down the inert code-span branch instead of
 * emitting it as live link text.
 */
function isSafeUrl(ref: string): boolean {
  return /^https?:\/\//i.test(ref) && !/[\s`()[\]\\<>"']/.test(ref);
}

/**
 * A tracker url becomes a markdown link; anything else becomes an inline code span. The value is
 * normalized first (see `normalizeIssueRef`), and backticks are stripped from the code-span form
 * so the value can never terminate the span early. Returns `null` when there is nothing left to
 * show — a whitespace-only or backtick-only input normalizes (and, for the code-span branch,
 * de-backticks) to an empty string, and the caller must treat that as if `issueRef` were absent
 * rather than emit a degenerate empty code span (` `` `).
 */
function issueMd(ref: string): string | null {
  const normalized = normalizeIssueRef(ref);
  if (!normalized) return null;
  if (isSafeUrl(normalized)) return `[${normalized}](${normalized})`;
  const stripped = normalized.replace(/`/g, '');
  return stripped ? `\`${stripped}\`` : null;
}

export const FIX_ANNOTATIONS_MD = `# /fix-annotations

If the nit MCP tools are available (\`nit_list_annotations\`, \`nit_get_annotation\`, \`nit_mark_fixed\`,
\`nit_set_status\`, \`nit_set_issue_ref\`), use them for every read and every change — do not edit
\`annotations.json\` by hand. The rest of this sheet is for working from the files alone.

## File-only mode

Read \`annotations.json\` in this directory. For each annotation of \`type: "change-request"\` whose
\`status\` is \`"open"\` **or** \`"reopened"\` (a fix that did not hold), make the change described in
\`comment\` at the referenced element, then set that annotation's \`status\` to \`"fixed"\`. Treat
\`type: "comment"\` annotations as context — do not change code for them; surface them to the user
instead. If a change should not be made, set \`status\` to \`"wontfix"\` and record why in
\`statusReason\`.

Locating each spot: use \`target.component\` (custom-element tag ≈ Angular component selector) and
\`route\` first. \`target.ngComponent\` is the Angular class name when the build exposed it —
grep for it directly. \`selector\`, \`classes\` and \`text\` pin down the exact element, and the
cropped screenshot in \`shots/\` shows it visually.

Note: the target marks where the reviewer SAW the problem — the defect may live in a neighboring
component (spacing/overflow issues especially). Verify the root cause before editing.

Optional metadata: if you file or resolve a tracker issue for a nit, record its key or url in that
annotation's \`issueRef\`. Do not hand-edit \`updatedAt\`/\`updatedBy\` in file-only mode — nit stamps
them itself whenever a change goes through the tools.

Reproduction: when an annotation carries \`history\` (the reviewer's last clicks on that page,
oldest first), the described state may only exist after replaying those clicks — open the route,
perform the steps, then look at the target element.
`;
