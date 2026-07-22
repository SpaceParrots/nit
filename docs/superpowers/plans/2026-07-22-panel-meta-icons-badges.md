# Panel Meta Icons + Badges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The expanded annotation detail labels its metadata with color-coded status/scope badges and lucide icon + label rows instead of run-together text lines.

**Architecture:** Six new inlined lucide icons in `src/panel/icons.ts`; `src/panel/list.ts` replaces its `line(...)` meta lines with `badges(ann)` + `metaRow(icon, label, value)` helpers; grid/badge styles in `src/panel/panel.css`. Icon markup is static trusted code; all values stay `textContent`-only (annotations.json is untrusted).

**Tech Stack:** TypeScript strict ESM NodeNext (local imports need `.js`), esbuild-bundled panel window, `node:test` + Playwright browser tests importing from `../dist/**`.

**Spec:** `docs/superpowers/specs/2026-07-22-panel-meta-icons-badges-design.md`

## Global Constraints

- Untrusted annotations.json: never build class names from file data — only the five known statuses (`open`, `fixed`, `verified`, `reopened`, `wontfix`) get a `badge-status--<status>` modifier; unknown statuses keep the neutral base class. Values reach the DOM via `textContent`/`createTextNode` only; `innerHTML` is allowed solely for static `ICONS.*` strings.
- Badge colors: open = `var(--accent)`, fixed = `var(--comment)`, verified = `#34c759`, reopened = `#ff9f0a`, wontfix = muted text on transparent.
- Scope icons: desktop → existing `monitor`, mobile → existing `smartphone`, general → new `globe`; unknown scope falls back to `globe`.
- Keep `line()` (still used by screenshot captions) and the `.sel-code` tokenizer rendering unchanged.
- BUILD GOTCHA: `npm test -- <file>` can SKIP the pretest build. Always `npm run build` explicitly after editing src/ before targeted test runs.
- Commits: Conventional Commits, ONE line, no co-author, scope `(nit)`. `npm run lint` must exit 0 before committing.

---

### Task 1: Badges + icon rows in the expanded detail

**Files:**
- Modify: `D:\Tools\Nit\src\panel\icons.ts` (six new entries in `ICONS`)
- Modify: `D:\Tools\Nit\src\panel\list.ts` (meta block of `renderItem`; new helpers `badges`, `metaRow`, `selectorCode`; remove `stamps`)
- Modify: `D:\Tools\Nit\src\panel\panel.css` (badge + row styles)
- Test: `D:\Tools\Nit\test\browser-panel.test.js` (new subtest; one existing assertion updated)

**Interfaces:**
- Consumes: `ICONS` map (`src/panel/icons.ts`), `tokenizeSelector` (already imported in list.ts), existing `shortTime`.
- Produces: DOM contract for tests: `.meta-badges` holding `.badge-status[data-status]` + `.badge-scope`; `.meta-row` rows each holding `.meta-ico`, `.meta-label`, `.meta-value`; the selector row's `.meta-value` contains the existing `.sel-code`.

- [ ] **Step 1: Write the failing test**

In `test/browser-panel.test.js`, directly after the `'expanded item shows a syntax-highlighted selector'` subtest (a1 is left expanded by it), append:

```js
  await t.test('expanded item labels fields with badges and icon rows', async () => {
    const panel = S.session.panelPage;
    await waitFor(async () => (await panel.locator('.meta-badges').count()) === 1 ? true : null,
      { message: 'badge row appears' });
    const status = panel.locator('.badge-status');
    assert.equal(await status.count(), 1, 'one status badge');
    assert.equal(await status.getAttribute('data-status'), 'open');
    assert.ok((await status.getAttribute('class')).includes('badge-status--open'), 'known status gets modifier');
    const scope = panel.locator('.badge-scope');
    assert.equal(await scope.count(), 1, 'one scope badge');
    assert.equal((await scope.textContent()).trim(), 'general');
    assert.equal(await scope.locator('svg').count(), 1, 'scope badge has an icon');
    const labels = await panel.locator('.meta-row .meta-label').allTextContents();
    assert.deepEqual(labels, ['created', 'component', 'selector', 'id'], 'labeled rows in order (a1 has no updatedAt)');
    assert.equal(await panel.locator('.meta-row .meta-value .sel-code').count(), 1, 'selector row keeps highlighting');
    assert.equal(await panel.locator('.meta-row .meta-value').last().textContent(), 'a1', 'id row shows the id');
    assert.equal(await panel.locator('.meta-row .meta-ico svg').count(), 4, 'every row has an icon');
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build; node --test test/browser-panel.test.js`
Expected: new subtest FAILS (`.meta-badges` never appears); all pre-existing subtests pass.

