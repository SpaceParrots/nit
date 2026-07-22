// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure element → target reference (SPEC §4). Runs inside the inspected page (bundled
// into the overlay); must never throw and must work without window.ng (production builds).
import type { Rect, Target } from '../types.js';

const MAX_TEXT = 80;
const MAX_CLASSES = 8;
const ANGULAR_RUNTIME_CLASS = /^(ng-star-inserted|ng-trigger.*|ng-tns-.*|ng-animate.*|ng-animating)$/;

// data-id is the only attribute treated as identity (Kevin's scope decision) —
// values longer than this are likely serialized state, not stable ids.
const MAX_DATA_ID = 100;

function dataIdOf(n: Element): string | null {
  const v = n.getAttribute('data-id');
  return v && v.length <= MAX_DATA_ID ? v : null;
}

// CSS.escape is for identifiers; inside a quoted attribute string only the
// backslash and the closing quote need escaping.
function attrEscape(s: string): string {
  return s.replace(/[\\"]/g, '\\$&');
}

function dataIdSelector(n: Element): string | null {
  const v = dataIdOf(n);
  return v === null ? null : `${n.tagName.toLowerCase()}[data-id="${attrEscape(v)}"]`;
}

/**
 * Resolve an element to its layered target reference — the stable pointer a coding
 * agent (and the replay anchorer) uses to find it again. Never throws.
 * @param el the annotated DOM element
 * @param win the window the element lives in (injectable for tests)
 */
export function resolveTarget(el: Element, win: Window | undefined = globalThis.window): Target {
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

/**
 * Nearest ancestor (incl. self) whose tag contains a hyphen — a custom element /
 * Angular component selector like `app-product-tile`.
 * @returns the component tag, or the element's own tag when no custom ancestor exists
 */
export function nearestComponentTag(el: Element): string {
  for (let n: Element | null = el; n?.nodeType === 1; n = n.parentElement) {
    if (n.tagName.includes('-')) return n.tagName.toLowerCase();
  }
  return el.tagName.toLowerCase();
}

/**
 * Angular component class name via `window.ng.getComponent`, walking up to the
 * nearest component instance. Dev/staging builds expose `window.ng`; production
 * builds strip it — then (and on any error) this returns null, never throws.
 * @returns e.g. `ProductTileComponent`
 */
export function resolveNgComponent(el: Element, win: Window | undefined): string | null {
  try {
    const ng = win?.ng;
    if (!ng || typeof ng.getComponent !== 'function') return null;
    for (let n: Element | null = el; n?.nodeType === 1; n = n.parentElement) {
      const comp: unknown = ng.getComponent(n);
      if (comp && typeof comp === 'object' && comp.constructor?.name) return comp.constructor.name;
    }
    return null;
  } catch {
    return null;
  }
}

// Landmark tags are meaningful waypoints: they anchor selectors and survive
// re-renders far better than anonymous div chains.
const LANDMARK_TAGS = new Set(['SECTION', 'ARTICLE', 'MAIN', 'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'FORM']);

/**
 * Build a short, stable CSS selector for an element. Preference order:
 *  1. the element's own unique `#id`
 *  2. the element's own unique `tag[data-id="…"]`
 *  3. nearest unique anchor (`#id`, `data-id`, custom element, or landmark tag) + unique class shorthand
 *  4. anchor + compressed path of significant nodes (ids, data-ids, custom elements, landmarks)
 *  5. anchor + full child chain
 *  6. absolute nth-of-type chain
 * Every candidate is verified unique against the live document before being returned,
 * so the selector is also the primary replay anchor.
 * @param doc the document to verify uniqueness against
 */
export function buildSelector(el: Element, doc: Document = el.ownerDocument): string {
  if (el.id) {
    const idSel = `#${cssEscape(el.id)}`;
    if (matchesUnique(doc, idSel, el)) return idSel;
  }

  const ownDataId = dataIdSelector(el);
  if (ownDataId && matchesUnique(doc, ownDataId, el)) return ownDataId;

  // Ancestor path from just below body down to the element itself.
  const path: Element[] = [];
  for (let n: Element | null = el; n?.nodeType === 1 && n.tagName !== 'BODY' && n.tagName !== 'HTML'; n = n.parentElement) {
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

function isSignificant(n: Element): boolean {
  return Boolean(n.id) || dataIdOf(n) !== null || n.tagName.includes('-') || LANDMARK_TAGS.has(n.tagName);
}

function sigSegment(n: Element): string {
  if (n.id) return `${n.tagName.toLowerCase()}#${cssEscape(n.id)}`;
  const dataSel = dataIdSelector(n);
  if (dataSel) return dataSel;
  return segment(n);
}

function anchorSelectorFor(n: Element, doc: Document): { sel: string; kind: 'id' | 'data-id' | 'custom' | 'landmark' } | null {
  if (n.id) {
    const sel = `#${cssEscape(n.id)}`;
    if (matchesUnique(doc, sel, n)) return { sel, kind: 'id' };
  }
  const dataSel = dataIdSelector(n);
  if (dataSel && matchesUnique(doc, dataSel, n)) return { sel: dataSel, kind: 'data-id' };
  if (n.tagName.includes('-') || LANDMARK_TAGS.has(n.tagName)) {
    const tag = n.tagName.toLowerCase();
    const cand = matchesUnique(doc, tag, n) ? tag : `${tag}:nth-of-type(${nthOfType(n)})`;
    if (matchesUnique(doc, cand, n)) {
      return { sel: cand, kind: n.tagName.includes('-') ? 'custom' : 'landmark' };
    }
  }
  return null;
}

/**
 * Absolute XPath with per-tag sibling indices (`/html[1]/body[1]/…`) — the
 * secondary replay anchor when the CSS selector no longer matches.
 */
export function buildXPath(el: Element): string {
  const parts: string[] = [];
  for (let n: Element | null = el; n?.nodeType === 1; n = n.parentElement) {
    parts.unshift(`${n.tagName.toLowerCase()}[${nthOfType(n)}]`);
  }
  return '/' + parts.join('/');
}

/**
 * The element's class list minus Angular runtime noise (`ng-star-inserted`,
 * `ng-tns-*`, `ng-trigger*`, …), capped at 8 entries.
 */
export function cleanClasses(el: Element): string[] {
  const out: string[] = [];
  for (const c of el.classList) {
    if (ANGULAR_RUNTIME_CLASS.test(c)) continue;
    out.push(c);
    if (out.length >= MAX_CLASSES) break;
  }
  return out;
}

/**
 * Whitespace-normalized text content, capped at 80 chars — the last-resort
 * replay anchor and a human-readable hint in the annotation file.
 */
export function cleanText(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

function pageRect(el: Element, win: Window | undefined): Rect {
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

function nthOfType(el: Element): number {
  let i = 1;
  for (let s = el.previousElementSibling; s; s = s.previousElementSibling) {
    if (s.tagName === el.tagName) i++;
  }
  return i;
}

function segment(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const parent = el.parentElement;
  if (!parent) return tag;
  let sameTag = 0;
  for (const c of parent.children) if (c.tagName === el.tagName) sameTag++;
  return sameTag > 1 ? `${tag}:nth-of-type(${nthOfType(el)})` : tag;
}

function absoluteChain(el: Element): string {
  const parts: string[] = [];
  for (let n: Element | null = el; n?.nodeType === 1 && n.tagName !== 'HTML'; n = n.parentElement) {
    parts.unshift(segment(n));
  }
  return parts.join(' > ');
}

function matchesUnique(doc: Document, selector: string, el: Element): boolean {
  try {
    const found = doc.querySelectorAll(selector);
    return found.length === 1 && found[0] === el;
  } catch {
    return false;
  }
}

function cssEscape(s: string): string {
  if (typeof globalThis.CSS?.escape === 'function') return globalThis.CSS.escape(s);
  return String(s).replace(/([^a-zA-Z0-9_-])/g, '\\$1');
}
