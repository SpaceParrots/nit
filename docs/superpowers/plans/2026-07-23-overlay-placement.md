# Overlay Placement Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the annotation overlay place pins reliably (SPA route changes, DOM re-renders, responsive twins), record whether annotations were captured in a dialog, fall back to ghost pins at recorded coordinates, and show an "x hidden" pill with per-annotation reasons.

**Architecture:** Element-first anchoring stays the source of truth. Anchoring becomes visibility-aware; the overlay classifies every on-route annotation into placed / approx (ghost pin at recorded rect) / hidden (reason: viewport, dialog, not-found); a MutationObserver plus review-mode retry cycle keeps re-anchoring; dialog context is detected at capture and stored additively on the annotation.

**Tech Stack:** TypeScript (ES modules, `tsc` build to `dist/`), vanilla DOM overlay in shadow root, Playwright-driven browser tests + `node --test`, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-23-overlay-placement-design.md`

## Global Constraints

- Schema changes are **additive only**: `Annotation.context` is optional; a missing field means page context. Plain-page annotations must NOT get a `context` field written (file stays byte-identical to before for them).
- `OverlayUiEvent.placed` / `unplaced` keep their exact current semantics: `placed` = truly anchored to a rendered element (never approximate rects — verify crops from these); `unplaced` = on this route, scope-visible, but not anchored (approx ids INCLUDED, viewport-filtered ids EXCLUDED). `browser/verify.ts` must not change.
- Every file starts with `// SPDX-License-Identifier: AGPL-3.0-or-later` (`/* … */` in CSS).
- Kevin's npm config disables lifecycle scripts: **always run `npm run build` explicitly before `node --test`** (there is no automatic pretest).
- Conventional commits, ONE line, no co-author, no body. Types: `feat`/`fix` (changelog), `docs`/`test`/`chore` (no changelog). Scope is `nit`.
- Immutability where practical; no `any` (use `unknown` + narrowing); files < 800 lines.
- Run all commands from repo root `D:\Tools\Nit`. Full suite: `npm run build && npm test` (~2-4 min, spawns headless Chromium).

---

### Task 1: Types and state groundwork

**Files:**
- Modify: `src/types.ts`
- Modify: `src/browser/session.ts` (the `SessionUiState` interface, around line 20-30)
- Modify: `src/overlay/state.ts`
- Modify: `src/overlay/main.ts` (state init object only, lines 46-59)

**Interfaces:**
- Consumes: existing `Rect`, `PlacedRef`, `Annotation`.
- Produces (all later tasks depend on these exact names):
  - `types.ts`: `HiddenReason`, `HiddenRef`, `CaptureContext`, `Annotation.context?`, `SavePayload.context?`, `OverlayUiEvent.approx?/hidden?`, `PanelState.approx/hidden`
  - `overlay/state.ts`: `ApproxAnnotation`, `HiddenAnnotation`, `OverlayState.approx/hidden`

- [ ] **Step 1: Add types to `src/types.ts`**

After the `Target` interface (line 67), add:

```ts
/** Where the annotated element lived at capture time. Missing = plain page. */
export interface CaptureContext {
  /** 'page' for normal content; 'dialog' for modal/dialog/drawer overlay surfaces */
  kind: 'page' | 'dialog';
  /** selector for the dialog container itself — replay checks "is that dialog open?" */
  selector?: string;
  /** human-readable dialog name: aria-label → aria-labelledby → first heading */
  label?: string;
}
```

In `Annotation`, after the `target` field: `context?: CaptureContext;` with doc comment `/** where the element lived at capture; absent = plain page (pre-context files) */`.

In `SavePayload`, after `route`: `context?: CaptureContext;` with doc comment `/** dialog context when the picked element was inside one; omitted on plain pages */`.

After `PlacedRef` (line 194), add:

```ts
/** Why an on-route annotation is not shown on the page right now. */
export type HiddenReason = 'viewport' | 'dialog' | 'not-found';

/** A hidden annotation and the reason, as reported by the overlay. */
export interface HiddenRef {
  id: string;
  reason: HiddenReason;
  /** dialog label for reason 'dialog' (e.g. `Checkout`) */
  label?: string;
}
```

In `OverlayUiEvent`, after `unplaced: string[];`:

```ts
  /** ghost-pinned annotations shown at their recorded rect (ids are also in `unplaced`) */
  approx?: PlacedRef[];
  /** annotations on this route that cannot be shown, with reasons */
  hidden?: HiddenRef[];
```

In `PanelState`, after `unplaced: string[];`:

```ts
  /** ids shown as ghost pins at their recorded position */
  approx: string[];
  /** hidden annotations on the current route, with reasons */
  hidden: HiddenRef[];
```

- [ ] **Step 2: Extend `SessionUiState` in `src/browser/session.ts`**

Find the `SessionUiState` interface (has `unplaced?: string[]` around line 26) and add after it:

```ts
  approx?: PlacedRef[];
  hidden?: HiddenRef[];
```

Add `HiddenRef` to the existing `types.js` import (a `PlacedRef` import already exists or is added alongside).

- [ ] **Step 3: Extend overlay state in `src/overlay/state.ts`**

Add `HiddenReason`, `Rect` to the type import from `../types.js`. After `PlacedAnnotation`:

```ts
/** An annotation shown at its recorded rect because the element couldn't be re-found. */
export interface ApproxAnnotation {
  ann: Annotation;
  rect: Rect;
}

/** An annotation on this route that cannot be shown, with the reason. */
export interface HiddenAnnotation {
  ann: Annotation;
  reason: HiddenReason;
  /** dialog label for reason 'dialog' */
  label?: string;
}
```

In `OverlayState` after `placed`/`unplaced`:

```ts
  approx: ApproxAnnotation[];
  hidden: HiddenAnnotation[];
```

Also update the `showAll` doc comment to: `/** override: show annotations of every viewport scope (default: filter to general + current viewport) */` — the behavior change itself lands in Task 4.

- [ ] **Step 4: Initialize the new fields in `src/overlay/main.ts`**

In the `state` init object (line 46-59), after `unplaced: [],` add:

```ts
    approx: [],
    hidden: [],
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/browser/session.ts src/overlay/state.ts src/overlay/main.ts
git commit -m "feat(nit): add capture-context and hidden-annotation types"
```

---

### Task 2: Dialog detection at capture

**Files:**
- Create: `src/capture/context.ts`
- Test: `test/unit-context.test.js`

**Interfaces:**
- Consumes: nothing project-specific (pure DOM-method walks).
- Produces: `detectDialog(el: Element): DialogContainer | null` where `DialogContainer = { container: Element; label: string | null }`. Task 8's popover calls this and builds `CaptureContext` from it (selector via existing `buildSelector`).

Detection uses ONLY these DOM members — keep it that way so the unit tests can fake elements without a DOM library: `tagName`, `getAttribute`, `classList.contains`, `parentElement`, `nodeType`, `querySelector`, `textContent`, `ownerDocument.getElementById`.

- [ ] **Step 1: Write the failing test `test/unit-context.test.js`**

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectDialog } from '../dist/capture/context.js';

/** Minimal fake element: just the members detectDialog is allowed to touch. */
function fakeEl({ tag = 'DIV', attrs = {}, classes = [], parent = null, heading = null, text = '' } = {}) {
  const el = {
    nodeType: 1,
    tagName: tag,
    parentElement: parent,
    textContent: text,
    getAttribute: name => (name in attrs ? attrs[name] : null),
    classList: { contains: c => classes.includes(c) },
    querySelector: sel => (sel === 'h1,h2,h3,h4,h5,h6' ? heading : null),
    ownerDocument: null,
  };
  return el;
}

test('detectDialog: plain page chain returns null', () => {
  const root = fakeEl({ tag: 'BODY' });
  const el = fakeEl({ tag: 'SPAN', parent: fakeEl({ tag: 'DIV', parent: root }) });
  assert.equal(detectDialog(el), null);
});

test('detectDialog: <dialog> ancestor is found, heading is the label', () => {
  const heading = fakeEl({ tag: 'H2', text: '  Checkout   Settings ' });
  const dlg = fakeEl({ tag: 'DIALOG', heading });
  const el = fakeEl({ tag: 'BUTTON', parent: dlg });
  const found = detectDialog(el);
  assert.equal(found.container, dlg);
  assert.equal(found.label, 'Checkout Settings');
});