- [ ] **Step 3: Add the icons**

In `src/panel/icons.ts`, extend `ICONS` (before the closing `} as const;`) with standard lucide paths:

```ts
  clock: svg('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
  pencil: svg('<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>'),
  box: svg('<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>'),
  code: svg('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'),
  hash: svg('<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>'),
  globe: svg('<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>'),
```

- [ ] **Step 4: Implement the rendering**

In `src/panel/list.ts`, replace the meta text lines inside `renderItem` — the block

```ts
    meta.append(
      line(`${ann.id} · ${ann.status} · scope ${ann.viewportScope}`),
      line(stamps(ann)),
      line('component: ' + (ann.target?.component || '?')
        + (ann.target?.ngComponent ? ' (' + ann.target.ngComponent + ')' : '')),
    );
    if (ann.target?.selector) meta.append(selectorLine(ann.target.selector));
```

with:

```ts
    meta.append(badges(ann));
    meta.append(metaRow(ICONS.clock, 'created', shortTime(ann.createdAt)));
    if (ann.updatedAt) {
      meta.append(metaRow(ICONS.pencil, 'updated',
        shortTime(ann.updatedAt) + (ann.updatedBy ? ` by ${ann.updatedBy}` : '')));
    }
    meta.append(metaRow(ICONS.box, 'component', (ann.target?.component || '?')
      + (ann.target?.ngComponent ? ` (${ann.target.ngComponent})` : '')));
    if (ann.target?.selector) meta.append(metaRow(ICONS.code, 'selector', selectorCode(ann.target.selector)));
    meta.append(metaRow(ICONS.hash, 'id', ann.id));
```

Delete the now-unused `stamps()` function. Rename/reshape `selectorLine` into `selectorCode` — it returns only the highlighted `<code>` (the row provides icon + label now):

```ts
/**
 * The highlighted selector value, token by token. Built from `textContent`-only
 * spans — the selector string comes from untrusted annotations.json and must
 * never reach innerHTML.
 */
function selectorCode(sel: string): HTMLElement {
  const code = document.createElement('code');
  code.className = 'sel-code';
  for (const tok of tokenizeSelector(sel)) {
    const s = document.createElement('span');
    s.className = 'sel-' + tok.kind;
    s.textContent = tok.text;
    code.append(s);
  }
  return code;
}
```

Add the two new helpers next to it:

```ts
const KNOWN_STATUSES = new Set(['open', 'fixed', 'verified', 'reopened', 'wontfix']);

/**
 * Status + scope badge row. The status modifier class is only applied for the
 * known status set — class names are never built from unvalidated file data;
 * the visible text itself is textContent and therefore safe verbatim.
 */
function badges(ann: Annotation): HTMLElement {
  const row = document.createElement('div');
  row.className = 'meta-badges';
  const status = document.createElement('span');
  status.className = 'badge-status' + (KNOWN_STATUSES.has(ann.status) ? ` badge-status--${ann.status}` : '');
  status.dataset.status = ann.status;
  status.textContent = ann.status;
  const scope = document.createElement('span');
  scope.className = 'badge-scope';
  scope.innerHTML = ann.viewportScope === 'desktop' ? ICONS.monitor
    : ann.viewportScope === 'mobile' ? ICONS.smartphone : ICONS.globe;
  scope.append(document.createTextNode(ann.viewportScope));
  row.append(status, scope);
  return row;
}

/** One icon + label + value row of the expanded meta block. */
function metaRow(icon: string, label: string, value: string | HTMLElement): HTMLElement {
  const row = document.createElement('div');
  row.className = 'meta-row';
  const ic = document.createElement('span');
  ic.className = 'meta-ico';
  ic.innerHTML = icon; // static trusted ICONS markup only — never file data
  const lab = document.createElement('span');
  lab.className = 'meta-label';
  lab.textContent = label;
  const val = document.createElement('span');
  val.className = 'meta-value';
  if (typeof value === 'string') val.textContent = value;
  else val.append(value);
  row.append(ic, lab, val);
  return row;
}
```

