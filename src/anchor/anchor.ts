// SPDX-License-Identifier: AGPL-3.0-or-later
// Re-anchor an annotation target to a live element for replay (SPEC §2.4).
// Layered: selector → xpath → text heuristic scoped to the component tag.
// Returns the element or null — never throws.
import type { Target } from '../types.js';

/**
 * Resolve an annotation target back to a live element for replay.
 * Layers: CSS `selector` → `xpath` → text/class heuristic scoped to the
 * component tag. Degrades gracefully: any invalid or stale layer falls through
 * to the next one.
 * @param target the captured target reference (from an annotations.json file)
 * @param doc the document to search in
 * @returns the re-anchored element, or null when no layer matches (never throws)
 */
export function anchorTarget(target: Target | null | undefined, doc: Document = globalThis.document): Element | null {
  if (!target || typeof target !== 'object') return null;

  if (target.selector) {
    try {
      const el = doc.querySelector(target.selector);
      if (el) return el;
    } catch { /* invalid selector → fall through */ }
  }

  if (target.xpath) {
    try {
      const res = doc.evaluate(target.xpath, doc, null, 9 /* FIRST_ORDERED_NODE_TYPE */, null);
      const node = res.singleNodeValue;
      if (node?.nodeType === 1) return node as Element;
    } catch { /* fall through */ }
  }

  return textHeuristic(target, doc);
}

function textHeuristic(target: Target, doc: Document): Element | null {
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
