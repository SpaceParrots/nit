# Dialog Opener Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `context.reopen` actually get recorded for dialogs nit can detect, so `nit verify` can click its way back into a modal instead of screenshotting a closed page.

**Architecture:** Three changes. (1) Extract the "is this a dialog surface?" decision into one exported predicate so detection and observation stop using two different definitions. (2) Replace the timed `openSurfaces` before/after diff with a `MutationObserver`-driven watcher that also sees attribute-toggled, permanently-mounted surfaces. (3) Give the opener chain its own storage on the trail so ordinary clicks can no longer evict it.

**Tech Stack:** TypeScript (ESM, `nodenext`), esbuild-bundled overlay running inside the inspected page, Playwright for browser tests, `node:test` for unit tests.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-03-dialog-opener-detection-design.md`. Read it before Task 1.
- **Branch:** `feat/dialog-opener-detection` (already checked out, spec already committed as `d8f3876`).
- **No file-format change.** `CaptureContext.reopen` keeps its shape. Do not touch `src/types.ts`, `src/store/store.ts`, `src/util/history.ts`, or `src/browser/reopen.ts`.
- **`src/capture/context.ts` DOM discipline:** the module may only touch `tagName`, `getAttribute`, `classList.contains`, `parentElement`, `querySelector`, `querySelectorAll`, `textContent`, `getBoundingClientRect`, `contains`, `isConnected`, `ownerDocument.getElementById`, `ownerDocument.body`, `ownerDocument.defaultView.getComputedStyle`. The unit tests fake elements out of exactly that member set. Adding any other member breaks `test/unit-context.test.js`.
- **Attribute names are exactly `data-dialog` and `data-dialog-trigger`** — unprefixed, no `nit`. Both are declared once in `src/capture/context.ts` and imported everywhere else; never spell them as string literals in another file.
- **Build before test.** `npm test` does not run `pretest` in this environment (lifecycle scripts are disabled). Always: `npm run build && node --test test/<file>`.
- **Lint:** `npm run lint` must pass. The repo uses `@stylistic` — 2-space indent, single quotes, semicolons, trailing commas in multiline.
- **Commit style:** Conventional Commits, one line, no co-author trailer.
- **Every exported function gets a doc comment** explaining *why*, not just what — match the density of the surrounding files.

## File Structure

**Created:**
- `src/overlay/surfaces.ts` — owns the `MutationObserver` and the visible-surface set. Exists as its own module because `trail.ts` is already about recording clicks; observing the DOM for surfaces is a separate responsibility with its own unit-testable core.
- `test/unit-surfaces.test.js` — the watcher's pure core against faked elements.
- `test/unit-trail.test.js` — the trail's pure chain functions (there is no existing unit test for `trail.ts`).
- `test/fixtures/nested-dialog.html` — a fixture in the fainin storefront's shape; the regression case.
- `test/browser-dialog-opener.test.js` — end-to-end: pick inside the nested sheet, assert `context.reopen` lands.

**Modified:**
- `src/capture/context.ts` — extract `classify`/`memoLock`, export `isDialogSurface`, `isRendered`, `SURFACE_HINT_SELECTOR`, `DATA_DIALOG`, `DATA_DIALOG_TRIGGER`; teach `isDialogContainer` about `data-dialog`.
- `src/overlay/trail.ts` — chain storage replaces `opened`/`markOpened`/`selectReopenSteps`/`watchForOpening`.
- `src/overlay/state.ts` — `reopenSnapshot` takes a surface.
- `src/overlay/main.ts` — pass the surface through.
- `src/overlay/popover.ts` — pass `dialog.container`.
- `test/unit-context.test.js` — cover `isDialogSurface` and `data-dialog`.
- `docs/wiki/annotations.md`, `src/README.md` — document the attributes. **Correction (during execution):** `test/docs.test.js:61` asserts `src/README.md` lists every module in `src/`, so a minimal, accurate module-tree entry for `surfaces.ts` must land with Task 2, which creates it. Task 6 still owns the final wording of both entries.

---

### Task 1: One predicate, and the `data-dialog` attribute

**Files:**
- Modify: `src/capture/context.ts`
- Test: `test/unit-context.test.js`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `export const DATA_DIALOG = 'data-dialog'`
  - `export const DATA_DIALOG_TRIGGER = 'data-dialog-trigger'`
  - `export function isDialogSurface(n: Element): DialogConfidence | null`
  - `export function isRendered(n: Element): boolean`
  - `export const SURFACE_HINT_SELECTOR: string`
  - unchanged: `detectDialog`, `openSurfaces`, `DialogConfidence`, `DialogContainer`

- [ ] **Step 1: Write the failing tests**

Append to `test/unit-context.test.js`. The `fakeEl` / `fakeDoc` / `overlayEl` helpers already exist at the top of that file — reuse them, do not redefine them.

```js
import { detectDialog, isDialogSurface, isRendered, SURFACE_HINT_SELECTOR } from '../dist/capture/context.js';

test('isDialogSurface: role=dialog is confident', () => {
  const el = fakeEl({ attrs: { role: 'dialog' } });
  fakeDoc({ all: [el] });
  assert.equal(isDialogSurface(el), 'confident');
});

test('isDialogSurface: data-dialog alone is confident, whatever it looks like', () => {
  // Statically positioned, no modal-ish class: every heuristic tier says no.
  const el = fakeEl({ attrs: { 'data-dialog': '' } });
  el.styles = { position: 'static' };
  fakeDoc({ all: [el] });
  assert.equal(isDialogSurface(el), 'confident', 'the attribute outranks the heuristics');
});

test('isDialogSurface: a modal-ish class on an overlay-positioned box is suspected', () => {
  const el = overlayEl({ cls: 'action-sheet', position: 'fixed' });
  fakeDoc({ all: [el] });
  assert.equal(isDialogSurface(el), 'suspected');
});

test('isDialogSurface: a sticky bar on an unlocked page is not a surface', () => {
  const el = overlayEl({ cls: 'sticky-bar', position: 'fixed' });
  fakeDoc({ all: [el], scrolls: false });
  assert.equal(isDialogSurface(el), null);
});

test('detectDialog: a data-dialog ancestor is found and reported confident', () => {
  const surface = fakeEl({ attrs: { 'data-dialog': 'feedback' }, heading: { textContent: 'Bewertung abgeben' } });
  const inner = fakeEl({ parent: surface });
  fakeDoc({ all: [surface, inner] });
  const found = detectDialog(inner);
  assert.equal(found.container, surface);
  assert.equal(found.confidence, 'confident');
  assert.equal(found.label, 'Bewertung abgeben', 'data-dialog value is an identity key, never the label');
});

