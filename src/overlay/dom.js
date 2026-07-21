// Tiny DOM helpers for the overlay UI (vanilla, Shadow DOM scoped).

/**
 * Create a `<div>` with an optional class and text content.
 * @param {string} [cls]
 * @param {string} [text]
 * @returns {HTMLDivElement}
 */
export function div(cls, text) {
  const el = document.createElement('div');
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

/**
 * Create a `<span>` with an optional class and text content.
 * @param {string} [cls]
 * @param {string} [text]
 * @returns {HTMLSpanElement}
 */
export function span(cls, text) {
  const el = document.createElement('span');
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

/**
 * Create a `<button type="button">` with a class, label and click handler.
 * @param {string} cls
 * @param {string} text
 * @param {(e: MouseEvent) => void} [onClick]
 * @returns {HTMLButtonElement}
 */
export function button(cls, text, onClick) {
  const el = document.createElement('button');
  el.type = 'button';
  if (cls) el.className = cls;
  el.textContent = text;
  if (onClick) el.addEventListener('click', onClick);
  return el;
}

/**
 * Segmented single-choice control (used for the type and viewport-scope pickers).
 * @param {Array<{value: string, label: string}>} options
 * @param {string} selected the initially active value
 * @param {(value: string) => void} onChange called with the newly selected value
 * @returns {HTMLDivElement}
 */
export function segmented(options, selected, onChange) {
  const row = div('nit-seg');
  const buttons = [];
  for (const opt of options) {
    const b = button('nit-seg-btn' + (opt.value === selected ? ' nit-seg-btn--active' : ''), opt.label, () => {
      for (const x of buttons) x.classList.remove('nit-seg-btn--active');
      b.classList.add('nit-seg-btn--active');
      onChange(opt.value);
    });
    b.dataset.value = opt.value;
    buttons.push(b);
    row.append(b);
  }
  return row;
}

/**
 * A labelled form row: small label on the left, control on the right.
 * @param {string} label
 * @param {HTMLElement} control
 * @returns {HTMLDivElement}
 */
export function labelRow(label, control) {
  const row = div('nit-row');
  row.append(span('nit-row-label', label), control);
  return row;
}

/**
 * Short human label for an element — `component-tag › span` — used in the
 * hover-highlight chip and the popover header.
 * @param {Element} el
 * @returns {string}
 */
export function describeElement(el) {
  let comp = el;
  while (comp && comp.nodeType === 1 && !comp.tagName.includes('-')) comp = comp.parentElement;
  const compTag = comp && comp.nodeType === 1 ? comp.tagName.toLowerCase() : null;
  const own = el.tagName.toLowerCase();
  return compTag && compTag !== own ? `${compTag} › ${own}` : own;
}
