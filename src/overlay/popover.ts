// SPDX-License-Identifier: AGPL-3.0-or-later
// The annotation popover: comment text, type selector (default change-request),
// viewport-scope toggle (default: general, toggleable to the current viewport),
// and — only when the picked element looks like it lives on a dialog surface —
// one checkbox confirming that. Confirming is what lets `nit verify` re-open the
// dialog later instead of screenshotting a blank page, so it is worth the row;
// on a plain page nothing extra is rendered.
import { div, button, segmented, labelRow, checkboxRow, describeElement } from './dom.js';
import { detectDialog } from '../capture/context.js';
import type { DialogContainer } from '../capture/context.js';
import { buildSelector, resolveTarget } from '../capture/target.js';
import { currentRoute } from '../util/route.js';
import type { AnnotationType, Rect, SavePayload, ViewportScope } from '../types.js';
import type { OverlayActions, OverlayState, Popover } from './state.js';

/**
 * Create the annotation popover: comment text, type selector (default
 * change-request) and viewport-scope toggle (default: general — most fixes
 * apply everywhere, and general items get verified on both viewports).
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
  // The element's rect at pick time — the truthful record when the element
  // (e.g. inside a native <dialog>) collapses to zero size before save().
  let openRect: Rect | null = null;
  // Keep keystrokes (except Escape) away from page-level hotkey handlers.
  el.addEventListener('keydown', e => { if (e.key !== 'Escape') e.stopPropagation(); });

  function open(target: Element): void {
    currentEl = target;
    saving = false;
    openRect = pageRectOf(target);
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
    let scope: ViewportScope = 'general'; // default: applies to every viewport

    // Detected here rather than in save(): the popover has to render the
    // confirmation row, and the dialog may already be gone by save time.
    const dialog = detectDialog(currentEl);
    // Semantics or a known framework class are trustworthy enough to pre-check;
    // a modal-ish class name or a fixed box on a scroll-locked page is a guess,
    // so the reviewer opts in.
    let inDialog = dialog?.confidence === 'confident';

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
        { value: 'general', label: 'General' },
        { value: state.viewportMode, label: `This viewport (${state.viewportMode})` },
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
      const pickRect = openRect;
      close(); // close first — nothing below may keep the popover on screen
      try {
        const history = actions.historySnapshot();
        const targetRef = resolveTarget(elementToSave, window);
        // The dialog/menu the element lived in may have closed (display:none)
        // between pick and save, collapsing resolveTarget's live rect to zero
        // size — that would persist a meaningless origin point and make
        // verify's fallback crop meaningless too. The element was visible at
        // pick time, so the pick-time rect is the truthful record.
        if ((targetRef.rect.w <= 0 || targetRef.rect.h <= 0) && pickRect && pickRect.w > 0 && pickRect.h > 0) {
          targetRef.rect = pickRect;
        }
        // The reopen steps are only worth recording for a surface we will
        // actually try to re-open, and they are the only thing nit ever replays
        // against a live page — so they ride on the reviewer's confirmation.
        const reopen = dialog && inDialog ? actions.reopenSnapshot() : [];
        const payload: SavePayload = {
          comment,
          type,
          viewportScope: scope,
          target: targetRef,
          route: currentRoute(location),
          // absent on plain pages (and when the reviewer unticked a false
          // positive) — keeps the file identical to before for them
          context: dialog && inDialog
            ? {
              kind: 'dialog',
              selector: buildSelector(dialog.container),
              label: dialog.label ?? undefined,
              // absent (not []) when the trail holds no click from outside the
              // dialog — nothing honest to replay
              reopen: reopen.length ? reopen : undefined,
            }
            : undefined,
          // absent (not []) when nothing was clicked — keeps the file identical to before
          history: history.length ? history : undefined,
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

    el.append(head, ta, labelRow('Type', typeRow), labelRow('Applies to', scopeRow));
    if (dialog) el.append(checkboxRow(dialogLabel(dialog), inDialog, v => { inDialog = v; }));
    el.append(buttons);
  }

  /** Wording for the confirmation row: an assertion when we are sure, a question when we are not. */
  function dialogLabel(dialog: DialogContainer): string {
    const named = dialog.label ? `“${dialog.label}”` : null;
    return dialog.confidence === 'confident'
      ? `In dialog ${named ?? '(unnamed)'}`
      : `Inside a dialog / modal${named ? ` ${named}` : ''}?`;
  }

  /** Element bounds in absolute page coordinates (what the capture clip expects). */
  function pageRectOf(el: Element): Rect {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x + window.scrollX),
      y: Math.round(r.y + window.scrollY),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
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
