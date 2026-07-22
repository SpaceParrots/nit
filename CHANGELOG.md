# Changelog

## 1.0.0 (2026-07-22)

First stable release.

### The loop

`nit review` lets you annotate a live site in a real Chromium. Hand the review folder or the MCP
server to a coding agent, then run `nit verify` to compare before/after screenshots and rule each
fix Verified or Reopen. Reviews are shareable (`export` / `import`) and mergeable across authors.

### Added since 0.2.0

- **Annotation metadata.** Annotations carry an optional `issueRef` (a tracker key or url) and
  `updatedAt`/`updatedBy` stamps on every status or issue-ref change. All writes go through one
  store funnel, and `updatedBy` is `"agent"` for MCP writes.
- **Click-history reproduction trail.** The reviewer's last clicks on the page (up to 10) are
  stored on each annotation as `history`, so states hidden behind "open menu, pick tab" can be
  replayed. The trail is scoped to the pathname: query-param changes keep it, navigation resets
  it.
- **Routes with query and hash.** Annotations record the exact page state. Pin placement still
  matches on the pathname, so older review files behave unchanged.
- **Rebuilt panel.** A logo, an icon toolbar, sorting (time/page/state) and grouping (page/state)
  behind a filter dropdown, collapsible page groups with the current page first, created/updated
  stamps, an issue-ref input, editable comment texts, "Go to page" navigation, and a pinned
  footer with the actionable count.
- **MCP.** A new `set_issue_ref` tool; `list_annotations` summaries carry `issueRef`, timestamps
  and `historyCount`.
- **Context screenshots, captured at pick time.** Screenshots expand to a minimum context window
  (480x360, centered on the element) so a button's surroundings stay visible. They are captured
  the moment the element is picked, so an open dropdown is still in the shot instead of
  collapsing while the comment is typed. Verify after-shots use the same rules, so before and
  after compare cleanly.
- **Pins stay glued to fixed and sticky elements.** The pin layer is viewport-anchored and
  repositions on scroll. Annotating a fixed tabbar, a sticky header, or content in an inner
  scroll pane keeps the pin on the element instead of letting it drift with the page.
- **Selectors anchor on `data-id`.** Generated selectors prefer `#id`, then `[data-id="…"]`, on
  the element itself, as ancestor anchors, and as path waypoints. Values are escaped and
  uniqueness-verified as before.
- **Labeled, highlighted annotation details.** The expanded panel item shows a color-coded status
  badge, a scope badge, and icon-labeled rows (created, updated, component, selector, id). The
  selector renders monospace with ids and `data-id` attributes syntax-highlighted, built from
  safe text-only spans.

### Security

- Annotation files are treated as untrusted end to end, because they are shared between teammates
  and written by AI agents: navigation is origin-gated against the url the session actually
  opened, `issueRef`, click history and selectors are sanitized before they reach `review.md`,
  and screenshot paths cannot escape the review directory.
