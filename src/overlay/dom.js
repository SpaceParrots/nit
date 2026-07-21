// Tiny DOM helpers for the overlay UI (vanilla, Shadow DOM scoped).

export function div(cls, text) {
  const el = document.createElement('div');
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

export function span(cls, text) {
  const el = document.createElement('span');
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

export function button(cls, text, onClick) {
  const el = document.createElement('button');
  el.type = 'button';
  if (cls) el.className = cls;
  el.textContent = text;
  if (onClick) el.addEventListener('click', onClick);
  return el;
}

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

export function labelRow(label, control) {
  const row = div('nit-row');
  row.append(span('nit-row-label', label), control);
  return row;
}

/** "component-tag › span" chip text for highlight + popover headers. */
export function describeElement(el) {
  let comp = el;
  while (comp && comp.nodeType === 1 && !comp.tagName.includes('-')) comp = comp.parentElement;
  const compTag = comp && comp.nodeType === 1 ? comp.tagName.toLowerCase() : null;
  const own = el.tagName.toLowerCase();
  return compTag && compTag !== own ? `${compTag} › ${own}` : own;
}
