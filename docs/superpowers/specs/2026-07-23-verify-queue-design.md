# Verify queue — make `nit verify` actually usable

Date: 2026-07-23 · Status: approved for implementation

## Problem

`nit verify` promises "after-shots are captured automatically; rule each item in the
panel" but in practice nothing visible happens:

1. **Capture only runs on the route you are on.** After-shots are driven by overlay
   `ui` events; fixed items on other routes are never captured unless the reviewer
   happens to navigate there, and nothing tells them to.
2. **SPAs break the fallback.** The overlay's first refresh fires at
   `DOMContentLoaded`, before an SPA renders. Every fixed item fails to anchor, so
   `captureAfterShots` immediately captures the *original region of a still-blank
   page* as the fallback after-shot and marks the id captured for the whole session —
   the real element appearing two seconds later never gets a shot.
3. **The verdict UI is invisible.** Verified/Reopen buttons exist only inside an
   expanded list row; there is no Skip, no progress, and verify mode looks identical
   to review mode.

## Design

### A. Verify queue in the panel (new, the visible UX)

In `mode === 'verify'` the panel renders a **queue card** above the list:

- **Progress header**: `Verify fixes — 2 of 5 ruled` plus a thin progress bar.
  Denominator = ids the panel has seen with status `fixed` this session; numerator =
  those now `verified`/`reopened`.
- **Current item card**: pin number/comment, route chip, **before** and **after**
  screenshots stacked with labels. While `screenshotAfter` is absent: a "capturing
  after-shot…" line. When the item is currently in the `unplaced` list: note
  "element couldn't be re-found — showing the originally recorded region".
- **Action row, always visible**: `✓ Verified` · `↺ Reopen` · `Skip →`.
  - *Reopen* reveals an optional one-line note input ("why is it not fixed?") with
    Reopen/Cancel; the note is stored as `statusReason` (existing schema field).
  - *Verified* rules immediately (clears a stale `statusReason`).
  - *Skip* is session-local: the item moves to the end of the queue and counts as
    "skipped" in the done-state summary; its status stays `fixed`.
- **Auto-tour**: queue is ordered current-route-first, then grouped by route to
  minimize navigation. When the current item sits on another route the panel calls
  `__nitGoTo(id)` automatically (once per item — a `navRequestedFor` guard, so a user
  navigating away manually is not fought). `__nitGoTo` already gates origins and
  focuses the pin.
- **Done state**: when no unruled items remain: `All fixed items ruled — X verified,
  Y reopened, Z skipped` + the Finish button (now shown in verify mode too).
- **Empty state**: no `fixed` items at all → "Nothing to verify yet — the agent has
  not marked any annotation fixed."

Queue ordering/progress is pure logic in `src/panel/verify-queue.ts` (unit-tested);
DOM rendering lives in `src/panel/verify.ts`; `main.ts` wires both in verify mode.

### B. Capture robustness (Node + overlay)

- **Grace period for the fallback**: an unplaced fixed item is only fallback-captured
  after it has stayed unplaced for ≥4 s since first being reported on its route
  (per-id first-seen timestamps in the session). Placed items still capture
  immediately. SPA late renders anchor within the grace window and get a real shot.
- **Fallback upgrade**: `_afterCaptured` becomes a map `id → 'anchored' | 'fallback'`.
  If a fallback-captured id later reports placed, the element is recaptured and the
  after-shot overwritten (logged as an upgrade).
- **Overlay re-anchor retries**: in `view`/`verify` mode, after load or route change
  the overlay re-runs `refresh` every 1 s (up to 10 tries, reset per route) while
  unplaced items remain, emitting fresh `ui` events so late-rendering elements
  anchor and capture.

### C. Contract + CLI

- `__nitVerdict(id, verdict, note?)` — optional note stored as `statusReason`
  (trimmed, capped at 500 chars); omitted/empty note clears a stale reason.
  `types.ts` Window signature updated (additive).
- `nit verify` CLI copy tells the truth ("the panel walks you through each fixed
  item"), and the session end prints a summary: verified / reopened / still fixed.

## Out of scope

- No schema additions (statusReason and screenshotAfter already exist).
- No changes to review/view modes beyond the shared overlay retry.
- No MCP surface changes (statusReason is already served).

## Tests

- Unit: `verify-queue.ts` ordering, progress, skip cycling (table-driven, node:test).
- Browser (`test/browser-verify.test.js`): queue card renders with visible verdict
  buttons without expanding rows; Skip advances; Reopen-with-note lands in
  `statusReason`; fallback grace (unanchorable item captured only after ~4 s);
  fallback upgrade when an element appears late (fixture route with delayed render
  if feasible); done-state summary appears after all rulings.
