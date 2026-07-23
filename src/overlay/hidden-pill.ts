// SPDX-License-Identifier: AGPL-3.0-or-later
// The "x hidden" pill: sits in the bottom-left dock next to the chip whenever
// annotations on this route cannot be shown (closed dialog, other viewport,
// element gone). Click toggles a mini-popover listing each with its reason;
// a row click focuses the annotation in the panel window.
import type { HiddenAnnotation, HiddenPill, OverlayActions, OverlayState } from './state.js';

const MAX_SNIPPET = 40;

/**
 * Create the hidden pill + reason popover.
 * @param dock the bottom-left dock element to mount the pill into
 * @param state shared overlay state (`state.hidden` drives it)
 * @param actions overlay actions (focusAnnotation on row click)
 */
export function createHiddenPill(dock: HTMLElement, state: OverlayState, actions: OverlayActions): HiddenPill {
  const pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'nit-hidden-pill';
  pill.hidden = true;
  pill.title = "Annotations on this page that can't be shown right now";
  dock.append(pill);

  const pop = document.createElement('div');
  pop.className = 'nit-hidden-pop';
  pop.hidden = true;
  dock.append(pop);

  pill.addEventListener('click', () => {
    if (!pop.hidden) {
      pop.hidden = true;
      return;
    }
    renderPop();
    pop.hidden = false;
  });

  function reasonText(h: HiddenAnnotation): string {
    if (h.reason === 'viewport') return `${h.ann.viewportScope}-only`;
    if (h.reason === 'dialog') return h.label ? `in dialog \u201C${h.label}\u201D` : 'in a closed dialog';
    return 'not found on this page';
  }

  function renderPop(): void {
    pop.innerHTML = '';
    for (const h of state.hidden) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'nit-hidden-row';
      const snippet = h.ann.comment.length > MAX_SNIPPET ? `${h.ann.comment.slice(0, MAX_SNIPPET)}\u2026` : h.ann.comment;
      row.textContent = `${h.ann.id} \u00B7 ${snippet} \u2014 ${reasonText(h)}`;
      row.addEventListener('click', () => actions.focusAnnotation(h.ann.id));
      pop.append(row);
    }
  }

  function update(): void {
    const n = state.hidden.length;
    pill.hidden = n === 0;
    if (n === 0) {
      pop.hidden = true;
      return;
    }
    pill.textContent = `${n} hidden`;
    if (!pop.hidden) renderPop();
  }
  update();
  return { update };
}
