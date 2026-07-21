// Pure annotations → review.md renderer (SPEC §5) + the /fix-annotations contract file.

export function renderReviewMd(data) {
  const review = data.review || {};
  const annotations = data.annotations || [];
  const openCrs = annotations.filter(isActionable).length;

  const lines = [];
  lines.push(`# Nit review — ${review.url || 'unknown url'} — ${(review.createdAt || '').slice(0, 10)}`);
  lines.push('');
  lines.push(`Authors: ${(review.authors || []).join(', ') || '—'} · ${annotations.length} annotation${annotations.length === 1 ? '' : 's'} · ${openCrs} actionable (open change-requests)`);

  for (const a of annotations) {
    const t = a.target || {};
    lines.push('');
    lines.push(`## ${a.id} · ${a.type} · ${a.status} · ${a.viewport ? a.viewport.mode : 'general'} — ${oneLine(a.comment)}`);
    if (isActionable(a)) {
      lines.push('**ACTIONABLE** — make this change, then set `status` to `"fixed"` in annotations.json.');
    } else if (a.type === 'comment') {
      lines.push('*Context only — do not change code for this.*');
    } else {
      lines.push(`*Not actionable — status: ${a.status}.*`);
    }
    if (a.screenshot) lines.push(`![${a.id}](${a.screenshot})`);
    lines.push(`- component: \`${t.component || '?'}\`${t.ngComponent ? ` (${t.ngComponent})` : ''}`);
    if (t.selector) lines.push(`- selector: \`${t.selector}\``);
    lines.push(`- route: \`${a.route || '/'}\` · author: ${a.author || '—'} · scope: ${a.viewportScope || 'general'}${a.viewport ? ` · captured at ${a.viewport.w}×${a.viewport.h}` : ''}`);
  }
  lines.push('');
  return lines.join('\n');
}

function isActionable(a) {
  return a.type === 'change-request' && a.status === 'open';
}

function oneLine(s) {
  return (s || '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

export const FIX_ANNOTATIONS_MD = `# /fix-annotations

Read \`annotations.json\` in this directory. For each annotation with \`status: "open"\` **and**
\`type: "change-request"\`, make the change described in \`comment\` at the referenced element, then set
that annotation's \`status\` to \`"fixed"\`. Treat \`type: "comment"\` annotations as context — do not
change code for them; surface them to the user instead.

Locating each spot: use \`target.component\` (custom-element tag ≈ Angular component selector) and
\`route\` first. \`target.ngComponent\` is the Angular class name when the build exposed it —
grep for it directly. \`selector\`, \`classes\` and \`text\` pin down the exact element, and the
cropped screenshot in \`shots/\` shows it visually.

Note: the target marks where the reviewer SAW the problem — the defect may live in a neighboring
component (spacing/overflow issues especially). Verify the root cause before editing.
`;
