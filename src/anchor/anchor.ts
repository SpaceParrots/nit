// SPDX-License-Identifier: AGPL-3.0-or-later
// Re-anchor an annotation target to a live element for replay (SPEC §2.4).
// Layered: selector → xpath → text heuristic scoped to the component tag.
// Returns the element or null — never throws.
import type { Target } from '../types.js';

/** A re-anchored element plus whether it is actually rendered (non-zero box). */
export interface AnchoredElement {
  el: Element;
  rendered: boolean;
}

/**
 * Resolve an annotation target back to a live element for replay.
 * Layers: CSS `selector` → `xpath` → text/class heuristic scoped to the
 * component tag. Visibility-aware: a layer's match that is not rendered (a
 * hidden responsive twin) is kept only as a fallback while later layers search
 * for a rendered match. Degrades gracefully: any invalid or stale layer falls
 * through to the next one.
 * @param target the captured target reference (from an annotations.json file)
 * @param doc the document to search in
 * @returns the match and its rendered state, or null when no layer matches (never throws)
 */
export function anchorTargetDetailed(
  target: Target | null | undefined,
  doc: Document = globalThis.document,
): AnchoredElement | null {
  if (!target || typeof target !== 'object') return null;
  let hiddenFallback: Element | null = null;
  const consider = (el: Element | null): AnchoredElement | null => {
    if (!el) return null;
    if (isElementRendered(el)) return { el, rendered: true };
    hiddenFallback ??= el;
    return null;
  };

  if (target.selector) {
    try {
      const found = consider(doc.querySelector(target.selector));
      if (found) return found;
    } catch { /* invalid selector → fall through */ }
  }

  if (target.xpath) {
    try {
      const res = doc.evaluate(target.xpath, doc, null, 9 /* FIRST_ORDERED_NODE_TYPE */, null);
      const node = res.singleNodeValue;
      if (node?.nodeType === 1) {
        const found = consider(node as Element);
        if (found) return found;
      }
    } catch { /* fall through */ }
  }

  const byText = consider(textHeuristic(target, doc, true) ?? textHeuristic(target, doc, false));
  if (byText) return byText;

  return hiddenFallback ? { el: hiddenFallback, rendered: false } : null;
}

/**
 * Back-compat wrapper: the rendered match when any layer has one, else the
 * hidden fallback, else null.
 */
export function anchorTarget(target: Target | null | undefined, doc: Document = globalThis.document): Element | null {
  return anchorTargetDetailed(target, doc)?.el ?? null;
}

/** Whether an element takes up space (display:none / detached boxes collapse to 0). */
export function isElementRendered(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 || r.height > 0;
}

function textHeuristic(target: Target, doc: Document, onlyRendered: boolean): Element | null {
  const text = norm(target.text);
  const tag = isValidTag(target.tag) ? target.tag : '*';

  let scopes: (Element | Document)[] = [];
  if (target.component && isValidTag(target.component)) {
    try { scopes = [...doc.querySelectorAll(target.component)]; } catch { scopes = []; }
  }
  if (!scopes.length) scopes = [doc.body ?? doc];

  for (const scope of scopes) {
    let candidates: Element[];
    try { candidates = [...scope.querySelectorAll(tag)]; } catch { candidates = []; }
    if (scope.nodeType === 1 && tagMatches(scope as Element, tag)) candidates.unshift(scope as Element);
    if (onlyRendered) candidates = candidates.filter(isElementRendered);
    if (!candidates.length) continue;

    if (text) {
      // Exact text first; then prefix match (captured text is capped at 80 chars).
      const exact = candidates.find(c => norm(c.textContent) === text);
      if (exact) return exact;
      const prefix = candidates.find(c => norm(c.textContent).startsWith(text));
      if (prefix) return prefix;
    } else {
      // No text (icon rows etc.): fall back to the first class match inside the scope.
      const classes = (target.classes ?? []).slice(0, 2);
      if (classes.length) {
        const byClass = candidates.find(c => classes.every(k => c.classList.contains(k)));
        if (byClass) return byClass;
      }
    }
  }
  return null;
}

function norm(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

function tagMatches(el: Element, tag: string): boolean {
  return tag === '*' || el.tagName.toLowerCase() === tag.toLowerCase();
}

function isValidTag(t: unknown): t is string {
  return typeof t === 'string' && /^[a-zA-Z][a-zA-Z0-9-]*$/.test(t);
}