test('detectDialog: role=dialog / alertdialog / aria-modal ancestors match', () => {
  for (const attrs of [{ role: 'dialog' }, { role: 'alertdialog' }, { 'aria-modal': 'true' }]) {
    const box = fakeEl({ tag: 'DIV', attrs });
    const el = fakeEl({ tag: 'SPAN', parent: box });
    assert.equal(detectDialog(el).container, box, JSON.stringify(attrs));
  }
});

test('detectDialog: overlay container classes match (cdk-overlay-pane, modal, offcanvas)', () => {
  for (const cls of ['cdk-overlay-pane', 'modal', 'offcanvas']) {
    const box = fakeEl({ tag: 'DIV', classes: [cls] });
    const el = fakeEl({ tag: 'SPAN', parent: box });
    assert.equal(detectDialog(el).container, box, cls);
  }
});

test('detectDialog: the annotated element may itself be the container', () => {
  const dlg = fakeEl({ tag: 'DIALOG' });
  assert.equal(detectDialog(dlg).container, dlg);
});

test('detectDialog: aria-label wins over heading', () => {
  const heading = fakeEl({ tag: 'H2', text: 'Heading' });
  const dlg = fakeEl({ tag: 'DIALOG', attrs: { 'aria-label': ' Cart ' }, heading });
  assert.equal(detectDialog(fakeEl({ parent: dlg })).label, 'Cart');
});

test('detectDialog: aria-labelledby resolves ids via ownerDocument', () => {
  const title = fakeEl({ tag: 'SPAN', text: 'Login' });
  const dlg = fakeEl({ tag: 'DIALOG', attrs: { 'aria-labelledby': 't1  missing' } });
  dlg.ownerDocument = { getElementById: id => (id === 't1' ? title : null) };
  assert.equal(detectDialog(fakeEl({ parent: dlg })).label, 'Login');
});

