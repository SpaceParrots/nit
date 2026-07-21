// The annotation popover: comment text, type selector (default change-request),
// viewport-scope toggle (default: current viewport, toggleable to general).
import { div, button, segmented, labelRow, describeElement } from './dom.js';
import { resolveTarget } from '../capture/target.js';

export function createPopover(root, state, actions) {
  const el = document.createElement('div');
  el.className = 'nit-popover';
  el.hidden = true;
  root.append(el);
  let currentEl = null;
  let saving = false;

  function open(target) {
    currentEl = target;
    saving = false;
    render();
    el.hidden = false;
    position(target);
    el.querySelector('textarea').focus();
  }

  function close() {
    el.hidden = true;
    currentEl = null;
    actions.hideHighlight();
  }

  function render() {
    el.innerHTML = '';
    let type = 'change-request';
    let scope = state.viewportMode; // default: scoped to the current viewport

    const head = div('nit-pop-head', describeElement(currentEl));
    const ta = document.createElement('textarea');
    ta.className = 'nit-pop-comment';
    ta.placeholder = 'What should change here?';
    ta.rows = 3;
    ta.addEventListener('input', () => ta.classList.remove('nit-invalid'));

    const typeRow = segmented(
      [
        { value: 'change-request', label: 'Change request' },
        { value: 'comment', label: 'Comment' },
      ],
      type,
      v => { type = v; },
    );
    const scopeRow = segmented(
      [
        { value: state.viewportMode, label: `This viewport (${state.viewportMode})` },
        { value: 'general', label: 'General' },
      ],
      scope,
      v => { scope = v; },
    );

    const saveBtn = button('nit-btn nit-btn--primary nit-save', 'Save', async () => {
      const comment = ta.value.trim();
      if (!comment) {
        ta.classList.add('nit-invalid');
        ta.focus();
        return;
      }
      if (saving || !currentEl) return;
      saving = true;
      const payload = {
        comment,
        type,
        viewportScope: scope,
        target: resolveTarget(currentEl, window),
        route: location.pathname,
      };
      close();
      actions.setUiHidden(true); // keep our own UI out of the CDP screenshot
      await new Promise(r => setTimeout(r, 80));
      try {
        const res = await window.__nitSave(payload);
        if (res && res.ok) actions.onSaved(res.annotation);
        else console.warn('[nit] save failed:', res && res.error);
      } catch (err) {
        console.warn('[nit] save failed:', err);
      } finally {
        actions.setUiHidden(false);
      }
    });
    const cancelBtn = button('nit-btn nit-cancel', 'Cancel', () => close());
    const buttons = div('nit-btnrow');
    buttons.append(cancelBtn, saveBtn);

    el.append(head, ta, labelRow('Type', typeRow), labelRow('Applies to', scopeRow), buttons);
    // Keep keystrokes (except Escape) away from page-level hotkey handlers.
    el.addEventListener('keydown', e => { if (e.key !== 'Escape') e.stopPropagation(); });
  }

  function position(target) {
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
