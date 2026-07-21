# Annotation metadata & panel UX — design

Date: 2026-07-21
Status: approved, ready for implementation planning

## Problem

Two gaps, one theme: an annotation records *what* and *where*, but almost nothing about its life
afterwards — and the panel that displays them has grown past what its original shape supports.

1. **Metadata.** An annotation carries `createdAt` and a `status`, but nothing records when the
   status last changed or who changed it, and there is no way to tie a nit to a real issue in a
   tracker. The fixing agent — the primary consumer of this data — sees less than it could.
2. **Navigation.** `route` stores `location.pathname` only. Annotations from other routes appear in
   the panel list with no way to get to the page they were found on, and query-driven pages
   (`?id=5`, `#tab`) can't be returned to at all.
3. **Panel UX.** The panel is a 290-line HTML-and-inline-JS string: no logo, text-labelled viewport
   buttons, no hover or focus feedback, no sorting or grouping, and the Finish action sits in the
   middle of the controls. None of its logic is testable.

## Direction

The metadata exists to make the **agent handoff richer** — it flows into `review.md` and the MCP
tools, not just the panel. The navigation and panel work exist to make a human's pass over a long
review fast.

## Part A — annotation metadata

### A1. Schema (`src/types.ts`)

Three optional fields on `Annotation`:

```ts
/** free-form issue key or URL: "FAI-1234", "#87", "https://…/browse/FAI-1234" */
issueRef?: string;
/** ISO timestamp of the last change to this annotation (status, issueRef) */
updatedAt?: string;
/** who made that change: the session author, or "agent" via MCP */
updatedBy?: string;
```

All three are optional, so every existing `annotations.json` remains valid and no migration step is
needed. `createdAt` (birth) and `verifiedAt` (verify verdict) keep their current meanings.

`mergeReviews` spreads annotations (`{ ...ann, id, author }`), so merged reviews carry the new
fields with no change to `merge.ts`.

**Rejected:** a `statusAt` map keyed by status, and discrete `fixedAt`/`wontfixAt`/`reopenedAt`
fields. Both answer "when was it first fixed"; neither is worth the field count for the value.
`updatedAt` + `verifiedAt` covers what the agent and `review.md` actually display.

### A2. One mutation funnel: `store.patch`

Today mutations are scattered — `bridge.ts` sets `ann.status` and `ann.verifiedAt` inline,
`mcp/server.ts` does the same. Adding `updatedAt`/`updatedBy` to each site invites one of them to
drift. Instead, a single method on `Store`:

```ts
/**
 * Apply changes to one annotation, stamping updatedAt/updatedBy. Returns the new
 * annotation, or null when the id is unknown. Replaces the entry (no in-place mutation).
 */
patch(id: string, changes: Partial<Annotation>, by: string): Annotation | null;
```

It builds `{ ...ann, ...changes, updatedAt: new Date().toISOString(), updatedBy: by }` and routes
through the existing `upsert`. Callers:

| Caller | `changes` | `by` |
| --- | --- | --- |
| `bridge.__nitVerdict` | `{ status, verifiedAt }` | `session.author` |
| `bridge.__nitSetIssueRef` | `{ issueRef }` | `session.author` |
| `mcp set_status` / `mark_fixed` | `{ status, verifiedAt? }` | `"agent"` |
| `mcp set_issue_ref` | `{ issueRef }` | `"agent"` |

Annotation creation (`__nitSave`) does **not** go through `patch` — a fresh annotation has
`createdAt` and no `updatedAt` until something changes it.

`store.flush()`'s existing concurrent-writer reconciliation (`mergeExternalStatuses`) adopts an
external `status` when we have no competing local edit; it must adopt that annotation's
`updatedAt`/`updatedBy` alongside `verifiedAt` so the stamp matches the status it belongs to.

### A3. Route captures query and hash

New module `src/overlay/route.ts`:

```ts
/** the annotation-facing route: pathname + search + hash */
export function currentRoute(): string;
/** the pathname portion of a stored route value */
export function routePath(route: string | undefined): string;
```

