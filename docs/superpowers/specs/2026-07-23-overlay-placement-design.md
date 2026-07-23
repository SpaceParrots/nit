# Overlay placement reliability — design

Date: 2026-07-23
Status: approved (Kevin), pending implementation plan

## Problem

The replay/capture overlay places numbered pins by re-anchoring each annotation's
`target` to a live element. Three failure modes are hurting trust in the overlay:

1. **Pins disappear on SPA route changes.** The anchor retry cycle only runs in
   `view`/`verify` mode; in `review` mode a route change gets exactly two delayed
   refreshes (300 ms / 1500 ms). Pages that render slower lose their pins until
   the next incidental refresh. Additionally, when the SPA re-renders and
   replaces DOM nodes, pins keep tracking **detached elements** whose
   `getBoundingClientRect()` collapses to `0,0` — pins drift to the top-left or
   sit over unrelated content ("placed wrong").
2. **Mobile and desktop annotations mix.** Review mode defaults to
   `showAll = true`, so mobile-scoped annotations render while in desktop mode
   and vice versa. Separately, responsive sites often render both mobile and
   desktop markup and hide one; the anchorer returns the first selector match
   even when that match is the hidden twin.
3. **Dialog context is not captured.** An annotation made inside a
   modal/dialog/drawer silently lands in `unplaced` on replay with no in-page
   indication of why, and nothing records that it belonged to a dialog at all.

## Goals

- The overlay accurately shows where annotations were placed.
- Annotations remember whether they were captured in a modal/dialog or on the
  plain page.
- When an annotation cannot be placed (closed dialog, other viewport, element
  gone), the page shows a small disclaimer: "x annotations hidden", with
  per-annotation reasons.
- Last-resort coordinate fallback: when the element cannot be re-found but the
  captured position is still meaningful, show an "approximate" ghost pin at the
  recorded page coordinates.

## Non-goals

- Auto-reopening dialogs by replaying the click trail (explicitly rejected —
  clicking through arbitrary app state is fragile and can have side effects).
- Position-first placement (pins always at recorded x/y) — trades "missing" for
  "confidently wrong" whenever layout shifts.

## Design

### 1. Data model (`src/types.ts`, additive)

```ts
/** Where the annotated element lived at capture time. */
export interface CaptureContext {
  /** 'page' for normal content; 'dialog' for modal/dialog/drawer/overlay surfaces */
  kind: 'page' | 'dialog';
  /** selector for the dialog container itself — replay checks "is that dialog open?" */
  selector?: string;
  /** human-readable dialog name: aria-label → aria-labelledby → first heading, capped */
  label?: string;
}
```

- `Annotation.context?: CaptureContext`. Missing (all existing files) is treated
  as page context. The field is written at capture time and passed through
  store, merge, export, and MCP untouched.
- `SavePayload.context?: CaptureContext` carries it over the bridge.
- `OverlayUiEvent` and `PanelState` gain optional additive fields:
  - `approx?: PlacedRef[]` — ghost-pinned annotations with their fallback rects,
  - `hidden?: HiddenRef[]` where
    `HiddenRef = { id: string; reason: 'viewport' | 'dialog' | 'not-found'; label?: string }`.
- The existing `placed` list keeps meaning **truly anchored to a rendered
  element** only; `unplaced` keeps meaning "on this route but not anchored"
  (approx ids stay in `unplaced`). The verify after-shot pipeline and its
  grace-period clocks consume these exact semantics and keep working unchanged.

### 2. Dialog detection at capture (`src/capture/context.ts`, new)

Pure DOM walk from the picked element upward; never throws. First ancestor
matching any of:

- `<dialog>` element,
- `[role="dialog"]`, `[role="alertdialog"]`, `[aria-modal="true"]`,
- Angular CDK overlay pane (`.cdk-overlay-pane`) — covers Material dialogs,
  bottom sheets, and overlay-hosted menus,
- `.modal`, `.offcanvas` (Bootstrap-style).

On a hit, the context is `kind: 'dialog'` with:

- `selector`: built for the container via the existing `buildSelector`,
- `label`: container `aria-label` → resolved `aria-labelledby` text → first
  `h1–h6` text inside the container, whitespace-normalized, capped at 60 chars.

No hit ⇒ `{ kind: 'page' }`. The popover save path calls this and includes the
result in `SavePayload`.

### 3. Visibility-aware anchoring (`src/anchor/anchor.ts`)

Today each layer (CSS selector → XPath → text heuristic) returns its first
match even when that match is not rendered (hidden responsive twin). Change:

- New export `anchorTargetDetailed(target, doc): { el: Element; rendered: boolean } | null`.
  Each layer's match is checked for being rendered (non-zero rect). A
  non-rendered match is remembered as fallback and the search continues to the
  next layer looking for a rendered match. Text-heuristic candidate scans prefer
  rendered candidates the same way.
- `anchorTarget()` keeps its exact signature/behavior contract for existing
  consumers, implemented on top of the detailed variant (returns the rendered
  match if any, else the hidden fallback, else null).

### 4. Placement states (`src/overlay/main.ts` refresh)

Every annotation on the current route classifies into exactly one of:

