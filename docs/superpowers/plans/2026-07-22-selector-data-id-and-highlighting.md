# Selector data-id Preference + Panel Selector Highlighting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generated selectors prefer `#id` and `[data-id="…"]` anchors, and the panel's expanded annotation detail syntax-highlights the selector line.

**Architecture:** Part 1 extends the existing uniqueness-verified preference ladder in `src/capture/target.ts` — `data-id` participates everywhere `id` does, one rung below it. Part 2 adds a pure, lossless tokenizer (`src/panel/highlight.ts`) whose tokens the panel renders as `<span>`s via `textContent` only (annotations.json is untrusted — no innerHTML).

**Tech Stack:** TypeScript strict ESM (NodeNext — local imports need `.js`), `node:test` (tests are plain JS importing from `../dist/**`, never `src/`), Playwright headless for browser tests.

**Spec:** `docs/superpowers/specs/2026-07-22-selector-data-id-and-highlighting-design.md`

## Global Constraints

- `data-id` ONLY — no `data-testid`/`data-test`/`data-cy`, no generic `data-*` (Kevin's decision).
- Skip `data-id` values that are empty or longer than 100 chars.
- Attribute values escaped for the CSS quoted-string context: backslash and double quote.
- Panel rendering: token text set via `textContent` only; never innerHTML with annotation data.
- Tokenizer is lossless: concatenating all token texts reproduces the input exactly; it never throws.
- BUILD GOTCHA: `npm test -- <file>` can SKIP the pretest build. Always run `npm run build` explicitly after editing `src/` and before any targeted test run.
- Commits: Conventional Commits, ONE line, no co-author. Scope `(nit)`.
- Lint before committing: `npm run lint` must exit 0.

---

### Task 1: `tokenizeSelector` pure module

**Files:**
- Create: `D:\Tools\Nit\src\panel\highlight.ts`
- Test: `D:\Tools\Nit\test\unit-highlight.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `tokenizeSelector(sel: string): SelToken[]` with `interface SelToken { kind: SelTokenKind; text: string }` and `type SelTokenKind = 'id' | 'attr' | 'class' | 'tag' | 'pseudo' | 'combinator' | 'text'` — Task 3 imports `tokenizeSelector` and builds `sel-<kind>` class names from `kind`.

- [ ] **Step 1: Write the failing test**

Create `test/unit-highlight.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
// Selector tokenizer unit table: every token kind, quoted attrs, lossless fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenizeSelector } from '../dist/panel/highlight.js';

const join = toks => toks.map(t => t.text).join('');
const kinds = toks => toks.map(t => t.kind);

test('tokenizeSelector table', async t => {
  await t.test('empty string → no tokens', () => {
    assert.deepEqual(tokenizeSelector(''), []);
  });

  await t.test('plain id', () => {
    assert.deepEqual(tokenizeSelector('#hero-title'), [{ kind: 'id', text: '#hero-title' }]);
  });

  await t.test('tag + class + descendant', () => {
    const toks = tokenizeSelector('nav a.active');
    assert.deepEqual(toks, [
      { kind: 'tag', text: 'nav' },
      { kind: 'combinator', text: ' ' },
      { kind: 'tag', text: 'a' },
      { kind: 'class', text: '.active' },
    ]);
  });

  await t.test('attr with quoted value', () => {
    const toks = tokenizeSelector('li[data-id="42"]');
    assert.deepEqual(toks, [
      { kind: 'tag', text: 'li' },
      { kind: 'attr', text: '[data-id="42"]' },
    ]);
  });

  await t.test('quoted value containing ] and escaped quote stays one attr token', () => {
    const sel = 'div[data-id="a]b\\"c"] span';
    const toks = tokenizeSelector(sel);
    assert.equal(join(toks), sel);
    assert.equal(toks[1].kind, 'attr');
    assert.equal(toks[1].text, '[data-id="a]b\\"c"]');
  });

  await t.test('pseudo with argument and child combinator', () => {
    const toks = tokenizeSelector('section:nth-of-type(2) > p');
    assert.deepEqual(kinds(toks), ['tag', 'pseudo', 'combinator', 'tag']);
    assert.equal(toks[1].text, ':nth-of-type(2)');
    assert.equal(toks[2].text, ' > ');
  });

  await t.test('escaped characters inside id/class stay in one token', () => {
    const sel = '#a\\.b .c\\:d';
    const toks = tokenizeSelector(sel);
    assert.equal(join(toks), sel);
    assert.deepEqual(kinds(toks), ['id', 'combinator', 'class']);
  });

  await t.test('unclosed attr bracket is lossless', () => {
    const sel = 'a[data-id="broken';
    assert.equal(join(tokenizeSelector(sel)), sel);
  });

  await t.test('unknown characters fall back to text tokens, lossless', () => {
    const sel = 'a {{weird}} b';
    const toks = tokenizeSelector(sel);
    assert.equal(join(toks), sel);
    assert.ok(toks.some(tok => tok.kind === 'text'));
  });

  await t.test('kitchen sink round-trips', () => {
    const sel = '#hdr nav[data-id="m\\"x"] > ul.menu li:nth-of-type(3) a.active';
    assert.equal(join(tokenizeSelector(sel)), sel);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build; node --test test/unit-highlight.test.js`
Expected: FAIL — `Cannot find module '…dist/panel/highlight.js'`

- [ ] **Step 3: Write the implementation**

Create `src/panel/highlight.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build; node --test test/unit-highlight.test.js`
Expected: PASS, all subtests.

- [ ] **Step 5: Lint and commit**

```powershell
npm run lint
git add src/panel/highlight.ts test/unit-highlight.test.js
git commit -m "feat(nit): add pure lossless CSS-selector tokenizer for the panel"
```

---

### Task 2: `data-id` in `buildSelector`

**Files:**
- Modify: `D:\Tools\Nit\src\capture\target.ts` (`buildSelector`, `anchorSelectorFor`, `isSignificant`, `sigSegment`; new helpers `dataIdOf`, `attrEscape`, `dataIdSelector`)
- Modify: `D:\Tools\Nit\test\fixtures\page.html` (add data-id fixture block at the END of `<body>`)
- Test: `D:\Tools\Nit\test\browser-target.test.js` (extend the existing table)

**Interfaces:**
- Consumes: existing `matchesUnique`, `cssEscape`, `segment`, `cleanClasses`, `LANDMARK_TAGS` in `target.ts`.
- Produces: no API change — `buildSelector(el, doc): string` keeps its signature; anchor kind union becomes `'id' | 'data-id' | 'custom' | 'landmark'`. Replay (`anchor.ts`) is untouched.

- [ ] **Step 1: Add the fixture block**

In `test/fixtures/page.html`, immediately before `</body>` (appending at the end so no existing nth-of-type positions shift), add:

```html
  <!-- data-id selector fixtures (kept last so existing sibling indices are stable) -->
  <div class="cards">
    <div data-id="card-1" class="card"><span class="card-label">One</span></div>
    <div data-id="card-2" class="card"><span class="card-label">Two</span></div>
    <div data-id="we&quot;ird" class="card"><span class="card-label">Three</span></div>
    <i data-id="dup" class="dup-mark"></i><i data-id="dup" class="dup-mark"></i>
    <b data-id="" class="empty-mark"></b>
  </div>
```

- [ ] **Step 2: Write the failing test cases**

In `test/browser-target.test.js`, inside the `page.evaluate` block after case 12 (`cases.rect`), add:

```js
    // 13: own data-id (no id) → tag[data-id="…"]
    const card1 = q('[data-id="card-1"]');
    cases.card1 = verify(R.resolveTarget(card1), card1);
    // 14: data-id anchors descendants
    const label2 = document.querySelectorAll('.card-label')[1];
    cases.label2 = verify(R.resolveTarget(label2), label2);
    // 15: double quote in the value is escaped and still resolves
    const weird = document.querySelectorAll('.card')[2];
    cases.weird = verify(R.resolveTarget(weird), weird);
    // 16: duplicate data-id is not unique → falls through, still resolves
    const dup2 = document.querySelectorAll('.dup-mark')[1];
    cases.dup2 = verify(R.resolveTarget(dup2), dup2);
    // 17: empty data-id is skipped
    const emptyMark = q('.empty-mark');
    cases.emptyMark = verify(R.resolveTarget(emptyMark), emptyMark);
    // 18: >100-char data-id is skipped
    card1.setAttribute('data-id', 'x'.repeat(101));
    cases.longDataId = R.resolveTarget(card1).selector;
    card1.setAttribute('data-id', 'card-1');
    // 19: own #id still wins over data-id
    card1.id = 'card-one';
    cases.idWins = R.resolveTarget(card1).selector;
    card1.removeAttribute('id');
```

And after the last existing assertion, add:

```js
  assert.equal(results.card1.selector, 'div[data-id="card-1"]');
  assert.ok(results.card1.selectorResolves && results.card1.xpathResolves);

  assert.match(results.label2.selector, /^div\[data-id="card-2"\]/, `data-id anchored: ${results.label2.selector}`);
  assert.ok(results.label2.selectorResolves && results.label2.xpathResolves);

  assert.equal(results.weird.selector, 'div[data-id="we\\"ird"]');
  assert.ok(results.weird.selectorResolves, `escaped quote resolves: ${results.weird.selector}`);

  assert.ok(!results.dup2.selector.includes('data-id'), `dup not used: ${results.dup2.selector}`);
  assert.ok(results.dup2.selectorResolves);

  assert.ok(!results.emptyMark.selector.includes('data-id'), `empty skipped: ${results.emptyMark.selector}`);
  assert.ok(results.emptyMark.selectorResolves);

  assert.ok(!results.longDataId.includes('data-id'), `overlong skipped: ${results.longDataId}`);

  assert.equal(results.idWins, '#card-one');
```

- [ ] **Step 3: Run to verify the new cases fail**

Run: `npm run build; node --test test/browser-target.test.js`
Expected: FAIL on case 13 (`card1.selector` is a class/path selector, not `div[data-id="card-1"]`).

- [ ] **Step 4: Implement**

In `src/capture/target.ts`:

Add near the top (after `ANGULAR_RUNTIME_CLASS`):

```ts
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
```

In `buildSelector`, after the own-`#id` check (the `if (el.id) { … }` block) insert:

```ts
  const ownDataId = dataIdSelector(el);
  if (ownDataId && matchesUnique(doc, ownDataId, el)) return ownDataId;
```

Update the doc comment's preference list: insert `2. the element's own unique \`tag[data-id="…"]\`` after rung 1 and renumber; mention data-id alongside ids in rungs 2–3 (anchors, significant waypoints).

In `anchorSelectorFor`, widen the kind union and add the rung between `id` and the custom/landmark branch:

```ts
function anchorSelectorFor(n: Element, doc: Document): { sel: string; kind: 'id' | 'data-id' | 'custom' | 'landmark' } | null {
  if (n.id) {
    const sel = `#${cssEscape(n.id)}`;
    if (matchesUnique(doc, sel, n)) return { sel, kind: 'id' };
  }
  const dataSel = dataIdSelector(n);
  if (dataSel && matchesUnique(doc, dataSel, n)) return { sel: dataSel, kind: 'data-id' };
  // …existing custom/landmark branch unchanged
```

(The landmark-prefix loop keys on `outer.kind !== 'landmark'`, so a `data-id` anchor is automatically a strong outer prefix — no change needed there.)

Update `isSignificant` and `sigSegment`:

```ts
function isSignificant(n: Element): boolean {
  return Boolean(n.id) || dataIdOf(n) !== null || n.tagName.includes('-') || LANDMARK_TAGS.has(n.tagName);
}

function sigSegment(n: Element): string {
  if (n.id) return `${n.tagName.toLowerCase()}#${cssEscape(n.id)}`;
  const dataSel = dataIdSelector(n);
  if (dataSel) return dataSel;
  return segment(n);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run build; node --test test/browser-target.test.js`
Expected: PASS, cases 1–19.

- [ ] **Step 6: Full suite, lint, commit**

```powershell
npm run build; npm test
npm run lint
git add src/capture/target.ts test/fixtures/page.html test/browser-target.test.js
git commit -m "feat(nit): prefer data-id attributes in generated selectors"
```

Expected: full suite green (171 existing + new subtests), lint exit 0.

---

### Task 3: Highlighted selector line in the panel

**Files:**
- Modify: `D:\Tools\Nit\src\panel\list.ts` (replace the plain `selector:` line, line 126, with a `selectorLine` helper)
- Modify: `D:\Tools\Nit\src\panel\panel.css` (token colors + monospace)
- Modify: `D:\Tools\Nit\CHANGELOG.md` (new `## Unreleased` section — do NOT touch the 1.0.0 section; publish state unknown)
- Test: `D:\Tools\Nit\test\browser-panel.test.js` (new subtest)

**Interfaces:**
- Consumes: `tokenizeSelector` from Task 1 (`import { tokenizeSelector } from './highlight.js';` — NodeNext needs the `.js`).
- Produces: DOM contract for tests: `.sel-code` container holding `span.sel-<kind>` children inside the expanded item's meta block.

- [ ] **Step 1: Write the failing test**

In `test/browser-panel.test.js`, append a subtest after the last existing `t.test` (`a1`'s stored selector is `#hero-title`; clicking its row expands the meta block):

```js
  await t.test('expanded item shows a syntax-highlighted selector', async () => {
    const panel = S.session.panelPage;
    await panel.locator('.nit-item[data-id="a1"]').click();
    await waitFor(async () => (await panel.locator('.sel-code').count()) === 1 ? true : null,
      { message: 'selector code line appears' });
    const idSpan = panel.locator('.sel-code .sel-id');
    assert.equal(await idSpan.count(), 1, 'one id token');
    assert.equal(await idSpan.textContent(), '#hero-title');
    assert.equal(await panel.locator('.sel-code').textContent(), '#hero-title', 'lossless');
  });
```

Note: by this point in the file the group-by has been switched to `none`, so `.nit-item[data-id="a1"]` is directly clickable in the flat list.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build; node --test test/browser-panel.test.js`
Expected: new subtest FAILS waiting for `.sel-code`; all pre-existing subtests still pass.

- [ ] **Step 3: Implement the panel rendering**

In `src/panel/list.ts`, add the import:

```ts
import { tokenizeSelector } from './highlight.js';
```

Replace line 126:

```ts
    if (ann.target?.selector) meta.append(line('selector: ' + ann.target.selector));
```

with:

```ts
    if (ann.target?.selector) meta.append(selectorLine(ann.target.selector));
```

Add next to `line()` at the bottom of the file:

```ts
/**
 * The `selector:` meta line, syntax-highlighted token by token. Built from
 * `textContent`-only spans — the selector string comes from untrusted
 * annotations.json and must never reach innerHTML.
 */
function selectorLine(sel: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'meta-line';
  el.append(document.createTextNode('selector: '));
  const code = document.createElement('code');
  code.className = 'sel-code';
  for (const tok of tokenizeSelector(sel)) {
    const s = document.createElement('span');
    s.className = 'sel-' + tok.kind;
    s.textContent = tok.text;
    code.append(s);
  }
  el.append(code);
  return el;
}
```

In `src/panel/panel.css`, after the `.meta-line` rule add:

```css
.sel-code { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 10.5px; }
.sel-id, .sel-attr { color: var(--accent); }
.sel-class { color: var(--comment); }
.sel-tag { color: var(--fg); }
.sel-pseudo, .sel-combinator, .sel-text { color: var(--muted); }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build; node --test test/browser-panel.test.js`
Expected: PASS, including the new subtest.

- [ ] **Step 5: Changelog**

In `CHANGELOG.md`, insert directly under the `# Changelog` heading (leave the 1.0.0 section untouched):

```markdown
## Unreleased

- **Selectors anchor on `data-id`** — generated selectors prefer `#id`, then
  `[data-id="…"]`, on the element itself, as ancestor anchors, and as path
  waypoints. Values are escaped and uniqueness-verified as before.
- **Syntax-highlighted selectors in the panel** — the expanded annotation
  detail renders the selector monospace with ids and `data-id` attributes
  highlighted, built from safe text-only spans.
```

- [ ] **Step 6: Full suite, lint, commit**

```powershell
npm run build; npm test
npm run lint
git add src/panel/list.ts src/panel/panel.css test/browser-panel.test.js CHANGELOG.md
git commit -m "feat(nit): syntax-highlight the selector line in the panel detail"
```

Expected: full suite green, lint exit 0.

---

## Self-Review Notes

- Spec coverage: Part 1 → Task 2 (own element, anchors, compressed paths, value rules, escaping); Part 2 → Tasks 1 + 3 (tokenizer, textContent-only rendering, palette); testing section → the three test files. Browser `.sel-attr` assertion from the spec is covered by the unit table instead — changing a fixture annotation's selector to an attr form would unplace its pin and break the existing group tests.
- Types consistent: `SelToken`/`SelTokenKind` defined in Task 1, consumed in Task 3; anchor kind union widened in Task 2 only.