- `popover.ts` saves `currentRoute()` instead of `location.pathname`.
- `main.ts` `emitUi()` reports `currentRoute()` so the panel's route chip reflects query changes.
- `main.ts` `refresh()` matches **leniently**: `routePath(ann.route) === location.pathname`. An
  annotation captured at `/products?id=5` still pins on `/products`, and every review file written
  before this change behaves exactly as it does today.
- `installRouteWatcher` watches `currentRoute()` rather than `location.pathname`, so a query-only
  change refreshes the panel chip. Placement is unaffected (matching ignores the query).

The origin is deliberately **not** stored: it keeps coming from `review.url`, so a review captured
on staging still replays against localhost.

### A4. Navigation: `__nitGoTo(id)`

Navigation must happen in Node — only Node owns `session.sitePage` — so this is a new bridge
binding rather than a `PanelCmd`.

```ts
__nitGoTo?: (id: string) => Promise<BridgeResult<{ url: string }>>;
```

Behaviour:

1. Look up the annotation; unknown id → `{ ok: false, error }`.
2. Resolve the destination with a pure, unit-testable helper:
   ```ts
   /** src/store/url.ts — resolve an annotation route against the review url. */
   export function resolveAnnotationUrl(reviewUrl: string, route: string | undefined): string | null;
   ```
   It returns `new URL(route || '/', reviewUrl).href` **only** when the result's origin equals
   `reviewUrl`'s origin; otherwise `null`.
3. If the site page is already at that path+search, skip the navigation and go straight to step 5.
4. `await sitePage.goto(url, { waitUntil: 'domcontentloaded' })`.
5. Set `session.pendingFocus = { id, expiresAt }`.

**Security.** `annotations.json` is shared between people and edited by agents, so `route` is
untrusted input. A crafted `route: "https://evil.com/"` or `"javascript:alert(1)"` must never
navigate the reviewer's browser. Resolving through `new URL` and requiring an origin match against
`review.url` covers absolute URLs, protocol-relative `//host`, and non-http schemes alike (a
`javascript:` route resolves to a `javascript:` origin, which never matches).

**Focusing after navigation.** The pin cannot be focused immediately — the overlay has not
re-anchored yet. Rather than racing a timer, the existing `__nitEvent` `ui` handler does it: when
`session.pendingFocus` is set and that id appears in the reported `placed` list, Node relays
`{ cmd: 'focus', id }` to the overlay and clears the pending focus. It also clears when
`expiresAt` (≈10s) passes, so an annotation that never anchors doesn't leave a stale pending focus
to fire on some later page.

### A5. `__nitSetIssueRef(id, ref)`

```ts
__nitSetIssueRef?: (id: string, ref: string) => Promise<AnnotationResult>;
```

`VerdictResult` (`BridgeResult<{ annotation: Annotation }>`) is now returned by two bindings that
have nothing to do with verdicts, so it is renamed `AnnotationResult` and `VerdictResult` becomes
an alias of it for one version.

Trims the value; an empty string clears the field (`issueRef: undefined`). Caps the stored value at
200 characters — it is free-form text that ends up in `review.md` and MCP output. Goes through
`store.patch`, then `session.flush()`.

### A6. Outputs

**`review.md`** (`render.ts`) — the existing meta line gains the new facts:

```
- route: `/products?id=5` · author: Kevin · scope: desktop · captured at 1440×900
- issue: [FAI-1234](https://jira…/browse/FAI-1234) · updated 2026-07-22 by agent
```

The issue renders as a markdown link when the value parses as an `http`/`https` URL, otherwise as
inline code. The line is omitted entirely when neither `issueRef` nor `updatedAt` is set.

**MCP** (`mcp/server.ts`):

- `list_annotations` summary objects gain `issueRef`, `createdAt`, `updatedAt`, `updatedBy`.
- Its `route` filter matches the full stored route **or** the route's path, so it does not turn
  brittle now that routes carry query strings.
- New tool `set_issue_ref { id, ref }` — sets or (with an empty `ref`) clears the reference.
- `set_status` / `mark_fixed` route through `store.patch` with `by: "agent"`.

**`fix-annotations.md`** — one added paragraph: the agent may record the issue it filed or fixed
under `issueRef`; `updatedAt`/`updatedBy` are maintained by nit and should not be hand-edited.

## Part B — panel

### B1. Structure

