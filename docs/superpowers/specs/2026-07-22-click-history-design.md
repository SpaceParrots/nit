# Click history (reproduction trail) — design

Date: 2026-07-22
Status: approved (user: "Implement it all now")

## Problem

An annotation records *where* something is wrong, but not *how the reviewer got there*. A broken
state behind "open menu → pick tab → expand row" is hard for a fixing agent to reproduce from the
target reference alone.

## Design

Record the last page clicks leading up to an annotation and store them on it as reproduction data.

### Schema (`src/types.ts`)

```ts
/** One recorded page click leading up to an annotation (reproduction trail). */
export interface ClickStep {
  /** short CSS selector, built at click time (the element may be gone later) */
  selector: string;
  tag: string;
  /** nearest custom-element tag */
  component: string;
  /** visible text, whitespace-normalized, capped at 80 chars */
  text: string;
  /** ISO timestamp */
  at: string;
}

// on Annotation:
/** last ≤10 page clicks on this pathname before capture, oldest first */
history?: ClickStep[];
```

Optional — existing files load unchanged. `mergeReviews` spreads annotations, so merged reviews
carry it for free.

### Recording (`src/overlay/trail.ts`, new)

Overlay-owned, in-memory. A capture-phase click listener installed only in `review` mode:

- Skips clicks while picking (`state.picking`), clicks inside nit's own UI (`composedPath`
  contains the overlay host), and non-Element targets.
- Each entry reuses `buildSelector`, `nearestComponentTag`, `cleanText` from `capture/target.ts`.
- **Pathname scoping at click time:** if `location.pathname` differs from the trail's page, clear
  the trail first, then record. Query/hash changes do not reset. No route-watcher coupling.
- Ring of `MAX_HISTORY = 10`, oldest dropped.
- The bounded-append logic is a pure function (`appendStep`) so it is unit-testable; the DOM
  listener is a thin shell around it.

Rejected: Node-side recording via bridge events (chatty, more moving parts) and sessionStorage
(writes into the reviewed site — violates nit's zero-touch principle).

### Save path

`SavePayload` gains `history?: ClickStep[]`; the popover snapshots the trail at save. The trail is
NOT cleared after save — two annotations on the same broken state both carry the path there.

The bridge treats the payload as untrusted (page JS can forge `__nitSave` calls):
`sanitizeHistory(v: unknown)` in `src/util/history.ts` (shared constants with the overlay) keeps at
most 10 entries, requires all four string fields, whitespace-normalizes them, and caps lengths
(selector 300, text 80, tag/component 60). Non-conforming entries are dropped silently.

### Outputs

- `review.md`: a numbered "Steps on this page before this annotation (oldest first)" list, one
  line per step — selector as a code span (backticks stripped), text in quotes, component in
  parentheses. Same injection discipline as `issueRef`.
- MCP: `get_annotation` includes the field for free; `list_annotations` summaries gain
  `historyCount`.
- Panel: nothing (decided).

### Testing

- Unit: `appendStep` bounding + pathname reset + query survival; `sanitizeHistory` against hostile
  payloads (wrong types, oversized arrays/strings, markdown in text); `review.md` rendering incl.
  an injection attempt in click text; MCP `historyCount`.
- Integration: real clicks on the fixture SPA → save → assert stored trail content and order;
  navigate to another route, click, save → assert the trail reset; picking clicks excluded.

## V1 release (same effort)

- Version 1.0.0 in `package.json` (and the hardcoded serverInfo version in `mcp/server.ts`).
- `CHANGELOG.md` created with the 1.0.0 feature summary.
- `npm pack --dry-run` verified; `npm publish` is performed by Kevin (needs npm auth).
- Git tag `v1.0.0` on the release commit.
