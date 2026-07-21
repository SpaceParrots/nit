// Slim in-page chip (bottom-left): annotation count + picking state. The full
// list/controls UI lives in the separate nit panel window, not over the page.
/**
 * Create the chip: shows mode + annotation count, doubles as a picking toggle
 * in review mode, and switches to a "picking…" hint while active.
 * @param {ShadowRoot} root the overlay shadow root to mount into
 * @param {object} state shared overlay state (mode, picking, annotations)
 * @param {object} actions overlay actions (setPicking)
 * @returns {{update: () => void}}
 */
export function createChip(root, state, actions) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'nit-chip';
  root.append(el);
  el.addEventListener('click', () => {
    if (state.mode === 'review') actions.setPicking(!state.picking);
  });

  function update() {
    el.classList.toggle('nit-chip--picking', state.picking);
    if (state.picking) {
      el.textContent = '◉ picking — click an element (Esc cancels)';
    } else {
      const modeLabel = state.mode === 'view' ? ' replay' : state.mode === 'verify' ? ' verify' : '';
      el.textContent = `nit${modeLabel} · ${state.annotations.length}`;
    }
    el.title = state.mode === 'review' ? 'Toggle element picking (Alt)' : 'nit replay';
  }
  update();
  return { update };
}
