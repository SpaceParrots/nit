# Viewport-anchored pins — design

Date: 2026-07-22
Status: approved (option B)

## Problem

Pins are positioned in absolute page coordinates (`rect + scroll`), so they ride along with
scrolling content. Elements inside `position: fixed` containers (a mobile tabbar) do NOT ride
along — the pin drifts away as soon as the page scrolls. The same coordinate-space mismatch
affects sticky headers (while stuck) and elements inside inner scroll containers.

## Decision

Viewport-anchor all pins and mirror the element's live on-screen position (approach B; approach A —
detecting fixed ancestors only — was rejected because sticky and inner-scroller cases stay broken).

- `.nit-pins` becomes `position: fixed` at the viewport origin; pins stay `position: absolute`
  inside it, so pin `left/top` are viewport coordinates read directly from
  `getBoundingClientRect()`. No scroll offsets, and the old `Math.max(0, …)` clamp is removed —
  a pin whose element scrolls out of the viewport scrolls out with it instead of sticking to the
  screen edge over unrelated content.
- `render()` keeps a `{ pin, el }` list. A new `reposition()` re-reads each element's rect and
  updates the existing pin nodes (no DOM rebuild).
- One scroll listener on `window` — `{ capture: true, passive: true }` so scrolls inside inner
  containers are seen too — plus `resize`, both rAF-throttled, calling `reposition()`. The
  existing debounced `refresh()` on resize (re-anchoring) is unchanged.
- `flash()` uses the same viewport coordinates (its layer is now fixed).
- Out of scope / unchanged: `emitUi` placed rects and verify screenshot clips stay in page
  coordinates (`pageRectOf`); the popover and highlight are already viewport-positioned.

Cost: ~N `getBoundingClientRect` calls per scrolled frame (N = pins on the route, typically <20) —
the standard devtools-overlay pattern.

## Testing

- Fixture gains a `position: fixed` bottom tabbar on `/`.
- Browser test (replay mode): one annotation anchored to the tabbar, one to normal content.
  Scroll → the tabbar pin's screen position is unchanged and still aligned with the tabbar; the
  content pin moved up with its content. Also: the content pin scrolled out of the viewport is NOT
  clamped to the screen edge.
