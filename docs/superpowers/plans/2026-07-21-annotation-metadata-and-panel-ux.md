# Annotation Metadata & Panel UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each annotation an issue reference and last-changed stamp, let the panel navigate to the page an annotation was found on, and rebuild the panel as real bundled TypeScript with a logo, icon buttons, and a sort/group dropdown.

**Architecture:** Three optional fields on `Annotation`, written through a single `store.patch()` funnel so every mutation is stamped exactly once. Routes gain query+hash while pin matching stays lenient on the path. Navigation runs in Node (`__nitGoTo`) because only Node owns the site page, gated to the review's own origin. The panel stops being a 290-line HTML string and becomes `src/panel/*.ts` bundled by esbuild — the same pattern `inject.ts` already uses for the overlay — which is what makes its sort/group logic unit-testable.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), Playwright, esbuild, `node:test`, no new runtime dependencies.

## Global Constraints

- Every source file starts with `// SPDX-License-Identifier: AGPL-3.0-or-later`.
- Tests are plain JavaScript in `test/`, run by `node --test`, and import from `../dist/**` — `npm test` builds first via `pretest`. Never import from `src/` in a test.
- Commit messages: Conventional Commits, **one line, no co-author**, pattern `<type>(nit): <description>`.
- No `any` in application code; exported functions carry explicit parameter and return types.
- No new npm dependencies. Lucide icons and the logo are inlined as strings.
- All three new `Annotation` fields are **optional** — existing `annotations.json` files must load unchanged, with no migration step.
- These panel selectors are a test contract and must survive the rebuild: `.nit-item`, `.nit-item[data-id]`, `.nit-item--unplaced`, `.unplaced`, `.nit-pick`, `.nit-filter`, `.nit-vp-desktop`, `.nit-vp-mobile`, `.nit-finish`, `.nit-del`, `.nit-verdict-verified`, `.nit-verdict-reopen`.
- Run `npm run lint` before each commit; it must pass.

---

### Task 1: Annotation metadata fields + `store.patch`

**Files:**
- Modify: `src/types.ts:70-91` (Annotation interface)
- Modify: `src/store/store.ts:21-44` (Store interface), `:65-122` (implementation), `:180-199` (`mergeExternalStatuses`)
- Test: `test/unit-store.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `Annotation.issueRef?: string`, `Annotation.updatedAt?: string`, `Annotation.updatedBy?: string`; `Store.patch(id: string, changes: Partial<Annotation>, by: string): Annotation | null`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit-store.test.js`:

```js
test('store: patch stamps updatedAt/updatedBy and returns the new annotation', () => {
  const dir = tmpDir('nit-store-');
  const store = createStore(dir, { url: 'https://x.test' });
  store.upsert({ id: 'a1', comment: 'hello', status: 'open' });
  store.upsert({ id: 'a2', comment: 'other', status: 'open' });

  const before = store.annotations[0];
  const patched = store.patch('a1', { status: 'fixed' }, 'agent');

  assert.equal(patched.status, 'fixed');
  assert.equal(patched.updatedBy, 'agent');
  assert.match(patched.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(patched.comment, 'hello', 'untouched fields survive');
  assert.notEqual(store.annotations[0], before, 'entry is replaced, not mutated in place');
  assert.equal(store.annotations[1].updatedAt, undefined, 'other annotations untouched');
});

test('store: patch returns null for an unknown id', () => {
  const dir = tmpDir('nit-store-');
  const store = createStore(dir, { url: 'https://x.test' });
  assert.equal(store.patch('nope', { status: 'fixed' }, 'Kevin'), null);
});

test('store: patch with an undefined value clears the field on disk', () => {
  const dir = tmpDir('nit-store-');
  const store = createStore(dir, { url: 'https://x.test' });
  store.upsert({ id: 'a1', comment: 'hello', status: 'open', issueRef: 'FAI-1' });
  store.patch('a1', { issueRef: undefined }, 'Kevin');
  store.flush();

  const written = JSON.parse(fs.readFileSync(path.join(dir, 'annotations.json'), 'utf8'));
  assert.equal('issueRef' in written.annotations[0], false);
});

test('store: flush adopts an external updatedAt/updatedBy with the status it belongs to', () => {
  const dir = tmpDir('nit-store-');
  const store = createStore(dir, { url: 'https://x.test' });
  store.upsert({ id: 'a1', comment: 'hello', status: 'open' });
  store.flush();

  // another writer (an agent via MCP) marks it fixed while we hold the file
  const file = path.join(dir, 'annotations.json');
  const external = JSON.parse(fs.readFileSync(file, 'utf8'));
  external.annotations[0].status = 'fixed';
  external.annotations[0].updatedAt = '2026-07-22T09:00:00.000Z';
  external.annotations[0].updatedBy = 'agent';
  fs.writeFileSync(file, JSON.stringify(external, null, 2));
  fs.utimesSync(file, new Date(Date.now() + 2000), new Date(Date.now() + 2000));

  store.flush();
  assert.equal(store.annotations[0].status, 'fixed');
  assert.equal(store.annotations[0].updatedBy, 'agent');
  assert.equal(store.annotations[0].updatedAt, '2026-07-22T09:00:00.000Z');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="store: patch"`
Expected: FAIL — `store.patch is not a function`.

- [ ] **Step 3: Add the schema fields**

In `src/types.ts`, inside `interface Annotation`, after the `verifiedAt` field:

```ts
  /** free-form issue key or URL: `FAI-1234`, `#87`, `https://…/browse/FAI-1234` */
  issueRef?: string;
  /** ISO timestamp of the last change to this annotation (status, issueRef) */
  updatedAt?: string;
  /** who made that change: the session author, or `agent` via MCP */
  updatedBy?: string;
```

- [ ] **Step 4: Add `patch` to the Store interface**

In `src/store/store.ts`, in `interface Store`, after `upsert`:

```ts
  /**
   * Apply changes to one annotation, stamping `updatedAt`/`updatedBy`. The entry
   * is replaced rather than mutated, so callers holding the old object see no
   * surprise writes. A change value of `undefined` clears that field.
   * @param id annotation id
   * @param changes fields to overwrite
   * @param by who is making the change (session author, or `agent`)
   * @returns the new annotation, or null when the id is unknown
   */
  patch(id: string, changes: Partial<Annotation>, by: string): Annotation | null;
```

- [ ] **Step 5: Implement `patch`**

In `src/store/store.ts`, in the returned object after `upsert`:

```ts
    patch(id: string, changes: Partial<Annotation>, by: string): Annotation | null {
      const i = data.annotations.findIndex(a => a.id === id);
      if (i === -1) return null;
      const next: Annotation = {
        ...data.annotations[i],
        ...changes,
        updatedAt: new Date().toISOString(),
        updatedBy: by,
      };
      data.annotations[i] = next;
      return next;
    },
```

- [ ] **Step 6: Adopt the external stamp in `mergeExternalStatuses`**

In `src/store/store.ts`, replace the body of the `if (localUnchanged)` block:

```ts
    if (localUnchanged) {
      local.status = ext.status;
      if (ext.verifiedAt) local.verifiedAt = ext.verifiedAt;
      // the stamp belongs to the status we just adopted — take it too, or the
      // record would claim our author made the other writer's change
      if (ext.updatedAt) local.updatedAt = ext.updatedAt;
      if (ext.updatedBy) local.updatedBy = ext.updatedBy;
    }
```

- [ ] **Step 7: Run the tests**

Run: `npm test -- --test-name-pattern="store:"`
Expected: PASS, all store tests including the four new ones.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/store/store.ts test/unit-store.test.js
git commit -m "feat(nit): add issueRef/updatedAt/updatedBy and a store.patch mutation funnel"
```

---

### Task 2: Shared route helpers (query + hash)

**Files:**
- Create: `src/util/route.ts`
- Modify: `src/overlay/popover.ts:91`, `src/overlay/main.ts:117-121`, `:134-145`, `:168-186`
- Test: `test/unit-route.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `currentRoute(loc: RouteLocation): string`, `routePath(route: string | undefined): string`, `interface RouteLocation { pathname: string; search: string; hash: string }`. Both the overlay and the panel import these — that is why they live in `src/util/`, not `src/overlay/`.

- [ ] **Step 1: Write the failing test**

Create `test/unit-route.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { currentRoute, routePath } from '../dist/util/route.js';

test('route: currentRoute joins pathname, search and hash', () => {
  assert.equal(currentRoute({ pathname: '/p', search: '?id=5', hash: '#tab' }), '/p?id=5#tab');
  assert.equal(currentRoute({ pathname: '/', search: '', hash: '' }), '/');
});

test('route: routePath strips query and hash', () => {
  assert.equal(routePath('/products?id=5#tab'), '/products');
  assert.equal(routePath('/products#tab'), '/products');
  assert.equal(routePath('/products'), '/products');
});

