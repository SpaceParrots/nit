# Changelog

## 1.1.0 (2026-07-22)

- **Leaner MCP tool payloads.** A field test of the MCP surface showed roughly two thirds of the
  tokens an agent paid for were waste. Tool results are now a single compact JSON text block:
  `structuredContent` and the output schemas are gone (arguments are still zod-validated), and
  nothing is pretty-printed on the wire anymore.
- **`nit_list_annotations` rows carry the working record.** Summaries now include the target's
  `classes` and `text` (the fields an agent greps the codebase with) plus `statusReason`, and drop
  `author` (already in the review envelope) and `createdAt` (never used). The review envelope is
  only sent on unfiltered calls. For most fixes the list alone is now enough to start working.
- **`nit_get_annotation` batches.** `id` accepts a single id or an array; batch results come back
  in request order with a `missing` list for unknown ids. `target.xpath` — the most fragile
  locator — is omitted unless `includeXpath: true`. Screenshots stay inline by default (they are
  cheap image tokens and often the only thing that identifies the element);
  `includeScreenshot: false` is the escape hatch for re-fetches.
- **Compressed click history.** The trail an annotation carries over MCP now drops clicks on the
  annotated element itself (prodding the target is the bug, not a repro step), collapses
  consecutive clicks on the same selector, drops repeated text, and caps at the last 5 steps;
  `historyCount` still reports the original length. The file on disk keeps the full trail.
- **`wontfix` reasons persist.** `nit_set_status` and `nit_mark_fixed` take an optional `reason`,
  stored on the annotation as `statusReason` — so the next session reads why instead of
  re-litigating the decision. Every status change replaces it, the concurrent-writer merge adopts
  it together with the status, and review.md renders it.
- **New resource: `nit://review/brief.md`.** One sanitized line per annotation — the token-lean
  overview for agents. The server instructions no longer advertise `review.md` to agents (it is
  the human rendering and a third copy of the same data) and no longer claim resources cost no
  tool call.
- **`fix-annotations.md` is tools-first.** The sheet used to tell agents to hand-edit `status` in
  `annotations.json` while the server instructions said every change goes through the tools; it
  now says to use the tools when they are available and reserves hand-editing for file-only
  sessions.
- **Honest descriptions.** The "verified-unique CSS selector" claim is corrected (the last-resort
  fallback selector is not verified), the review.md heading now shows the annotation's
  `viewportScope` instead of the capture viewport (which mislabeled general-scope issues captured
  on mobile), and the captured-at line names the viewport mode.

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
- **New: `nit status`** (alias `stats`). A quick read on a review folder without opening a
  browser: the annotations file, when it last changed and by whom, counts by status and type,
  the routes annotations sit on, what the screenshots weigh, and what to do next. Takes a review
  directory or a feedback file, writes nothing, and prints JSON with `--json`.
- **The MCP server now runs on the official SDK.** `nit mcp` is built on
  `@modelcontextprotocol/sdk` instead of a hand-rolled JSON-RPC loop, so protocol details
  (version negotiation, cancellation, completions, the resource methods) come from the
  reference implementation. The five tools, their arguments and everything they write to
  `annotations.json` are unchanged — existing agent setups keep working as they are.
- **Typed tool results.** Every tool declares an output schema and returns `structuredContent`
  alongside the JSON text block it always returned, so an agent gets typed data instead of
  parsing a blob.
- **Validated arguments.** Tool arguments are checked against zod schemas before a handler runs.
  A wrong type (say a numeric `ref`) is reported as an error rather than reaching the store;
  only the message text changed, the outcome was already safe.
- **Tool hints and titles.** Tools carry MCP's `readOnlyHint` / `destructiveHint` /
  `idempotentHint` / `openWorldHint` annotations and display titles, which clients use to decide
  what may run without confirmation.
- **The review is now readable as resources.** `nit://review/annotations.json`,
  `nit://review/review.md`, `nit://review/fix-annotations.md`, `nit://annotation/<id>` (with id
  completion) and the annotation screenshots. Resources are read-only; writes still go through
  the tools.
- **`serverInfo.version` reports the installed version** instead of a hardcoded `1.0.0`.

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
