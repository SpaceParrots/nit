// Pure element → target reference (SPEC §4). Runs inside the inspected page (bundled
// into the overlay); must never throw and must work without window.ng (production builds).

const MAX_TEXT = 80;
const MAX_CLASSES = 8;
const ANGULAR_RUNTIME_CLASS = /^(ng-star-inserted|ng-trigger.*|ng-tns-.*|ng-animate.*|ng-animating)$/;

export function resolveTarget(el, win = globalThis.window) {
  const doc = el.ownerDocument;
  return {
    component: nearestComponentTag(el),
    ngComponent: resolveNgComponent(el, win),
    selector: buildSelector(el, doc),
    xpath: buildXPath(el),
    tag: el.tagName.toLowerCase(),
    classes: cleanClasses(el),
    text: cleanText(el),
    rect: pageRect(el, win),
  };
}

/** Nearest ancestor (incl. self) whose tag contains a hyphen — custom element /
 *  Angular component selector. Falls back to the element's own tag. */
export function nearestComponentTag(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    if (n.tagName.includes('-')) return n.tagName.toLowerCase();
  }
  return el.tagName.toLowerCase();
}

/** Angular class name via window.ng, walked to the nearest component instance.
 *  Returns null when window.ng is absent (prod builds) or anything goes wrong. */
export function resolveNgComponent(el, win) {
  try {
    const ng = win && win.ng;
    if (!ng || typeof ng.getComponent !== 'function') return null;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const comp = ng.getComponent(n);
      if (comp && comp.constructor && comp.constructor.name) return comp.constructor.name;
    }
    return null;
  } catch {
    return null;
  }
}

/** Short, stable CSS selector: prefer id, then a nearby id/custom-element anchor plus
 *  either a unique class shorthand or a child chain. Verified unique before returning. */
export function buildSelector(el, doc = el.ownerDocument) {
  if (el.id) {
    const idSel = `#${cssEscape(el.id)}`;
    if (matchesUnique(doc, idSel, el)) return idSel;
  }

  // Walk up collecting a child chain until an anchor (unique id / custom element) is found.
  const chain = [];
  let anchorSel = '';
  for (let n = el; n && n.nodeType === 1 && n.tagName !== 'BODY' && n.tagName !== 'HTML'; ) {
    chain.unshift(segment(n));
    const p = n.parentElement;
    if (!p || p.tagName === 'BODY' || p.tagName === 'HTML') break;
    if (p.id) {
      const idSel = `#${cssEscape(p.id)}`;
      if (matchesUnique(doc, idSel, p)) { anchorSel = idSel; break; }
    }
    if (p.tagName.includes('-')) {
      const tag = p.tagName.toLowerCase();
      const cand = matchesUnique(doc, tag, p) ? tag : `${tag}:nth-of-type(${nthOfType(p)})`;
      if (matchesUnique(doc, cand, p)) { anchorSel = cand; break; }
    }
    n = p;
  }

  // Prefer a short class-based selector inside the anchor when it is unique.
  const classes = cleanClasses(el).slice(0, 3);
  if (classes.length) {
    const short = `${anchorSel ? anchorSel + ' ' : ''}${el.tagName.toLowerCase()}.${classes.map(cssEscape).join('.')}`;
    if (matchesUnique(doc, short, el)) return short;
  }

  const full = `${anchorSel ? anchorSel + ' > ' : 'body > '}${chain.join(' > ')}`;
  if (matchesUnique(doc, full, el)) return full;

  // Last resort: absolute nth-of-type chain from body.
  const abs = absoluteChain(el);
  return abs;
}

/** Absolute XPath with per-tag indices — the replay fallback anchor. */
export function buildXPath(el) {
  const parts = [];
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    parts.unshift(`${n.tagName.toLowerCase()}[${nthOfType(n)}]`);
  }
  return '/' + parts.join('/');
}

export function cleanClasses(el) {
  const out = [];
  for (const c of el.classList) {
    if (ANGULAR_RUNTIME_CLASS.test(c)) continue;
    out.push(c);
    if (out.length >= MAX_CLASSES) break;
  }
  return out;
}

export function cleanText(el) {
  return (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

function pageRect(el, win) {
  const r = el.getBoundingClientRect();
  const sx = win ? win.scrollX || 0 : 0;
  const sy = win ? win.scrollY || 0 : 0;
  return {
    x: Math.round(r.x + sx),
    y: Math.round(r.y + sy),
    w: Math.round(r.width),
    h: Math.round(r.height),
  };
}

function nthOfType(el) {
  let i = 1;
  for (let s = el.previousElementSibling; s; s = s.previousElementSibling) {
    if (s.tagName === el.tagName) i++;
  }
  return i;
}

function segment(el) {
  const tag = el.tagName.toLowerCase();
  const parent = el.parentElement;
  if (!parent) return tag;
  let sameTag = 0;
  for (const c of parent.children) if (c.tagName === el.tagName) sameTag++;
  return sameTag > 1 ? `${tag}:nth-of-type(${nthOfType(el)})` : tag;
}

function absoluteChain(el) {
  const parts = [];
  for (let n = el; n && n.nodeType === 1 && n.tagName !== 'HTML'; n = n.parentElement) {
    parts.unshift(segment(n));
  }
  return parts.join(' > ');
}

function matchesUnique(doc, selector, el) {
  try {
    const found = doc.querySelectorAll(selector);
    return found.length === 1 && found[0] === el;
  } catch {
    return false;
  }
}

function cssEscape(s) {
  if (globalThis.CSS && typeof globalThis.CSS.escape === 'function') return globalThis.CSS.escape(s);
  return String(s).replace(/([^a-zA-Z0-9_-])/g, '\\$1');
}
