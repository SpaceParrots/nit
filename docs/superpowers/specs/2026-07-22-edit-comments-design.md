# Edit annotation comments — design

Date: 2026-07-22
Status: approved (panel expanded item)

## Problem

An annotation's comment is written once in the capture popover and read-only everywhere after.
Typos and clarifications require delete + re-annotate.

## Design

Editing lives in the panel's expanded item, mirroring the issue-ref input pattern exactly.

- **Bridge**: new guarded binding `__nitSetComment(id, comment)` — requires a string id and a
  non-empty trimmed comment (an empty edit is rejected: clearing text is the delete button's job,
  and validateSave applies the same rule at capture). Goes through `store.patch` (stamps
  `updatedAt`/`updatedBy` with the session author), then `session.flush()`. No length cap — the
  capture path has none, and edits stay consistent with it.
- **Panel** (`list.ts`): the expanded meta section gains a `.nit-comment-edit` textarea prefilled
  with the comment, above the stamps line. Commits on blur and Ctrl/Cmd+Enter; Escape restores the
  original value before blurring so the no-change guard suppresses the commit; an emptied textarea
  reverts instead of committing. Click does not toggle the item (stopPropagation). The collapsed
  row's comment text refreshes on the next poll.
- **Poll-loop safety**: the `tick()` focus guard and the window-blur release handler extend from
  `.nit-issue` to `.nit-comment-edit`, so typing is never interrupted and a window switch commits
  rather than strands the loop.
- Available in every session mode (like the issue-ref input); the MCP surface is unchanged — the
  agent has no business rewriting the reviewer's words.

## Testing

Integration (`test/browser-panel.test.js`): edit + blur persists the new text with
`updatedAt`/`updatedBy` stamped; Escape reverts without a write; an emptied textarea does not
commit; the existing no-double-commit discipline holds (single log line per edit).
