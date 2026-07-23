// SPDX-License-Identifier: AGPL-3.0-or-later
// Numbered pins anchored to elements on the current route (replay + resumed capture).
// The layer is viewport-fixed and pins mirror each element's live on-screen position
// (getBoundingClientRect), repositioned on scroll — this is what keeps a pin glued to
// an element inside a fixed tabbar, a sticky header, or an inner scroll container,
// where absolute page coordinates would drift as soon as anything scrolls.
import type { OverlayActions, OverlayState, Pins } from './state.js';
import type { Annotation, Rect } from '../types.js';

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

  /** live pin nodes: element-tracked (el) or rect-fallback ghosts (rect); rebuilt by render */
  let tracked: { pin: HTMLElement; el?: Element; rect?: Rect }[] = [];

  function place(pin: HTMLElement, el: Element): void {
    const r = el.getBoundingClientRect();
    // No clamping: an element scrolled out of the viewport takes its pin with it
    // instead of leaving the pin stuck at the screen edge over unrelated content.
    pin.style.left = `${r.left - 10}px`;
    pin.style.top = `${r.top - 10}px`;
  }

  function placeApprox(pin: HTMLElement, rect: Rect): void {
    pin.style.left = `${rect.x - window.scrollX - 10}px`;
    pin.style.top = `${rect.y - window.scrollY - 10}px`;
  }

  function makePin(ann: Annotation, n: number, approx: boolean): HTMLElement {
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = `nit-pin nit-pin--${ann.type}`
      + (ann.status !== 'open' ? ' nit-pin--closed' : '')
      + (approx ? ' nit-pin--approx' : '');
    pin.textContent = String(n);
    pin.title = approx ? `${ann.comment}\n(approximate position — element not re-found)` : ann.comment;
    layer.append(pin);
    return pin;
  }

  function render(): void {
    layer.innerHTML = '';
    tracked = state.placed.map(({ ann, el }, i) => {
      const pin = makePin(ann, i + 1, false);
      place(pin, el);
      pin.addEventListener('click', e => {
        e.stopPropagation();
        actions.focusAnnotation(ann.id);
        flash(el);
      });
      return { pin, el };
    });
    // Ghost pins continue the numbering so the panel and the page agree on numbers.
    tracked.push(...state.approx.map(({ ann, rect }, i) => {
      const pin = makePin(ann, state.placed.length + i + 1, true);
      placeApprox(pin, rect);
      pin.addEventListener('click', e => {
        e.stopPropagation();
        actions.focusAnnotation(ann.id);
      });
      return { pin, rect };
    }));
  }

  /** Re-read every tracked position and move its pin — no DOM rebuild. A pin whose
   *  element got detached by an SPA re-render is hidden instead of collapsing to
   *  0,0 over unrelated content; the mutation watcher re-anchors it right after. */
  function reposition(): void {
    for (const t of tracked) {
      if (t.el) {
        const gone = !t.el.isConnected;
        t.pin.style.visibility = gone ? 'hidden' : '';
        if (!gone) place(t.pin, t.el);
      } else if (t.rect) {
        placeApprox(t.pin, t.rect);
      }
    }
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
    if (entry) {
      entry.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setTimeout(() => flash(entry.el), 250);
      return;
    }
    const ghost = state.approx.find(a => a.ann.id === id);
    if (!ghost) return;
    window.scrollTo({
      top: Math.max(0, ghost.rect.y - window.innerHeight / 2),
      left: Math.max(0, ghost.rect.x - window.innerWidth / 2),
      behavior: 'smooth',
    });
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
