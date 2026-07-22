# Context screenshots, captured at pick time — design

Date: 2026-07-22
Status: approved (context crop)

## Problems

1. A screenshot is the element rect + 24px padding — for a button that is a tight crop with no
   visual context of where the component sits.
2. The capture runs at save time (inside `__nitSave`), after the reviewer typed the comment — by
   then transient states (open dropdowns, hover menus) have collapsed, so the screenshot shows the
   closed state the annotation is NOT about.

## Design

### Context crop (minimum clip size)

`contextClip(rect, opts)` — pure, unit-tested — replaces the inline clip math in
`capture/screenshot.ts`:

- The clip is the element rect + padding, expanded to at least `MIN_SHOT_W × MIN_SHOT_H`
  (480×360), centered on the element.
- Clamped to the page bounds (scrollWidth/scrollHeight, fetched once per capture; on failure the
  clamp is skipped, only `x,y ≥ 0` holds). When the page is smaller than the minimum, the clip is
  the page.
- Large elements behave as today (padding only). Verify after-shots go through the same function,
  so before/after stay comparable.

### Capture at pick time

- New guarded binding `__nitStageShot(rect)`: captures the context clip into an in-memory
  `session.pendingShot = { buffer, at }` (latest wins, expires after 2 minutes). No file is
  written at this point.
- The picker, after an element is selected and before the popover opens: hide nit's UI, await
  `__nitStageShot`, unhide, open the popover. Nothing has moved the mouse or stolen focus yet, so
  a dropdown open at click time is still open in the shot. A staging failure never blocks the
  popover (fallback below covers it).
- `__nitSave`: a fresh pending shot is written as the annotation's screenshot and cleared;
  without one (expiry, forged call, staging failure) the old capture-at-save path runs unchanged.

### Trust

`__nitStageShot` goes through the existing `guard()`; the rect remains page-supplied and is
re-clamped by the existing capture validation. The pending buffer is keyed to the session, not
trusted content.

## Testing

- Unit: `contextClip` table — small element expands centered to the minimum; large element keeps
  padding-only; clamping at page edges; page smaller than the minimum.
- Integration: pick a small element → `session.pendingShot` exists before save; after save the
  PNG's dimensions (via `pngSize`) meet the minimum and the pending shot is consumed.