The panel is currently one function returning a 290-line HTML string with the entire UI as inline
JavaScript. Sorting and grouping are real logic and cannot be unit-tested in that shape. The
overlay already solves this problem: it is ordinary TypeScript, bundled to an IIFE by esbuild
(`inject.ts`) and injected as a string. The panel adopts the same pattern.

```
src/panel/main.ts      boot, poll loop, render orchestration
src/panel/list.ts      item + group rendering
src/panel/filter.ts    sortAnnotations() / groupAnnotations()   ← pure, unit-tested
src/panel/icons.ts     lucide SVG strings
src/panel/logo.ts      generated: base64 data URI of assets/nit-32.png
src/panel/panel.css    styles (copied into dist/ by the build, like overlay.css)
src/browser/panel.ts   thin: open the popup window, set the shell HTML, inject the bundle
```

`panel.ts` keeps `openPanel()` — window geometry, docking, the `close` handler — sets a minimal
shell document via `setContent`, then evaluates the esbuild-produced bundle in the panel page. The
bundle is built and cached once per process, mirroring `buildOverlayBundle()`.

The overlay bundle already refuses to run in the panel (`window.name === 'nit-panel'`); the panel
bundle is only ever evaluated in the panel page, so no equivalent guard is needed.

### B2. Assets

`assets/` is not in package.json's `files`, and the panel is a `setContent` document with no server
behind it — so the logo must be an inlined data URI regardless of packaging.

`scripts/gen-logo.mjs` reads `assets/nit-32.png` and writes `src/panel/logo.ts`
(`export const NIT_LOGO_DATA_URI = 'data:image/png;base64,…'`, ≈3.8 KB). The file is committed;
the script is re-run by hand when the logo changes. No package.json `files` change, no runtime file
IO, works headless and offline.

Lucide icons ship the same way: `src/panel/icons.ts` exports the SVG markup for `crosshair`,
`monitor`, `smartphone`, `filter`, `check`, `trash-2`, `external-link`, `chevron-right` and `tag`.
Inlined paths, no npm dependency, no network request.

### B3. Layout

```
┌────────────────────────────────┐
│ ▣ nit                  REVIEW  │  header: logo (18px) + wordmark + mode pill
├────────────────────────────────┤
│ [◎ Pick element]  [▭][▯]  [⚟]  │  toolbar: pick · monitor/smartphone · filter
├────────────────────────────────┤
│ ▾ /products (3)                │  list (scrolls)
│    ① CR  Star icons not filled │
│    ② C   Copy reads oddly      │
│  ▸ /auth/sign-in (1)           │
├────────────────────────────────┤
│ Couldn't place here (2)        │  unchanged section
├────────────────────────────────┤
│ 5 actionable                   │  footer, pinned to the bottom
│ [✓ Finish review]              │
└────────────────────────────────┘
```

Changes from today: the logo appears; Desktop/Mobile become icon buttons with `title`/`aria-label`
instead of text; the scope filter button leaves the toolbar for the dropdown; Finish moves from the
middle of the controls to a pinned footer, above which sits a muted actionable count. Finish stays
review-mode only; the count shows in every mode. "Actionable" uses the same definition as
`render.ts`: a `change-request` whose status is `open` or `reopened`.

### B4. Interaction feedback

Applied to every button:

- `transition: background .12s, border-color .12s` — hover lifts background and border.
- `:active { transform: translateY(1px) }` — a physical press.
- `:focus-visible` — accent-coloured ring (the panel is keyboard-reachable).
- Toggled/active state keeps today's accent fill.
- Disabled (Go-to-page while already on that route) — 40% opacity, `cursor: default`.
- Icon-only buttons carry `title` and `aria-label`.

### B5. Filter dropdown

The filter icon opens a dropdown containing:

- **Sort:** Page · Time · State
- **Group by:** None · Page · State
- **Scope:** a checkbox for the existing "general + current viewport" filter, moved out of the
  toolbar (it still drives the overlay through the existing `toggleShowAll` command).

Defaults: group by **Page**, sort by **Time**.

Semantics, all in `src/panel/filter.ts` as pure functions over `(annotations, options, context)`:

