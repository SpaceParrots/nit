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

// Landmark tags are meaningful waypoints: they anchor selectors and survive
// re-renders far better than anonymous div chains.
const LANDMARK_TAGS = new Set(['SECTION', 'ARTICLE', 'MAIN', 'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'FORM']);

/** Short, stable CSS selector. Preference order:
 *  1. the element's own unique #id
 *  2. nearest unique anchor (#id, custom element, or landmark tag) + unique class shorthand
 *  3. anchor + compressed path of significant nodes (ids, custom elements, landmarks)
 *  4. anchor + full child chain
 *  5. absolute nth-of-type chain
 *  Every candidate is verified unique against the live document before being returned. */
export function buildSelector(el, doc = el.ownerDocument) {
  if (el.id) {
    const idSel = `#${cssEscape(el.id)}`;
    if (matchesUnique(doc, idSel, el)) return idSel;
  }

  // Ancestor path from just below body down to the element itself.
  const path = [];
  for (let n = el; n && n.nodeType === 1 && n.tagName !== 'BODY' && n.tagName !== 'HTML'; n = n.parentElement) {
    path.unshift(n);
  }

  // Deepest ancestor (strictly above el) that is uniquely selectable on its own.
  let anchorIdx = -1;
  let anchorSel = '';
  let anchorKind = '';
  for (let i = path.length - 2; i >= 0; i--) {
    const found = anchorSelectorFor(path[i], doc);
    if (found) { anchorIdx = i; anchorSel = found.sel; anchorKind = found.kind; break; }
  }
  // A bare landmark (nav, section, …) is a weak anchor — prefix it with the nearest
  // outer id/custom-element anchor so replay survives new landmarks appearing.
  if (anchorKind === 'landmark') {
    for (let j = anchorIdx - 1; j >= 0; j--) {
      const outer = anchorSelectorFor(path[j], doc);
      if (outer && outer.kind !== 'landmark') {
        const combined = `${outer.sel} ${anchorSel}`;
        if (matchesUnique(doc, combined, path[anchorIdx])) anchorSel = combined;
        break;
      }
    }
  }
  const chainEls = path.slice(anchorIdx + 1);

  // 2: unique class shorthand inside the anchor.
  const classes = cleanClasses(el).slice(0, 3);
  if (classes.length) {
    const short = `${anchorSel ? anchorSel + ' ' : ''}${el.tagName.toLowerCase()}.${classes.map(cssEscape).join('.')}`;
    if (matchesUnique(doc, short, el)) return short;
  }

  // 3: compressed path keeping only significant waypoints (ids, custom elements, landmarks).
  const significant = chainEls.filter((n, i) => i === chainEls.length - 1 || isSignificant(n));
  if (significant.length < chainEls.length) {
    const sig = `${anchorSel ? anchorSel + ' ' : ''}${significant.map(sigSegment).join(' ')}`;
    if (matchesUnique(doc, sig, el)) return sig;
  }

  // 4: full child chain from the anchor.
  const full = `${anchorSel ? anchorSel + ' > ' : 'body > '}${chainEls.map(segment).join(' > ')}`;
  if (matchesUnique(doc, full, el)) return full;

  // 5: absolute nth-of-type chain.
  return absoluteChain(el);
}

function isSignificant(n) {
  return Boolean(n.id) || n.tagName.includes('-') || LANDMARK_TAGS.has(n.tagName);
}

function sigSegment(n) {
  if (n.id) return `${n.tagName.toLowerCase()}#${cssEscape(n.id)}`;
  return segment(n);
}

function anchorSelectorFor(n, doc) {
  if (n.id) {
    const sel = `#${cssEscape(n.id)}`;
    if (matchesUnique(doc, sel, n)) return { sel, kind: 'id' };
  }
  if (n.tagName.includes('-') || LANDMARK_TAGS.has(n.tagName)) {
    const tag = n.tagName.toLowerCase();
    const cand = matchesUnique(doc, tag, n) ? tag : `${tag}:nth-of-type(${nthOfType(n)})`;
    if (matchesUnique(doc, cand, n)) {
      return { sel: cand, kind: n.tagName.includes('-') ? 'custom' : 'landmark' };
    }
  }
  return null;
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
