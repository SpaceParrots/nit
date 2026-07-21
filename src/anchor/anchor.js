// Re-anchor an annotation target to a live element for replay (SPEC §2.4).
// Layered: selector → xpath → text heuristic scoped to the component tag.
// Returns the element or null — never throws.

export function anchorTarget(target, doc = globalThis.document) {
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
      if (node && node.nodeType === 1) return node;
    } catch { /* fall through */ }
  }

  return textHeuristic(target, doc);
}

function textHeuristic(target, doc) {
  const text = norm(target.text);
  const tag = isValidTag(target.tag) ? target.tag : '*';

  let scopes = [];
  if (target.component && isValidTag(target.component)) {
    try { scopes = [...doc.querySelectorAll(target.component)]; } catch { scopes = []; }
  }
  if (!scopes.length) scopes = [doc.body || doc];

  for (const scope of scopes) {
    let candidates;
    try { candidates = [...scope.querySelectorAll(tag)]; } catch { candidates = []; }
    if (scope.nodeType === 1 && tagMatches(scope, tag)) candidates.unshift(scope);
    if (!candidates.length) continue;

    if (text) {
      // Exact text first; then prefix match (captured text is capped at 80 chars).
      const exact = candidates.find(c => norm(c.textContent) === text);
      if (exact) return exact;
      const prefix = candidates.find(c => norm(c.textContent).startsWith(text));
      if (prefix) return prefix;
    } else {
      // No text (icon rows etc.): fall back to the first class match inside the scope.
      const classes = (target.classes || []).slice(0, 2);
      if (classes.length) {
        const byClass = candidates.find(c => classes.every(k => c.classList && c.classList.contains(k)));
        if (byClass) return byClass;
      }
    }
  }
  return null;
}

function norm(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

function tagMatches(el, tag) {
  return tag === '*' || el.tagName.toLowerCase() === tag.toLowerCase();
}

function isValidTag(t) {
  return typeof t === 'string' && /^[a-zA-Z][a-zA-Z0-9-]*$/.test(t);
}