(`line()` stays — screenshot captions still use it. `shortTime` stays unchanged.)

- [ ] **Step 5: Style it**

In `src/panel/panel.css`, after the `.meta-line` rule add:

```css
.meta-badges { display: flex; gap: 5px; align-items: center; }
.badge-status {
  font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
  border: 1px solid var(--border); border-radius: 4px; padding: 2px 5px; color: var(--muted);
}
.badge-status--open { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
.badge-status--fixed { background: var(--comment); border-color: var(--comment); color: var(--accent-fg); }
.badge-status--verified { background: #34c759; border-color: #34c759; color: var(--accent-fg); }
.badge-status--reopened { background: #ff9f0a; border-color: #ff9f0a; color: var(--accent-fg); }
.badge-status--wontfix { color: var(--muted); }
.badge-scope {
  display: inline-flex; align-items: center; gap: 4px; font-size: 9px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted);
  border: 1px solid var(--border); border-radius: 4px; padding: 2px 5px;
}
.badge-scope .ico { width: 11px; height: 11px; }
.meta-row { display: grid; grid-template-columns: 14px 64px 1fr; gap: 6px; align-items: start; font-size: 11px; }
.meta-row .meta-ico { color: var(--muted); display: inline-flex; padding-top: 1px; }
.meta-row .meta-ico .ico { width: 13px; height: 13px; }
.meta-label { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; padding-top: 1px; }
.meta-value { color: var(--fg); overflow-wrap: anywhere; min-width: 0; }
```

- [ ] **Step 6: Run the tests**

Run: `npm run build; node --test test/browser-panel.test.js`
Expected: PASS including the new subtest. If the existing highlighted-selector subtest fails on `.sel-code` lookups, its locators still match (`.sel-code` now lives inside `.meta-value`) — do not weaken its assertions.

- [ ] **Step 7: Changelog**

In `CHANGELOG.md`, append to the existing `## Unreleased` bullet list:

```markdown
- **Labeled annotation details** — the expanded panel item shows a color-coded
  status badge, a scope badge, and icon-labeled rows (created, updated,
  component, selector, id) instead of run-together text lines.
```

- [ ] **Step 8: Full suite, lint, commit**

```powershell
npm run build; npm test
npm run lint
git add src/panel/icons.ts src/panel/list.ts src/panel/panel.css test/browser-panel.test.js CHANGELOG.md
git commit -m "feat(nit): label expanded annotation details with badges and lucide icon rows"
```

Expected: full suite green (184 + 1 new subtest), lint exit 0.

---

## Self-Review Notes

- Spec coverage: badge row → `badges()`; five modifier colors + unknown-status neutral → `KNOWN_STATUSES` + CSS; scope icons incl. globe fallback → ternary in `badges()`; key-value rows/table → `metaRow` calls (updated row conditional on `updatedAt`, selector row conditional, id row always); icons section → Step 3; CSS section → Step 5; testing → Step 1 (screenshot verification is done by the controller after review, per spec "not committed as a test").
- Type consistency: `metaRow(icon: string, label: string, value: string | HTMLElement)` matches all call sites; `selectorCode` replaces `selectorLine` and its only caller is updated in the same step.
