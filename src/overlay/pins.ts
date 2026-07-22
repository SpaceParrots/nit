// SPDX-License-Identifier: AGPL-3.0-or-later
// Numbered pins anchored to elements on the current route (replay + resumed capture).
// The layer is viewport-fixed and pins mirror each element's live on-screen position
// (getBoundingClientRect), repositioned on scroll — this is what keeps a pin glued to
// an element inside a fixed tabbar, a sticky header, or an inner scroll container,
// where absolute page coordinates would drift as soon as anything scrolls.
import type { OverlayActions, OverlayState, Pins } from './state.js';

/**
 * Create the pins layer: one numbered pin per re-anchored annotation, positioned
 * in viewport coordinates and kept in place by a rAF-throttled scroll listener.
 * @param root the overlay shadow root to mount into
 * @param state shared overlay state (`state.placed` drives rendering)
 * @param actions overlay actions (focusAnnotation on pin click)
 */
export function createPins(root: ShadowRoot, state: OverlayState, actions: OverlayActions): Pins {
  const layer = document.createElement('div');
  layer.className = 'nit-pins';
  root.append(layer);

  /** live pin nodes and the elements they track (rebuilt by render) */
  let tracked: { pin: HTMLElement; el: Element }[] = [];

  function place(pin: HTMLElement, el: Element): void {
    const r = el.getBoundingClientRect();
    // No clamping: an element scrolled out of the viewport takes its pin with it
    // instead of leaving the pin stuck at the screen edge over unrelated content.
    pin.style.left = `${r.left - 10}px`;
    pin.style.top = `${r.top - 10}px`;
  }

  function render(): void {
    layer.innerHTML = '';
    tracked = state.placed.map(({ ann, el }, i) => {
      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = `nit-pin nit-pin--${ann.type}` + (ann.status !== 'open' ? ' nit-pin--closed' : '');
      pin.textContent = String(i + 1);
      pin.title = ann.comment;
      place(pin, el);
      pin.addEventListener('click', e => {
        e.stopPropagation();
        actions.focusAnnotation(ann.id);
        flash(el);
      });
      layer.append(pin);
      return { pin, el };
    });
  }

  /** Re-read every tracked element's rect and move its pin — no DOM rebuild. */
  function reposition(): void {
    for (const t of tracked) place(t.pin, t.el);
  }

  // Scroll anywhere (capture sees inner scroll containers too — scroll events
  // don't bubble) and resizes reposition the pins on the next animation frame.
  let scheduled = false;
  const onViewChange = (): void => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      reposition();
    });
  };
  window.addEventListener('scroll', onViewChange, { capture: true, passive: true });
  window.addEventListener('resize', onViewChange, { passive: true });

  function focus(id: string): void {
    const entry = state.placed.find(p => p.ann.id === id);
    if (!entry) return;
    entry.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => flash(entry.el), 250);
  }

  function flash(el: Element): void {
    const r = el.getBoundingClientRect();
    const f = document.createElement('div');
    f.className = 'nit-flash';
    f.style.left = `${r.left - 2}px`;
    f.style.top = `${r.top - 2}px`;
    f.style.width = `${r.width}px`;
    f.style.height = `${r.height}px`;
    layer.append(f);
    setTimeout(() => f.remove(), 1200);
  }

  return { render, focus };
}