- **Page** — by `routePath`, then the full route, alphabetically.
- **Time** — by `createdAt`, **newest first**. (This differs from today's implicit
  oldest-first array order; it is a deliberate choice, easy to flip.)
- **State** — actionable first: `open → reopened → fixed → verified → wontfix`.
- **Group by Page** — one collapsible section per route, with a count. **The current route's group
  sorts first and starts expanded; every other group starts collapsed.** This is what makes
  Go-to-page useful: the panel shows you where you are, and everything else is one click away. The
  current route comes from `PanelState.route` (already reported by the overlay), matched on
  `routePath` so a query-string difference does not split the group you are standing on.
- The chosen sort applies **within** each group as well as to an ungrouped list. Groups themselves
  are ordered by the grouping key (route alphabetically, status actionable-first), not by the sort.
- **Group by State** — one collapsible section per status, in the actionable-first order above.

Sort/group choices and collapsed-group state live in panel memory for the session. The dropdown
closes on outside click and on Escape.

### B6. Expanded item

The expanded annotation gains, above the existing component/selector lines:

```
created 2026-07-21 14:22 · updated 2026-07-22 09:01 by Kevin
[tag icon] [ FAI-1234                    ]        ← input; Enter/blur commits, empty clears
[external-link icon] /products?id=5                ← "Go to page"; disabled on the current route
```

Collapsed rows show a small muted `issueRef` chip beside the route chip when one is set.

### B7. Re-render hazard

The panel re-renders wholesale whenever its polled state key changes (every 600 ms). Introducing a
text input and a dropdown means a tick landing mid-typing would steal the caret or close the menu.

Mitigations, both required:

1. Skip the render pass while `document.activeElement` is an input inside the list, or while the
   filter dropdown is open. The next tick after focus leaves picks up the pending state.
2. Include the local UI state — sort, group, collapsed group ids, expanded id — in the diff key
   that currently holds `[state, expandedId]`, so local changes actually repaint.

## Implementation order

Part A and Part B are one spec because the panel is where the new metadata is read and written, but
they land in sequence and each is independently shippable:

1. **A1–A2** schema + `store.patch` (+ MCP and bridge callers routed through it).
2. **A3** route with query/hash, lenient matching.
3. **A4–A5** `__nitGoTo` and `__nitSetIssueRef` bindings.
4. **A6** `review.md`, MCP tool surface, `fix-annotations.md`.
5. **B1–B2** panel extracted to `src/panel/`, bundled, logo and icons — no behaviour change yet.
6. **B3–B7** the new layout, feedback, dropdown, and expanded-item controls.

Step 5 is a pure refactor and should be verified green (existing panel behaviour intact) before
step 6 changes anything visible.

## Testing

**Unit**

- `filter.ts`: each sort order; each grouping; current-route-group-first; the actionable-first state
  ordering; empty and single-group inputs.
- `resolveAnnotationUrl`: relative route resolves; cross-origin absolute route rejected;
  `javascript:` route rejected; protocol-relative `//host` rejected; missing/empty route → `/`.
- `store.patch`: stamps `updatedAt`/`updatedBy`; returns null for an unknown id; leaves other
  annotations untouched; `flush` adopts an external `updatedAt` with its status.
- `route.ts`: `currentRoute()` composition; `routePath()` on values with query, hash, both, neither.
- `render.ts`: `issueRef` as a plain key vs. a URL; the meta line omitted when both fields are
  absent.
- `mcp`: `set_issue_ref` sets and clears; `list_annotations` route filter matches full route and
  path; `set_status` stamps `updatedBy: "agent"`.

**Integration (headless browser)**

- Go-to-page on an annotation from another route navigates the site page and focuses the pin.
- Group headers collapse and expand.
- Setting an issue ref from the panel persists to `annotations.json`.

## Out of scope

- Issue-tracker integration (creating tickets, fetching status, URL templates per project). The
  reference is a free-form string; if it is a URL, `review.md` links it.
- A status-history log — explicitly rejected in favour of `updatedAt`/`updatedBy`.
- Status filtering (hide fixed/verified) in the dropdown — grouping by state covers it for now.
- Persisting sort/group preferences across sessions.
- Reviewer-driven status changes in review mode (marking something fixed by hand); the verdict
  buttons stay verify-mode only.
