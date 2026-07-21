// Numbered pins anchored to elements on the current route (replay + resumed capture).

/**
 * Create the pins layer: one numbered pin per re-anchored annotation, positioned
 * in absolute page coordinates so pins scroll with the content.
 * @param {ShadowRoot} root the overlay shadow root to mount into
 * @param {object} state shared overlay state (`state.placed` drives rendering)
 * @param {object} actions overlay actions (focusAnnotation on pin click)
 * @returns {{render: () => void, focus: (id: string) => void}}
 */
export function createPins(root, state, actions) {
  const layer = document.createElement('div');
  layer.className = 'nit-pins';
  root.append(layer);

  function render() {
    layer.innerHTML = '';
    state.placed.forEach(({ ann, el }, i) => {
      const r = el.getBoundingClientRect();
      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = `nit-pin nit-pin--${ann.type}` + (ann.status !== 'open' ? ' nit-pin--closed' : '');
      pin.textContent = String(i + 1);
      pin.title = ann.comment;
      pin.style.left = `${Math.max(0, r.left + window.scrollX - 10)}px`;
      pin.style.top = `${Math.max(0, r.top + window.scrollY - 10)}px`;
      pin.addEventListener('click', e => {
        e.stopPropagation();
        actions.focusAnnotation(ann.id);
        flash(el);
      });
      layer.append(pin);
    });
  }

  function focus(id) {
    const entry = state.placed.find(p => p.ann.id === id);
    if (!entry) return;
    entry.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => flash(entry.el), 250);
  }

  function flash(el) {
    const r = el.getBoundingClientRect();
    const f = document.createElement('div');
    f.className = 'nit-flash';
    f.style.left = `${r.left + window.scrollX - 2}px`;
    f.style.top = `${r.top + window.scrollY - 2}px`;
    f.style.width = `${r.width}px`;
    f.style.height = `${r.height}px`;
    layer.append(f);
    setTimeout(() => f.remove(), 1200);
  }

  return { render, focus };
}
