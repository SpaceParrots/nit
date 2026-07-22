# Changelog

## 1.0.1 (2026-07-22)

- **Node 20.12 is now the minimum.** 1.0.0 declared Node 18 but crashed on it: the prompt
  library uses `node:util`'s `styleText`, which arrived in 20.12, and Node 18 has been end of
  life since April 2025. `engines`, `nit doctor` and CI now agree on the real floor. Install
  1.0.1 rather than 1.0.0 if you are on Node 18.
- **MCP tools are namespaced.** The five tools are now `nit_list_annotations`,
  `nit_get_annotation`, `nit_mark_fixed`, `nit_set_status` and `nit_set_issue_ref`, so they stay
  unambiguous next to other MCP servers' tools. Clients discover tools by name at connect time,
  so nothing needs reconfiguring beyond an agent's own tool allow-lists.
- **Agent-facing server instructions.** The MCP handshake now carries standing guidance for
  connected agents: the intended list, get, fix, mark-fixed loop; comments are context and never
  tasks; `wontfix` instead of forcing a bad change; humans rule on verification. Tool and
  argument descriptions were rewritten in the same spirit.

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
  and `historyCount`. (Renamed with a `nit_` prefix in 1.0.1.)
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
- **Reviewer name in the user config.** `nit setup` prompts for an author name and stores it in a
  per-user config (defaulting to the OS username), so repeated setups on the same machine no
  longer need to ask.
- **Panel author display and filter.** Once a review has more than one distinct annotation author,
  each row gets a small author chip and the filter dropdown gains an "Author" row to narrow the
  list (and the "couldn't place" list) down to one reviewer. Single-author reviews are unaffected:
  no chip, no filter row. The expanded detail view always shows an "author" line when the
  annotation has one, regardless of author count.

### Security

- Annotation files are treated as untrusted end to end, because they are shared between teammates
  and written by AI agents: navigation is origin-gated against the url the session actually
  opened, `issueRef`, click history and selectors are sanitized before they reach `review.md`,
  and screenshot paths cannot escape the review directory.