test('isRendered: an element with no box is not rendered', () => {
  const el = fakeEl();
  el.getBoundingClientRect = () => ({ width: 0, height: 0 });
  assert.equal(isRendered(el), false);
  el.getBoundingClientRect = () => ({ width: 320, height: 200 });
  assert.equal(isRendered(el), true);
});

test('SURFACE_HINT_SELECTOR covers every declared surface and the modal-ish class names', () => {
  for (const part of ['[role=dialog]', '[data-dialog]', '[class*="sheet"]', '[class*="modal"]', '[class*="drawer"]']) {
    assert.ok(SURFACE_HINT_SELECTOR.includes(part), `hint includes ${part}`);
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run build && node --test test/unit-context.test.js
```

Expected: FAIL — `isDialogSurface is not a function` (the import of a missing named export from an ESM module is a link-time error, so the whole file fails to load; that is the expected failure).

- [ ] **Step 3: Implement in `src/capture/context.ts`**

Add the attribute constants above `DIALOG_CLASSES`:

```ts
/**
 * Attributes an app can add so nit needs no heuristics at all. Deliberately
 * unprefixed: a generic name is far likelier to be adopted in real markup than a
 * vendor-prefixed one, and the cost of a collision is one unticked checkbox.
 *
 * `data-dialog` marks the surface; `data-dialog-trigger` marks the control that
 * opens it (read by the overlay's trail, see overlay/trail.ts). A shared value
 * pairs the two, which disambiguates a page with several dialogs.
 */
export const DATA_DIALOG = 'data-dialog';
export const DATA_DIALOG_TRIGGER = 'data-dialog-trigger';
```

Teach `isDialogContainer` about it — put the check first, since it is the cheapest and the most authoritative:

```ts
function isDialogContainer(n: Element): boolean {
  // An explicit declaration by the page author outranks everything below it.
  if (n.getAttribute(DATA_DIALOG) !== null) return true;
  if (n.tagName === 'DIALOG') return true;
  // …rest unchanged…
}
```

Add `[data-dialog]` to `CONFIDENT_SELECTOR` so `openSurfaces` finds declared surfaces, and define the hint next to it so the two can never drift:

```ts
const CONFIDENT_SELECTOR = 'dialog,[role=dialog],[role=alertdialog],[aria-modal=true],[popover],'
  + `[${DATA_DIALOG}],.cdk-overlay-pane,.modal,.offcanvas`;

/**
 * A deliberately over-wide CSS pre-filter for {@link isDialogSurface}. The
 * surface watcher (overlay/surfaces.ts) runs on the page's whole mutation
 * stream, and a framework like Angular rewrites `class` attributes constantly —
 * so `getComputedStyle` must never run on that stream directly. This narrows it
 * to a handful of elements with a pure selector match; the real word-boundary
 * and position tests stay in {@link isDialogSurface}.
 *
 * Substring matches on purpose (`[class*="sheet"]` catches `action-sheet`,
 * `bottom-sheet` and `sheet-open` alike): a hint that misses is a dialog nit
 * never sees, while a hint that over-matches only costs one style read.
 */
export const SURFACE_HINT_SELECTOR = `${CONFIDENT_SELECTOR},`
  + '[class*="modal"],[class*="dialog"],[class*="drawer"],[class*="sheet"],'
  + '[class*="popup"],[class*="lightbox"],[class*="flyout"]';
```

Extract the classifier and the memo that both callers were duplicating inline:

```ts
/**
 * How this one element classifies as a dialog surface, or null when it is not
 * one. The single definition of "dialog surface": {@link detectDialog} asks it
 * per ancestor when the reviewer picks an element, and the surface watcher
 * (overlay/surfaces.ts) asks it per mutation candidate to decide that a dialog
 * has just opened.
 *
 * Those two used to be different tests, and the second was strictly weaker —
 * it only ever looked at declared surfaces and `<body>`'s own children, so a
 * custom modal nested in a component tree was detectable but never observably
 * *opened*, and its annotations got no re-open steps. One exported predicate is
 * what keeps them from drifting apart again.
 */
export function isDialogSurface(n: Element): DialogConfidence | null {
  return classify(n, memoLock(n));
}

/** {@link isDialogSurface} with a scroll-lock check shared across a whole walk. */
function classify(n: Element, scrollLocked: () => boolean): DialogConfidence | null {
  if (isDialogContainer(n)) return 'confident';
  return isSuspectedContainer(n, scrollLocked) ? 'suspected' : null;
}

/**
 * A scroll-lock check evaluated lazily and at most once. It is the same answer
 * for every element in a document, and on a plain page nothing ever asks for it.
 */
function memoLock(el: Element): () => boolean {
  let locked: boolean | null = null;
  return () => locked ??= isScrollLocked(el);
}
```

Rewrite `detectDialog`'s loop to use them (behaviour identical, the inline memo goes away):

```ts
export function detectDialog(el: Element): DialogContainer | null {
  const scrollLocked = memoLock(el);
  let suspected: Element | null = null;
  for (let n: Element | null = el; n?.nodeType === 1; n = n.parentElement) {
    const kind = classify(n, scrollLocked);
    if (kind === 'confident') return { container: n, label: dialogLabel(n), confidence: 'confident' };
    if (kind === 'suspected' && !suspected) suspected = n;
  }
  return suspected ? { container: suspected, label: dialogLabel(suspected), confidence: 'suspected' } : null;
}
```

Rewrite `openSurfaces`'s filter loop the same way:

```ts
  const out: Element[] = [];
  for (const n of candidates) {
    if (!classify(n, memoLock(n))) continue;
    if (isRendered(n)) out.push(n);
  }
  return out;
```

Finally export `isRendered` and give it a doc comment mentioning its second caller:

```ts
/**
 * Whether the element occupies space — an animating-in dialog starts at zero.
 * Shared with the surface watcher, which uses it as the "is it actually on
 * screen now?" half of open/closed.
 */
export function isRendered(n: Element): boolean {
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm run build && node --test test/unit-context.test.js test/browser-capture-context.test.js test/unit-render.test.js
```

Expected: PASS. `browser-capture-context.test.js` is the guard that the refactor of `detectDialog`/`openSurfaces` changed no behaviour.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add src/capture/context.ts test/unit-context.test.js
git commit -m "refactor(capture): one dialog-surface predicate, and a data-dialog attribute"
```

---

### Task 2: The watcher's pure core

**Files:**
- Create: `src/overlay/surfaces.ts`
- Test: `test/unit-surfaces.test.js`

**Interfaces:**
- Consumes: `isDialogSurface`, `isRendered` from `src/capture/context.ts` (Task 1).
- Produces: `export function refreshVisible(candidates: Iterable<Element>, visible: Set<Element>): Element[]`

`MutationObserver` does not exist in Node, so the observer wiring cannot be unit-tested — this task isolates the decision logic that can be. Task 3 adds the wiring and covers it in a browser test.

- [ ] **Step 1: Write the failing test**

Create `test/unit-surfaces.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshVisible } from '../dist/overlay/surfaces.js';

/** A surface the predicate accepts, whose rendered-ness the test can flip. */
function surface({ rendered = true, attrs = { role: 'dialog' } } = {}) {
  const el = {
    nodeType: 1,
    tagName: 'DIV',
    isConnected: true,
    parentElement: null,
    getAttribute: name => (name in attrs ? attrs[name] : null),
    classList: { contains: () => false },
    getBoundingClientRect: () => (rendered ? { width: 400, height: 300 } : { width: 0, height: 0 }),
    ownerDocument: null,
  };
  el.show = v => { rendered = v; };
  return el;
}

/** Something the predicate rejects: a plain box with nothing dialog-ish on it. */
function plain() {
  const el = surface({ attrs: {} });
  el.ownerDocument = { defaultView: { getComputedStyle: () => ({ position: 'static' }) } };
  return el;
}

test('refreshVisible: a newly rendered surface is reported opened, once', () => {
  const visible = new Set();
  const dialog = surface();
  assert.deepEqual(refreshVisible([dialog], visible), [dialog], 'first sight reports it');
  assert.deepEqual(refreshVisible([dialog], visible), [], 'still open is not opening again');
});

test('refreshVisible: a non-surface candidate is ignored', () => {
  const visible = new Set();
  assert.deepEqual(refreshVisible([plain()], visible), []);
  assert.equal(visible.size, 0);
});

test('refreshVisible: a surface that stops rendering is pruned, and re-opening reports again', () => {
  const visible = new Set();
  const dialog = surface();
  refreshVisible([dialog], visible);

  dialog.show(false);
  assert.deepEqual(refreshVisible([], visible), [], 'closing is not an opening');
  assert.equal(visible.size, 0, 'pruned even with no candidates — the idle path keeps the set honest');

  dialog.show(true);
  assert.deepEqual(refreshVisible([dialog], visible), [dialog], 'the same element re-opening is a new opening');
});

test('refreshVisible: a disconnected surface is pruned', () => {
  const visible = new Set();
  const dialog = surface();
  refreshVisible([dialog], visible);
  dialog.isConnected = false;
  dialog.show(false);
  refreshVisible([], visible);
  assert.equal(visible.size, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run build && node --test test/unit-surfaces.test.js
```

Expected: FAIL — `Cannot find module '../dist/overlay/surfaces.js'`.

- [ ] **Step 3: Create `src/overlay/surfaces.ts` with the core only**

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
// Watches the page for dialog surfaces becoming visible, so the click trail can
// tell which click *opened* a dialog rather than guessing from position in the
// trail. Observed, not polled: the surface it most needs to catch is the
// permanently-mounted one that a framework animation merely shows and hides, so
// its element identity never changes and no before/after set diff would ever see
// it appear.
//
// Runs inside the inspected page (bundled into the overlay) on every mutation
// the site makes, so cost discipline is the whole design: a cheap CSS hint
// narrows the mutation stream before the predicate's style reads ever run, and
// the visible set holds a handful of elements at most.
import { isDialogSurface, isRendered } from '../capture/context.js';

/**
 * Reconcile `visible` against the world and return the surfaces that have just
 * become visible. Mutates `visible` in place — it is the caller's long-lived
 * record of what is on screen, not a value.
 *
 * Pruning runs first and runs unconditionally, including on the idle path where
 * `candidates` is empty. That is not an optimisation detail but a correctness
 * one: if a closed surface were left in the set, the *same* element being shown
 * again later would read as "already open" and its opening would never be
 * reported — which is exactly the always-mounted drawer this module exists for.
 * @param candidates elements worth testing (already narrowed by the CSS hint)
 * @param visible the surfaces believed to be on screen, updated in place
 * @returns the newly opened surfaces, in candidate order
 */
export function refreshVisible(candidates: Iterable<Element>, visible: Set<Element>): Element[] {
  for (const el of [...visible]) {
    if (!el.isConnected || !isRendered(el) || !isDialogSurface(el)) visible.delete(el);
  }
  const opened: Element[] = [];
  for (const el of candidates) {
    if (visible.has(el)) continue;
    if (!isDialogSurface(el) || !isRendered(el)) continue;
    visible.add(el);
    opened.push(el);
  }
  return opened;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm run build && node --test test/unit-surfaces.test.js
```

Expected: PASS (4 tests).

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add src/overlay/surfaces.ts test/unit-surfaces.test.js
git commit -m "feat(overlay): surface visibility reconciliation for the click trail"
```

---

### Task 3: The MutationObserver wiring

**Files:**
- Modify: `src/overlay/surfaces.ts`
- Test: covered by the browser test in Task 5 (no `MutationObserver` in Node)

**Interfaces:**
- Consumes: `refreshVisible` (Task 2); `SURFACE_HINT_SELECTOR`, `openSurfaces` from `src/capture/context.ts` (Task 1).
- Produces:
  - `export const OPEN_WINDOW_MS = 1500`
  - `export interface SurfaceWatcher { watch(onOpen: (surface: Element) => void): void }`
  - `export function installSurfaceWatcher(doc: Document): SurfaceWatcher`

- [ ] **Step 1: Add the wiring to `src/overlay/surfaces.ts`**

Append below `refreshVisible`:

```ts
/**
 * How long after a click a surface may take to show up and still be attributed
 * to it. Replaces the two fixed probes (150 ms / 600 ms) the trail used to run:
 * an event-driven watch costs nothing while nothing happens, so the window can
 * be generous enough for a modal that mounts behind a lazy chunk or a data
 * fetch — the old 600 ms ceiling silently lost those.
 */
export const OPEN_WINDOW_MS = 1500;

/**
 * Attributes worth re-testing an element after. `class` and `style` carry the
 * common show/hide (a framework animation writes inline styles; a utility-CSS
 * app toggles a class), the rest are the declared ways an element becomes a
 * dialog after it is already in the tree.
 */
const WATCHED_ATTRS = ['class', 'style', 'hidden', 'open', 'role', 'aria-modal', 'popover', DATA_DIALOG];

/** Watches for dialog surfaces appearing; one instance per page. */
export interface SurfaceWatcher {
  /**
   * Call `onOpen` with the first surface to become visible within
   * {@link OPEN_WINDOW_MS}, at most once. Silent when nothing opens, which is
   * the normal case for almost every click.
   */
  watch(onOpen: (surface: Element) => void): void;
}

/**
 * Install the page's surface watcher: one MutationObserver, one small set of
 * the surfaces currently on screen, seeded from what is already open at install.
 * @param doc the document to watch
 */
export function installSurfaceWatcher(doc: Document): SurfaceWatcher {
  const visible = new Set<Element>(openSurfaces(doc));
  const listeners = new Set<(surface: Element) => void>();

  const observer = new MutationObserver(records => {
    // With nobody watching, only the pruning half runs. Skipping the whole batch
    // would let the set go stale, and a stale entry swallows the next opening of
    // that same element (see refreshVisible).
    const opened = refreshVisible(listeners.size ? candidatesOf(records, doc) : [], visible);
    if (!opened.length) return;
    for (const listener of [...listeners]) {
      listeners.delete(listener);
      listener(opened[0]);
    }
  });
  observer.observe(doc.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: WATCHED_ATTRS,
  });

  return {
    watch(onOpen) {
      listeners.add(onOpen);
      setTimeout(() => listeners.delete(onOpen), OPEN_WINDOW_MS);
    },
  };
}

/**
 * The elements in a mutation batch worth running the predicate on. Attribute
 * records name their element directly; childList records can carry an entire
 * routed page, so the added node is scanned with the CSS hint rather than walked.
 */
function candidatesOf(records: MutationRecord[], doc: Document): Set<Element> {
  const out = new Set<Element>();
  for (const record of records) {
    if (record.type === 'attributes') {
      addHinted(out, record.target, doc);
      continue;
    }
    for (const node of record.addedNodes) addHinted(out, node, doc);
  }
  return out;
}

/**
 * Add `node` and any hinted descendants to `out`. A direct child of `<body>` is
 * always worth testing whatever it looks like: that is where portal-mounted
 * modals land, and they are frequently a bare `<div>` with a generated class.
 */
function addHinted(out: Set<Element>, node: Node, doc: Document): void {
  if (node.nodeType !== 1) return;
  const el = node as Element;
  try {
    if (el.parentElement === doc.body || el.matches(SURFACE_HINT_SELECTOR)) out.add(el);
    for (const n of el.querySelectorAll(SURFACE_HINT_SELECTOR)) out.add(n);
  } catch { /* exotic or detached node — nothing to hint on */ }
}
```

Extend the import at the top of the file:

```ts
import { DATA_DIALOG, SURFACE_HINT_SELECTOR, isDialogSurface, isRendered, openSurfaces } from '../capture/context.js';
```

- [ ] **Step 2: Verify it compiles and nothing regressed**

```bash
npm run build && npm run lint && node --test test/unit-surfaces.test.js
```

Expected: build clean, lint clean, 4 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/overlay/surfaces.ts
git commit -m "feat(overlay): observe dialog surfaces opening instead of polling for them"
```

---

### Task 4: The opener chain

**Files:**
- Modify: `src/overlay/trail.ts`
- Test: `test/unit-trail.test.js` (create)

**Interfaces:**
- Consumes: `MAX_HISTORY`, `MAX_REOPEN_STEPS` from `src/util/history.js`; `ClickStep` from `src/types.js`.
- Produces:
  - `export interface TrailStep extends ClickStep { surface: string | null }` — note `opened` is **removed**
  - `export interface ChainStep { step: TrailStep; surface: Element | null; declared: boolean }`
  - `export interface Trail { page: string; steps: readonly TrailStep[]; chain: readonly ChainStep[] }`
  - `export function emptyTrail(page: string): Trail`
  - `export function appendStep(trail: Trail, step: TrailStep, pathname: string): Trail`
  - `export function openChain(trail: Trail, step: TrailStep, surface: Element | null, declared: boolean): Trail`
  - `export function chainFor(chain: readonly ChainStep[], surface: Element): ClickStep[]`
  - **Deleted:** `markOpened`, `selectReopenSteps`, `TrailStep.opened`

This task changes only the pure functions. `installTrail` is rewired in Task 5, so the build will not typecheck until then — Step 4 below builds with the temporary shim noted.

- [ ] **Step 1: Write the failing test**

Create `test/unit-trail.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
// The trail's pure half: the bounded click window, and the opener chain that
// must survive it. The chain exists because the opener used to live in the same
// ten-entry window as ordinary clicks — a reviewer clicking through a wizard
// modal evicted the click that opened it, and the annotation saved no way back in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyTrail, appendStep, openChain, chainFor } from '../dist/overlay/trail.js';
import { MAX_REOPEN_STEPS } from '../dist/util/history.js';

/** A recorded click. `surface` is the dialog it happened *inside*, null on the page. */
function step(selector, surface = null) {
  return { selector, tag: 'button', component: 'button', text: selector, at: '2026-08-03T10:00:00Z', surface };
}

/** A stand-in for a dialog element; `contains` answers only for its own children. */
function el(children = []) {
  const node = { contains: other => children.includes(other) };
  return node;
}

test('appendStep: the click window is bounded and a pathname change resets it', () => {
  let trail = emptyTrail('/account');
  for (let i = 0; i < 14; i++) trail = appendStep(trail, step(`#b${i}`), '/account');
  assert.equal(trail.steps.length, 10, 'bounded at MAX_HISTORY');
  assert.equal(trail.steps[0].selector, '#b4', 'oldest fall off');

  trail = appendStep(trail, step('#other'), '/product');
  assert.deepEqual(trail.steps.map(s => s.selector), ['#other']);
  assert.deepEqual(trail.chain, [], 'a chain recorded on another page cannot be replayed here');
});

test('openChain: the opener survives clicks that would evict it from the window', () => {
  const sheet = el();
  const opener = step('#open-sheet');
  let trail = emptyTrail('/account');
  trail = appendStep(trail, opener, '/account');
  trail = openChain(trail, opener, sheet, false);

  // The wizard: twenty clicks inside the sheet, far past MAX_HISTORY.
  for (let i = 0; i < 20; i++) {
    const inside = step(`#weiter${i}`, 'div.action-sheet');
    trail = appendStep(trail, inside, '/account');
  }

  assert.equal(trail.steps.some(s => s.selector === '#open-sheet'), false, 'evicted from history, as before');
  assert.deepEqual(chainFor(trail.chain, sheet).map(s => s.selector), ['#open-sheet'], 'but kept in the chain');
});

test('chainFor: a chain that opened another dialog is not offered for this one', () => {
  const other = el();
  const wanted = el();
  const opener = step('#open-other');
  let trail = emptyTrail('/account');
  trail = openChain(trail, opener, other, false);
  assert.deepEqual(chainFor(trail.chain, wanted), [], 'surfaces unrelated — nothing honest to replay');
  assert.deepEqual(chainFor(trail.chain, other).map(s => s.selector), ['#open-other']);
});

test('chainFor: the observed surface may be an ancestor or a descendant of the picked container', () => {
  const inner = el();
  const outer = el([inner]);
  let trail = emptyTrail('/account');
  trail = openChain(trail, step('#open'), outer, false);
  assert.equal(chainFor(trail.chain, inner).length, 1, 'observed container wraps the annotated one');

  trail = emptyTrail('/account');
  trail = openChain(trail, step('#open'), inner, false);
  assert.equal(chainFor(trail.chain, outer).length, 1, 'and the other way round');
});

test('chainFor: a declared trigger is trusted without any observed surface', () => {
  let trail = emptyTrail('/account');
  trail = openChain(trail, step('#open-panel'), null, true);
  assert.deepEqual(chainFor(trail.chain, el()).map(s => s.selector), ['#open-panel']);
});

test('chainFor: an unobserved, undeclared opener is never replayed', () => {
  let trail = emptyTrail('/account');
  trail = openChain(trail, step('#open'), null, false);
  assert.deepEqual(chainFor(trail.chain, el()), []);
});

test('openChain: a click made inside a surface extends the chain, one on the page restarts it', () => {
  const menu = el();
  const dialog = el();
  let trail = emptyTrail('/account');
  trail = openChain(trail, step('#open-menu'), menu, false);
  trail = openChain(trail, step('#menu-item', 'div.menu'), dialog, false);
  assert.deepEqual(chainFor(trail.chain, dialog).map(s => s.selector), ['#open-menu', '#menu-item']);

  trail = openChain(trail, step('#open-elsewhere'), dialog, false);
  assert.deepEqual(chainFor(trail.chain, dialog).map(s => s.selector), ['#open-elsewhere'], 'page click restarts');
});

test('chainFor: past the cap it returns nothing rather than a truncated sequence', () => {
  const dialog = el();
  let trail = emptyTrail('/account');
  trail = openChain(trail, step('#one'), dialog, false);
  for (let i = 0; i < MAX_REOPEN_STEPS; i++) {
    trail = openChain(trail, step(`#nested${i}`, 'div.surface'), dialog, false);
  }
  assert.ok(trail.chain.length > MAX_REOPEN_STEPS);
  assert.deepEqual(chainFor(trail.chain, dialog), [], 'half a way back in is worse than an honest none');
});

test('chainFor: strips the in-memory fields — only ClickStep crosses the bridge', () => {
  const dialog = el();
  let trail = emptyTrail('/account');
  trail = openChain(trail, step('#open'), dialog, false);
  const [only] = chainFor(trail.chain, dialog);
  assert.deepEqual(Object.keys(only).sort(), ['at', 'component', 'selector', 'tag', 'text']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run build && node --test test/unit-trail.test.js
```

Expected: FAIL — `openChain`/`chainFor` are not exported.

- [ ] **Step 3: Rewrite the pure half of `src/overlay/trail.ts`**

Replace the `TrailStep`/`Trail` interfaces and the `emptyTrail` → `toClickStep` block (everything from `export interface TrailStep` down to and including `selectReopenSteps` and `markOpened`) with:

```ts
/**
 * A recorded click plus the surface it happened on. `surface` is in-memory only
 * — {@link toClickStep} strips it before anything crosses the bridge, so the
 * stored `history` shape is unchanged.
 */
export interface TrailStep extends ClickStep {
  /** selector of the dialog-like container the click happened inside, or null on the plain page */
  surface: string | null;
}

/**
 * A click observed (or declared) to have opened a dialog surface.
 *
 * Whether a click opened something is never inferred from its position in the
 * trail: with a non-modal drawer open, a click on the page behind it looks
 * exactly like an opener, and treating it as one made verify replay an arbitrary
 * page click and then report success.
 */
export interface ChainStep {
  step: TrailStep;
  /** the surface seen to appear, or null when the opener was declared rather than observed */
  surface: Element | null;
  /** the click carried `data-dialog-trigger` — the author's word, taken over our heuristics */
  declared: boolean;
}

/** The recorded clicks plus the pathname they belong to. */
export interface Trail {
  /** pathname the steps were recorded on */
  page: string;
  /** oldest first, at most {@link MAX_HISTORY} entries */
  steps: readonly TrailStep[];
  /**
   * The chain of openings that leads into the surface currently on screen:
   * page → menu → dialog, oldest first.
   *
   * Stored apart from {@link steps} rather than derived from them, because
   * `steps` is a rolling window and the opener is the entry a reviewer is most
   * likely to push out of it — clicking through a five-step wizard modal
   * evicted the click that opened the wizard, and the annotation saved no way
   * back in. Ordinary clicks never touch the chain.
   */
  chain: readonly ChainStep[];
}

/** A fresh trail for a pathname. */
export function emptyTrail(page: string): Trail {
  return { page, steps: [], chain: [] };
}

/**
 * Append a click to the trail, returning a new trail (inputs are never mutated).
 * A different pathname starts a fresh trail — query and hash changes arrive as
 * the same pathname, so they keep the trail alive. Oldest entries fall off
 * beyond {@link MAX_HISTORY}; the chain is dropped outright, since clicks
 * recorded on another page cannot be replayed on this one.
 * @param trail the current trail
 * @param step the click to record
 * @param pathname `location.pathname` at click time
 */
export function appendStep(trail: Trail, step: TrailStep, pathname: string): Trail {
  const same = pathname === trail.page;
  return {
    page: pathname,
    steps: [...(same ? trail.steps : []), step].slice(-MAX_HISTORY),
    chain: same ? trail.chain : [],
  };
}

/**
 * Record that a click opened a surface. A click made on the plain page starts a
 * fresh chain; one made from inside a surface extends it, which is how a
 * page → menu → dialog sequence survives intact.
 *
 * Kept one entry longer than {@link MAX_REOPEN_STEPS} on purpose: {@link
 * chainFor} needs to be able to *see* that the chain overran the cap so it can
 * decline it, and a chain silently trimmed to the cap would instead be replayed
 * with its first click missing.
 * @param surface the surface observed to appear, or null for a declared opener
 * @param declared whether the click carried `data-dialog-trigger`
 */
export function openChain(trail: Trail, step: TrailStep, surface: Element | null, declared: boolean): Trail {
  const base = step.surface ? trail.chain : [];
  const chain = [...base, { step, surface, declared }].slice(-(MAX_REOPEN_STEPS + 1));
  return { ...trail, chain };
}

/**
 * The clicks that re-open `surface`, oldest first — or `[]` when the chain does
 * not lead there.
 *
 * The chain is only offered when its last opening is about the surface being
 * annotated: the same page can hold several dialogs, and replaying the opener of
 * a different one would open the wrong thing and still report success. A
 * declared opener skips that check — an author who wrote `data-dialog-trigger`
 * on the button knows something our heuristics do not, which is the entire
 * reason the attribute exists.
 *
 * Returns `[]` rather than a partial sequence when the chain is longer than
 * {@link MAX_REOPEN_STEPS}: a truncated re-open would leave the dialog
 * half-restored while reporting success, and a wrong re-open is worse than an
 * honest "couldn't get back in".
 * @param chain the trail's chain
 * @param surface the dialog container the annotation was captured in
 */
export function chainFor(chain: readonly ChainStep[], surface: Element): ClickStep[] {
  const last = chain[chain.length - 1];
  if (!last) return [];
  if (!last.declared && !relates(last.surface, surface)) return [];
  if (chain.length > MAX_REOPEN_STEPS) return [];
  return chain.map(c => toClickStep(c.step));
}

/** Whether two elements are the same surface: identical, or one inside the other. */
function relates(observed: Element | null, surface: Element): boolean {
  if (!observed) return false;
  if (observed === surface) return true;
  return contains(observed, surface) || contains(surface, observed);
}

function contains(a: Element, b: Element): boolean {
  return typeof a.contains === 'function' && a.contains(b);
}

/** Drop the in-memory `surface` marker — what crosses the bridge is a plain {@link ClickStep}. */
function toClickStep(s: TrailStep): ClickStep {
  return { selector: s.selector, tag: s.tag, component: s.component, text: s.text, at: s.at };
}
```

Update the file's header comment: the second paragraph should now say the trail keeps a separate opener chain rather than selecting one out of the window.

Task 5 rewrites `installTrail`, `describeClick` and `TrailApi`. To keep *this* task's build and lint green in the meantime, make these three deletions and nothing more:

- delete the `opened: false` line (and its comment) from `describeClick`'s return object;
- delete the whole `watchForOpening` function and the `OPEN_PROBES_MS` constant above it;
- in `installTrail`'s click listener, delete the `const before = new Set(openSurfaces(document));` line and the `watchForOpening(before, …)` line, and drop `openSurfaces` from the `../capture/context.js` import.

`installTrail` will record clicks but no openings until Task 5 — that is expected, and `test/browser-trail.test.js` (which only asserts on `history`) still passes.

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm run build && node --test test/unit-trail.test.js
```

Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
npm run lint
git add src/overlay/trail.ts test/unit-trail.test.js
git commit -m "feat(overlay): keep the dialog opener chain out of the evictable click window"
```

---

### Task 5: Wire it up, and the regression test

**Files:**
- Modify: `src/overlay/trail.ts` (`installTrail`), `src/overlay/state.ts`, `src/overlay/main.ts`, `src/overlay/popover.ts`
- Create: `test/fixtures/nested-dialog.html`, `test/browser-dialog-opener.test.js`

**Interfaces:**
- Consumes: `installSurfaceWatcher` (Task 3), `openChain`/`chainFor` (Task 4), `DATA_DIALOG_TRIGGER` (Task 1).
- Produces: `TrailApi.reopenSteps(surface: Element): ClickStep[]`, `OverlayActions.reopenSnapshot: (surface: Element) => ClickStep[]`

- [ ] **Step 1: Write the fixture**

Create `test/fixtures/nested-dialog.html`. The point of every detail here is that the existing `dialog.html` fixture's drawer is a **direct child of `<body>`**, which is exactly why the old code passed its tests while failing on real apps.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Nit nested dialog fixture</title>
<style>
  body { font-family: sans-serif; margin: 0; padding: 20px; }
  .filler { height: 2000px; background: #fafafa; }

  /* The fainin storefront's mobile sheet, reproduced: permanently in the DOM,
     nested inside two custom elements (so it is NOT a child of <body>), no
     role, no aria-modal, and shown by flipping a class on itself rather than by
     being mounted. Nothing the old before/after set diff could ever see. */
  .action-sheet {
    position: fixed; inset: auto 0 0 0; height: 60%; background: #fff;
    border-top: 2px solid #333; padding: 20px; visibility: hidden; opacity: 0;
  }
  .action-sheet.open { visibility: visible; opacity: 1; }

  /* Declared surface: statically positioned with a class no heuristic tier
     recognises, so ONLY data-dialog can make it a surface. */
  .plain-box { position: static; display: none; background: #fff; padding: 20px; }
  .plain-box.open { display: block; }
</style>
</head>
<body>
  <app-root>
    <app-page>
      <h1 id="page-title">Nested dialog fixture</h1>
      <button id="open-sheet" type="button">Feedback geben</button>
      <button id="open-panel" type="button" data-dialog-trigger="panel">Open panel</button>
      <div class="filler"></div>

      <app-sheet>
        <div class="action-sheet" id="sheet">
          <h2>Zustand bei Rückgabe</h2>
          <button class="next" type="button">Weiter</button>
          <span id="sheet-total" style="display:block;width:640px;height:120px">Total: 12,00</span>
        </div>
      </app-sheet>

      <app-panel>
        <div class="plain-box" id="panel" data-dialog="panel">
          <h2>Declared panel</h2>
          <span id="panel-note" style="display:block;width:400px;height:80px">Nothing dialog-ish about me</span>
        </div>
      </app-panel>
    </app-page>
  </app-root>

  <script>
    var sheet = document.getElementById('sheet');
    var panel = document.getElementById('panel');
    document.getElementById('open-sheet').addEventListener('click', function () {
      sheet.classList.add('open');
    });
    document.getElementById('open-panel').addEventListener('click', function () {
      panel.classList.add('open');
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { sheet.classList.remove('open'); panel.classList.remove('open'); }
    });
  </script>
</body>
</html>
```

- [ ] **Step 2: Write the failing browser test**

Create `test/browser-dialog-opener.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
// The regression this whole change exists for: a dialog that is permanently
// mounted, nested inside components rather than parked on <body>, and shown by a
// class flip. detectDialog always found it; nothing ever saw it *open*, so the
// annotation saved no way back in. Recorded reviews of a real Angular app had
// eight such annotations and not one `context.reopen`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureServer } from './helpers/server.js';
import { startTestSession, waitFor, readAnnotations } from './helpers/session.js';

test('nit review — the opener of a nested, class-toggled dialog is recorded', async t => {
  const server = await startFixtureServer();
  const S = await startTestSession({ url: server.url + '/nested-dialog.html' });
  t.after(async () => {
    await S.session.close();
    await server.close();
  });
  const page = S.session.page;

  await waitFor(
    () => page.evaluate(() => Boolean(document.getElementById('nit-root')?.shadowRoot)),
    { message: 'overlay booted' },
  );

  /** Alt-pick `selector`, tick the dialog box if it is not already ticked, save. */
  const annotate = async (selector, comment) => {
    const box = await page.locator(selector).boundingBox();
    await page.keyboard.press('Alt');
    await page.mouse.click(box.x + 5, box.y + 5);
    await page.locator('.nit-pop-comment').fill(comment);
    const check = page.locator('.nit-check input[type=checkbox]');
    await check.waitFor({ timeout: 5000 });
    if (!(await check.isChecked())) await check.check();
    await page.locator('.nit-save').click();
    return waitFor(() => {
      try {
        const d = readAnnotations(S.dir);
        return d.annotations.find(x => x.comment === comment) ?? null;
      } catch { return null; } // annotations.json not written yet
    }, { message: `annotation "${comment}" written` });
  };

  await t.test('the opener survives a wizard that overruns the click window', async () => {
    await page.locator('#open-sheet').click();
    await waitFor(
      () => page.evaluate(() => document.getElementById('sheet').classList.contains('open')),
      { message: 'sheet open' },
    );
    // Twelve in-sheet clicks: more than MAX_HISTORY, so the opener is gone from
    // `history` and can only come from the chain.
    for (let i = 0; i < 12; i++) await page.locator('#sheet .next').click();

    const a = await annotate('#sheet-total', 'total is misaligned in the sheet');
    assert.equal(a.context?.kind, 'dialog', 'saved as a dialog annotation');
    assert.deepEqual(
      a.context.reopen?.map(s => s.selector),
      ['#open-sheet'],
      'the opener is recorded even though it was evicted from history',
    );
    assert.equal(a.context.reopen[0].text, 'Feedback geben');
    assert.equal(
      a.history.some(s => s.selector === '#open-sheet'),
      false,
      'and it really had fallen out of the click window',
    );
  });

  await t.test('a data-dialog-trigger opener is recorded with no heuristics involved', async () => {
    await page.keyboard.press('Escape');
    await page.locator('#open-panel').click();
    await waitFor(
      () => page.evaluate(() => document.getElementById('panel').classList.contains('open')),
      { message: 'panel open' },
    );

    const b = await annotate('#panel-note', 'declared panel copy is wrong');
    assert.equal(b.context?.kind, 'dialog', 'data-dialog alone makes it a dialog surface');
    assert.deepEqual(b.context.reopen?.map(s => s.selector), ['#open-panel']);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npm run build && node --test test/browser-dialog-opener.test.js
```

Expected: FAIL — the first subtest's `assert.deepEqual` on `reopen` gets `undefined`, because `installTrail` still records nothing.

- [ ] **Step 4: Rewrite `installTrail` in `src/overlay/trail.ts`**

Replace `installTrail`, `OPEN_PROBES_MS`, `watchForOpening`, the temporary `void before;` from Task 4, and `TrailApi` with:

```ts
/** What the overlay reads from the live trail (snapshots for the save payload). */
export interface TrailApi {
  /** the current steps, oldest first (already bounded) */
  snapshot(): ClickStep[];
  /**
   * The clicks that re-open the dialog being annotated — see {@link chainFor}.
   * @param surface the dialog container the annotation was captured in
   */
  reopenSteps(surface: Element): ClickStep[];
}

/**
 * Install the trail recorder: a capture-phase click listener that describes each
 * page click with the same primitives annotations use, noting the dialog surface
 * (if any) it happened on, and watching whether a surface opened as a result.
 * Skips picking clicks (they select, they don't interact), clicks inside nit's
 * own UI, and non-Element targets. Review mode only — the caller decides.
 * @param state shared overlay state (read for `picking`)
 * @param host nit's overlay host element (clicks inside it are ignored)
 */
export function installTrail(state: OverlayState, host: HTMLElement): TrailApi {
  let trail = emptyTrail(location.pathname);
  const surfaces = installSurfaceWatcher(document);

  window.addEventListener('click', e => {
    if (state.picking || e.composedPath().includes(host)) return;
    const t = e.composedPath()[0];
    if (!(t instanceof Element)) return;
    const step = describeClick(t);
    trail = appendStep(trail, step, location.pathname);
    // A declared trigger needs no observation at all — which is the point of the
    // attribute. It exists for the surfaces our heuristics cannot see, so making
    // it depend on them would defeat it.
    if (t.closest(`[${DATA_DIALOG_TRIGGER}]`)) {
      trail = openChain(trail, step, null, true);
      return;
    }
    surfaces.watch(surface => { trail = openChain(trail, step, surface, false); });
  }, true);

  /** reset-on-navigate also applies when no click happened since the change */
  const current = (): Trail => {
    if (trail.page !== location.pathname) trail = emptyTrail(location.pathname);
    return trail;
  };

  return {
    snapshot: () => current().steps.map(toClickStep),
    reopenSteps: (surface: Element) => chainFor(current().chain, surface),
  };
}

/** A light element descriptor — enough to find and re-click it, ~200 bytes. */
function describeClick(el: Element): TrailStep {
  // Captured at click time: the dialog may be long gone by the time the reviewer
  // saves, and this is the only moment the ancestry can still be walked.
  const dialog = detectDialog(el);
  return {
    selector: buildSelector(el),
    tag: el.tagName.toLowerCase(),
    component: nearestComponentTag(el),
    text: cleanText(el),
    at: new Date().toISOString(),
    surface: dialog ? buildSelector(dialog.container) : null,
  };
}
```

Fix the imports at the top of the file:

```ts
import { buildSelector, cleanText, nearestComponentTag } from '../capture/target.js';
import { DATA_DIALOG_TRIGGER, detectDialog } from '../capture/context.js';
import { installSurfaceWatcher } from './surfaces.js';
import { MAX_HISTORY, MAX_REOPEN_STEPS } from '../util/history.js';
```

`openSurfaces` is no longer imported here — it is now only used by `surfaces.ts`.

- [ ] **Step 5: Thread the surface through the three call sites**

`src/overlay/state.ts` — change the `reopenSnapshot` member:

```ts
  /** the trail's clicks that re-open the given dialog surface (review mode; empty otherwise) */
  reopenSnapshot: (surface: Element) => ClickStep[];
```

`src/overlay/main.ts` — in the `actions` object:

```ts
    reopenSnapshot: (surface: Element) => trail ? trail.reopenSteps(surface) : [],
```

`src/overlay/popover.ts` — in `save()`, pass the container the popover already detected:

```ts
        const reopen = dialog && inDialog ? actions.reopenSnapshot(dialog.container) : [];
```

- [ ] **Step 6: Run the new test, then the whole suite**

```bash
npm run build && node --test test/browser-dialog-opener.test.js
```

Expected: PASS (both subtests).

```bash
npm run lint && node --test
```

Expected: the full suite PASSES. `test/browser-trail.test.js`, `test/browser-verify-dialog.test.js` and `test/browser-reopen-safety.test.js` are the ones that would catch a regression here; if `browser-verify-dialog.test.js` fails, note that its fixture drawer is a body child and *should* still work — investigate rather than adjusting the test.

- [ ] **Step 7: Commit**

```bash
git add src/overlay/trail.ts src/overlay/state.ts src/overlay/main.ts src/overlay/popover.ts \
  test/fixtures/nested-dialog.html test/browser-dialog-opener.test.js
git commit -m "fix(overlay): record the opener of nested and class-toggled dialogs"
```

---

### Task 6: Document the attributes

**Files:**
- Modify: `docs/wiki/annotations.md`, `src/README.md`
- Test: `node --test test/docs.test.js`

**Interfaces:**
- Consumes: the attribute names from Task 1. No code changes.

- [ ] **Step 1: Add the section to `docs/wiki/annotations.md`**

Read the file first and match its heading level and tone. Add, after the existing dialog/re-open material:

````markdown
## Helping nit find your dialogs

nit detects dialogs on its own: anything with `role="dialog"`, `aria-modal`, a
`<dialog>` element, the HTML popover API, or a known framework class is
recognised outright, and a modal-ish class name on an overlay-positioned box is
offered to you as a checkbox to confirm.

What it cannot always see is the moment a dialog *opens* — which is what lets
`nit verify` click its way back in later. A surface that is detectable only by
its position (fixed or absolute on a scroll-locked page, with no dialog role and
no modal-ish class name, mounted somewhere other than directly under `<body>`)
gets a checkbox but no recorded way back in.

Two optional attributes close that gap:

```html
<button data-dialog-trigger="feedback">Give feedback</button>
…
<div class="action-sheet" data-dialog="feedback">…</div>
```

- **`data-dialog`** on the dialog itself. nit treats it as a dialog with no
  guesswork, so the confirmation box arrives already ticked.
- **`data-dialog-trigger`** on the control that opens it. The click is recorded
  as the way back in without nit having to observe anything — put it on the
  button, not on an icon inside it (a click on a child still counts).

The shared value is optional and only matters when one page has several dialogs
whose openers could otherwise be confused; bare `data-dialog` and
`data-dialog-trigger` work fine.

The names are deliberately generic rather than nit-specific: they describe your
markup, not our tool, and nothing else in nit depends on them.
````

- [ ] **Step 2: Update the module map in `src/README.md`**

The map is an ASCII tree around line 69. Replace the current `trail.ts` entry, whose description still names the deleted functions:

```
│  ├─ trail.ts    # click-history recorder: the last 10 page clicks on this pathname,
│  │              # the dialog surface each happened on, and whether each was
│  │              # observed to OPEN one — snapshotted into the save payload as
│  │              # `history` + `context.reopen` (pure appendStep / markOpened /
│  │              # selectReopenSteps + a DOM shell)
```

with:

```
│  ├─ trail.ts    # click-history recorder: the last 10 page clicks on this pathname,
│  │              # plus a separate opener CHAIN (page → menu → dialog) that ordinary
│  │              # clicks cannot evict — snapshotted into the save payload as
│  │              # `history` + `context.reopen` (pure appendStep / openChain /
│  │              # chainFor + a DOM shell)
│  ├─ surfaces.ts # MutationObserver watch for dialog surfaces becoming visible, so
│  │              # trail.ts knows which click opened one rather than guessing
```

Then check the `capture/context.ts` entry in the same tree: if it describes detection only, extend it to say it also exports the shared `isDialogSurface` predicate the watcher uses.

- [ ] **Step 3: Verify the docs tests still pass**

```bash
node --test test/docs.test.js
```

Expected: PASS.

- [ ] **Step 4: Full suite and commit**

```bash
npm run build && npm run lint && node --test
```

Expected: everything PASSES.

```bash
git add docs/wiki/annotations.md src/README.md
git commit -m "docs: document the data-dialog and data-dialog-trigger attributes"
```

---

## Verification against the original bug

After Task 6, re-run the review that motivated this in the fainin storefront and
confirm a dialog annotation now carries `context.reopen`:

```bash
node -e "const a=require('D:/Fainin/App/fainin-storefront/nit-review/localhost-4201/annotations.json');console.log(a.annotations.filter(x=>x.context?.kind==='dialog').map(x=>[x.id,x.context.reopen?.map(s=>s.text)]))"
```

Old annotations will still show `undefined` — they were captured before this
existed and nothing rewrites them. The check is that a **newly captured**
annotation inside the feedback sheet has a non-empty `reopen`.