test('detectDialog: label is capped at 60 chars and null when nothing labels the dialog', () => {
  const long = fakeEl({ tag: 'H2', text: 'x'.repeat(200) });
  const dlg = fakeEl({ tag: 'DIALOG', heading: long });
  assert.equal(detectDialog(fakeEl({ parent: dlg })).label.length, 60);
  const bare = fakeEl({ tag: 'DIALOG' });
  assert.equal(detectDialog(fakeEl({ parent: bare })).label, null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build` — Expected: FAIL, `Cannot find module '.../src/capture/context.ts'`-style tsc error is NOT possible (nothing imports it yet), so build passes and `node --test test/unit-context.test.js` fails with `Cannot find module '.../dist/capture/context.js'`.

- [ ] **Step 3: Implement `src/capture/context.ts`**

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
// Detect whether a picked element lives inside a modal/dialog/drawer surface.
// Pure DOM-method walks over a small member set (tagName, getAttribute,
// classList.contains, parentElement, querySelector, textContent,
// ownerDocument.getElementById) so the unit tests can fake elements — keep it
// that way. Runs inside the inspected page (bundled into the overlay); never throws.

const MAX_LABEL = 60;

/** class names of common overlay containers (Angular CDK, Bootstrap) */
const DIALOG_CLASSES = ['cdk-overlay-pane', 'modal', 'offcanvas'];

/** A dialog-like ancestor of a picked element. */
export interface DialogContainer {
  container: Element;
  /** aria-label → resolved aria-labelledby → first heading text; null when unnamed */
  label: string | null;
}

/**
 * Nearest ancestor (incl. self) that is a dialog-like container: `<dialog>`,
 * `role=dialog|alertdialog`, `aria-modal=true`, or a known overlay class.
 * @returns the container and its human-readable label, or null on a plain page
 */
export function detectDialog(el: Element): DialogContainer | null {
  for (let n: Element | null = el; n && n.nodeType === 1; n = n.parentElement) {
    if (isDialogContainer(n)) return { container: n, label: dialogLabel(n) };
  }
  return null;
}

function isDialogContainer(n: Element): boolean {
  if (n.tagName === 'DIALOG') return true;
  const role = n.getAttribute('role');
  if (role === 'dialog' || role === 'alertdialog') return true;
  if (n.getAttribute('aria-modal') === 'true') return true;
  return DIALOG_CLASSES.some(c => n.classList.contains(c));
}

function dialogLabel(container: Element): string | null {
  const aria = norm(container.getAttribute('aria-label'));
  if (aria) return aria.slice(0, MAX_LABEL);
  const labelledby = norm(
    (container.getAttribute('aria-labelledby') ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map(id => container.ownerDocument?.getElementById(id)?.textContent ?? '')
      .join(' '),
  );
  if (labelledby) return labelledby.slice(0, MAX_LABEL);
  const heading = container.querySelector('h1,h2,h3,h4,h5,h6');
  const text = norm(heading?.textContent);
  return text ? text.slice(0, MAX_LABEL) : null;
}

function norm(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build && node --test test/unit-context.test.js`
Expected: all 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/capture/context.ts test/unit-context.test.js
git commit -m "feat(nit): detect dialog capture context with human-readable labels"
```

---

### Task 3: Visibility-aware anchoring

**Files:**
- Modify: `src/anchor/anchor.ts`
- Create: `test/fixtures/replay.html`
- Test: `test/browser-overlay-placement.test.js` (created here, extended in Tasks 4/5/7)

**Interfaces:**
- Consumes: `Target` from `types.js`.
- Produces:
  - `anchorTargetDetailed(target: Target | null | undefined, doc?: Document): { el: Element; rendered: boolean } | null` (export interface name: `AnchoredElement`)
  - `isElementRendered(el: Element): boolean` (exported — Task 4 uses it for the dialog-open check)
  - `anchorTarget()` keeps its exact signature; new behavior: prefers a rendered match across layers, returns a hidden match only when no layer yields a rendered one.

- [ ] **Step 1: Create the fixture `test/fixtures/replay.html`**

The fixture server serves this at `/replay.html` (exact file match beats SPA fallback). It has: responsive twins (hidden desktop nav + visible mobile nav with identical text inside one component), a native `<dialog>`, and a stable element.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Nit replay fixture</title>
<style>
  body { font-family: sans-serif; margin: 0; padding: 20px; }
  #nav-desktop { display: none; }
  .spacer { height: 1400px; background: #fafafa; }
</style>
</head>
<body>
  <h1 id="page-title">Replay fixture</h1>
  <fake-nav>
    <div id="nav-desktop"><a class="nav-link" href="#">Products</a></div>
    <div id="nav-mobile"><a class="nav-link" href="#">Products</a></div>
  </fake-nav>
  <p id="present">Always here</p>
  <div class="spacer"></div>
  <dialog id="dlg" aria-label="Checkout">
    <h2 id="dlg-title">Checkout Settings</h2>
    <button id="dlg-save" type="button">Save order</button>
  </dialog>
</body>
</html>
```

- [ ] **Step 2: Write the failing browser test `test/browser-overlay-placement.test.js`**

The annotation's selector AND xpath both point at the hidden desktop link (exactly what a capture on desktop produces once the site renders mobile markup) — only the text heuristic scoped to `fake-nav` can reach the visible twin. Old anchor returns the hidden element → old `refresh` drops it as unplaced. New anchor must place it on the visible twin.

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
// Overlay placement classification (spec: docs/superpowers/specs/2026-07-23-overlay-placement-design.md):
// visibility-aware anchoring, dialog/viewport/not-found hidden reasons, ghost pins, hidden pill.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startFixtureServer } from './helpers/server.js';
import { startTestSession, waitFor, tmpDir } from './helpers/session.js';

const BASE = {
  type: 'change-request', author: 'Kevin', status: 'open', viewportScope: 'general',
  viewport: { mode: 'desktop', w: 1280, h: 720 }, createdAt: '2026-07-23T10:00:00Z',
  route: '/replay.html', screenshot: null,
};

function target(overrides) {
  return {
    component: 'fake-nav', ngComponent: null, selector: '#no-such', xpath: '/html[1]/body[1]/div[99]',
    tag: 'a', classes: [], text: '', rect: { x: 0, y: 0, w: 0, h: 0 }, ...overrides,
  };
}

function writeReview(dir, url, annotations) {
  const file = path.join(dir, 'annotations.json');
  fs.writeFileSync(file, JSON.stringify({
    review: { id: 'placement-fixture', url: `${url}/replay.html`, createdAt: '2026-07-23T10:00:00Z', authors: ['Kevin'] },
    annotations,
  }, null, 2));
  return file;
}

test('overlay placement', async t => {
  const server = await startFixtureServer();
  let S;
  t.after(async () => {
    await S?.session.close();
    await server.close();
  });

  await t.test('anchoring prefers the visible responsive twin over the hidden selector match', async () => {
    const dir = tmpDir('nit-place-');
    const reviewFile = writeReview(dir, server.url, [
      { ...BASE, id: 'a1', comment: 'Rename the products link',
        target: target({
          selector: '#nav-desktop a.nav-link',
          xpath: '/html[1]/body[1]/fake-nav[1]/div[1]/a[1]',
          text: 'Products',
          rect: { x: 20, y: 60, w: 80, h: 18 },
        }) },
    ]);
    S = await startTestSession({ mode: 'view', url: undefined, reviewFile });
    const page = S.session.page;

    await waitFor(() => S.session.uiState.placed?.some(p => p.id === 'a1') ? true : null,
      { message: 'a1 placed', timeout: 15000 });
    const placedRect = S.session.uiState.placed.find(p => p.id === 'a1').rect;
    const visibleRect = await page.evaluate(() => {
      const r = document.querySelector('#nav-mobile a.nav-link').getBoundingClientRect();
      return { x: Math.round(r.x + scrollX), y: Math.round(r.y + scrollY), w: Math.round(r.width) };
    });
    assert.equal(placedRect.x, visibleRect.x);
    assert.equal(placedRect.y, visibleRect.y);
    assert.equal(placedRect.w, visibleRect.w);
    await S.session.close();
    S = null;
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm run build && node --test test/browser-overlay-placement.test.js`
Expected: FAIL — `waitFor` times out on `'a1 placed'` (old anchor returns the hidden `#nav-desktop` match; old refresh's `isRendered` drops it to unplaced).

- [ ] **Step 4: Rework `src/anchor/anchor.ts`**

Replace the file's body (keep header comment + imports) with:

```ts
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
```

Keep the existing `norm`, `tagMatches`, `isValidTag` helpers unchanged. Delete the old `anchorTarget`/`textHeuristic` bodies they replace.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run build && node --test test/browser-overlay-placement.test.js`
Expected: PASS.

- [ ] **Step 6: Run the whole suite to catch anchor regressions**

Run: `npm run build && npm test`
Expected: all existing tests PASS (browser-smoke and browser-verify exercise `anchorTarget` end-to-end; behavior for already-visible matches is unchanged).

- [ ] **Step 7: Commit**

```bash
git add src/anchor/anchor.ts test/fixtures/replay.html test/browser-overlay-placement.test.js
git commit -m "feat(nit): prefer visible matches when re-anchoring annotations"
```

---

### Task 4: Placement classification, viewport filtering, bridge pass-through

**Files:**
- Modify: `src/overlay/main.ts` (refresh, emitUi, state init `showAll`)
- Modify: `src/browser/bridge.ts` (`__nitEvent` ui sanitize, `__nitPanelState`)
- Test: extend `test/browser-overlay-placement.test.js`

**Interfaces:**
- Consumes: `anchorTargetDetailed`, `isElementRendered` (Task 3); `ApproxAnnotation`, `HiddenAnnotation`, `HiddenRef` (Task 1).
- Produces:
  - `refresh()` fills `state.placed/approx/hidden/unplaced` per the classification below; `state.unplaced = approx anns + hidden anns with reason !== 'viewport'`.
  - `ui` events carry `approx: PlacedRef[]` (id + recorded rect) and `hidden: HiddenRef[]`.
  - `session.uiState.approx/hidden` (sanitized); `PanelState.approx: string[]` (ids), `PanelState.hidden: HiddenRef[]`.
  - `showAll` defaults to `false` in every mode (overlay state init AND the `__nitPanelState` fallback).

- [ ] **Step 1: Write the failing tests (extend `test/browser-overlay-placement.test.js`)**

Append inside the outer `test('overlay placement', …)` block:

```js
  await t.test('classification: dialog / viewport / not-found reasons and approx rects', async () => {
    const dir = tmpDir('nit-class-');
    const reviewFile = writeReview(dir, server.url, [
      // in the (closed) <dialog> — context recorded at capture time
      { ...BASE, id: 'd1', comment: 'Dialog button label',
        context: { kind: 'dialog', selector: '#dlg', label: 'Checkout' },
        target: target({ component: 'dialog', selector: '#dlg-save', xpath: '/html[1]/body[1]/dialog[1]/button[1]', tag: 'button', text: 'Save order', rect: { x: 100, y: 200, w: 90, h: 30 } }) },
      // mobile-scoped — session runs desktop, so it must be viewport-hidden
      { ...BASE, id: 'm1', comment: 'Mobile spacing', viewportScope: 'mobile',
        viewport: { mode: 'mobile', w: 390, h: 844 },
        target: target({ selector: '#present', xpath: '/html[1]/body[1]/p[1]', tag: 'p', text: 'Always here' }) },
      // gone element, page context, same viewport → approx ghost rect
      { ...BASE, id: 'g1', comment: 'Removed banner',
        target: target({ selector: '#never', xpath: '/html[1]/body[1]/div[42]', tag: 'div', text: 'NO SUCH TEXT ANYWHERE', component: 'no-such-component', rect: { x: 40, y: 900, w: 200, h: 50 } }) },
      // gone element captured at the OTHER viewport → rect meaningless → not-found
      { ...BASE, id: 'g2', comment: 'Removed mobile banner', viewport: { mode: 'mobile', w: 390, h: 844 },
        target: target({ selector: '#never2', xpath: '/html[1]/body[1]/div[43]', tag: 'div', text: 'ALSO NO SUCH TEXT', component: 'no-such-component', rect: { x: 10, y: 500, w: 100, h: 40 } }) },
    ]);
    S = await startTestSession({ mode: 'view', url: undefined, reviewFile });
    const page = S.session.page;

    await waitFor(() => {
      const h = S.session.uiState.hidden ?? [];
      return h.some(x => x.id === 'd1') && h.some(x => x.id === 'm1') && h.some(x => x.id === 'g2')
        && (S.session.uiState.approx ?? []).some(x => x.id === 'g1') ? true : null;
    }, { message: 'classification reported', timeout: 15000 });

    const hidden = new Map(S.session.uiState.hidden.map(h => [h.id, h]));
    assert.deepEqual(hidden.get('d1'), { id: 'd1', reason: 'dialog', label: 'Checkout' });
    assert.equal(hidden.get('m1').reason, 'viewport');
    assert.equal(hidden.get('g2').reason, 'not-found');
    // approx carries the recorded rect; its id also counts as unplaced (verify contract)
    assert.deepEqual(S.session.uiState.approx.find(a => a.id === 'g1').rect, { x: 40, y: 900, w: 200, h: 50 });
    assert.ok(S.session.uiState.unplaced.includes('g1'));
    assert.ok(S.session.uiState.unplaced.includes('d1'));
    assert.ok(!S.session.uiState.unplaced.includes('m1'), 'viewport-filtered ids stay out of unplaced');

    // opening the dialog re-anchors d1 into placed (the MutationObserver from
    // Task 6 makes this instant; until then the 1s retry cycle covers it)
    await page.evaluate(() => document.getElementById('dlg').showModal());
    await waitFor(() => S.session.uiState.placed?.some(p => p.id === 'd1') ? true : null,
      { message: 'd1 placed once dialog opens', timeout: 15000 });
    await S.session.close();
    S = null;
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && node --test test/browser-overlay-placement.test.js`
Expected: the new subtest FAILS (`uiState.hidden` is undefined — nothing emits it yet). The Task 3 subtest still PASSES.

- [ ] **Step 3: Implement classification in `src/overlay/main.ts`**

Update imports: `import { anchorTargetDetailed, isElementRendered } from '../anchor/anchor.js';` (replacing the `anchorTarget` import); add `ApproxAnnotation`, `HiddenAnnotation` to the `./state.js` type import; add `CaptureContext` to the `../types.js` type import.

In the state init, change `showAll: mode !== 'view'` (and its comment) to:

```ts
    // filter to general + current viewport by default; the show-all toggle overrides
    showAll: false,
```

Replace `refresh` and delete the local `isRendered` helper (now `isElementRendered` in anchor.ts):

```ts
function refresh(state: OverlayState, ui: OverlayUi): void {
  const route = location.pathname;
  // matching ignores query/hash: an annotation captured at /p?id=5 still pins on /p
  const placed: PlacedAnnotation[] = [];
  const approx: ApproxAnnotation[] = [];
  const hidden: HiddenAnnotation[] = [];
  for (const ann of state.annotations) {
    if (routePath(ann.route) !== route) continue;
    if (!scopeVisible(state, ann)) {
      hidden.push({ ann, reason: 'viewport' });
      continue;
    }
    const found = anchorTargetDetailed(ann.target, document);
    if (found?.rendered) {
      placed.push({ ann, el: found.el });
      continue;
    }
    if (ann.context?.kind === 'dialog' && !dialogOpen(ann.context)) {
      hidden.push({ ann, reason: 'dialog', label: ann.context.label });
      continue;
    }
    const rect = ann.target?.rect;
    // Last resort: the recorded position — only meaningful outside dialogs and
    // at the viewport the annotation was captured at.
    if (ann.context?.kind !== 'dialog' && ann.viewport?.mode === state.viewportMode && rect && (rect.w > 0 || rect.h > 0)) {
      approx.push({ ann, rect });
    } else {
      hidden.push({ ann, reason: 'not-found' });
    }
  }
  state.placed = placed;
  state.approx = approx;
  state.hidden = hidden;
  // `unplaced` keeps its bridge meaning "on this route but not anchored": approx
  // ids are in (verify's fallback capture relies on it), viewport-filtered are out.
  state.unplaced = [...approx.map(a => a.ann), ...hidden.filter(h => h.reason !== 'viewport').map(h => h.ann)];
  ui.pins.render();
  ui.chip.update();
  emitUi(state);
}

/** Whether the dialog an annotation was captured in is currently open. */
function dialogOpen(ctx: CaptureContext): boolean {
  if (!ctx.selector) return false;
  try {
    const el = document.querySelector(ctx.selector);
    return Boolean(el && isElementRendered(el));
  } catch {
    return false;
  }
}
```

Extend `emitUi`'s event payload after `unplaced`:

```ts
      approx: state.approx.map(a => ({ id: a.ann.id, rect: a.rect })),
      hidden: state.hidden.map(h => ({ id: h.ann.id, reason: h.reason, ...(h.label ? { label: h.label } : {}) })),
```

- [ ] **Step 4: Sanitize + expose in `src/browser/bridge.ts`**

Add `HiddenRef`, `HiddenReason` to the `types.js` type import. In the `__nitEvent` `ui` branch, extend the `session.uiState` assignment:

```ts
        approx: Array.isArray(ui.approx) ? ui.approx.filter(isPlacedRef) : [],
        hidden: Array.isArray(ui.hidden) ? ui.hidden.filter(isHiddenRef).map(sanitizeHiddenRef) : [],
```

Next to `isPlacedRef` add:

```ts
const HIDDEN_REASONS: readonly HiddenReason[] = ['viewport', 'dialog', 'not-found'];

function isHiddenRef(v: unknown): v is HiddenRef {
  return Boolean(v) && typeof v === 'object'
    && typeof (v as HiddenRef).id === 'string'
    && (HIDDEN_REASONS as readonly string[]).includes((v as HiddenRef).reason);
}

/** The label is page-supplied free text shown in the panel — keep strings only, bounded. */
function sanitizeHiddenRef(h: HiddenRef): HiddenRef {
  return { id: h.id, reason: h.reason, ...(typeof h.label === 'string' ? { label: h.label.slice(0, 60) } : {}) };
}
```

In `__nitPanelState`, change the `showAll` fallback and add the new fields after `unplaced`:

```ts
    showAll: session.uiState.showAll ?? false,
    ...
    approx: (session.uiState.approx ?? []).map(p => p.id),
    hidden: session.uiState.hidden ?? [],
```

- [ ] **Step 5: Run the tests**

Run: `npm run build && node --test test/browser-overlay-placement.test.js`
Expected: both subtests PASS (the dialog-open re-anchor rides on the existing 1 s retry cycle in view mode).

- [ ] **Step 6: Run the whole suite**

Run: `npm run build && npm test`
Expected: PASS. Watch specifically `browser-verify*.test.js` (unplaced/placed contract) and `browser-smoke.test.js`. If a smoke test depended on review mode showing off-viewport annotations, fix the TEST expectation only if it asserts the old mixing behavior — the new default is the spec'd behavior.

- [ ] **Step 7: Commit**

```bash
git add src/overlay/main.ts src/browser/bridge.ts test/browser-overlay-placement.test.js
git commit -m "feat(nit): classify overlay annotations as placed, approximate, or hidden with reasons"
```

---

### Task 5: Ghost pins and the detached-element guard

**Files:**
- Modify: `src/overlay/pins.ts`
- Modify: `src/overlay/overlay.css`
- Test: extend `test/browser-overlay-placement.test.js`

**Interfaces:**
- Consumes: `state.approx` (Task 4), `Rect`.
- Produces: ghost pins with class `nit-pin--approx`, numbered after the placed pins; `reposition()` hides pins whose element is detached; `focus(id)` also handles approx ids (scrolls to the rect).

- [ ] **Step 1: Write the failing test (extend `browser-overlay-placement.test.js`)**

Append a subtest:

```js
  await t.test('ghost pin renders dashed at the recorded rect; placed pins stay numbered first', async () => {
    const dir = tmpDir('nit-ghost-');
    const reviewFile = writeReview(dir, server.url, [
      { ...BASE, id: 'p1', comment: 'Title casing',
        target: target({ selector: '#page-title', xpath: '/html[1]/body[1]/h1[1]', tag: 'h1', text: 'Replay fixture', component: 'h1', rect: { x: 20, y: 20, w: 200, h: 30 } }) },
      { ...BASE, id: 'g1', comment: 'Removed banner',
        target: target({ selector: '#never', text: 'NO SUCH TEXT ANYWHERE', component: 'no-such-component', rect: { x: 40, y: 300, w: 200, h: 50 } }) },
    ]);
    S = await startTestSession({ mode: 'view', url: undefined, reviewFile });
    const page = S.session.page;

    await waitFor(() => (S.session.uiState.approx ?? []).some(a => a.id === 'g1') ? true : null,
      { message: 'g1 approx', timeout: 15000 });
    const pins = await page.evaluate(() => {
      const root = document.getElementById('nit-root').shadowRoot;
      return [...root.querySelectorAll('.nit-pin')].map(p => ({
        n: p.textContent, approx: p.classList.contains('nit-pin--approx'),
        left: p.style.left, top: p.style.top,
      }));
    });
    assert.deepEqual(pins.map(p => [p.n, p.approx]), [['1', false], ['2', true]]);
    // page not scrolled → viewport coords equal page coords, offset by the 10px pin nudge
    assert.equal(pins[1].left, `${40 - 10}px`);
    assert.equal(pins[1].top, `${300 - 10}px`);
    await S.session.close();
    S = null;
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && node --test test/browser-overlay-placement.test.js`
Expected: new subtest FAILS — only one pin exists (`['1', false]`).

- [ ] **Step 3: Implement in `src/overlay/pins.ts`**

Add `Rect` to a type import from `../types.js`. Change the tracked shape and rendering:

```ts
  /** live pin nodes: element-tracked (el) or rect-fallback ghosts (rect); rebuilt by render */
  let tracked: { pin: HTMLElement; el?: Element; rect?: Rect }[] = [];

  function placeApprox(pin: HTMLElement, rect: Rect): void {
    pin.style.left = `${rect.x - window.scrollX - 10}px`;
    pin.style.top = `${rect.y - window.scrollY - 10}px`;
  }

  function makePin(ann: Annotation, n: number, approx: boolean): HTMLElement {
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = `nit-pin nit-pin--${ann.type}`
      + (ann.status !== 'open' ? ' nit-pin--closed' : '')
      + (approx ? ' nit-pin--approx' : '');
    pin.textContent = String(n);
    pin.title = approx ? `${ann.comment}\n(approximate position — element not re-found)` : ann.comment;
    layer.append(pin);
    return pin;
  }

  function render(): void {
    layer.innerHTML = '';
    tracked = state.placed.map(({ ann, el }, i) => {
      const pin = makePin(ann, i + 1, false);
      place(pin, el);
      pin.addEventListener('click', e => {
        e.stopPropagation();
        actions.focusAnnotation(ann.id);
        flash(el);
      });
      return { pin, el };
    });
    // Ghost pins continue the numbering so the panel and the page agree on numbers.
    tracked.push(...state.approx.map(({ ann, rect }, i) => {
      const pin = makePin(ann, state.placed.length + i + 1, true);
      placeApprox(pin, rect);
      pin.addEventListener('click', e => {
        e.stopPropagation();
        actions.focusAnnotation(ann.id);
      });
      return { pin, rect };
    }));
  }

  /** Re-read every tracked position and move its pin — no DOM rebuild. A pin whose
   *  element got detached by an SPA re-render is hidden instead of collapsing to
   *  0,0 over unrelated content; the mutation watcher re-anchors it right after. */
  function reposition(): void {
    for (const t of tracked) {
      if (t.el) {
        const gone = !t.el.isConnected;
        t.pin.style.visibility = gone ? 'hidden' : '';
        if (!gone) place(t.pin, t.el);
      } else if (t.rect) {
        placeApprox(t.pin, t.rect);
      }
    }
  }
```

Update `focus` to cover approx ids:

```ts
  function focus(id: string): void {
    const entry = state.placed.find(p => p.ann.id === id);
    if (entry) {
      entry.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setTimeout(() => flash(entry.el), 250);
      return;
    }
    const ghost = state.approx.find(a => a.ann.id === id);
    if (!ghost) return;
    window.scrollTo({ top: Math.max(0, ghost.rect.y - window.innerHeight / 2), behavior: 'smooth' });
  }
```

Add the `Annotation` type import from `../types.js` for `makePin`.

- [ ] **Step 4: Add the ghost style to `src/overlay/overlay.css`**

After `.nit-pin--closed`:

```css
.nit-pin--approx { border-style: dashed; opacity: 0.75; }
```

- [ ] **Step 5: Run the tests**

Run: `npm run build && node --test test/browser-overlay-placement.test.js`
Expected: all subtests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/overlay/pins.ts src/overlay/overlay.css test/browser-overlay-placement.test.js
git commit -m "feat(nit): render ghost pins at recorded positions and hide detached pins"
```

---

### Task 6: Re-anchor reliability — retries in review mode + MutationObserver

**Files:**
- Modify: `src/overlay/main.ts`
- Modify: `test/fixtures/page.html` (opt-in slow rendering; script-only change — body sibling indices must not shift, other tests depend on them)
- Test: `test/browser-overlay-reanchor.test.js` (new)

**Interfaces:**
- Consumes: `refresh` (Task 4), `state.placed/unplaced`.
- Produces: `installMutationWatcher(state, ui)` in `main.ts`; anchor retry cycle installed in every mode. Constants `MUTATION_DEBOUNCE_MS = 250`, `MUTATION_REFRESH_FLOOR_MS = 500`.

- [ ] **Step 1: Add opt-in slow rendering to `test/fixtures/page.html`**

Replace the `render` function inside the fixture's script (only this function — nothing else):

```js
    function render() {
      const app = document.getElementById('app');
      const paint = () => { app.innerHTML = routes[location.pathname] || '<p class="notfound">404</p>'; };
      // ?slow simulates an SPA that renders well after DOMContentLoaded/route change
      if (new URLSearchParams(location.search).has('slow')) {
        app.innerHTML = '';
        setTimeout(paint, 2500);
      } else {
        paint();
      }
    }
```

- [ ] **Step 2: Write the failing test `test/browser-overlay-reanchor.test.js`**

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
// Re-anchor reliability: review-mode retry cycle after slow SPA route changes,
// and MutationObserver-driven recovery when an SPA re-render replaces DOM nodes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startFixtureServer } from './helpers/server.js';
import { startTestSession, waitFor, tmpDir } from './helpers/session.js';

const ANN = {
  id: 'a1', type: 'change-request', author: 'Kevin', status: 'open', viewportScope: 'general',
  viewport: { mode: 'desktop', w: 1280, h: 720 }, createdAt: '2026-07-23T10:00:00Z',
  route: '/about', comment: 'About paragraph wording', screenshot: null,
  target: { component: 'fake-about', ngComponent: null, selector: 'fake-about p.about-text',
    xpath: '/html[1]/body[1]/main[1]/fake-about[1]/p[1]', tag: 'p', classes: ['about-text'],
    text: 'About page paragraph', rect: { x: 20, y: 60, w: 300, h: 20 } },
};

function writeReview(dir, url) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'annotations.json'), JSON.stringify({
    review: { id: 'reanchor-fixture', url: `${url}/`, createdAt: '2026-07-23T10:00:00Z', authors: ['Kevin'] },
    annotations: [ANN],
  }, null, 2));
}

test('overlay re-anchoring', async t => {
  const server = await startFixtureServer();
  let S;
  t.after(async () => {
    await S?.session.close();
    await server.close();
  });

  await t.test('review mode: pins appear after a slow SPA route render (retry cycle)', async () => {
    const out = tmpDir('nit-retry-');
    writeReview(out, server.url);
    S = await startTestSession({ mode: 'review', out, url: `${server.url}/` });
    const page = S.session.page;
    await waitFor(() => S.session.uiState.route !== undefined ? true : null, { message: 'overlay up', timeout: 15000 });

    // SPA-navigate to a route that renders 2.5s later — beyond the fixed
    // 300ms/1500ms post-route refreshes, so only the retry cycle can catch it.
    await page.evaluate(() => {
      history.pushState({}, '', '/about?slow');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() => S.session.uiState.placed?.some(p => p.id === 'a1') ? true : null,
      { message: 'a1 placed after slow render', timeout: 15000 });
    await S.session.close();
    S = null;
  });

  await t.test('view mode: a DOM re-render that replaces nodes re-anchors pins (MutationObserver)', async () => {
    const dir = tmpDir('nit-mutate-');
    writeReview(dir, server.url);
    S = await startTestSession({ mode: 'view', url: undefined, reviewFile: path.join(dir, 'annotations.json') });
    const page = S.session.page;

    await page.evaluate(() => {
      history.pushState({}, '', '/about');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() => S.session.uiState.placed?.some(p => p.id === 'a1') ? true : null,
      { message: 'a1 placed', timeout: 15000 });

    // Replace every node under #app with fresh clones (what SPA re-renders do).
    // No route change, no annotation change: only the MutationObserver can see it.
    await page.evaluate(() => {
      const app = document.getElementById('app');
      // eslint-disable-next-line no-self-assign
      app.innerHTML = app.innerHTML;
    });
    // The overlay must (a) report a fresh placed rect for the NEW node and
    // (b) not leave the pin tracking the detached one.
    await waitFor(async () => {
      const ok = await page.evaluate(() => {
        const root = document.getElementById('nit-root').shadowRoot;
        const pin = root.querySelector('.nit-pin');
        if (!pin || pin.style.visibility === 'hidden') return false;
        const el = document.querySelector('fake-about p.about-text');
        const r = el.getBoundingClientRect();
        return Math.abs(parseFloat(pin.style.left) - (r.left - 10)) < 2
          && Math.abs(parseFloat(pin.style.top) - (r.top - 10)) < 2;
      });
      return ok ? true : null;
    }, { message: 'pin re-anchored to the replacing node', timeout: 5000 });
    await S.session.close();
    S = null;
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm run build && node --test test/browser-overlay-reanchor.test.js`
Expected: subtest 1 FAILS (review mode has no retry cycle — `a1 placed after slow render` times out). Subtest 2 may pass by luck only if something else refreshes; it must pass deterministically after Step 4-5.

- [ ] **Step 4: Install retries in every mode (`src/overlay/main.ts`)**

In `init`, replace the conditional retry install:

```ts
  // Sites render on their own schedule in every mode — a review-mode route
  // change needs the retry cycle just as much as replay (pins used to vanish
  // on slow SPA routes during capture). Capture-time picks still anchor
  // instantly; retries only run while something is unplaced.
  const retryAnchors = installAnchorRetries(state, ui);
  installRouteWatcher(state, ui, retryAnchors);
  installSync(state, ui, retryAnchors);
  installMutationWatcher(state, ui);
  refresh(state, ui);
  retryAnchors();
```

Update `installRouteWatcher`/`installSync` signatures from `restartAnchors?: () => void` to `restartAnchors: () => void` and drop the `?.` calls (they are always provided now); update both functions' doc comments to say the cycle runs in every mode.

- [ ] **Step 5: Add the mutation watcher (`src/overlay/main.ts`)**

Add constants next to the existing ones:

```ts
const MUTATION_DEBOUNCE_MS = 250;
const MUTATION_REFRESH_FLOOR_MS = 500;
```

Add after `installSync`:

```ts
/** SPA re-renders replace DOM nodes without any route change: pins would keep
 *  tracking detached elements and unplaced annotations would wait a full retry
 *  tick to appear. Watch the page body (the overlay host lives on
 *  documentElement and its UI in a shadow root, so our own mutations are never
 *  seen) and refresh — debounced, with a floor between refreshes so animated
 *  pages can't thrash — whenever something is unplaced or a tracked element got
 *  detached. */
function installMutationWatcher(state: OverlayState, ui: OverlayUi): void {
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let lastRefresh = 0;
  const needsRefresh = (): boolean =>
    state.unplaced.length > 0 || state.placed.some(p => !p.el.isConnected);
  const tick = (): void => {
    debounce = undefined;
    if (!needsRefresh()) return;
    const since = Date.now() - lastRefresh;
    if (since < MUTATION_REFRESH_FLOOR_MS) {
      debounce = setTimeout(tick, MUTATION_REFRESH_FLOOR_MS - since);
      return;
    }
    lastRefresh = Date.now();
    refresh(state, ui);
  };
  const observe = (): void => {
    if (!document.body) return;
    new MutationObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(tick, MUTATION_DEBOUNCE_MS);
    }).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'open'],
    });
  };
  observe();
}
```

- [ ] **Step 6: Run the tests**

Run: `npm run build && node --test test/browser-overlay-reanchor.test.js`
Expected: both subtests PASS. Subtest 2 must complete within its 5 s window (debounce 250 ms + refresh ≪ 5 s), proving the observer — not the 1 s retry cycle, which stopped once everything was placed — did the work.

- [ ] **Step 7: Run the whole suite**

Run: `npm run build && npm test`
Expected: PASS — the verify tests are timing-sensitive; the observer must not have broken the `ui`-event cadence they rely on.

- [ ] **Step 8: Commit**

```bash
git add src/overlay/main.ts test/fixtures/page.html test/browser-overlay-reanchor.test.js
git commit -m "fix(nit): re-anchor pins after SPA re-renders and slow route changes in every mode"
```

---

### Task 7: Hidden pill with reason popover

**Files:**
- Create: `src/overlay/hidden-pill.ts`
- Modify: `src/overlay/state.ts` (`HiddenPill` contract, `OverlayUi.hiddenPill`)
- Modify: `src/overlay/main.ts` (dock container, wiring, `refresh` update call)
- Modify: `src/overlay/chip.ts` (mounts into the dock instead of the root)
- Modify: `src/overlay/overlay.css`
- Test: extend `test/browser-overlay-placement.test.js`

**Interfaces:**
- Consumes: `state.hidden` (Task 4), `actions.focusAnnotation`.
- Produces: `createHiddenPill(root: HTMLElement, state: OverlayState, actions: OverlayActions): HiddenPill` where `HiddenPill = { update(): void }`. DOM: `.nit-dock` fixed container (bottom-left) holding `.nit-chip` and `.nit-hidden-pill`; popover `.nit-hidden-pop` with `.nit-hidden-row` entries.

- [ ] **Step 1: Write the failing test (extend `browser-overlay-placement.test.js`)**

Append a subtest (reuses the classification fixture shape — d1 dialog-hidden, m1 viewport-hidden, g1 approx):

```js
  await t.test('hidden pill counts hidden (not approx) annotations and lists reasons', async () => {
    const dir = tmpDir('nit-pill-');
    const reviewFile = writeReview(dir, server.url, [
      { ...BASE, id: 'd1', comment: 'Dialog button label',
        context: { kind: 'dialog', selector: '#dlg', label: 'Checkout' },
        target: target({ component: 'dialog', selector: '#dlg-save', tag: 'button', text: 'Save order', rect: { x: 100, y: 200, w: 90, h: 30 } }) },
      { ...BASE, id: 'm1', comment: 'Mobile spacing', viewportScope: 'mobile', viewport: { mode: 'mobile', w: 390, h: 844 },
        target: target({ selector: '#present', tag: 'p', text: 'Always here' }) },
      { ...BASE, id: 'g1', comment: 'Removed banner',
        target: target({ selector: '#never', text: 'NO SUCH TEXT ANYWHERE', component: 'no-such-component', rect: { x: 40, y: 300, w: 200, h: 50 } }) },
    ]);
    S = await startTestSession({ mode: 'view', url: undefined, reviewFile });
    const page = S.session.page;

    await waitFor(() => (S.session.uiState.hidden ?? []).length === 2 ? true : null,
      { message: '2 hidden reported', timeout: 15000 });
    const pill = await page.evaluate(() => {
      const root = document.getElementById('nit-root').shadowRoot;
      const el = root.querySelector('.nit-hidden-pill');
      return { hidden: el.hidden, text: el.textContent };
    });
    assert.equal(pill.hidden, false);
    assert.equal(pill.text, '2 hidden');

    const rows = await page.evaluate(() => {
      const root = document.getElementById('nit-root').shadowRoot;
      root.querySelector('.nit-hidden-pill').click();
      return [...root.querySelectorAll('.nit-hidden-row')].map(r => r.textContent);
    });
    assert.equal(rows.length, 2);
    assert.ok(rows[0].includes('in dialog “Checkout”'), rows[0]);
    assert.ok(rows[1].includes('mobile-only'), rows[1]);

    // a row click asks the panel to focus that annotation
    await page.evaluate(() => {
      document.getElementById('nit-root').shadowRoot.querySelector('.nit-hidden-row').click();
    });
    await waitFor(() => S.events.some(e => e.type === 'focus' && e.id === 'd1') ? true : null,
      { message: 'focus event for d1', timeout: 5000 });
    await S.session.close();
    S = null;
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && node --test test/browser-overlay-placement.test.js`
Expected: new subtest FAILS (`.nit-hidden-pill` is null → evaluate throws).

- [ ] **Step 3: Add the contract to `src/overlay/state.ts`**

```ts
/** The "x hidden" pill next to the chip. */
export interface HiddenPill {
  update(): void;
}
```

Add `hiddenPill: HiddenPill;` to `OverlayUi` (after `chip`).

- [ ] **Step 4: Implement `src/overlay/hidden-pill.ts`**

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
// The "x hidden" pill: sits in the bottom-left dock next to the chip whenever
// annotations on this route cannot be shown (closed dialog, other viewport,
// element gone). Click toggles a mini-popover listing each with its reason;
// a row click focuses the annotation in the panel window.
import type { HiddenAnnotation, HiddenPill, OverlayActions, OverlayState } from './state.js';

const MAX_SNIPPET = 40;

/**
 * Create the hidden pill + reason popover.
 * @param dock the bottom-left dock element to mount the pill into
 * @param state shared overlay state (`state.hidden` drives it)
 * @param actions overlay actions (focusAnnotation on row click)
 */
export function createHiddenPill(dock: HTMLElement, state: OverlayState, actions: OverlayActions): HiddenPill {
  const pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'nit-hidden-pill';
  pill.hidden = true;
  pill.title = 'Annotations on this page that can\u2019t be shown right now';
  dock.append(pill);

  const pop = document.createElement('div');
  pop.className = 'nit-hidden-pop';
  pop.hidden = true;
  dock.append(pop);

  pill.addEventListener('click', () => {
    if (!pop.hidden) {
      pop.hidden = true;
      return;
    }
    renderPop();
    pop.hidden = false;
  });

  function reasonText(h: HiddenAnnotation): string {
    if (h.reason === 'viewport') return `${h.ann.viewportScope}-only`;
    if (h.reason === 'dialog') return h.label ? `in dialog \u201C${h.label}\u201D` : 'in a closed dialog';
    return 'not found on this page';
  }

  function renderPop(): void {
    pop.innerHTML = '';
    for (const h of state.hidden) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'nit-hidden-row';
      const snippet = h.ann.comment.length > MAX_SNIPPET ? `${h.ann.comment.slice(0, MAX_SNIPPET)}\u2026` : h.ann.comment;
      row.textContent = `${h.ann.id} \u00B7 ${snippet} \u2014 ${reasonText(h)}`;
      row.addEventListener('click', () => actions.focusAnnotation(h.ann.id));
      pop.append(row);
    }
  }

  function update(): void {
    const n = state.hidden.length;
    pill.hidden = n === 0;
    if (n === 0) {
      pop.hidden = true;
      return;
    }
    pill.textContent = `${n} hidden`;
    if (!pop.hidden) renderPop();
  }
  update();
  return { update };
}
```

- [ ] **Step 5: Mount a dock, wire the pill (`src/overlay/main.ts`, `src/overlay/chip.ts`)**

`main.ts`: after the shadow root setup, create the dock and pass it to chip + pill; add the pill to `ui` and call it from `refresh`:

```ts
  // Bottom-left dock: chip + hidden pill side by side without coordinate math.
  const dock = document.createElement('div');
  dock.className = 'nit-dock';
  root.append(dock);
```

Change `createChip(root, …)` to `createChip(dock, state, actions)`, add `const hiddenPill = createHiddenPill(dock, state, actions);` (import from `./hidden-pill.js`), extend `ui = { host, root, pins, chip, hiddenPill, popover, picker };`, and in `refresh` after `ui.chip.update();` add `ui.hiddenPill.update();`.

`chip.ts`: change the first parameter from `root: ShadowRoot` to `dock: HTMLElement` (update the doc comment) — the body only uses `root.append(el)` → `dock.append(el)`.

- [ ] **Step 6: Styles (`src/overlay/overlay.css`)**

Replace the chip's positioning (keep every other declaration) and add the dock/pill/pop rules:

```css
/* ---- bottom-left dock: chip + hidden pill (the only persistent in-page UI) ---- */
.nit-dock {
  position: fixed;
  left: 12px;
  bottom: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  z-index: 40;
}
```

In `.nit-chip`, delete `position: fixed; left: 12px; bottom: 12px;` and `z-index: 40;` (the dock owns placement now).

```css
.nit-hidden-pill {
  background: var(--nit-bg);
  color: var(--nit-muted);
  border: 1px dashed var(--nit-border);
  border-radius: 999px;
  font-size: 12px;
  padding: 6px 12px;
  cursor: pointer;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
}
.nit-hidden-pill:hover { color: var(--nit-fg); border-color: var(--nit-muted); }
.nit-hidden-pop {
  position: absolute;
  left: 0;
  bottom: calc(100% + 8px);
  min-width: 260px;
  max-width: 380px;
  background: var(--nit-bg);
  border: 1px solid var(--nit-border);
  border-radius: 10px;
  padding: 6px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.nit-hidden-row {
  background: none;
  border: none;
  color: var(--nit-fg);
  font-size: 12px;
  text-align: left;
  padding: 5px 8px;
  border-radius: 6px;
  cursor: pointer;
}
.nit-hidden-row:hover { background: #2a2a2e; }
```

- [ ] **Step 7: Run the tests**

Run: `npm run build && node --test test/browser-overlay-placement.test.js`
Expected: all subtests PASS.

- [ ] **Step 8: Run the whole suite** (chip moved into the dock — smoke tests click it)

Run: `npm run build && npm test`
Expected: PASS (`.nit-chip` selectors still resolve — only its parent changed).

- [ ] **Step 9: Commit**

```bash
git add src/overlay/hidden-pill.ts src/overlay/state.ts src/overlay/main.ts src/overlay/chip.ts src/overlay/overlay.css test/browser-overlay-placement.test.js
git commit -m "feat(nit): show a hidden-annotations pill with per-annotation reasons"
```

---

### Task 8: Capture the dialog context end-to-end

**Files:**
- Modify: `src/overlay/popover.ts`
- Modify: `src/browser/bridge.ts` (`RawSavePayload`, `__nitSave`)
- Test: `test/browser-capture-context.test.js` (new)

**Interfaces:**
- Consumes: `detectDialog` (Task 2), `buildSelector` (existing, `src/capture/target.ts`), `SavePayload.context` (Task 1).
- Produces: annotations picked inside a dialog persist `context: { kind: 'dialog', selector, label? }` in annotations.json; plain-page annotations persist NO `context` field.

- [ ] **Step 1: Write the failing test `test/browser-capture-context.test.js`**

Picking flow mirrors `test/browser-smoke.test.js` (Alt toggles picking, click selects, popover in the shadow root — Playwright pierces open shadow roots).

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
// Capture context: an annotation picked inside a dialog records where it lived;
// plain-page annotations keep their file shape byte-identical (no context field).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startFixtureServer } from './helpers/server.js';
import { startTestSession, waitFor, tmpDir } from './helpers/session.js';

async function annotate(page, targetSelector, comment) {
  await page.keyboard.press('Alt');
  const box = await page.locator(targetSelector).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const ta = page.locator('#nit-root .nit-pop-comment');
  await ta.waitFor({ state: 'visible' });
  await ta.fill(comment);
  await page.locator('#nit-root .nit-save').click();
}

test('capture context', async t => {
  const server = await startFixtureServer();
  const out = tmpDir('nit-ctx-');
  const S = await startTestSession({ mode: 'review', out, url: `${server.url}/replay.html` });
  t.after(async () => {
    await S.session.close();
    await server.close();
  });
  const page = S.session.page;
  const readFile = () => JSON.parse(fs.readFileSync(path.join(out, 'annotations.json'), 'utf8'));

  await t.test('dialog pick records kind/selector/label', async () => {
    await page.evaluate(() => document.getElementById('dlg').showModal());
    await annotate(page, '#dlg-save', 'Rename this button');
    const data = await waitFor(() => {
      const d = readFile();
      return d.annotations.length === 1 ? d : null;
    }, { message: 'annotation saved', timeout: 15000 });
    const ann = data.annotations[0];
    assert.equal(ann.context.kind, 'dialog');
    assert.equal(ann.context.label, 'Checkout'); // aria-label wins over the heading
    // the selector re-finds the dialog container itself
    const hits = await page.evaluate(sel => document.querySelectorAll(sel).length, ann.context.selector);
    assert.equal(hits, 1);
    await page.evaluate(() => document.getElementById('dlg').close());
  });

  await t.test('plain-page pick stores no context field at all', async () => {
    await annotate(page, '#present', 'Tighten this copy');
    const data = await waitFor(() => {
      const d = readFile();
      return d.annotations.length === 2 ? d : null;
    }, { message: 'second annotation saved', timeout: 15000 });
    assert.ok(!('context' in data.annotations[1]));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && node --test test/browser-capture-context.test.js`
Expected: FAIL — `ann.context` is undefined in subtest 1.

- [ ] **Step 3: Include the context in the popover save (`src/overlay/popover.ts`)**

Add imports:

```ts
import { detectDialog } from '../capture/context.js';
import { buildSelector, resolveTarget } from '../capture/target.js';
```

(replacing the existing `resolveTarget` import line). In `save()`, before building the payload:

```ts
        const dialog = detectDialog(elementToSave);
```

and in the payload after `route`:

```ts
          // absent on plain pages — keeps the file identical to before for them
          context: dialog
            ? { kind: 'dialog', selector: buildSelector(dialog.container), label: dialog.label ?? undefined }
            : undefined,
```

- [ ] **Step 4: Sanitize + persist in `src/browser/bridge.ts`**

Add `context?: unknown;` to `RawSavePayload`. Add `CaptureContext` to the type import. In the `__nitSave` handler, add to the `annotation` literal after `target`:

```ts
      // untrusted like the rest of the payload — dialog contexts only, bounded strings
      context: sanitizeContext(p.context),
```

Add next to `validateSave`:

```ts
/**
 * Page-supplied capture context. Only dialog contexts are stored — 'page' is
 * the implicit default and writing it would churn every plain annotation.
 * Free-text fields are bounded: they end up in the panel UI and MCP output.
 */
function sanitizeContext(v: unknown): CaptureContext | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const c = v as Partial<CaptureContext>;
  if (c.kind !== 'dialog') return undefined;
  const selector = typeof c.selector === 'string' && c.selector ? c.selector.slice(0, 300) : undefined;
  const label = typeof c.label === 'string' && c.label ? c.label.slice(0, 60) : undefined;
  return { kind: 'dialog', ...(selector ? { selector } : {}), ...(label ? { label } : {}) };
}
```

(`context: undefined` on the annotation serializes away — plain-page files stay identical.)

- [ ] **Step 5: Run the tests**

Run: `npm run build && node --test test/browser-capture-context.test.js`
Expected: both subtests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/overlay/popover.ts src/browser/bridge.ts test/browser-capture-context.test.js
git commit -m "feat(nit): record dialog capture context on saved annotations"
```

---

### Task 9: Panel — reasons in the "Couldn't place" section

**Files:**
- Modify: `src/panel/list.ts` (`renderItem` gains an optional note)
- Modify: `src/panel/main.ts` (compute notes + ghost numbers from `PanelState`)
- Modify: `src/panel/panel.css`
- Test: extend `test/browser-overlay-placement.test.js`

**Interfaces:**
- Consumes: `PanelState.approx/hidden` (Task 4).
- Produces: `renderItem(ann, num, s, unplaced, note?)` — when `note` is set, a `.nit-note` line renders inside the item. Approx rows get their ghost pin number and the note `approximate pin shown at the recorded position`; dialog rows `in dialog “<label>”` (or `in a closed dialog`); not-found rows `couldn't re-find the element`.

- [ ] **Step 1: Write the failing test (extend `browser-overlay-placement.test.js`)**

Append a subtest (same annotations as the pill test — d1 dialog, g1 approx):

```js
  await t.test('panel unplaced rows show the reason and ghost number', async () => {
    const dir = tmpDir('nit-panelreason-');
    const reviewFile = writeReview(dir, server.url, [
      { ...BASE, id: 'd1', comment: 'Dialog button label',
        context: { kind: 'dialog', selector: '#dlg', label: 'Checkout' },
        target: target({ component: 'dialog', selector: '#dlg-save', tag: 'button', text: 'Save order', rect: { x: 100, y: 200, w: 90, h: 30 } }) },
      { ...BASE, id: 'g1', comment: 'Removed banner',
        target: target({ selector: '#never', text: 'NO SUCH TEXT ANYWHERE', component: 'no-such-component', rect: { x: 40, y: 300, w: 200, h: 50 } }) },
    ]);
    S = await startTestSession({ mode: 'view', url: undefined, reviewFile });
    const panel = S.session.panelPage;
    assert.ok(panel, 'panel window opened');

    await waitFor(async () =>
      (await panel.locator('#unplaced-list .nit-item').count()) === 2 ? true : null,
    { message: 'both rows in the unplaced section', timeout: 15000 });
    const d1 = await panel.locator('#unplaced-list .nit-item[data-id="d1"] .nit-note').textContent();
    assert.ok(d1.includes('in dialog “Checkout”'), d1);
    const g1 = await panel.locator('#unplaced-list .nit-item[data-id="g1"] .nit-note').textContent();
    assert.ok(g1.includes('approximate pin shown'), g1);
    await S.session.close();
    S = null;
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && node --test test/browser-overlay-placement.test.js`
Expected: new subtest FAILS (`.nit-note` count 0 / null textContent).

- [ ] **Step 3: Implement**

`src/panel/list.ts` — extend `renderItem`'s signature with `note?: string` (document it: `@param note extra muted line explaining placement (unplaced section)`), and before returning the item element:

```ts
  if (note) {
    const n = document.createElement('div');
    n.className = 'nit-note';
    n.textContent = note;
    el.append(n);
  }
```

(adjust `el` to whatever the item's root variable is called in the file).

`src/panel/main.ts` — after `const unplacedSet = new Set(s.unplaced || []);` add:

```ts
  const approxSet = new Set(s.approx || []);
  const hiddenById = new Map((s.hidden || []).map(h => [h.id, h]));
  // Ghost pins continue the on-page numbering after the placed pins.
  (s.approx || []).forEach((id, i) => placedIndex.set(id, (s.placed || []).length + i + 1));
```

(move this below the existing `placedIndex` setup). Replace the unplaced-section loop:

```ts
  for (const ann of un) ul.append(renderItem(ann, placedIndex.get(ann.id), s, true, placementNote(ann.id, approxSet, hiddenById)));
```

and add:

```ts
/** Why an unplaced-section row isn't (properly) on the page. */
function placementNote(id: string, approxSet: Set<string>, hiddenById: Map<string, HiddenRef>): string {
  if (approxSet.has(id)) return 'approximate pin shown at the recorded position';
  const h = hiddenById.get(id);
  if (h?.reason === 'dialog') return h.label ? `in dialog \u201C${h.label}\u201D` : 'in a closed dialog';
  return 'couldn\u2019t re-find the element';
}
```

Add `HiddenRef` to the panel's `types.js` type import.

`src/panel/panel.css` — near the `.nit-item--unplaced` rule:

```css
.nit-note { font-size: 11px; color: var(--muted); margin-top: 4px; }
```

- [ ] **Step 4: Run the tests**

Run: `npm run build && node --test test/browser-overlay-placement.test.js`
Expected: all subtests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/panel/list.ts src/panel/main.ts src/panel/panel.css test/browser-overlay-placement.test.js
git commit -m "feat(nit): explain unplaced annotations in the panel with placement reasons"
```

---

### Task 10: Docs, full suite, lint

**Files:**
- Modify: `docs/wiki/annotations.md`
- Modify: `docs/wiki/how-it-works.md`

- [ ] **Step 1: Document the schema addition in `docs/wiki/annotations.md`**

In the annotation field reference (follow the file's existing table/section style), add `context` after `target`:

> `context` *(optional)* — where the element lived at capture time. Absent on plain pages. For dialogs: `{ "kind": "dialog", "selector": "#checkout-dialog", "label": "Checkout" }` — `selector` re-finds the dialog container, `label` is its human-readable name (aria-label → aria-labelledby → first heading). Replay uses it to tell "this dialog is closed" apart from "the element is gone", and shows such annotations under the "x hidden" pill instead of dropping them silently.

- [ ] **Step 2: Document the replay behavior in `docs/wiki/how-it-works.md`**

In the replay/anchoring section, add (adapted to the surrounding prose style):

> **Placement states.** On every route the overlay classifies annotations three ways: **placed** (anchored to a live, visible element — numbered pin), **approximate** (element not re-found; a dashed ghost pin marks the originally recorded position, only when the current viewport matches the one it was captured at), and **hidden** (scoped to the other viewport, captured in a dialog that isn't open, or simply gone). Hidden annotations are counted in a small "x hidden" pill next to the nit chip; clicking it lists each one with its reason. Anchoring prefers visible matches, so a hidden desktop-only twin never steals a pin from the rendered mobile markup, and annotations are filtered to the current viewport by default in every mode (the show-all toggle overrides). A MutationObserver re-anchors pins when an SPA re-renders or replaces DOM nodes.

- [ ] **Step 3: Full suite + lint + typecheck**

Run: `npm run build && npm test && npm run lint && npm run typecheck`
Expected: everything green. Fix any lint nits (unused imports etc.) inline.

- [ ] **Step 4: Commit**

```bash
git add docs/wiki/annotations.md docs/wiki/how-it-works.md
git commit -m "docs(nit): document capture context, ghost pins, and the hidden pill"
```

---

## Self-Review (done at plan time)

- **Spec coverage:** data model → T1/T8; dialog detection → T2; visibility-aware anchoring → T3; classification + viewport default + bridge → T4; ghost pins + detached guard → T5; retries all modes + MutationObserver → T6; hidden pill → T7; capture path → T8; panel reasons → T9; docs → T10. Verify contract: untouched by design, guarded by full-suite runs in T4/T6/T7.
- **Type consistency:** `HiddenRef {id, reason, label?}` used identically in types/bridge/panel; `anchorTargetDetailed`/`isElementRendered` names match T3→T4; `createHiddenPill(dock, state, actions)` matches T7's wiring; `renderItem(ann, num, s, unplaced, note?)` matches T9's call.
- **Known judgment calls for the implementer:** exact variable names inside `panel/list.ts`'s `renderItem` and the smoke tests' chip selectors may differ slightly from the plan's assumptions — adapt mechanically, semantics are specified.
