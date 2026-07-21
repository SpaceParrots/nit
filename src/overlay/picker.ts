// SPDX-License-Identifier: AGPL-3.0-or-later
// Capture-mode element picker: Alt toggles picking, hover highlights, click selects,
// Esc cancels. All listeners are capture-phase so the page never sees picking clicks.
import { describeElement } from './dom.js';
import type { Highlight, OverlayActions, OverlayState, Picker, Popover } from './state.js';

/** The overlay parts the picker needs (a subset of the full ui). */
export interface PickerUi {
  host: HTMLElement;
  root: ShadowRoot;
  popover: Popover;
}

/**
 * Install the element picker: Alt toggles picking, hover highlights, click
 * selects (and never reaches the page), Esc cancels. Debug mode additionally
 * reports every page click through the bridge.
 * @param state shared overlay state (picking flag, mode, hovered element)
 * @param ui mounted overlay parts (see {@link PickerUi})
 * @param actions overlay actions (uiChanged is called on picking toggles)
 */
export function installPicker(state: OverlayState, ui: PickerUi, actions: OverlayActions): Picker {
  const highlight = createHighlight(ui.root);

  const api: Picker = {
    highlight,
    setPicking(on: boolean): void {
      state.picking = on;
      if (!on) {
        highlight.hide();
        state.hovered = null;
      }
      document.documentElement.style.cursor = on ? 'crosshair' : '';
      actions.uiChanged();
    },
  };

  const inOwnUi = (e: Event): boolean => e.composedPath().includes(ui.host);

  window.addEventListener('keydown', e => {
    if (inOwnUi(e)) return; // our inputs handle their own keys
    if (e.key === 'Alt' && !e.repeat && state.mode === 'review' && !ui.popover.isOpen()) {
      e.preventDefault();
      api.setPicking(!state.picking);
    } else if (e.key === 'Escape') {
      if (ui.popover.isOpen()) ui.popover.close();
      else if (state.picking) api.setPicking(false);
    }
  }, true);

  window.addEventListener('mousemove', e => {
    if (!state.picking) return;
    if (inOwnUi(e)) { highlight.hide(); state.hovered = null; return; }
    const t = e.composedPath()[0];
    if (!(t instanceof Element)) return;
    state.hovered = t;
    highlight.show(t);
  }, true);

  const swallow = (e: Event): void => {
    if (!state.picking || inOwnUi(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'auxclick', 'contextmenu']) {
    window.addEventListener(type, swallow, true);
  }

  window.addEventListener('click', e => {
    if (state.debug && !inOwnUi(e)) {
      const t = e.composedPath()[0];
      try {
        void window.__nitEvent?.({
          type: 'click',
          x: Math.round(e.pageX),
          y: Math.round(e.pageY),
          tag: t instanceof Element ? t.tagName.toLowerCase() : '?',
        });
      } catch { /* bridge gone — ignore */ }
    }
    if (!state.picking || inOwnUi(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const t = e.composedPath()[0];
    if (!(t instanceof Element)) return;
    api.setPicking(false);
    state.selected = t;
    highlight.show(t, true);
    ui.popover.open(t);
  }, true);

  return api;
}

function createHighlight(root: ShadowRoot): Highlight {
  const box = document.createElement('div');
  box.className = 'nit-highlight';
  box.hidden = true;
  const label = document.createElement('div');
  label.className = 'nit-highlight-label';
  box.append(label);
  root.append(box);
  return {
    show(el: Element, pinned = false): void {
      const r = el.getBoundingClientRect();
      box.hidden = false;
      box.classList.toggle('nit-highlight--pinned', pinned);
      box.style.left = `${r.left - 2}px`;
      box.style.top = `${r.top - 2}px`;
      box.style.width = `${r.width}px`;
      box.style.height = `${r.height}px`;
      label.textContent = describeElement(el);
    },
    hide(): void {
      box.hidden = true;
    },
  };
}