- **placed** — anchored to a rendered element. Normal numbered pin (unchanged).
- **approx** — no rendered element found, `context.kind !== 'dialog'`, and the
  current viewport mode equals the captured `viewport.mode`, and `target.rect`
  has non-zero size. Rendered as a **ghost pin** (dashed/translucent, same
  numbering sequence) at the recorded `target.rect` absolute page coordinates,
  converted to viewport coordinates and repositioned on scroll like normal
  pins. Tooltip: "approximate position — element not re-found". Click focuses
  the annotation in the panel.
- **hidden** — everything else, with a reason:
  - `viewport`: scope-filtered for the current viewport mode (see §6),
  - `dialog`: `context.kind === 'dialog'` and the context selector resolves to
    no rendered container (the dialog is closed). `label` is carried along for
    display ("in dialog 'Checkout'"),
  - `not-found`: anchoring failed and no safe fallback exists (dialog is open
    but the element is gone; viewport mode differs from capture so the recorded
    rect is meaningless; rect missing/empty).

Classification order: route match → viewport scope filter → anchor → context
check → approx fallback.

### 5. Re-anchor reliability

- **Retry cycle in all modes.** `installAnchorRetries` (1 s interval, 10
  attempts while unplaced annotations remain) currently runs in view/verify
  only; it now runs in review mode too, restarted by the same triggers (route
  change, debounced resize, viewport switch).
- **MutationObserver.** Observe `document.body` (childList + subtree +
  `attributeFilter: ['class', 'style', 'hidden', 'open']`), debounced ~250 ms
  after the last mutation with a ≥500 ms floor between observer-triggered
  refreshes. Fires a refresh when annotations for the current route are
  unplaced/approx **or any tracked pin element is detached**. The overlay host
  lives on `document.documentElement` (not body) and its UI in a shadow root,
  so the observer never sees the overlay's own mutations.
- **Detached-element guard.** `pins.reposition()` checks `el.isConnected`; a
  detached element hides its pin immediately (no 0,0 drift) — the observer
  refresh then re-anchors it.
- The timer-based retry cycle is kept (not replaced): verify's per-viewport
  grace clock needs the steady stream of `ui` events; the observer only makes
  recovery near-instant.

### 6. Viewport filtering by default, everywhere

`state.showAll` defaults to `false` in **all** modes (today: `true` outside
view mode). Scoped annotations render only in their own viewport mode;
`general` renders in both. Filtered-out annotations are hidden with reason
`viewport` and count toward the pill. The existing show-all toggle (panel +
overlay command) stays as the override.

Verify note: with filtering on, a scoped annotation is no longer reported
`unplaced` while the session sits in the other viewport — its grace clock only
runs at its own viewport, which the verify tour switches to anyway. This is
strictly more correct than today (prevents wrong-viewport fallback crops).

### 7. Hidden pill (overlay UI)

A small pill next to the existing bottom-left chip, only rendered when the
hidden count for the current route is > 0: **"3 hidden"**. Click toggles a
mini-popover listing each hidden annotation — id/number, a short comment
snippet, and the reason ("in dialog 'Checkout'", "mobile-only", "not found").
Clicking a row focuses that annotation in the panel window (`focus` event).
Approx (ghost-pinned) annotations do not count — they are visible.

The pill participates in `setUiHidden` like the rest of the overlay (hidden
during screenshot capture automatically, since it lives in the same host).

### 8. Panel

The "Couldn't place on this page" section shows the reason per row, sourced
from `PanelState.hidden` / `approx` (rows for approx annotations say
"approximate pin shown"). No structural panel changes.

### 9. Compatibility

- `annotations.json` schema change is additive (`context` optional). Old files
  load unchanged; old nit versions reading new files ignore the field.
- Bridge events/state gain optional fields only; `placed`/`unplaced` semantics
  are unchanged, so `browser/verify.ts`, `panel/verify.ts`, and the
  verify-queue keep working without modification.
- Store sanitization (`store.ts`) must accept and preserve `context` (untrusted
  file: validate shape, drop invalid values).

## Testing

- **Unit:** dialog-context detection (dialog/role/aria-modal/cdk/modal
  ancestors, label resolution, page fallback); visibility-aware anchoring
  (hidden selector match + visible xpath/text match → visible wins; all hidden
  → hidden fallback returned, `rendered: false`).
- **Browser:** pins survive an SPA route change with delayed rendering (review
  mode); DOM node replacement re-anchors instead of drifting; viewport
  filtering in review mode (mobile-scoped pin absent on desktop, pill counts
  it); dialog annotation → hidden with reason + pill text; ghost pin at
  recorded rect when the element is removed; pill absent when everything
  places.
- **Contract:** existing verify-queue and after-shot tests must pass untouched.

## Affected files (expected)

- `src/types.ts` — `CaptureContext`, `HiddenRef`, event/state fields
- `src/capture/context.ts` — new
- `src/anchor/anchor.ts` — visibility-aware layering
- `src/overlay/main.ts` — classification, observer, retries in review mode
- `src/overlay/pins.ts` — ghost pins, detached guard
- `src/overlay/hidden-pill.ts` — new (pill + mini-popover)
- `src/overlay/popover.ts` — include context in save payload
- `src/overlay/overlay.css` — ghost pin + pill styles
- `src/browser/bridge.ts` — pass-through of new event fields, save context
- `src/store/store.ts` — sanitize/persist `context`
- `src/panel/main.ts` — reasons in the unplaced section
- `docs/wiki/annotations.md`, `docs/wiki/how-it-works.md` — schema + behavior
