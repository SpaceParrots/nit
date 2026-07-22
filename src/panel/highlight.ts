// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure CSS-selector tokenizer for the panel's syntax-highlighted selector line.
// Lossless: concatenating all token texts reproduces the input. Never throws —
// anything unmatchable is emitted as a plain `text` token, so a malformed
// selector (annotations.json is untrusted) still renders in full.

export type SelTokenKind = 'id' | 'attr' | 'class' | 'tag' | 'pseudo' | 'combinator' | 'text';

export interface SelToken {
  kind: SelTokenKind;
  text: string;
}

const ID_OR_CLASS = /^[#.](?:\\.|[\w-])+/;
const PSEUDO = /^::?[\w-]+(?:\([^)]*\))?/;
const COMBINATOR = /^[\s>+~]+/;
const TAG = /^(?:(?:\\.|[\w-])+|\*)/;

/** Tokenize a CSS selector string into typed, lossless fragments. */
export function tokenizeSelector(sel: string): SelToken[] {
  const out: SelToken[] = [];
  const push = (kind: SelTokenKind, text: string): void => {
    const last = out[out.length - 1];
    if (kind === 'text' && last?.kind === 'text') {
      out[out.length - 1] = { kind: 'text', text: last.text + text };
      return;
    }
    out.push({ kind, text });
  };

  let i = 0;
  while (i < sel.length) {
    const rest = sel.slice(i);
    const ch = sel[i];
    if (ch === '#' || ch === '.') {
      const m = ID_OR_CLASS.exec(rest);
      if (m) { push(ch === '#' ? 'id' : 'class', m[0]); i += m[0].length; continue; }
    }
    if (ch === '[') {
      i += pushAttr(rest, push);
      continue;
    }
    if (ch === ':') {
      const m = PSEUDO.exec(rest);
      if (m) { push('pseudo', m[0]); i += m[0].length; continue; }
    }
    const comb = COMBINATOR.exec(rest);
    if (comb) { push('combinator', comb[0]); i += comb[0].length; continue; }
    const tag = TAG.exec(rest);
    if (tag) { push('tag', tag[0]); i += tag[0].length; continue; }
    push('text', ch);
    i += 1;
  }
  return out;
}

/**
 * Consume one `[…]` attribute selector from the start of `rest`, honouring
 * quotes and backslash escapes (a `]` inside quotes does not close it). An
 * unclosed bracket consumes the remainder — lossless either way.
 * @returns the number of characters consumed
 */
function pushAttr(rest: string, push: (kind: SelTokenKind, text: string) => void): number {
  let j = 1;
  let quote = '';
  while (j < rest.length) {
    const c = rest[j];
    if (quote) {
      if (c === '\\') j += 1;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === '\'') {
      quote = c;
    } else if (c === ']') {
      j += 1;
      push('attr', rest.slice(0, j));
      return j;
    }
    j += 1;
  }
  push('attr', rest);
  return rest.length;
}
