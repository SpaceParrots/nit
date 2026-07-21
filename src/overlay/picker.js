// Capture-mode element picker: Alt toggles picking, hover highlights, click selects,
// Esc cancels. All listeners are capture-phase so the page never sees picking clicks.

export function installPicker(state, ui, actions) {
  const highlight = createHighlight(ui.root);

  const api = {
    highlight,
    setPicking(on) {
      state.picking = on;
      if (!on) {
        highlight.hide();
        state.hovered = null;
      }
      document.documentElement.style.cursor = on ? 'crosshair' : '';
      ui.sidebar.render();
    },
  };

  const inOwnUi = e => e.composedPath && e.composedPath().includes(ui.host);

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
    if (!t || t.nodeType !== 1) return;
    state.hovered = t;
    highlight.show(t);
  }, true);

  const swallow = e => {
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
        window.__nitEvent?.({
          type: 'click',
          x: Math.round(e.pageX),
          y: Math.round(e.pageY),
          tag: t && t.tagName ? t.tagName.toLowerCase() : '?',
        });
      } catch { /* bridge gone — ignore */ }
    }
    if (!state.picking || inOwnUi(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const t = e.composedPath()[0];
    if (!t || t.nodeType !== 1) return;
    api.setPicking(false);
    state.selected = t;
    highlight.show(t, true);
    ui.popover.open(t);
  }, true);

  return api;
}

import { describeElement } from './dom.js';

function createHighlight(root) {
  const box = document.createElement('div');
  box.className = 'nit-highlight';
  box.hidden = true;
  const label = document.createElement('div');
  label.className = 'nit-highlight-label';
  box.append(label);
  root.append(box);
  return {
    show(el, pinned = false) {
      const r = el.getBoundingClientRect();
      box.hidden = false;
      box.classList.toggle('nit-highlight--pinned', pinned);
      box.style.left = `${r.left - 2}px`;
      box.style.top = `${r.top - 2}px`;
      box.style.width = `${r.width}px`;
      box.style.height = `${r.height}px`;
      label.textContent = describeElement(el);
    },
    hide() {
      box.hidden = true;
    },
  };
}
