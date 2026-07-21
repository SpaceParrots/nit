// SPDX-License-Identifier: AGPL-3.0-or-later
// The annotation popover: comment text, type selector (default change-request),
// viewport-scope toggle (default: current viewport, toggleable to general).
import { div, button, segmented, labelRow, describeElement } from './dom.js';
import { resolveTarget } from '../capture/target.js';
import type { AnnotationType, SavePayload, ViewportScope } from '../types.js';
import type { OverlayActions, OverlayState, Popover } from './state.js';

/**
 * Create the annotation popover: comment text, type selector (default
 * change-request) and viewport-scope toggle (default: the current viewport).
 * Save resolves the target, hides the overlay for a clean screenshot, and hands
 * the payload to Node via `__nitSave`.
 * @param root the overlay shadow root to mount into
 * @param state shared overlay state (viewport mode for the scope options)
 * @param actions overlay actions (onSaved, hideHighlight, setUiHidden)
 */
export function createPopover(root: ShadowRoot, state: OverlayState, actions: OverlayActions): Popover {
  const el = document.createElement('div');
  el.className = 'nit-popover';
  el.hidden = true;
  root.append(el);
  let currentEl: Element | null = null;
  let saving = false;
  // Keep keystrokes (except Escape) away from page-level hotkey handlers.
  el.addEventListener('keydown', e => { if (e.key !== 'Escape') e.stopPropagation(); });

  function open(target: Element): void {
    currentEl = target;
    saving = false;
    render();
    el.hidden = false;
    position(target);
    el.querySelector('textarea')?.focus();
  }

  function close(): void {
    el.hidden = true;
    currentEl = null;
    actions.hideHighlight();
  }

  function render(): void {
    el.innerHTML = '';
    if (!currentEl) return;
    let type: AnnotationType = 'change-request';
    let scope: ViewportScope = state.viewportMode; // default: scoped to the current viewport

    const head = div('nit-pop-head', describeElement(currentEl));
    const ta = document.createElement('textarea');
    ta.className = 'nit-pop-comment';
    ta.placeholder = 'What should change here?';
    ta.rows = 3;
    ta.addEventListener('input', () => ta.classList.remove('nit-invalid'));

    const typeRow = segmented<AnnotationType>(
      [
        { value: 'change-request', label: 'Change request' },
        { value: 'comment', label: 'Comment' },
      ],
      type,
      v => { type = v; },
    );
    const scopeRow = segmented<ViewportScope>(
      [
        { value: state.viewportMode, label: `This viewport (${state.viewportMode})` },
        { value: 'general', label: 'General' },
      ],
      scope,
      v => { scope = v; },
    );

    // Reads the live `type`/`scope` selection at click time.
    async function save(): Promise<void> {
      const comment = ta.value.trim();
      if (!comment) {
        ta.classList.add('nit-invalid');
        ta.focus();
        return;
      }
      if (saving || !currentEl) return;
      saving = true;
      const elementToSave = currentEl;
      close(); // close first — nothing below may keep the popover on screen
      try {
        const payload: SavePayload = {
          comment,
          type,
          viewportScope: scope,
          target: resolveTarget(elementToSave, window),
          route: location.pathname,
        };
        actions.setUiHidden(true); // keep our own UI out of the CDP screenshot
        await new Promise(r => setTimeout(r, 80));
        const res = await window.__nitSave?.(payload);
        if (res?.ok) actions.onSaved(res.annotation);
        else console.warn('[nit] save failed:', res?.error);
      } catch (err) {
        console.warn('[nit] save failed:', err);
      } finally {
        actions.setUiHidden(false);
      }
    }

    const saveBtn = button('nit-btn nit-btn--primary nit-save', 'Save', () => { void save(); });
    const cancelBtn = button('nit-btn nit-cancel', 'Cancel', () => close());
    const buttons = div('nit-btnrow');
    buttons.append(cancelBtn, saveBtn);

    el.append(head, ta, labelRow('Type', typeRow), labelRow('Applies to', scopeRow), buttons);
  }

  function position(target: Element): void {
    const r = target.getBoundingClientRect();
    const width = 320;
    const height = el.offsetHeight || 260;
    const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - width - 8));
    let top = r.bottom + 8;
    if (top + height > window.innerHeight - 8) top = Math.max(8, r.top - height - 8);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  return { open, close, isOpen: () => !el.hidden };
}