test('route: routePath defaults empty and query-only values to /', () => {
  assert.equal(routePath(undefined), '/');
  assert.equal(routePath(''), '/');
  assert.equal(routePath('?id=5'), '/');
  assert.equal(routePath('#tab'), '/');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- --test-name-pattern="route:"`
Expected: FAIL — cannot find module `../dist/util/route.js`.

- [ ] **Step 3: Create the module**

Create `src/util/route.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Route helpers shared by the overlay (which captures routes) and the panel
 * (which groups by them). Pure and DOM-free so both sides — and the unit tests —
 * can use them.
 */

/** The parts of `window.location` a route is built from. */
export interface RouteLocation {
  pathname: string;
  search: string;
  hash: string;
}

/**
 * The route recorded on an annotation: path plus query and hash, so a
 * query-driven page (`?id=5`, `#tab`) can be navigated back to exactly.
 * The origin is deliberately excluded — it comes from `review.url`, which is
 * what lets a review captured on staging replay against localhost.
 */
export function currentRoute(loc: RouteLocation): string {
  return `${loc.pathname}${loc.search}${loc.hash}`;
}

/**
 * The pathname portion of a stored route. Pin placement matches on this, so an
 * annotation captured at `/products?id=5` still anchors on `/products` and every
 * review file written before routes carried queries behaves as it always did.
 */
export function routePath(route: string | undefined): string {
  const value = route || '/';
  const cut = value.search(/[?#]/);
  return (cut === -1 ? value : value.slice(0, cut)) || '/';
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -- --test-name-pattern="route:"`
Expected: PASS (3 tests).

- [ ] **Step 5: Capture the full route when saving**

In `src/overlay/popover.ts`, add to the imports:

```ts
import { currentRoute } from '../util/route.js';
```

and replace line 91 (`route: location.pathname,`) with:

```ts
          route: currentRoute(location),
```

- [ ] **Step 6: Match leniently, report fully**

In `src/overlay/main.ts`, add to the imports:

```ts
import { currentRoute, routePath } from '../util/route.js';
```

In `refresh()`, replace lines 117 and 121:

```ts
  const route = location.pathname;
```
becomes
```ts
  const route = location.pathname;
  // matching ignores query/hash: an annotation captured at /p?id=5 still pins on /p
```
and
```ts
    if ((ann.route || '/') !== route) continue;
```
becomes
```ts
    if (routePath(ann.route) !== route) continue;
```

In `emitUi()`, replace `route: location.pathname,` with:

```ts
      route: currentRoute(location),
```

In `installRouteWatcher()`, replace the first three lines of the function body and the guard:

```ts
  let last = currentRoute(location);
  const onMaybeChange = (): void => {
    if (currentRoute(location) === last) return;
    last = currentRoute(location);
```

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS — 76 existing tests plus the 3 new ones. The browser tests exercise SPA route changes and must stay green.

- [ ] **Step 8: Commit**

```bash
git add src/util/route.ts src/overlay/popover.ts src/overlay/main.ts test/unit-route.test.js
git commit -m "feat(nit): record query and hash in annotation routes, match pins on the path"
```

---

### Task 3: `resolveAnnotationUrl` — origin-gated navigation target

**Files:**
- Create: `src/store/url.ts`
- Test: `test/unit-security.test.js` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: `resolveAnnotationUrl(reviewUrl: string, route: string | undefined): string | null`.

**Why this is its own task:** `annotations.json` is shared between people and edited by agents, so `route` is untrusted input. This is the whole security boundary for navigation, and it is pure — it gets tested without a browser.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit-security.test.js`:

```js
import { resolveAnnotationUrl } from '../dist/store/url.js';

test('security: resolveAnnotationUrl resolves a relative route against the review origin', () => {
  assert.equal(
    resolveAnnotationUrl('https://staging.example.com/', '/products?id=5#tab'),
    'https://staging.example.com/products?id=5#tab',
  );
  assert.equal(resolveAnnotationUrl('http://localhost:4200/', '/'), 'http://localhost:4200/');
  assert.equal(resolveAnnotationUrl('http://localhost:4200/x', undefined), 'http://localhost:4200/');
});

test('security: resolveAnnotationUrl rejects routes that escape the review origin', () => {
  const base = 'https://staging.example.com/';
  assert.equal(resolveAnnotationUrl(base, 'https://evil.com/steal'), null, 'absolute other-origin');
  assert.equal(resolveAnnotationUrl(base, '//evil.com/steal'), null, 'protocol-relative');
  assert.equal(resolveAnnotationUrl(base, 'javascript:alert(1)'), null, 'javascript: scheme');
  assert.equal(resolveAnnotationUrl(base, 'data:text/html,<script>1</script>'), null, 'data: scheme');
  assert.equal(resolveAnnotationUrl(base, 'file:///etc/passwd'), null, 'file: scheme');
  assert.equal(resolveAnnotationUrl(base, 'https://staging.example.com.evil.com/'), null, 'suffix lookalike');
});

test('security: resolveAnnotationUrl rejects an unusable review url', () => {
  assert.equal(resolveAnnotationUrl('', '/x'), null);
  assert.equal(resolveAnnotationUrl('not a url', '/x'), null);
  assert.equal(resolveAnnotationUrl('file:///tmp/page.html', '/x'), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --test-name-pattern="resolveAnnotationUrl"`
Expected: FAIL — cannot find module `../dist/store/url.js`.

- [ ] **Step 3: Implement**

Create `src/store/url.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Resolve an annotation's route to a navigable url. Annotation files are shared
 * between people and edited by agents, so `route` is untrusted: a crafted
 * `https://evil.com/`, `//evil.com`, or `javascript:` value must never navigate
 * the reviewer's browser. Everything is resolved against the review's own url and
 * rejected unless it stays on that origin over http(s).
 */

/**
 * @param reviewUrl the site under review (`review.url`)
 * @param route the annotation's stored route
 * @returns the absolute url to navigate to, or null when it is unsafe/unusable
 */
export function resolveAnnotationUrl(reviewUrl: string, route: string | undefined): string | null {
  let base: URL;
  try {
    base = new URL(reviewUrl);
  } catch {
    return null;
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') return null;

  let target: URL;
  try {
    target = new URL(route || '/', base);
  } catch {
    return null;
  }
  // `origin` is 'null' for opaque schemes (javascript:, data:), so a scheme check
  // is not enough on its own — but combined they reject every escape route.
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
  return target.origin === base.origin ? target.href : null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- --test-name-pattern="resolveAnnotationUrl"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/store/url.ts test/unit-security.test.js
git commit -m "feat(nit): resolve annotation routes to origin-gated navigation urls"
```

---

### Task 4: Bridge bindings `__nitGoTo` and `__nitSetIssueRef`

**Files:**
- Modify: `src/types.ts:132-147` (result types), `:206-229` (Window declarations)
- Modify: `src/browser/session.ts:29-58` (NitSession)
- Modify: `src/browser/bridge.ts:148-159` (`__nitVerdict`), and add the two new bindings

**Interfaces:**
- Consumes: `store.patch` (Task 1), `resolveAnnotationUrl` (Task 3).
- Produces: `window.__nitGoTo(id): Promise<BridgeResult<{ url: string }>>`, `window.__nitSetIssueRef(id, ref): Promise<AnnotationResult>`, `NitSession.pendingFocus`, and the type `AnnotationResult`.

- [ ] **Step 1: Add the result types**

In `src/types.ts`, replace the `VerdictResult` line:

```ts
export type VerdictResult = BridgeResult<{ annotation: Annotation }>;
```

with:

```ts
/** Envelope for bindings that return the annotation they changed. */
export type AnnotationResult = BridgeResult<{ annotation: Annotation }>;
/** @deprecated use {@link AnnotationResult} — kept for one version */
export type VerdictResult = AnnotationResult;
export type GoToResult = BridgeResult<{ url: string }>;
```

- [ ] **Step 2: Declare the new bindings**

In `src/types.ts`, inside `declare global { interface Window { … } }`, after `__nitVerdict`:

```ts
    __nitSetIssueRef?: (id: string, ref: string) => Promise<AnnotationResult>;
    __nitGoTo?: (id: string) => Promise<GoToResult>;
```

- [ ] **Step 3: Add `pendingFocus` to the session**

In `src/browser/session.ts`, inside `interface NitSession`, after `uiState`:

```ts
  /**
   * @internal set by `__nitGoTo`: focus this annotation as soon as the overlay
   * reports it placed on the newly loaded page. Expires so a pin that never
   * anchors cannot fire a stale focus on some later page.
   */
  pendingFocus?: { id: string; expiresAt: number } | null;
```

and in the session object literal, after `uiState: {},`:

```ts
    pendingFocus: null,
```

- [ ] **Step 4: Route `__nitVerdict` through `patch`**

In `src/browser/bridge.ts`, replace the body of the `__nitVerdict` binding:

```ts
  await context.exposeBinding('__nitVerdict', guard((source, id: unknown, verdict: unknown) => {
    if (verdict !== 'verified' && verdict !== 'reopened') {
      return { ok: false, error: 'verdict must be "verified" or "reopened"' };
    }
    if (typeof id !== 'string') return { ok: false, error: 'id must be a string' };
    const ann = store.patch(id, { status: verdict, verifiedAt: new Date().toISOString() }, session.author);
    if (!ann) return { ok: false, error: `no annotation ${id}` };
    session.flush();
    session.log(`${verdict === 'verified' ? '+ verified' : '~ reopened'} ${ann.id}`);
    return { ok: true, annotation: ann };
  }));
```

- [ ] **Step 5: Add `__nitSetIssueRef`**

In `src/browser/bridge.ts`, directly after the `__nitVerdict` binding:

```ts
  await context.exposeBinding('__nitSetIssueRef', guard((source, id: unknown, ref: unknown) => {
    if (typeof id !== 'string') return { ok: false, error: 'id must be a string' };
    // free-form text that ends up in review.md and MCP output — bound its length
    const value = typeof ref === 'string' ? ref.trim().slice(0, 200) : '';
    const ann = store.patch(id, { issueRef: value || undefined }, session.author);
    if (!ann) return { ok: false, error: `no annotation ${id}` };
    session.flush();
    session.log(value ? `~ ${id} issue ${value}` : `~ ${id} issue cleared`);
    return { ok: true, annotation: ann };
  }));
```

- [ ] **Step 6: Add `__nitGoTo`**

In `src/browser/bridge.ts`, add the import:

```ts
import { resolveAnnotationUrl } from '../store/url.js';
```

and add the binding after `__nitSetIssueRef`:

```ts
  await context.exposeBinding('__nitGoTo', guard(async (source, id: unknown) => {
    const ann = store.annotations.find(a => a.id === id);
    if (!ann) return { ok: false, error: `no annotation ${String(id)}` };
    const url = resolveAnnotationUrl(store.data.review.url, ann.route);
    if (!url) return { ok: false, error: `route is not on the review origin: ${String(ann.route)}` };
    const page = session.sitePage;
    if (!page) return { ok: false, error: 'no site page' };
    try {
      const target = new URL(url);
      const current = new URL(page.url());
      const samePage = current.pathname === target.pathname && current.search === target.search;
      if (!samePage) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      return { ok: false, error: errorMessage(e) };
    }
    // The overlay has not re-anchored yet; the `ui` event below focuses the pin
    // as soon as it reports this id placed.
    session.pendingFocus = { id: ann.id, expiresAt: Date.now() + 10000 };
    return { ok: true, url };
  }));
```

- [ ] **Step 7: Relay the pending focus from the `ui` event**

In `src/browser/bridge.ts`, inside the `__nitEvent` handler's `else if (type === 'ui')` branch, after the `session.uiState = { … }` assignment and before the `if (session.mode === 'verify')` block:

```ts
      const pending = session.pendingFocus;
      if (pending) {
        if (Date.now() > pending.expiresAt) {
          session.pendingFocus = null;
        } else if ((session.uiState.placed ?? []).some(p => p.id === pending.id)) {
          session.pendingFocus = null;
          await source.page
            .evaluate(fid => window.__nitOverlay?.cmd({ cmd: 'focus', id: fid }), pending.id)
            .catch(() => {});
        }
      }
```

- [ ] **Step 8: Build and run the suite**

Run: `npm test`
Expected: PASS — nothing consumes the new bindings yet, so this proves no regression. `npm run lint` must also pass.

- [ ] **Step 9: Commit**

```bash
git add src/types.ts src/browser/session.ts src/browser/bridge.ts
git commit -m "feat(nit): add __nitGoTo and __nitSetIssueRef bridge bindings"
```

---

### Task 5: Surface the metadata in `review.md` and the agent contract

**Files:**
- Modify: `src/store/render.ts:22-40` (annotation block), `:53-68` (`FIX_ANNOTATIONS_MD`)
- Test: `test/unit-render.test.js`

**Interfaces:**
- Consumes: `Annotation.issueRef`, `Annotation.updatedAt`, `Annotation.updatedBy` (Task 1).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit-render.test.js`:

```js
test('render: issue key renders as code, issue url renders as a link', () => {
  const md = renderReviewMd({
    review: { id: 'r', url: 'https://x.test', createdAt: '2026-07-21T00:00:00Z', authors: ['Kevin'] },
    annotations: [
      { id: 'a1', type: 'change-request', status: 'open', comment: 'key', author: 'Kevin',
        route: '/', target: {}, createdAt: '2026-07-21T00:00:00Z', issueRef: 'FAI-1234' },
      { id: 'a2', type: 'change-request', status: 'open', comment: 'url', author: 'Kevin',
        route: '/', target: {}, createdAt: '2026-07-21T00:00:00Z',
        issueRef: 'https://jira.test/browse/FAI-9' },
    ],
  });
  assert.match(md, /- issue: `FAI-1234`/);
  assert.match(md, /- issue: \[https:\/\/jira\.test\/browse\/FAI-9\]\(https:\/\/jira\.test\/browse\/FAI-9\)/);
});

test('render: updated stamp is shown, and the line is omitted when there is nothing to show', () => {
  const base = { review: { id: 'r', url: 'https://x.test', createdAt: '2026-07-21T00:00:00Z', authors: [] } };
  const withStamp = renderReviewMd({
    ...base,
    annotations: [{ id: 'a1', type: 'change-request', status: 'fixed', comment: 'c', author: 'Kevin',
      route: '/', target: {}, createdAt: '2026-07-21T00:00:00Z',
      updatedAt: '2026-07-22T09:00:00Z', updatedBy: 'agent' }],
  });
  assert.match(withStamp, /updated 2026-07-22 by agent/);

  const without = renderReviewMd({
    ...base,
    annotations: [{ id: 'a1', type: 'change-request', status: 'open', comment: 'c', author: 'Kevin',
      route: '/', target: {}, createdAt: '2026-07-21T00:00:00Z' }],
  });
  assert.equal(/- issue:|updated /.test(without), false);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- --test-name-pattern="render: (issue|updated)"`
Expected: FAIL — the strings are not in the output.

- [ ] **Step 3: Render the new line**

In `src/store/render.ts`, after the existing `- route: …` push inside the annotation loop:

```ts
    const extra: string[] = [];
    if (a.issueRef) extra.push(`issue: ${issueMd(a.issueRef)}`);
    if (a.updatedAt) extra.push(`updated ${a.updatedAt.slice(0, 10)}${a.updatedBy ? ` by ${a.updatedBy}` : ''}`);
    if (extra.length) lines.push(`- ${extra.join(' · ')}`);
```

and add the helper next to `oneLine`:

```ts
/** A tracker url becomes a link; anything else stays inline code. */
function issueMd(ref: string): string {
  return /^https?:\/\//i.test(ref) ? `[${ref}](${ref})` : `\`${ref}\``;
}
```

- [ ] **Step 4: Extend the agent contract**

In `src/store/render.ts`, append to the `FIX_ANNOTATIONS_MD` template, before the closing backtick:

```
Optional metadata: if you file or resolve a tracker issue for a nit, record its key or url in that
annotation's \`issueRef\`. Do not hand-edit \`updatedAt\`/\`updatedBy\` — nit stamps them whenever a
status or issue reference changes.
```

- [ ] **Step 5: Run the tests**

Run: `npm test -- --test-name-pattern="render:"`
Expected: PASS, all render tests.

- [ ] **Step 6: Commit**

```bash
git add src/store/render.ts test/unit-render.test.js
git commit -m "feat(nit): surface issueRef and update stamps in review.md"
```

---

### Task 6: MCP tool surface

**Files:**
- Modify: `src/mcp/server.ts:44-87` (TOOLS), `:157-190` (dispatch + list), `:211-224` (setStatus)
- Test: `test/mcp.test.js`

**Interfaces:**
- Consumes: `store.patch` (Task 1), `routePath` (Task 2).
- Produces: MCP tool `set_issue_ref { id, ref }`.

- [ ] **Step 1: Write the failing tests**

Append to `test/mcp.test.js`, following the request/response helper already used there:

```js
test('mcp: set_issue_ref sets and clears the reference', async () => {
  const { call, dir } = await startFixtureMcp();
  const set = await call('set_issue_ref', { id: 'a1', ref: ' FAI-1234 ' });
  assert.equal(JSON.parse(set.content[0].text).issueRef, 'FAI-1234', 'trimmed and stored');

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'annotations.json'), 'utf8'));
  assert.equal(onDisk.annotations[0].issueRef, 'FAI-1234');
  assert.equal(onDisk.annotations[0].updatedBy, 'agent');

  const cleared = await call('set_issue_ref', { id: 'a1', ref: '' });
  assert.equal(JSON.parse(cleared.content[0].text).issueRef, undefined);
});

test('mcp: set_status stamps updatedBy agent', async () => {
  const { call } = await startFixtureMcp();
  const res = await call('mark_fixed', { id: 'a1' });
  const ann = JSON.parse(res.content[0].text);
  assert.equal(ann.status, 'fixed');
  assert.equal(ann.updatedBy, 'agent');
  assert.match(ann.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('mcp: list_annotations route filter matches the full route and the path', async () => {
  const { call } = await startFixtureMcp({ route: '/products?id=5' });
  const byFull = JSON.parse((await call('list_annotations', { route: '/products?id=5' })).content[0].text);
  const byPath = JSON.parse((await call('list_annotations', { route: '/products' })).content[0].text);
  assert.equal(byFull.total, 1);
  assert.equal(byPath.total, 1, 'path-only filter still finds a query-carrying route');
  assert.equal(byFull.annotations[0].issueRef, undefined, 'summary carries the field');
});
```

Note: reuse the fixture helper already present in `test/mcp.test.js`. If it does not accept per-annotation overrides, extend it with an options argument rather than duplicating it.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- --test-name-pattern="mcp: (set_issue_ref|set_status|list_annotations route)"`
Expected: FAIL — `unknown tool: set_issue_ref`, missing `updatedBy`.

- [ ] **Step 3: Register the tool**

In `src/mcp/server.ts`, append to the `TOOLS` array:

```ts
  {
    name: 'set_issue_ref',
    description: 'Attach a tracker issue key or url to an annotation (empty string clears it).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        ref: { type: 'string' },
      },
      required: ['id', 'ref'],
    },
  },
```

- [ ] **Step 4: Dispatch it and stamp the agent**

In `src/mcp/server.ts`, add the import:

```ts
import { routePath } from '../util/route.js';
```

In `callTool`, add before the unknown-tool return:

```ts
    if (name === 'set_issue_ref') return setIssueRef(store, args);
```

Replace `setStatus` with a version that goes through `patch`, and add `setIssueRef` plus a shared writer:

```ts
function setStatus(store: Store, { id, status }: Record<string, unknown>): ToolResult {
  if (!isAnnotationStatus(status)) return toolError(`invalid status: ${String(status)}`);
  if (typeof id !== 'string') return toolError('id must be a string');
  const changes: Partial<Annotation> = { status };
  if (status === 'verified' || status === 'reopened') changes.verifiedAt = new Date().toISOString();
  return writeAnnotation(store, id, changes);
}

function setIssueRef(store: Store, { id, ref }: Record<string, unknown>): ToolResult {
  if (typeof id !== 'string') return toolError('id must be a string');
  const value = typeof ref === 'string' ? ref.trim().slice(0, 200) : '';
  return writeAnnotation(store, id, { issueRef: value || undefined });
}

/** Apply a change as the agent, persist, and keep the derived files in sync. */
function writeAnnotation(store: Store, id: string, changes: Partial<Annotation>): ToolResult {
  const ann = store.patch(id, changes, 'agent');
  if (!ann) return toolError(`no annotation with id ${id}`);
  store.flush();
  try {
    fs.writeFileSync(path.join(store.dir, 'review.md'), renderReviewMd(store.data), 'utf8');
    fs.writeFileSync(path.join(store.dir, 'fix-annotations.md'), FIX_ANNOTATIONS_MD, 'utf8');
  } catch { /* best effort */ }
  return text(JSON.stringify(ann, null, 2));
}
```

Add `Annotation` to the type import at the top:

```ts
import type { Annotation, AnnotationStatus } from '../types.js';
```

- [ ] **Step 5: Widen the route filter and the summary**

In `src/mcp/server.ts`, in `listAnnotations`, replace the filter and summary:

```ts
  const all = store.annotations.filter(a =>
    (!status || a.status === status)
    && (!type || a.type === type)
    // routes now carry query strings: accept an exact match or a path-only filter
    && (!route || a.route === route || routePath(a.route) === route));
  const summary = all.map(a => ({
    id: a.id,
    type: a.type,
    status: a.status,
    comment: a.comment,
    route: a.route,
    author: a.author,
    viewportScope: a.viewportScope,
    issueRef: a.issueRef,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    updatedBy: a.updatedBy,
    component: a.target?.component,
    ngComponent: a.target?.ngComponent,
    selector: a.target?.selector,
  }));
```

- [ ] **Step 6: Run the tests**

Run: `npm test -- --test-name-pattern="mcp:"`
Expected: PASS, all MCP tests.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/server.ts test/mcp.test.js
git commit -m "feat(nit): add set_issue_ref MCP tool and agent stamps on status writes"
```

---

### Task 7: Panel assets — logo and icons

**Files:**
- Create: `scripts/gen-logo.mjs`, `src/panel/logo.ts` (generated), `src/panel/icons.ts`
- Modify: `package.json` (add the `gen:logo` script)

**Interfaces:**
- Consumes: `assets/nit-32.png`.
- Produces: `NIT_LOGO_DATA_URI: string`, `ICONS: Record<IconName, string>` where `IconName` is `'crosshair' | 'monitor' | 'smartphone' | 'filter' | 'check' | 'trash' | 'externalLink' | 'chevronRight' | 'tag'`.

**Why generated-and-committed:** `assets/` is not in package.json's `files`, and the panel is a `setContent` document with no server behind it — so the logo must be an inlined data URI regardless of packaging. Committing the generated module avoids runtime file IO and works headless and offline.

- [ ] **Step 1: Write the generator**

Create `scripts/gen-logo.mjs`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
// Regenerate src/panel/logo.ts from assets/nit-32.png. Run by hand after the
// logo changes: `npm run gen:logo`.
import fs from 'node:fs';

const SOURCE = 'assets/nit-32.png';
const OUT = 'src/panel/logo.ts';

const base64 = fs.readFileSync(SOURCE).toString('base64');
fs.writeFileSync(OUT, `// SPDX-License-Identifier: AGPL-3.0-or-later
// GENERATED by scripts/gen-logo.mjs from ${SOURCE} — do not edit by hand.
// Inlined because the panel is a setContent document with no server behind it.
export const NIT_LOGO_DATA_URI = 'data:image/png;base64,${base64}';
`);
console.log(`wrote ${OUT} (${base64.length} chars)`);
```

- [ ] **Step 2: Add the npm script and generate**

In `package.json` `scripts`, add:

```json
    "gen:logo": "node scripts/gen-logo.mjs",
```

Run: `npm run gen:logo`
Expected: `wrote src/panel/logo.ts (…)` and the file exists.

- [ ] **Step 3: Write the icon module**

Create `src/panel/icons.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
// Lucide icons (lucide.dev, ISC licensed) inlined as SVG markup — no npm
// dependency and no network request from the panel window.

const svg = (paths: string): string =>
  '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
  + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const ICONS = {
  crosshair: svg('<circle cx="12" cy="12" r="8"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/>'),
  monitor: svg('<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>'),
  smartphone: svg('<rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/>'),
  filter: svg('<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>'),
  check: svg('<polyline points="20 6 9 17 4 12"/>'),
  trash: svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
  externalLink: svg('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>'),
  chevronRight: svg('<polyline points="9 18 15 12 9 6"/>'),
  tag: svg('<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>'),
} as const;

export type IconName = keyof typeof ICONS;
```

- [ ] **Step 4: Verify it compiles**

Run: `npm run build`
Expected: no TypeScript errors; `dist/panel/icons.js` and `dist/panel/logo.js` exist.

- [ ] **Step 5: Commit**

```bash
git add scripts/gen-logo.mjs src/panel/logo.ts src/panel/icons.ts package.json
git commit -m "build(nit): generate the inlined panel logo and add lucide icon markup"
```

---

### Task 8: Sort and group logic (pure)

**Files:**
- Create: `src/panel/filter.ts`
- Test: `test/unit-panel-filter.test.js`

**Interfaces:**
- Consumes: `routePath` (Task 2).
- Produces: `type SortKey = 'page' | 'time' | 'state'`, `type GroupKey = 'none' | 'page' | 'state'`, `interface FilterOptions { sort: SortKey; group: GroupKey }`, `interface AnnotationGroup { key: string; label: string; items: Annotation[] }`, `sortAnnotations(items, sort)`, `groupAnnotations(items, opts, currentRoute)`, `defaultExpanded(groupKey, opts, currentRoute)`, `STATE_ORDER`.

**Why this is a separate task from the panel UI:** this is the only real logic in the panel, and putting it in its own module is what makes it testable — the reason the panel stops being an HTML string at all.

- [ ] **Step 1: Write the failing tests**

Create `test/unit-panel-filter.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { sortAnnotations, groupAnnotations, defaultExpanded } from '../dist/panel/filter.js';

const ann = (id, route, status, createdAt) => ({ id, route, status, createdAt, type: 'change-request' });

const SET = [
  ann('a1', '/products', 'fixed', '2026-07-21T10:00:00Z'),
  ann('a2', '/about', 'open', '2026-07-21T12:00:00Z'),
  ann('a3', '/products?id=5', 'verified', '2026-07-21T11:00:00Z'),
  ann('a4', '/about', 'reopened', '2026-07-21T09:00:00Z'),
];

test('panel filter: time sorts newest first', () => {
  assert.deepEqual(sortAnnotations(SET, 'time').map(a => a.id), ['a2', 'a3', 'a1', 'a4']);
});

test('panel filter: page sorts by path then full route, newest first within a route', () => {
  assert.deepEqual(sortAnnotations(SET, 'page').map(a => a.id), ['a2', 'a4', 'a1', 'a3']);
});

test('panel filter: state sorts actionable first', () => {
  assert.deepEqual(sortAnnotations(SET, 'state').map(a => a.id), ['a2', 'a4', 'a1', 'a3']);
});

test('panel filter: sorting does not mutate the input', () => {
  const input = [...SET];
  sortAnnotations(input, 'time');
  assert.deepEqual(input.map(a => a.id), ['a1', 'a2', 'a3', 'a4']);
});

test('panel filter: group none returns a single unlabelled group', () => {
  const groups = groupAnnotations(SET, { sort: 'time', group: 'none' }, '/about');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, '');
  assert.equal(groups[0].items.length, 4);
});

test('panel filter: group by page puts the current route first', () => {
  const groups = groupAnnotations(SET, { sort: 'time', group: 'page' }, '/products?id=9');
  assert.deepEqual(groups.map(g => g.key), ['/products', '/products?id=5', '/about']);
  assert.deepEqual(groups[2].items.map(a => a.id), ['a2', 'a4'], 'sort applies inside groups');
});

test('panel filter: group by state uses the actionable-first order and skips empty states', () => {
  const groups = groupAnnotations(SET, { sort: 'time', group: 'state' }, '/');
  assert.deepEqual(groups.map(g => g.key), ['open', 'reopened', 'fixed', 'verified']);
});

test('panel filter: only the current route group is expanded by default', () => {
  const opts = { sort: 'time', group: 'page' };
  assert.equal(defaultExpanded('/products?id=5', opts, '/products'), true, 'query difference still matches');
  assert.equal(defaultExpanded('/about', opts, '/products'), false);
  assert.equal(defaultExpanded('open', { sort: 'time', group: 'state' }, '/products'), true);
});

test('panel filter: empty input yields no groups', () => {
  assert.deepEqual(groupAnnotations([], { sort: 'time', group: 'page' }, '/'), []);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- --test-name-pattern="panel filter:"`
Expected: FAIL — cannot find module `../dist/panel/filter.js`.

- [ ] **Step 3: Implement**

Create `src/panel/filter.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure sorting and grouping for the panel list. Kept free of DOM access so it can
// be unit-tested — the reason the panel is bundled TypeScript rather than an
// inline script string.
import { routePath } from '../util/route.js';
import type { Annotation, AnnotationStatus } from '../types.js';

export type SortKey = 'page' | 'time' | 'state';
export type GroupKey = 'none' | 'page' | 'state';

export interface FilterOptions {
  sort: SortKey;
  group: GroupKey;
}

/** One rendered section of the list. `key` is '' for the ungrouped case. */
export interface AnnotationGroup {
  key: string;
  label: string;
  items: Annotation[];
}

/** Actionable first — the order a reviewer works through a list in. */
export const STATE_ORDER: readonly AnnotationStatus[] =
  ['open', 'reopened', 'fixed', 'verified', 'wontfix'];

/**
 * Order annotations by the chosen key. Returns a new array; the input is never
 * mutated (it is the live store array polled from Node).
 */
export function sortAnnotations(items: readonly Annotation[], sort: SortKey): Annotation[] {
  const copy = [...items];
  if (sort === 'page') return copy.sort((a, b) => byRoute(a, b) || byNewest(a, b));
  if (sort === 'state') return copy.sort((a, b) => stateRank(a) - stateRank(b) || byNewest(a, b));
  return copy.sort(byNewest);
}

/**
 * Split annotations into rendered sections, sorted inside each. Groups themselves
 * are ordered by the grouping key — routes alphabetically with the current one
 * first, statuses actionable-first — never by the sort key.
 * @param currentRoute the route the site page is on (`PanelState.route`)
 */
export function groupAnnotations(
  items: readonly Annotation[],
  opts: FilterOptions,
  currentRoute: string,
): AnnotationGroup[] {
  const sorted = sortAnnotations(items, opts.sort);
  if (!sorted.length) return [];
  if (opts.group === 'none') return [{ key: '', label: '', items: sorted }];

  const buckets = new Map<string, Annotation[]>();
  for (const a of sorted) {
    const key = opts.group === 'state' ? a.status : (a.route || '/');
    const bucket = buckets.get(key);
    if (bucket) bucket.push(a);
    else buckets.set(key, [a]);
  }

  const keys = [...buckets.keys()];
  if (opts.group === 'state') {
    keys.sort((a, b) => rankOf(a) - rankOf(b));
  } else {
    const here = routePath(currentRoute);
    keys.sort((a, b) => {
      const aHere = routePath(a) === here;
      const bHere = routePath(b) === here;
      if (aHere !== bHere) return aHere ? -1 : 1;
      return a.localeCompare(b);
    });
  }
  return keys.map(key => ({ key, label: key, items: buckets.get(key) ?? [] }));
}

/**
 * Whether a group starts open. Grouped by page, only the route you are standing
 * on is expanded — that is what makes "Go to page" the way you reach the rest.
 */
export function defaultExpanded(groupKey: string, opts: FilterOptions, currentRoute: string): boolean {
  if (opts.group !== 'page') return true;
  return routePath(groupKey) === routePath(currentRoute);
}

function byNewest(a: Annotation, b: Annotation): number {
  return String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''));
}

function byRoute(a: Annotation, b: Annotation): number {
  return routePath(a.route).localeCompare(routePath(b.route))
    || String(a.route || '/').localeCompare(String(b.route || '/'));
}

function stateRank(a: Annotation): number {
  return rankOf(a.status);
}

function rankOf(status: string): number {
  const i = (STATE_ORDER as readonly string[]).indexOf(status);
  return i === -1 ? STATE_ORDER.length : i;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -- --test-name-pattern="panel filter:"`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/panel/filter.ts test/unit-panel-filter.test.js
git commit -m "feat(nit): add pure sort and group logic for the panel list"
```

---

### Task 9: Extract the panel into a bundled module — pure refactor

**Files:**
- Create: `src/panel/shell.ts`, `src/panel/panel.css`, `src/panel/main.ts`, `src/panel/list.ts`, `src/browser/panel-bundle.ts`
- Modify: `src/browser/panel.ts` (reduce to window management), `package.json` (build script copies `panel.css`)

**Interfaces:**
- Consumes: `ICONS`, `NIT_LOGO_DATA_URI` (Task 7); `PanelState`, `PanelCmd` from `src/types.ts`.
- Produces: `PANEL_HTML: string`, `buildPanelBundle(): Promise<string>`, `openPanel(context, sitePage, session): Promise<Page>` (unchanged signature).

**This task changes no behaviour.** Same layout, same classes, same interactions as today — only the delivery mechanism changes. The existing browser tests are the proof; they must pass untouched.

- [ ] **Step 1: Verify the baseline is green**

Run: `npm test -- test/browser-view.test.js test/browser-verify.test.js test/browser-smoke.test.js`
Expected: PASS. Record that these are the tests which must still pass at the end of this task.

- [ ] **Step 2: Move the styles into a real stylesheet**

Create `src/panel/panel.css` with the exact contents of the current `<style>` block in `src/browser/panel.ts:50-99` (from `:root {` through `.unplaced .nit-item { margin-bottom: 6px; }`), unchanged.

- [ ] **Step 3: Move the markup into a shell module**

Create `src/panel/shell.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
// The panel document shell: everything static. The interactive parts are built by
// the bundled panel script (src/panel/main.ts), which is injected after this loads.

/** The panel window's initial HTML (no script tag — the bundle is added after). */
export const PANEL_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>nit panel</title>
</head>
<body>
<header><span class="logo">nit</span><span class="mode" id="mode"></span></header>
<div class="controls">
  <button id="pick" class="btn nit-pick">Pick element (Alt)</button>
  <div class="vp">
    <button class="btn nit-vp-desktop" data-vp="desktop">Desktop</button>
    <button class="btn nit-vp-mobile" data-vp="mobile">Mobile</button>
  </div>
  <button id="filter" class="btn nit-filter"></button>
  <button id="finish" class="btn nit-finish">Finish review</button>
</div>
<div id="list" class="list"></div>
<div id="unplaced" class="unplaced" hidden>
  <div class="unplaced-head" id="unplaced-head"></div>
  <div id="unplaced-list"></div>
</div>
</body>
</html>`;
```

- [ ] **Step 4: Port the script to TypeScript**

Create `src/panel/list.ts` holding `item()`, `appendShot()`, `span()` and `line()` from the current inline script, typed against `Annotation` and `PanelState`, exported. Create `src/panel/main.ts` holding the boot, `call()`, `tick()`, `render()` and the CSS injection:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
// The nit panel UI. Bundled by esbuild (iife) and injected into the panel window
// after its shell document loads — the same pattern inject.ts uses for the overlay.
import css from './panel.css';
import { renderItem } from './list.js';
import type { PanelState } from '../types.js';

const TICK_MS = 600;

const style = document.createElement('style');
style.textContent = css;
document.head.append(style);

// …the current inline script's logic, unchanged in behaviour, typed…
```

Keep the port faithful: the same `expandedId`/`lastKey`/`shotCache` state, the same `setInterval(tick, TICK_MS)`, the same class names and text. `window.__nitPanelFocus` is still installed here. Escaped sequences that existed only because the script lived inside a template literal (`\\u00d7`, `\\u2713`, `\\u21ba`) become plain characters (`×`, `✓`, `↺`).

Two porting details that strict TypeScript forces, and which later tasks depend on:

```ts
/** Typed query helper — the panel owns its own markup, so the cast is safe. */
const $ = <T extends HTMLElement = HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;

/** The item renderer, exported from list.ts and used by main.ts (and Task 11's groups). */
export function renderItem(
  ann: Annotation,
  num: number | undefined,
  s: PanelState,
  unplaced: boolean,
): HTMLElement;
```

The old inline `call(name, arg)` helper cannot keep its dynamic `window[name]` indexing under
strict TypeScript. Replace it with one typed sender, which later tasks call as `call({ cmd: … })`:

```ts
/** Send a command to the overlay through Node; a dead bridge is not an error. */
function call(c: PanelCmd): void {
  try { void window.__nitPanelCmd?.(c); } catch { /* bridge gone */ }
}
```

- [ ] **Step 5: Add the bundler**

Create `src/browser/panel-bundle.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
// Bundle the panel UI with esbuild, mirroring inject.ts's overlay bundle.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

// Compiled panel entry next to this file (dist/panel/main.js at runtime);
// panel.css is copied there by the build so esbuild can inline it.
const PANEL_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'panel', 'main.js');

let cachedBundle: string | null = null;

/** Build the panel script once per process and cache it. */
export async function buildPanelBundle(): Promise<string> {
  if (!cachedBundle) {
    const result = await esbuild.build({
      entryPoints: [PANEL_ENTRY],
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      target: 'es2020',
      loader: { '.css': 'text' },
      legalComments: 'none',
    });
    cachedBundle = result.outputFiles[0].text;
  }
  return cachedBundle;
}
```

- [ ] **Step 6: Reduce `panel.ts` to window management**

Replace `src/browser/panel.ts` entirely:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
// The nit panel: a separate popup window (devtools-style, docked next to the browser
// window) hosting the annotation list and session controls. It is our own page, so it
// never overlays or competes with the site under review — important on mobile viewports.
// The UI itself lives in src/panel and is injected as a bundle.
import type { BrowserContext, Page } from 'playwright';
import { PANEL_HTML } from '../panel/shell.js';
import { buildPanelBundle } from './panel-bundle.js';
import type { NitSession } from './session.js';

/**
 * Open the panel as a popup window docked next to the browser window and load
 * its UI. The popup approach (vs. a tab) is what gives nit a devtools-like layout
 * without overlaying the site under review.
 * @param context the session's browser context
 * @param sitePage the page under review (opens the popup, provides window geometry)
 * @param session the live session; `session.panelPage` is cleared when the user closes the panel
 * @returns the panel page
 */
export async function openPanel(context: BrowserContext, sitePage: Page, session: NitSession): Promise<Page> {
  const [panel] = await Promise.all([
    context.waitForEvent('page', { timeout: 8000 }),
    sitePage.evaluate(() => {
      window.open(
        'about:blank',
        'nit-panel',
        `width=360,height=${Math.max(600, window.outerHeight || 900)},`
        + `left=${(window.screenX || 0) + (window.outerWidth || 1200) + 8},top=${window.screenY || 0}`,
      );
    }),
  ]);
  await panel.setViewportSize({ width: 344, height: 860 }).catch(() => {});
  await panel.setContent(PANEL_HTML, { waitUntil: 'domcontentloaded' });
  await panel.addScriptTag({ content: await buildPanelBundle() });
  panel.on('close', () => {
    if (session.panelPage === panel) session.panelPage = null;
  });
  return panel;
}
```

- [ ] **Step 7: Copy the stylesheet in the build**

In `package.json`, replace the `build` script:

```json
    "build": "tsc -p tsconfig.json && node -e \"const f=require('node:fs');f.cpSync('src/overlay/overlay.css','dist/overlay/overlay.css');f.cpSync('src/panel/panel.css','dist/panel/panel.css')\"",
```

- [ ] **Step 8: Verify no behaviour changed**

Run: `npm test`
Expected: PASS — every test, unchanged. `browser-view`, `browser-verify` and `browser-smoke` drive the panel through its class names and are the real proof this refactor is invisible.

Run: `npm run lint`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add src/panel src/browser/panel.ts src/browser/panel-bundle.ts package.json
git commit -m "refactor(nit): build the panel UI from bundled TypeScript instead of an inline string"
```

---

### Task 10: Panel layout — logo, icon toolbar, pinned footer

**Files:**
- Modify: `src/panel/shell.ts`, `src/panel/panel.css`, `src/panel/main.ts`
- Modify: `test/browser-view.test.js:104` (the `.nit-filter` interaction moves)

**Interfaces:**
- Consumes: `ICONS`, `NIT_LOGO_DATA_URI` (Task 7).
- Produces: the DOM ids `#filter-btn`, `#filter-menu`, `#count`; class `.nit-filter-btn`. The contract classes from Global Constraints all survive.

- [ ] **Step 1: Rebuild the shell markup**

Replace the `<body>` of `PANEL_HTML` in `src/panel/shell.ts` (import `ICONS` and `NIT_LOGO_DATA_URI` at the top):

```ts
<body>
<header>
  <img class="logo-img" src="${NIT_LOGO_DATA_URI}" alt="" width="18" height="18">
  <span class="logo">nit</span>
  <span class="mode" id="mode"></span>
</header>
<div class="controls">
  <button id="pick" class="btn nit-pick" title="Pick an element (Alt)">${ICONS.crosshair}<span id="pick-label">Pick element</span></button>
  <div class="vp">
    <button class="btn icon-btn nit-vp-desktop" data-vp="desktop" title="Desktop viewport" aria-label="Desktop viewport">${ICONS.monitor}</button>
    <button class="btn icon-btn nit-vp-mobile" data-vp="mobile" title="Mobile viewport" aria-label="Mobile viewport">${ICONS.smartphone}</button>
    <button class="btn icon-btn nit-filter-btn" id="filter-btn" title="Sort, group and filter" aria-label="Sort, group and filter" aria-expanded="false">${ICONS.filter}</button>
  </div>
  <div class="menu" id="filter-menu" hidden></div>
</div>
<div id="list" class="list"></div>
<div id="unplaced" class="unplaced" hidden>
  <div class="unplaced-head" id="unplaced-head"></div>
  <div id="unplaced-list"></div>
</div>
<footer>
  <div class="count" id="count"></div>
  <button id="finish" class="btn btn-primary nit-finish">${ICONS.check}Finish review</button>
</footer>
</body>
```

- [ ] **Step 2: Style the new chrome**

In `src/panel/panel.css`, change `body` to reserve the footer and add:

```css
  header { display: flex; align-items: center; gap: 7px; padding: 10px 14px; border-bottom: 1px solid var(--border); }
  .logo-img { display: block; border-radius: 4px; }
  .mode {
    margin-left: auto; font-size: 10px; color: var(--muted); text-transform: uppercase;
    letter-spacing: 0.06em; border: 1px solid var(--border); border-radius: 999px; padding: 2px 7px;
  }
  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    background: #2a2a2e; color: var(--fg); border: 1px solid var(--border);
    border-radius: 6px; font-size: 12px; padding: 7px 10px; cursor: pointer;
    transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
  }
  .btn:hover { background: #33333a; border-color: var(--muted); }
  .btn:active { transform: translateY(1px); }
  .btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .btn[disabled] { opacity: 0.4; cursor: default; transform: none; }
  .btn[disabled]:hover { background: #2a2a2e; border-color: var(--border); }
  .btn-primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); font-weight: 600; }
  .btn-primary:hover { background: #ffd633; border-color: #ffd633; }
  .icon-btn { padding: 7px; }
  .ico { width: 14px; height: 14px; flex: none; }
  footer { border-top: 1px solid var(--border); padding: 10px 14px; display: flex; flex-direction: column; gap: 6px; }
  footer .btn { width: 100%; }
  .count { font-size: 11px; color: var(--muted); }
  .menu {
    position: absolute; right: 12px; top: 92px; z-index: 10; width: 210px;
    background: #26262a; border: 1px solid var(--border); border-radius: 8px;
    padding: 8px; display: flex; flex-direction: column; gap: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  }
  .menu-head { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
  .menu-row { display: flex; gap: 4px; }
  .menu-row .btn { flex: 1; padding: 5px 6px; font-size: 11px; }
  .menu label { display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; }
  .menu hr { border: none; border-top: 1px solid var(--border); margin: 0; }
```

- [ ] **Step 3: Wire the new controls in `main.ts`**

The pick button keeps class `.nit-pick` and now updates `#pick-label` rather than its whole text content. The viewport buttons are unchanged apart from being icon-only. `#finish` keeps `.nit-finish`. Replace the old `$('#filter')` handler with a `#filter-btn` toggle that shows/hides `#filter-menu` and mirrors `aria-expanded`. In `render()`, set `#count`:

```ts
  const actionable = s.annotations.filter(
    a => a.type === 'change-request' && (a.status === 'open' || a.status === 'reopened'),
  ).length;
  $('#count').textContent = `${s.annotations.length} annotation${s.annotations.length === 1 ? '' : 's'} · ${actionable} actionable`;
```

and replace the old `$('#filter')` label/active lines (the menu owns that state now — Task 11 fills the menu in; for this task it renders empty and the scope toggle temporarily stays reachable through `.nit-filter` inside it).

- [ ] **Step 4: Move the scope toggle into the menu**

In `main.ts`, build the menu contents with a scope checkbox that keeps the contract class:

```ts
  filterMenu.innerHTML = '';
  const scope = document.createElement('label');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.className = 'nit-filter';
  box.checked = !s.showAll;
  box.addEventListener('change', () => { call({ cmd: 'toggleShowAll' }); lastKey = ''; });
  scope.append(box, document.createTextNode(`Only general + ${s.viewportMode}`));
  filterMenu.append(scope);
```

- [ ] **Step 5: Update the test that clicked the old filter button**

In `test/browser-view.test.js`, replace the scope-toggle interaction (line 104):

```js
    // the scope filter now lives in the filter dropdown
    await panel.locator('.nit-filter-btn').click();
    await panel.locator('.nit-filter').click();
    await waitFor(async () => (await page.locator('.nit-pin').count()) === 2 ? true : null, { message: 'all pins (a4 still anchorable)' });
```

- [ ] **Step 6: Run the suite**

Run: `npm test`
Expected: PASS. If `browser-verify` fails on clicking `.nit-item[data-id="a1"]`, that is a real regression in this task — the items must still render and expand.

- [ ] **Step 7: Commit**

```bash
git add src/panel test/browser-view.test.js
git commit -m "feat(nit): rebuild the panel chrome with the logo, icon buttons and a pinned footer"
```

---

### Task 11: Filter dropdown — sorting and collapsible groups

**Files:**
- Modify: `src/panel/main.ts`, `src/panel/list.ts`, `src/panel/panel.css`
- Test: `test/browser-panel.test.js` (create)

**Interfaces:**
- Consumes: `sortAnnotations`, `groupAnnotations`, `defaultExpanded`, `FilterOptions` (Task 8); `ICONS.chevronRight` (Task 7).
- Produces: classes `.nit-group`, `.nit-group-head`, `.nit-group--collapsed`, `.nit-sort[data-sort]`, `.nit-group-by[data-group]`.

- [ ] **Step 1: Hold the local UI state**

In `src/panel/main.ts`, next to `expandedId`:

```ts
let opts: FilterOptions = { sort: 'time', group: 'page' };
/** group keys the user has explicitly toggled away from their default */
const toggledGroups = new Set<string>();
let menuOpen = false;
/** the last state we rendered — lets a menu interaction repaint without waiting a tick */
let lastState: PanelState | null = null;
```

Set `lastState = s;` as the first line of `render(s)`. Every menu callback below repaints with
`if (lastState) render(lastState);`.

and include them in the render diff key so local changes actually repaint:

```ts
    const key = JSON.stringify([s, expandedId, opts, [...toggledGroups], menuOpen]);
```

- [ ] **Step 2: Guard the render pass**

In `tick()`, before comparing keys:

```ts
    // A wholesale repaint mid-typing would steal the caret from the issue input and
    // close the dropdown. Skip; the next tick after focus leaves picks the state up.
    const active = document.activeElement;
    if (menuOpen || (active && active.tagName === 'INPUT')) return;
```

- [ ] **Step 3: Fill the dropdown**

In `main.ts`, extend the menu builder from Task 10 with sort and group rows above the scope checkbox:

```ts
  const sortRow = radioRow('Sort', 'nit-sort', 'sort',
    [['time', 'Time'], ['page', 'Page'], ['state', 'State']], opts.sort, v => {
      opts = { ...opts, sort: v as SortKey };
      lastKey = '';
      if (lastState) render(lastState);
    });
  const groupRow = radioRow('Group by', 'nit-group-by', 'group',
    [['none', 'None'], ['page', 'Page'], ['state', 'State']], opts.group, v => {
      opts = { ...opts, group: v as GroupKey };
      toggledGroups.clear();
      lastKey = '';
      if (lastState) render(lastState);
    });
  filterMenu.append(sortRow, hr(), groupRow, hr(), scope);
```

with the helper:

```ts
/** A labelled row of mutually exclusive buttons. */
function radioRow(
  title: string,
  cls: string,
  dataKey: string,
  choices: ReadonlyArray<readonly [string, string]>,
  active: string,
  onPick: (value: string) => void,
): HTMLElement {
  const wrap = document.createElement('div');
  const head = document.createElement('div');
  head.className = 'menu-head';
  head.textContent = title;
  const row = document.createElement('div');
  row.className = 'menu-row';
  for (const [value, label] of choices) {
    const b = document.createElement('button');
    b.className = `btn ${cls}`;
    b.dataset[dataKey] = value;
    b.textContent = label;
    b.classList.toggle('active', value === active);
    b.addEventListener('click', () => onPick(value));
    row.append(b);
  }
  wrap.append(head, row);
  return wrap;
}
```

- [ ] **Step 4: Close the dropdown on outside click and Escape**

```ts
  document.addEventListener('click', e => {
    if (!menuOpen) return;
    const t = e.target;
    if (t instanceof Node && (filterMenu.contains(t) || filterBtn.contains(t))) return;
    setMenuOpen(false);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && menuOpen) setMenuOpen(false);
  });
```

- [ ] **Step 5: Render groups**

In `render()`, replace the flat `for (const ann of listed)` loop:

```ts
    const groups = groupAnnotations(listed, opts, s.route || '/');
    for (const g of groups) {
      if (!g.key) {
        for (const ann of g.items) list.append(renderItem(ann, placedIndex.get(ann.id), s, false));
        continue;
      }
      const open = toggledGroups.has(g.key)
        ? !defaultExpanded(g.key, opts, s.route || '/')
        : defaultExpanded(g.key, opts, s.route || '/');
      const section = document.createElement('div');
      section.className = 'nit-group' + (open ? '' : ' nit-group--collapsed');
      section.dataset.group = g.key;
      const head = document.createElement('button');
      head.className = 'nit-group-head';
      head.innerHTML = ICONS.chevronRight;
      head.append(document.createTextNode(`${g.label} (${g.items.length})`));
      head.addEventListener('click', () => {
        if (toggledGroups.has(g.key)) toggledGroups.delete(g.key);
        else toggledGroups.add(g.key);
        lastKey = '';
        render(s);
      });
      section.append(head);
      if (open) for (const ann of g.items) section.append(renderItem(ann, placedIndex.get(ann.id), s, false));
      list.append(section);
    }
```

- [ ] **Step 6: Style the groups**

Append to `src/panel/panel.css`:

```css
  .nit-group { display: flex; flex-direction: column; gap: 6px; }
  .nit-group-head {
    display: flex; align-items: center; gap: 5px; width: 100%;
    background: none; border: none; color: var(--muted); cursor: pointer;
    font-size: 11px; font-weight: 600; padding: 4px 2px; text-align: left;
    transition: color 0.12s ease;
  }
  .nit-group-head:hover { color: var(--fg); }
  .nit-group-head:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .nit-group-head .ico { width: 12px; height: 12px; transition: transform 0.12s ease; transform: rotate(90deg); }
  .nit-group--collapsed .nit-group-head .ico { transform: rotate(0deg); }
```

- [ ] **Step 7: Write the integration test**

Create `test/browser-panel.test.js`, modelled on `test/browser-view.test.js` (same fixture server, `startTestSession({ mode: 'view', reviewFile })`, annotations on `/` and `/about`):

```js
await t.test('groups by page with the current route expanded and others collapsed', async () => {
  const panel = S.session.panelPage;
  await waitFor(async () => (await panel.locator('.nit-group').count()) >= 2 ? true : null,
    { message: 'two route groups' });
  const first = panel.locator('.nit-group').first();
  assert.equal(await first.getAttribute('data-group'), '/', 'current route first');
  assert.equal(await first.locator('.nit-item').count() > 0, true, 'current route expanded');
  const other = panel.locator('.nit-group[data-group="/about"]');
  assert.equal(await other.locator('.nit-item').count(), 0, 'other routes collapsed');
});

await t.test('a group header toggles its items', async () => {
  const panel = S.session.panelPage;
  await panel.locator('.nit-group[data-group="/about"] .nit-group-head').click();
  await waitFor(async () => (await panel.locator('.nit-group[data-group="/about"] .nit-item').count()) === 1
    ? true : null, { message: 'about group expands' });
});

await t.test('switching group to none flattens the list', async () => {
  const panel = S.session.panelPage;
  await panel.locator('.nit-filter-btn').click();
  await panel.locator('.nit-group-by[data-group="none"]').click();
  await waitFor(async () => (await panel.locator('.nit-group').count()) === 0 ? true : null,
    { message: 'no group sections' });
});
```

- [ ] **Step 8: Run the suite**

Run: `npm test`
Expected: PASS, including the new `browser-panel` tests.

- [ ] **Step 9: Commit**

```bash
git add src/panel test/browser-panel.test.js
git commit -m "feat(nit): add a filter dropdown with sorting and collapsible groups to the panel"
```

---

### Task 12: Expanded item — timestamps, issue ref, Go to page

**Files:**
- Modify: `src/panel/list.ts`, `src/panel/panel.css`
- Modify: `test/browser-panel.test.js`

**Interfaces:**
- Consumes: `window.__nitSetIssueRef`, `window.__nitGoTo` (Task 4); `ICONS.tag`, `ICONS.externalLink` (Task 7); `routePath` (Task 2).
- Produces: classes `.nit-issue`, `.nit-goto`, `.nit-issue-chip`.

- [ ] **Step 1: Add the metadata line**

In `src/panel/list.ts`, inside the expanded `meta` block, replace the first `line(...)` call with:

```ts
      meta.append(
        line(`${ann.id} · ${ann.status} · scope ${ann.viewportScope}`),
        line(stamps(ann)),
      );
```

and add:

```ts
/** "created 2026-07-21 14:22 · updated 2026-07-22 09:01 by Kevin" */
function stamps(ann: Annotation): string {
  const parts = [`created ${shortTime(ann.createdAt)}`];
  if (ann.updatedAt) {
    parts.push(`updated ${shortTime(ann.updatedAt)}${ann.updatedBy ? ` by ${ann.updatedBy}` : ''}`);
  }
  return parts.join(' · ');
}

/** ISO timestamp → `2026-07-21 14:22` in local time; the raw value if unparseable. */
function shortTime(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
```

- [ ] **Step 2: Add the issue-ref input**

In the expanded block, after the stamps line:

```ts
      const issueRow = document.createElement('div');
      issueRow.className = 'issue-row';
      issueRow.innerHTML = ICONS.tag;
      const input = document.createElement('input');
      input.className = 'nit-issue';
      input.type = 'text';
      input.placeholder = 'issue ref';
      input.value = ann.issueRef ?? '';
      const commit = (): void => {
        if (input.value.trim() === (ann.issueRef ?? '')) return;
        void window.__nitSetIssueRef?.(ann.id, input.value);
      };
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { input.value = ann.issueRef ?? ''; input.blur(); }
      });
      input.addEventListener('blur', commit);
      input.addEventListener('click', e => e.stopPropagation());
      issueRow.append(input);
      meta.append(issueRow);
```

- [ ] **Step 3: Add the Go-to-page button**

```ts
      const goto = document.createElement('button');
      goto.className = 'btn nit-goto';
      goto.innerHTML = ICONS.externalLink;
      goto.append(document.createTextNode(ann.route || '/'));
      goto.title = `Open ${ann.route || '/'}`;
      // `s` is the PanelState argument of renderItem
      goto.disabled = (s.route || '/') === (ann.route || '/');
      goto.addEventListener('click', e => {
        e.stopPropagation();
        void window.__nitGoTo?.(ann.id);
      });
      meta.append(goto);
```

- [ ] **Step 4: Add the collapsed-row chip**

In the item head, after the route chip:

```ts
    if (ann.issueRef) head.append(span('issue-chip nit-issue-chip', ann.issueRef));
```

- [ ] **Step 5: Style them**

Append to `src/panel/panel.css`:

```css
  .issue-row { display: flex; align-items: center; gap: 6px; margin-top: 2px; color: var(--muted); }
  .issue-row .ico { width: 13px; height: 13px; }
  .nit-issue {
    flex: 1; min-width: 0; background: #1c1c1e; color: var(--fg);
    border: 1px solid var(--border); border-radius: 5px; padding: 4px 6px; font: inherit; font-size: 11px;
    transition: border-color 0.12s ease;
  }
  .nit-issue:hover { border-color: var(--muted); }
  .nit-issue:focus { outline: none; border-color: var(--accent); }
  .nit-goto { width: 100%; margin-top: 6px; justify-content: flex-start; font-size: 11px; }
  .issue-chip {
    flex: none; font-size: 9px; font-weight: 600; color: var(--comment);
    border: 1px solid var(--border); border-radius: 4px; padding: 1px 4px; margin-top: 1px;
    max-width: 76px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
```

- [ ] **Step 6: Add the integration tests**

Append to `test/browser-panel.test.js`:

```js
await t.test('setting an issue ref persists to annotations.json', async () => {
  const panel = S.session.panelPage;
  await panel.locator('.nit-item[data-id="a1"]').click();
  await panel.locator('.nit-item[data-id="a1"] .nit-issue').fill('FAI-1234');
  await panel.locator('.nit-item[data-id="a1"] .nit-issue').press('Enter');
  await waitFor(() => {
    const data = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
    const a1 = data.annotations.find(a => a.id === 'a1');
    return a1.issueRef === 'FAI-1234' && a1.updatedAt ? true : null;
  }, { message: 'issue ref written with a stamp' });
});

await t.test('Go to page navigates the site page and focuses the pin', async () => {
  const panel = S.session.panelPage;
  const page = S.session.page;
  await panel.locator('.nit-group[data-group="/about"] .nit-group-head').click();
  await panel.locator('.nit-item[data-id="a3"]').click();
  await panel.locator('.nit-item[data-id="a3"] .nit-goto').click();
  await waitFor(() => page.evaluate(() => location.pathname === '/about'), { message: 'navigated' });
  await waitFor(async () => (await page.locator('.nit-pin').count()) === 1 ? true : null,
    { message: 'pin re-anchored on the new route' });
});

await t.test('Go to page is disabled for an annotation on the current route', async () => {
  const panel = S.session.panelPage;
  await panel.locator('.nit-item[data-id="a3"]').click(); // collapse
  await panel.locator('.nit-item[data-id="a3"]').click(); // expand again, now on /about
  assert.equal(await panel.locator('.nit-item[data-id="a3"] .nit-goto').isDisabled(), true);
});
```

- [ ] **Step 7: Run the suite**

Run: `npm test`
Expected: PASS, everything.

- [ ] **Step 8: Commit**

```bash
git add src/panel test/browser-panel.test.js
git commit -m "feat(nit): show timestamps, edit issue refs and navigate to an annotation's page"
```

---

### Task 13: Documentation

**Files:**
- Modify: `README.md:98-144` (schema sample, MCP tool list, panel description), `src/README.md` (project layout)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Update the annotation sample**

In `README.md`, in the JSON sample, after `"createdAt"`:

```json
  "createdAt": "2026-07-21T02:28:11.550Z",
  "issueRef": "FAI-1234",
  "updatedAt": "2026-07-22T09:01:00.000Z",
  "updatedBy": "agent"
```

- [ ] **Step 2: Update the MCP tool list**

In `README.md`, replace the tools line:

```markdown
Tools: `list_annotations` (filterable, reports the actionable count) · `get_annotation` (full
record — screenshots are returned as images) · `mark_fixed` · `set_status` · `set_issue_ref`.
```

- [ ] **Step 3: Update the reviewing section**

In `README.md`, replace the panel bullet:

```markdown
- The **panel window** next to the browser lists everything, switches desktop ↔ mobile, sorts and
  groups by page, time or state, jumps to the page an annotation was found on, records an issue
  reference, deletes items and finishes the review — nothing overlays the page under review.
```

- [ ] **Step 4: Update the project layout**

In `src/README.md`, add `panel/` next to `overlay/`: the panel UI, bundled by esbuild and injected
into the panel window, with `filter.ts` holding the pure sort/group logic and `logo.ts` generated by
`scripts/gen-logo.mjs`.

- [ ] **Step 5: Verify and commit**

Run: `npm test && npm run lint`
Expected: PASS, clean.

```bash
git add README.md src/README.md
git commit -m "docs(nit): document issue refs, update stamps, and the rebuilt panel"
```

---

## Self-Review

**Spec coverage:** A1→T1, A2→T1, A3→T2, A4→T3+T4, A5→T4, A6→T5+T6, B1→T9, B2→T7, B3→T10, B4→T10, B5→T8+T11, B6→T12, B7→T11 (both mitigations: focus guard in step 2, diff key in step 1). The spec's implementation order maps to tasks 1→13 in sequence.

**Deviation from the spec, deliberate:** the spec placed the route helpers in `src/overlay/route.ts`. They are needed by the panel too (`filter.ts` groups by `routePath`), so they live in `src/util/route.ts`. Same functions, one importable place.

**Type consistency:** `store.patch(id, changes, by)` is defined in T1 and called with that signature in T4 and T6. `resolveAnnotationUrl(reviewUrl, route)` defined T3, called T4. `routePath`/`currentRoute` defined T2, used T2/T6/T8/T12. `ICONS` keys defined T7 (`crosshair`, `monitor`, `smartphone`, `filter`, `check`, `trash`, `externalLink`, `chevronRight`, `tag`) and only those keys are referenced in T10/T11/T12. `groupAnnotations(items, opts, currentRoute)` and `defaultExpanded(groupKey, opts, currentRoute)` defined T8, called T11 with matching arguments. `AnnotationResult` defined T4, used T4.

**Fixed during review:** the `renderItem` signature (`s`, not `state`) is now stated in T9 and used
consistently in T11/T12; `lastState` is declared in T11 rather than referenced out of nowhere; the
`call()` helper is defined once in T9 with the signature T10/T11 use; and the Go-to-page disabled
check is a single route comparison instead of a redundant pair.

**Known follow-up not covered by a task:** `src/panel/list.ts` uses `ICONS.trash` for the delete button; T9 ports the existing `×` character and T10/T12 do not change it. If a subagent wants the trash icon there, it belongs in T10's chrome work — it is cosmetic and optional.
