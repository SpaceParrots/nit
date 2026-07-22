# Changelog

## 1.0.0 — 2026-07-22

First stable release.

### The loop

`nit review` (annotate a live site in a real Chromium) → hand the review folder or the MCP server
to a coding agent → `nit verify` (before/after screenshots, Verified / Reopen). Reviews are
shareable (`export` / `import`) and mergeable across authors.

### Added since 0.2.0

- **Annotation metadata** — optional `issueRef` (tracker key or url), `updatedAt`/`updatedBy`
  stamps on every status or issue-ref change. Written through one store funnel; `updatedBy` is
  `"agent"` for MCP writes.
- **Click-history reproduction trail** — the reviewer's last ≤10 clicks on the page are stored on
  each annotation (`history`), so states behind "open menu → pick tab" are replayable. Scoped to
  the pathname: query-param changes keep the trail, navigation resets it.
- **Routes with query + hash** — annotations record the exact page state; pin placement still
  matches on the pathname, so older review files behave unchanged.
- **Rebuilt panel** — logo, icon toolbar, sort (time/page/state) + grouping (page/state) behind a
  filter dropdown, collapsible page groups with the current page first, created/updated stamps, an
  issue-ref input, "Go to page" navigation, and a pinned footer with the actionable count.
- **MCP** — new `set_issue_ref` tool; `list_annotations` summaries carry `issueRef`, timestamps and
  `historyCount`.

### Security

- Annotation files are treated as untrusted end to end (they are shared and agent-written):
  navigation is origin-gated against the url the session actually opened, `issueRef` and click
  history are sanitized before they reach `review.md`, and screenshot paths cannot escape the
  review directory.
