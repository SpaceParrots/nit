// SPDX-License-Identifier: AGPL-3.0-or-later
// Tiny DOM helpers for the overlay UI (vanilla, Shadow DOM scoped).

/** Create a `<div>` with an optional class and text content. */
export function div(cls?: string, text?: string): HTMLDivElement {
  const el = document.createElement('div');
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

/** Create a `<span>` with an optional class and text content. */
export function span(cls?: string, text?: string): HTMLSpanElement {
  const el = document.createElement('span');
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

/** Create a `<button type="button">` with a class, label and click handler. */
export function button(cls: string, text: string, onClick?: (e: MouseEvent) => void): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  if (cls) el.className = cls;
  el.textContent = text;
  if (onClick) el.addEventListener('click', onClick);
  return el;
}

/**
 * Segmented single-choice control (used for the type and viewport-scope pickers).
 * @param options the selectable values with their labels
 * @param selected the initially active value
 * @param onChange called with the newly selected value
 */
export function segmented<T extends string>(
  options: { value: T; label: string }[],
  selected: T,
  onChange: (value: T) => void,
): HTMLDivElement {
  const row = div('nit-seg');
  const buttons: HTMLButtonElement[] = [];
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

/** A labelled form row: small label on the left, control on the right. */
export function labelRow(label: string, control: HTMLElement): HTMLDivElement {
  const row = div('nit-row');
  row.append(span('nit-row-label', label), control);
  return row;
}

/**
 * Short human label for an element — `component-tag › span` — used in the
 * hover-highlight chip and the popover header.
 */
export function describeElement(el: Element): string {
  let comp: Element | null = el;
  while (comp?.nodeType === 1 && !comp.tagName.includes('-')) comp = comp.parentElement;
  const compTag = comp?.nodeType === 1 ? comp.tagName.toLowerCase() : null;
  const own = el.tagName.toLowerCase();
  return compTag && compTag !== own ? `${compTag} › ${own}` : own;
}
