# Multi-base-URL Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one nit review folder hold annotations for several base URLs (local / staging / prod), add `nit list` and `nit clear`, expose the review to agents as one MCP server across all bases, and bind `-v`.

**Architecture:** A review folder becomes a *workspace*: one subfolder per base URL, each subfolder being byte-for-byte today's review folder. A new `store/workspace.ts` sits above the existing store and owns layout detection, the `bases.json` index, base resolution and lazy migration. Nothing under `overlay/`, `panel/`, `anchor/`, `capture/` or `store/store.ts` changes, and `annotations.json` keeps its schema — the `staging:a1` id form exists only at the aggregate boundary (MCP output, `nit list`).

**Tech Stack:** TypeScript strict (NodeNext), commander 15, `@clack/prompts`, `@modelcontextprotocol/sdk`, zod (MCP inputs only), fflate (zip), `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-07-25-multi-base-workspace-design.md`

## Global Constraints

- **Build before testing.** This machine's npm config disables lifecycle scripts, so `pretest` does **not** run. Always `npm run build` before `node --test`. Tests import from `dist/`, never `src/`.
- **Test command:** `npm run build && node --test test/<file>.test.js`. Full suite: `npm run build && node --test`.
- **Every exported symbol gets JSDoc** — a sentence on what it does, `@param` per parameter, `@returns`, and `@throws` where it throws. Match the house style in `src/store/store.ts` and `src/store/stats.ts`, including short "why" comments where a decision is non-obvious.
- **TypeScript strict mode.** Data arriving from disk is typed `unknown` and validated, never cast. `bases.json` is hand-editable and arrives inside zips — treat it exactly as `store.ts` treats `annotations.json`.
- **SECURITY — slugs become path segments.** A slug read from `bases.json` must match `/^[a-z0-9][a-z0-9-]*$/` before it is ever joined into a path, or a crafted `"slug": "../../.ssh"` escapes the workspace. Base slugs surfaced to callers always come from `fs.readdirSync` enumeration or a validated index entry; no code path builds a base directory from raw user or file input.
- **Imports carry `.js` extensions** (`import { x } from '../store/store.js'`) — NodeNext names the emitted file.
- **Immutability.** Resolution and selection return new values. Only `Store` mutates, and only through its existing `patch` / `remove` / `upsert` / `flush` API.
- **File size:** every new module stays well under 400 lines.
- **SPDX header** on every new `.ts` and `.js` file: `// SPDX-License-Identifier: AGPL-3.0-or-later`.
- **Commits:** Conventional Commits, one line, no co-author. `feat` / `fix` / `refactor` / `test` / `docs` / `chore`.
- **Gates:** `npm run lint`, `npm run typecheck` and `npm test` must all pass before the branch is done.

## File Structure

**New:**

| File | Responsibility |
| --- | --- |
| `src/store/workspace.ts` | Layout detection, `bases.json` index, slug derivation, base resolution, id qualification, lazy migration |
| `src/store/derived.ts` | `writeDerivedFiles(store)` — re-render `review.md` + `fix-annotations.md` after a write (shared by MCP tools and clear) |
| `src/store/clear.ts` | Pure selection of what a clear scope matches, plus the clearing operation over one base |
| `src/cli/list.ts` | `nit list`: aggregation, both report shapes, `--json` |
| `src/cli/clear.ts` | `nit clear`: scope validation, confirmation prompt, dry run |
| `src/mcp/aggregate.ts` | Workspace-aware lookup for the MCP layer: base summaries, qualified-id resolution |

**Modified:** `src/cli/index.ts`, `src/cli/source.ts`, `src/cli/status.ts`, `src/cli/export.ts`, `src/cli/import.ts`, `src/cli/doctor.ts`, `src/browser/session.ts`, `src/mcp/server.ts`, `src/mcp/tools.ts`, `src/mcp/schema.ts`, `src/mcp/resources.ts`, `src/types.ts`.

**Untouched:** everything under `src/overlay/`, `src/panel/`, `src/anchor/`, `src/capture/`, plus `src/store/store.ts`, `src/store/render.ts`, `src/store/merge.ts`.

### One simplification against the spec

The spec's `bases.json` sketch carries both a `slug` and an optional `alias`. They collapse: `--base staging` **names the folder** `staging/`, so the alias *is* the slug. `bases.json` holds `slug`, `url`, `createdAt`, `lastSeenAt` — no `alias` field. Resolution rules are unchanged; there is simply one fewer thing to match against.

---

### Task 1: Bind `-v` and pin `-h`

Independent of everything else — land it first for a quick green commit.

**Files:**
- Modify: `src/cli/index.ts:43`
- Test: `test/cli-help.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Write the failing test**

Append to `test/cli-help.test.js`:

```js
test('cli: -v, -V and --version all print the package version', () => {
  const expected = JSON.parse(
    fs.readFileSync(path.join(path.dirname(CLI), '..', '..', 'package.json'), 'utf8'),
  ).version;
  for (const flag of ['-v', '-V', '--version']) {
    const { code, out } = run(flag);
    assert.equal(code, 0, `${flag} exits 0`);
    assert.equal(out.trim(), expected, `${flag} prints ${expected}`);
  }
});

test('cli: -h is help, same as --help', () => {
  const short = run('-h');
  const long = run('--help');
  assert.equal(short.code, 0);
  assert.equal(short.out, long.out);
});
```

`test/cli-help.test.js` already imports `path` and `spawnSync`; add `import fs from 'node:fs';` at the top if it is not there.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/cli-help.test.js`
Expected: FAIL — `-v` exits non-zero with "unknown option '-v'".

- [ ] **Step 3: Write minimal implementation**

In `src/cli/index.ts`, replace line 43 `.version(pkgVersion())` with:

```ts
  // commander binds one short flag per option, so -V (its default) is declared
  // separately from the -v most CLIs use. Both print the same string.
  .version(pkgVersion(), '-v, --version', 'print the nit version')
  .addOption(new Option('-V').hideHelp())
```

Then, immediately after the `program` builder chain ends (before the first `program.command(...)` call), add the `-V` handler:

```ts
// -V is declared hidden above so it stays accepted for scripts written against
// commander's default flag; commander only auto-handles the flag it owns.
program.on('option:V', () => {
  console.log(pkgVersion());
  process.exit(0);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/cli-help.test.js`
Expected: PASS. If `-V` still fails, check whether commander emits `option:V`; if it does not, drop `addOption`/`on` and instead declare the version flags as `'-v, --version'` plus a separate `program.option('-V', 'print the nit version')` handled in a `preAction` hook. Verify against the built binary — do not assume commander's behaviour.

- [ ] **Step 5: Commit**

```bash
git add src/cli/index.ts test/cli-help.test.js
git commit -m "feat(cli): accept -v as an alias for --version"
```

---

### Task 2: Workspace core — slug derivation and id qualification

**Files:**
- Create: `src/store/workspace.ts`
- Test: `test/unit-workspace.test.js`

**Interfaces:**
- Consumes: `slugify` from `src/util/slug.ts`.
- Produces:
  - `baseSlug(url: string): string`
  - `qualifyId(slug: string, id: string): string`
  - `parseQualifiedId(qualified: string): { slug: string | null; id: string }`
  - `SAFE_SLUG: RegExp`
  - `isSafeSlug(value: unknown): value is string`

- [ ] **Step 1: Write the failing test**

Create `test/unit-workspace.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { baseSlug, qualifyId, parseQualifiedId, isSafeSlug } from '../dist/store/workspace.js';

test('workspace: baseSlug derives host + non-default port', () => {
  const cases = [
    ['http://localhost:4200', 'localhost-4200'],
    ['https://staging.example.com', 'staging-example-com'],
    ['https://fainin.dev/', 'fainin-dev'],
    ['https://example.com/deep/path?q=1', 'example-com'],
    ['http://example.com:80/', 'example-com'],      // URL strips default ports
    ['https://example.com:443/', 'example-com'],
    ['http://127.0.0.1:3000', '127-0-0-1-3000'],
    ['not a url', 'review'],                         // unparseable → same fallback as safeHost
    ['', 'review'],
  ];
  for (const [url, expected] of cases) {
    assert.equal(baseSlug(url), expected, url);
  }
});

test('workspace: qualifyId/parseQualifiedId round-trip, splitting on the first colon', () => {
  assert.equal(qualifyId('staging', 'a1'), 'staging:a1');
  assert.deepEqual(parseQualifiedId('staging:a1'), { slug: 'staging', id: 'a1' });
  // a merged base keeps its author namespace intact in the id half
  assert.equal(qualifyId('staging', 'kevin:a1'), 'staging:kevin:a1');
  assert.deepEqual(parseQualifiedId('staging:kevin:a1'), { slug: 'staging', id: 'kevin:a1' });
  // a bare id has no slug half
  assert.deepEqual(parseQualifiedId('a1'), { slug: null, id: 'a1' });
});

test('workspace: isSafeSlug rejects anything that could escape a path', () => {
  for (const ok of ['staging', 'localhost-4200', 'a', '127-0-0-1-3000']) {
    assert.ok(isSafeSlug(ok), ok);
  }
  for (const bad of ['..', '../etc', 'a/b', 'a\\b', '.hidden', '-lead', 'UPPER', 'a b', '', 'a\0b', 42, null, undefined]) {
    assert.ok(!isSafeSlug(bad), String(bad));
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/unit-workspace.test.js`
Expected: FAIL — cannot find module `../dist/store/workspace.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/store/workspace.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A review folder holding more than one base URL — a *workspace*. Each base URL
 * gets a subfolder that is byte-for-byte a normal review folder, so everything
 * below this module (the store, the renderers, the overlay) stays single-review
 * and unchanged. This module owns the layer above: which bases exist, how one is
 * named, how a base-qualified id is read, and how a legacy flat folder becomes a
 * workspace.
 */
import { slugify } from '../util/slug.js';

/**
 * A slug is used as a directory name, so it is validated before it ever reaches
 * `path.join`. `bases.json` is hand-editable and travels inside shared zips: a
 * crafted `"slug": "../../.ssh"` must never resolve to a real path.
 */
export const SAFE_SLUG = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Whether a value is usable as a base slug (and therefore as a path segment).
 * @param value anything read from disk, an argument, or a tool call
 */
export function isSafeSlug(value: unknown): value is string {
  return typeof value === 'string' && SAFE_SLUG.test(value);
}

/**
 * The folder name for a base URL: hostname plus `-<port>` when the port is not
 * the scheme default (the WHATWG URL parser drops default ports for us).
 * @param url the site under review, e.g. `http://localhost:4200`
 * @returns a filesystem-safe slug; `'review'` for input that is not a url
 */
export function baseSlug(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'review';
  }
  if (!parsed.hostname) return 'review';
  return slugify(`${parsed.hostname}${parsed.port ? `-${parsed.port}` : ''}`);
}

/**
 * Namespace an annotation id with its base, for output that spans bases (MCP
 * results, `nit list`). Ids on disk are never rewritten.
 * @param slug the base's slug
 * @param id the annotation's own id, e.g. `a1` or a merged `kevin:a1`
 */
export function qualifyId(slug: string, id: string): string {
  return `${slug}:${id}`;
}

/**
 * Split a qualified id back into base and annotation id. The split is on the
 * **first** colon, so a base produced by `nit merge` keeps its author namespace
 * (`staging:kevin:a1` → base `staging`, id `kevin:a1`).
 *
 * A returned `slug` is a *candidate*: on a single-base workspace a bare merged
 * id (`kevin:a1`) parses as slug `kevin`, which resolves to no base. Callers
 * must fall back to treating the whole string as an id — see
 * `findAnnotation` in `src/mcp/aggregate.ts`.
 * @param qualified the id as it arrived from a caller
 */
export function parseQualifiedId(qualified: string): { slug: string | null; id: string } {
  const i = qualified.indexOf(':');
  if (i === -1) return { slug: null, id: qualified };
  return { slug: qualified.slice(0, i), id: qualified.slice(i + 1) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/unit-workspace.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/store/workspace.ts test/unit-workspace.test.js
git commit -m "feat(store): base slugs and qualified annotation ids"
```

---

### Task 3: Workspace core — layout detection and the self-healing index

**Files:**
- Modify: `src/store/workspace.ts`
- Modify: `src/types.ts` (additive workspace types)
- Test: `test/unit-workspace.test.js`

**Interfaces:**
- Consumes: `baseSlug`, `isSafeSlug` (Task 2).
- Produces:
  - `WorkspaceLayout = 'empty' | 'flat' | 'multi'`
  - `BaseRef { slug, url, dir, file, createdAt?, lastSeenAt? }`
  - `Workspace { dir, layout, bases: BaseRef[] }`
  - `openWorkspace(dir: string): Workspace`

- [ ] **Step 1: Write the failing test**

Append to `test/unit-workspace.test.js` (add `import fs from 'node:fs'; import path from 'node:path'; import { tmpDir } from './helpers/tmp.js';` at the top, and `openWorkspace` to the import from `workspace.js`):

```js
/** Write a review folder at `dir` with the given url and annotation ids. */
function writeReview(dir, url, ids = []) {
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'annotations.json'), JSON.stringify({
    review: { id: 'fixture', url, createdAt: '2026-07-20T10:00:00Z', authors: ['Kevin'] },
    annotations: ids.map(id => ({
      id, type: 'change-request', comment: `c ${id}`, status: 'open', author: 'Kevin',
      viewportScope: 'general', viewport: { mode: 'desktop', w: 1440, h: 900 }, route: '/',
      target: { component: 'div', ngComponent: null, selector: '.x', xpath: '/html[1]', tag: 'div', classes: [], text: '', rect: { x: 0, y: 0, w: 1, h: 1 } },
      screenshot: null, createdAt: '2026-07-20T10:01:00Z',
    })),
  }, null, 2));
}

test('workspace: an empty dir has no bases', () => {
  const ws = openWorkspace(tmpDir('nit-ws-'));
  assert.equal(ws.layout, 'empty');
  assert.deepEqual(ws.bases, []);
});

test('workspace: a flat review folder is one base, slug from its own review.url', () => {
  const dir = tmpDir('nit-ws-');
  writeReview(dir, 'https://fainin.dev/', ['a1']);
  const ws = openWorkspace(dir);
  assert.equal(ws.layout, 'flat');
  assert.equal(ws.bases.length, 1);
  assert.equal(ws.bases[0].slug, 'fainin-dev');
  assert.equal(ws.bases[0].url, 'https://fainin.dev/');
  assert.equal(ws.bases[0].dir, dir);
  assert.equal(ws.bases[0].file, path.join(dir, 'annotations.json'));
});

test('workspace: subfolders with annotations.json are bases, listed or not', () => {
  const dir = tmpDir('nit-ws-');
  writeReview(path.join(dir, 'staging'), 'https://staging.example.com', ['a1']);
  writeReview(path.join(dir, 'localhost-4200'), 'http://localhost:4200', ['a1', 'a2']);
  // index mentions only one of them, and one that no longer exists
  fs.writeFileSync(path.join(dir, 'bases.json'), JSON.stringify({
    version: 1,
    bases: [
      { slug: 'staging', url: 'https://staging.example.com', createdAt: '2026-07-25T09:00:00Z' },
      { slug: 'gone', url: 'https://gone.example.com' },
    ],
  }));
  const ws = openWorkspace(dir);
  assert.equal(ws.layout, 'multi');
  assert.deepEqual(ws.bases.map(b => b.slug), ['localhost-4200', 'staging']); // sorted, stale entry dropped
  assert.equal(ws.bases[1].createdAt, '2026-07-25T09:00:00Z');               // index metadata adopted
  assert.equal(ws.bases[0].url, 'http://localhost:4200');                    // unlisted folder adopted
});

test('workspace: a malformed bases.json is ignored, not fatal', () => {
  const dir = tmpDir('nit-ws-');
  writeReview(path.join(dir, 'staging'), 'https://staging.example.com', ['a1']);
  fs.writeFileSync(path.join(dir, 'bases.json'), '{ this is not json');
  const ws = openWorkspace(dir);
  assert.equal(ws.layout, 'multi');
  assert.deepEqual(ws.bases.map(b => b.slug), ['staging']);
});

test('workspace: an unsafe slug in bases.json never becomes a path', () => {
  const dir = tmpDir('nit-ws-');
  writeReview(path.join(dir, 'staging'), 'https://staging.example.com', ['a1']);
  fs.writeFileSync(path.join(dir, 'bases.json'), JSON.stringify({
    version: 1,
    bases: [{ slug: '../../escape', url: 'https://evil.test' }],
  }));
  const ws = openWorkspace(dir);
  assert.deepEqual(ws.bases.map(b => b.slug), ['staging']);
  for (const b of ws.bases) assert.ok(b.dir.startsWith(dir), 'every base stays inside the workspace');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/unit-workspace.test.js`
Expected: FAIL — `openWorkspace is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/types.ts` (append, additive only — the annotation schema is untouched):

```ts
// ---------------------------------------------------------------------------
// Workspace: a review folder holding one review folder per base URL.
// ---------------------------------------------------------------------------

/** Where a workspace's annotations live: nowhere, one flat review, or per-base subfolders. */
export type WorkspaceLayout = 'empty' | 'flat' | 'multi';

/** One base URL inside a workspace, and the review folder that holds it. */
export interface BaseRef {
  /** folder name inside the workspace; also what `--base` and qualified ids name */
  slug: string;
  /** the site under review for this base, from its own `review.url` */
  url: string;
  /** absolute path of the base's review folder */
  dir: string;
  /** absolute path of its annotations.json */
  file: string;
  /** ISO timestamp the base was registered (from bases.json, when known) */
  createdAt?: string;
  /** ISO timestamp of the last session against this base (from bases.json) */
  lastSeenAt?: string;
}

/** A review folder read as a workspace. */
export interface Workspace {
  /** absolute path of the workspace directory */
  dir: string;
  layout: WorkspaceLayout;
  /** every base found, slug-sorted; empty for a fresh folder */
  bases: BaseRef[];
}
```

Add to `src/store/workspace.ts` (imports first: `import fs from 'node:fs'; import path from 'node:path'; import type { BaseRef, ReviewData, Workspace, WorkspaceLayout } from '../types.js';` and re-export the types: `export type { BaseRef, Workspace, WorkspaceLayout };`):

```ts
/** The file that records slugs, their urls and when they were last used. */
export const BASES_FILE = 'bases.json';

/** One validated entry from bases.json. */
interface IndexEntry {
  slug: string;
  url: string;
  createdAt?: string;
  lastSeenAt?: string;
}

/**
 * Read a review folder as a workspace.
 *
 * `bases.json` is an *index*, never the source of truth: a subfolder holding an
 * annotations.json is a base whether or not it is listed (it is adopted, taking
 * its url from its own `review.url`), and an entry naming a folder that is gone
 * is ignored. That keeps a workspace working after a `git clone`, an unzip, or a
 * hand-edit — the same tolerance the store applies to annotations.json.
 * @param dir the review folder
 * @returns the workspace; `layout: 'empty'` for a folder with no review in it
 */
export function openWorkspace(dir: string): Workspace {
  const abs = path.resolve(dir);

  // A flat review folder stays readable as a one-base workspace forever.
  const flatFile = path.join(abs, 'annotations.json');
  if (fs.existsSync(flatFile)) {
    const url = readReviewUrl(flatFile);
    return {
      dir: abs,
      layout: 'flat',
      bases: [{ slug: baseSlug(url), url, dir: abs, file: flatFile }],
    };
  }

  const index = readIndex(abs);
  const bases: BaseRef[] = [];
  for (const slug of baseDirNames(abs)) {
    const entry = index.get(slug);
    const file = path.join(abs, slug, 'annotations.json');
    bases.push({
      slug,
      // review.url is written by the store and always current; the index is the
      // fallback for a review that was created without a url. `||` is deliberate
      // over `??` — an empty string means "no url recorded", not "a url".
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      url: readReviewUrl(file) || entry?.url || '',
      dir: path.join(abs, slug),
      file,
      ...(entry?.createdAt ? { createdAt: entry.createdAt } : {}),
      ...(entry?.lastSeenAt ? { lastSeenAt: entry.lastSeenAt } : {}),
    });
  }
  bases.sort((a, b) => a.slug.localeCompare(b.slug));
  const layout: WorkspaceLayout = bases.length ? 'multi' : 'empty';
  return { dir: abs, layout, bases };
}

/** Immediate subdirectories that hold an annotations.json, safe-slug names only. */
function baseDirNames(wsDir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(wsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(e => e.isDirectory() && isSafeSlug(e.name))
    .map(e => e.name)
    .filter(name => fs.existsSync(path.join(wsDir, name, 'annotations.json')));
}

/**
 * Parse bases.json into slug → entry. Everything is validated: the file is
 * hand-editable and arrives inside shared zips, and a slug becomes a path
 * segment. Anything unreadable or shape-invalid yields an empty index rather
 * than an error — the subfolders alone are enough to rebuild it.
 */
function readIndex(wsDir: string): Map<string, IndexEntry> {
  const out = new Map<string, IndexEntry>();
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(wsDir, BASES_FILE), 'utf8'));
  } catch {
    return out;
  }
  const list = (raw as { bases?: unknown } | null)?.bases;
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const { slug, url, createdAt, lastSeenAt } = item as Record<string, unknown>;
    if (!isSafeSlug(slug)) continue;
    out.set(slug, {
      slug,
      url: typeof url === 'string' ? url : '',
      ...(typeof createdAt === 'string' ? { createdAt } : {}),
      ...(typeof lastSeenAt === 'string' ? { lastSeenAt } : {}),
    });
  }
  return out;
}

/** A review file's `review.url`, or `''` when it cannot be read. */
function readReviewUrl(file: string): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ReviewData>;
    return typeof parsed.review?.url === 'string' ? parsed.review.url : '';
  } catch {
    return '';
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/unit-workspace.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/store/workspace.ts src/types.ts test/unit-workspace.test.js
git commit -m "feat(store): read a review folder as a multi-base workspace"
```

---

### Task 4: Workspace core — `resolveBase`

**Files:**
- Modify: `src/store/workspace.ts`
- Test: `test/unit-workspace.test.js`

**Interfaces:**
- Consumes: `Workspace`, `BaseRef`, `openWorkspace` (Task 3).
- Produces:
  - `resolveBase(ws: Workspace, nameOrUrl: string): BaseRef` — throws on miss or ambiguity
  - `describeBases(ws: Workspace): string` — `"localhost-4200, staging"` for error messages

- [ ] **Step 1: Write the failing test**

Append to `test/unit-workspace.test.js` (add `resolveBase` to the imports):

```js
/** A three-base workspace, for resolution tests. */
function threeBaseWorkspace() {
  const dir = tmpDir('nit-ws-');
  writeReview(path.join(dir, 'staging'), 'https://staging.example.com', ['a1']);
  writeReview(path.join(dir, 'localhost-4200'), 'http://localhost:4200', ['a1']);
  writeReview(path.join(dir, 'stage-two'), 'https://stage-two.example.com', ['a1']);
  return openWorkspace(dir);
}

test('workspace: resolveBase matches slug, url, origin and unique prefix', () => {
  const ws = threeBaseWorkspace();
  assert.equal(resolveBase(ws, 'staging').slug, 'staging');
  assert.equal(resolveBase(ws, 'STAGING').slug, 'staging');                          // case-insensitive
  assert.equal(resolveBase(ws, 'https://staging.example.com').slug, 'staging');      // exact url
  assert.equal(resolveBase(ws, 'https://staging.example.com/checkout').slug, 'staging'); // same origin
  assert.equal(resolveBase(ws, 'localhost').slug, 'localhost-4200');                 // unique prefix
});

test('workspace: resolveBase reports ambiguity and misses with the candidates', () => {
  const ws = threeBaseWorkspace();
  // "stag" prefixes both staging and stage-two
  assert.throws(() => resolveBase(ws, 'stag'), /ambiguous.*stage-two.*staging|ambiguous.*staging.*stage-two/s);
  assert.throws(() => resolveBase(ws, 'prod'), /no base.*prod/s);
  assert.throws(() => resolveBase(ws, 'prod'), /localhost-4200/s); // names what does exist
  assert.throws(() => resolveBase(ws, '   '), /no base/s);
});

test('workspace: an exact slug beats a prefix of another slug', () => {
  const dir = tmpDir('nit-ws-');
  writeReview(path.join(dir, 'stage'), 'https://stage.example.com', ['a1']);
  writeReview(path.join(dir, 'staging'), 'https://staging.example.com', ['a1']);
  const ws = openWorkspace(dir);
  assert.equal(resolveBase(ws, 'stage').slug, 'stage');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/unit-workspace.test.js`
Expected: FAIL — `resolveBase is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/store/workspace.ts`:

```ts
/**
 * Find the base a `--base` argument (or an MCP `base` parameter) names.
 *
 * Matching runs most-specific first — exact slug, exact url, same origin, then a
 * unique case-insensitive slug prefix — so an exact name always beats a prefix
 * of a longer one. One function serves the CLI and the MCP layer alike, so the
 * two can never drift apart.
 * @param ws the workspace to search
 * @param nameOrUrl a slug, a full url, or an unambiguous slug prefix
 * @returns the matching base
 * @throws when nothing matches, or when a prefix matches several bases; the
 *   message always names the workspace's actual bases
 */
export function resolveBase(ws: Workspace, nameOrUrl: string): BaseRef {
  const query = nameOrUrl.trim().toLowerCase();
  const known = describeBases(ws);
  if (!query) throw new Error(`no base given — known bases: ${known}`);

  const bySlug = ws.bases.find(b => b.slug.toLowerCase() === query);
  if (bySlug) return bySlug;

  const byUrl = ws.bases.find(b => b.url.toLowerCase() === query);
  if (byUrl) return byUrl;

  const origin = safeOrigin(query);
  if (origin) {
    const byOrigin = ws.bases.find(b => safeOrigin(b.url) === origin);
    if (byOrigin) return byOrigin;
  }

  const prefixed = ws.bases.filter(b => b.slug.toLowerCase().startsWith(query));
  if (prefixed.length === 1) return prefixed[0];
  if (prefixed.length > 1) {
    throw new Error(`base "${nameOrUrl}" is ambiguous — it matches ${prefixed.map(b => b.slug).join(', ')}`);
  }
  throw new Error(`no base "${nameOrUrl}" in ${ws.dir} — known bases: ${known}`);
}

/** The workspace's base slugs as a comma-separated list, for error messages. */
export function describeBases(ws: Workspace): string {
  return ws.bases.length ? ws.bases.map(b => b.slug).join(', ') : '(none yet)';
}

/**
 * A url's origin, or null when it is not an http(s) url. Used to treat
 * `https://x.test` and `https://x.test/checkout` as the same base.
 */
export function safeOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/unit-workspace.test.js`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add src/store/workspace.ts test/unit-workspace.test.js
git commit -m "feat(store): resolve a base by slug, url, origin or unique prefix"
```

---

### Task 5: Workspace core — `ensureBase` and lazy migration

**Files:**
- Modify: `src/store/workspace.ts`
- Test: `test/unit-workspace.test.js`

**Interfaces:**
- Consumes: `openWorkspace`, `resolveBase`, `safeOrigin`, `baseSlug`, `BASES_FILE` (Tasks 2–4).
- Produces:
  - `ensureBase(dir: string, url: string, alias?: string): BaseRef`
  - `writeIndex(wsDir: string, bases: BaseRef[]): void`

- [ ] **Step 1: Write the failing test**

Append to `test/unit-workspace.test.js` (add `ensureBase` to the imports):

```js
test('workspace: ensureBase creates and registers a base in an empty folder', () => {
  const dir = tmpDir('nit-ws-');
  const base = ensureBase(dir, 'http://localhost:4200');
  assert.equal(base.slug, 'localhost-4200');
  assert.equal(base.dir, path.join(dir, 'localhost-4200'));
  assert.ok(fs.existsSync(path.join(base.dir, 'shots')));
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'bases.json'), 'utf8'));
  assert.deepEqual(index.bases.map(b => b.slug), ['localhost-4200']);
  assert.equal(index.bases[0].url, 'http://localhost:4200');
});

test('workspace: an alias names the folder', () => {
  const dir = tmpDir('nit-ws-');
  const base = ensureBase(dir, 'https://staging.example.com', 'staging');
  assert.equal(base.slug, 'staging');
  assert.ok(fs.existsSync(path.join(dir, 'staging')));
});

test('workspace: ensureBase is idempotent and matches by origin', () => {
  const dir = tmpDir('nit-ws-');
  const first = ensureBase(dir, 'https://staging.example.com', 'staging');
  const again = ensureBase(dir, 'https://staging.example.com/checkout?x=1');
  assert.equal(again.slug, first.slug);
  assert.deepEqual(fs.readdirSync(dir).filter(n => n !== 'bases.json'), ['staging']);
});

test('workspace: the same url in a flat folder does NOT migrate', () => {
  const dir = tmpDir('nit-ws-');
  writeReview(dir, 'https://fainin.dev/', ['a1']);
  const base = ensureBase(dir, 'https://fainin.dev/');
  assert.equal(base.dir, dir, 'stays flat');
  assert.ok(fs.existsSync(path.join(dir, 'annotations.json')));
  assert.ok(!fs.existsSync(path.join(dir, 'bases.json')));
});

test('workspace: a second url migrates the flat folder, preserving ids and shots', () => {
  const dir = tmpDir('nit-ws-');
  writeReview(dir, 'https://fainin.dev/', ['a1', 'a2']);
  fs.writeFileSync(path.join(dir, 'review.md'), '# old review');
  fs.writeFileSync(path.join(dir, 'shots', 'a1.png'), 'png-bytes');

  const fresh = ensureBase(dir, 'http://localhost:4200');

  assert.equal(fresh.slug, 'localhost-4200');
  assert.ok(!fs.existsSync(path.join(dir, 'annotations.json')), 'flat file moved away');
  const moved = JSON.parse(fs.readFileSync(path.join(dir, 'fainin-dev', 'annotations.json'), 'utf8'));
  assert.deepEqual(moved.annotations.map(a => a.id), ['a1', 'a2']);
  assert.equal(moved.review.url, 'https://fainin.dev/');
  assert.equal(fs.readFileSync(path.join(dir, 'fainin-dev', 'review.md'), 'utf8'), '# old review');
  assert.equal(fs.readFileSync(path.join(dir, 'fainin-dev', 'shots', 'a1.png'), 'utf8'), 'png-bytes');

  const ws = openWorkspace(dir);
  assert.equal(ws.layout, 'multi');
  assert.deepEqual(ws.bases.map(b => b.slug), ['fainin-dev', 'localhost-4200']);
});

test('workspace: a slug collision from a different origin gets a suffix', () => {
  const dir = tmpDir('nit-ws-');
  ensureBase(dir, 'https://staging.example.com', 'staging');
  const second = ensureBase(dir, 'https://staging.other.test', 'staging');
  assert.equal(second.slug, 'staging-2');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/unit-workspace.test.js`
Expected: FAIL — `ensureBase is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/store/workspace.ts` (add `import { errorMessage } from '../util/error.js';` to the imports):

```ts
/** Files a flat review folder owns; everything else in the folder is left alone. */
const FLAT_ENTRIES = ['annotations.json', 'annotations.json.bak', 'review.md', 'fix-annotations.md', 'shots'];

/**
 * Find or create the base folder for a url, so a session can write into it.
 *
 * Migration is deliberately lazy: a flat review folder stays flat while it is
 * reviewed at the url it already holds, and only becomes a workspace when a
 * *second* base url actually arrives. Single-environment users therefore never
 * see their folder change shape.
 * @param dir the workspace directory (`--out`, default `nit-review`)
 * @param url the site about to be reviewed
 * @param alias optional short name for the base's folder (`--base staging`)
 * @returns the base to write into; its directory exists when this returns
 * @throws when a flat folder cannot be migrated (the move is rolled back first)
 */
export function ensureBase(dir: string, url: string, alias?: string): BaseRef {
  const abs = path.resolve(dir);
  const ws = openWorkspace(abs);
  const origin = safeOrigin(url);

  // Already known? Match on origin so /checkout and /?x=1 do not fork a base.
  const existing = origin ? ws.bases.find(b => safeOrigin(b.url) === origin) : undefined;
  if (existing) {
    if (ws.layout === 'multi') touchBase(abs, ws.bases, existing.slug);
    return existing;
  }

  // A flat folder holding a *different* url has to become a workspace first.
  if (ws.layout === 'flat') migrateFlat(abs, ws.bases[0].slug);

  const slug = uniqueSlug(abs, alias ? slugify(alias) : baseSlug(url));
  const baseDir = path.join(abs, slug);
  fs.mkdirSync(path.join(baseDir, 'shots'), { recursive: true });
  const now = new Date().toISOString();
  const base: BaseRef = {
    slug,
    url,
    dir: baseDir,
    file: path.join(baseDir, 'annotations.json'),
    createdAt: now,
    lastSeenAt: now,
  };
  writeIndex(abs, [...openWorkspace(abs).bases.filter(b => b.slug !== slug), base]);
  return base;
}

/**
 * Move a flat review folder's files into `<slug>/`. Every move is undone if any
 * one of them fails, so a failed migration never leaves a half-workspace.
 * @param wsDir the workspace directory
 * @param slug the folder name to move the flat review into
 * @throws when a move fails (after rolling back)
 */
function migrateFlat(wsDir: string, slug: string): void {
  const target = path.join(wsDir, slug);
  if (fs.existsSync(target)) {
    throw new Error(`cannot migrate ${wsDir}: ${slug}/ already exists`);
  }
  fs.mkdirSync(target, { recursive: true });
  const moved: [from: string, to: string][] = [];
  try {
    for (const name of FLAT_ENTRIES) {
      const from = path.join(wsDir, name);
      if (!fs.existsSync(from)) continue;
      const to = path.join(target, name);
      fs.renameSync(from, to);
      moved.push([from, to]);
    }
  } catch (e) {
    for (const [from, to] of moved.reverse()) {
      try { fs.renameSync(to, from); } catch { /* best effort — report the original failure */ }
    }
    try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* best effort */ }
    throw new Error(`could not turn ${wsDir} into a multi-base workspace: ${errorMessage(e)}`, { cause: e });
  }
}

/** `staging`, or `staging-2` when that folder is already taken by another base. */
function uniqueSlug(wsDir: string, desired: string): string {
  const safe = isSafeSlug(desired) ? desired : 'review';
  if (!fs.existsSync(path.join(wsDir, safe))) return safe;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${safe}-${n}`;
    if (!fs.existsSync(path.join(wsDir, candidate))) return candidate;
  }
  throw new Error(`cannot find a free folder name for base "${desired}" in ${wsDir}`);
}

/** Stamp `lastSeenAt` on one base, leaving the rest of the index alone. */
function touchBase(wsDir: string, bases: BaseRef[], slug: string): void {
  const now = new Date().toISOString();
  writeIndex(wsDir, bases.map(b => (b.slug === slug ? { ...b, lastSeenAt: now } : b)));
}

/**
 * Write bases.json. Only the fields the index owns are persisted — `dir` and
 * `file` are derived from the workspace path on every read, so a moved or
 * renamed workspace never carries stale absolute paths.
 * @param wsDir the workspace directory
 * @param bases every base the workspace should list
 */
export function writeIndex(wsDir: string, bases: BaseRef[]): void {
  const payload = {
    version: 1,
    bases: [...bases]
      .sort((a, b) => a.slug.localeCompare(b.slug))
      .map(b => ({
        slug: b.slug,
        url: b.url,
        ...(b.createdAt ? { createdAt: b.createdAt } : {}),
        ...(b.lastSeenAt ? { lastSeenAt: b.lastSeenAt } : {}),
      })),
  };
  const file = path.join(wsDir, BASES_FILE);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/unit-workspace.test.js`
Expected: PASS (17 tests).

- [ ] **Step 5: Commit**

```bash
git add src/store/workspace.ts test/unit-workspace.test.js
git commit -m "feat(store): create base folders and migrate flat reviews lazily"
```

---

### Task 6: Route `nit review <url>` into its base folder

**Files:**
- Modify: `src/browser/session.ts:157`
- Modify: `src/cli/index.ts` (the `review` command: add `--base`)
- Test: `test/cli-migrate.test.js` (create)

**Interfaces:**
- Consumes: `ensureBase` (Task 5).
- Produces: `StartSessionOptions.base?: string` on `startSession`.

- [ ] **Step 1: Write the failing test**

Create `test/cli-migrate.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
// Reviewing a second base url turns a flat review folder into a workspace.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ensureBase, openWorkspace } from '../dist/store/workspace.js';
import { createStore } from '../dist/store/store.js';
import { tmpDir } from './helpers/tmp.js';

test('migrate: a store opened on an ensureBase folder writes inside that base', () => {
  const dir = tmpDir('nit-migrate-');
  const base = ensureBase(dir, 'https://staging.example.com', 'staging');
  const store = createStore(base.dir, { url: base.url, author: 'Kevin' });
  store.upsert({ id: 'a1', comment: 'hi', status: 'open', type: 'change-request' });
  store.flush();

  assert.ok(fs.existsSync(path.join(dir, 'staging', 'annotations.json')));
  assert.ok(!fs.existsSync(path.join(dir, 'annotations.json')), 'nothing at the workspace root');
  const ws = openWorkspace(dir);
  assert.equal(ws.layout, 'multi');
  assert.equal(ws.bases[0].url, 'https://staging.example.com');
});

test('migrate: two bases keep independent id sequences', () => {
  const dir = tmpDir('nit-migrate-');
  for (const [url, alias] of [['https://staging.example.com', 'staging'], ['http://localhost:4200', undefined]]) {
    const base = ensureBase(dir, url, alias);
    const store = createStore(base.dir, { url: base.url });
    store.upsert({ id: store.nextId(), comment: 'first', status: 'open', type: 'change-request' });
    store.flush();
  }
  const ws = openWorkspace(dir);
  assert.deepEqual(ws.bases.map(b => b.slug), ['localhost-4200', 'staging']);
  for (const b of ws.bases) {
    const data = JSON.parse(fs.readFileSync(b.file, 'utf8'));
    assert.deepEqual(data.annotations.map(a => a.id), ['a1'], `${b.slug} starts at a1`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/cli-migrate.test.js`
Expected: PASS already — these assert Task 5 behaviour through the store. That is intentional: they pin the contract `session.ts` is about to depend on. If they fail, Task 5 is wrong; fix that first.

- [ ] **Step 3: Write minimal implementation**

In `src/browser/session.ts`, add the import and the option, then change the review-mode store creation:

```ts
import { ensureBase } from '../store/workspace.js';
```

Add to the options interface (near `out?: string` around line 109):

```ts
  /** short name for this url's base folder inside the workspace (`--base staging`) */
  base?: string;
```

Destructure `base` alongside `out` in the function signature, then replace line 157:

```ts
    // `out` names the workspace; the session writes into the base folder for this
    // url, which ensureBase creates (migrating a flat review folder when this is
    // the second base url it has seen).
    const target = ensureBase(path.resolve(out), url ?? '', base);
    store = createStore(target.dir, { url, author });
```

In `src/cli/index.ts`, add to `BrowserCmdOptions`:

```ts
  /** review: short name for this url's base folder inside the workspace */
  base?: string;
```

Add the flag to the `review` command builder, after `--author`:

```ts
    .option('-b, --base <name>', 'short name for this url\'s folder inside the review workspace (default: derived from the host)')
```

And pass it through in `startBrowser`:

```ts
    base: opts.base,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/cli-migrate.test.js && node --test test/cli-help.test.js`
Expected: PASS. Also check the flag is documented: `node dist/cli/index.js review --help` shows `-b, --base`.

- [ ] **Step 5: Commit**

```bash
git add src/browser/session.ts src/cli/index.ts test/cli-migrate.test.js
git commit -m "feat(cli): nit review writes into the base folder for its url"
```

---

### Task 7: Clearing — `store/derived.ts` and `store/clear.ts`

**Files:**
- Create: `src/store/derived.ts`
- Create: `src/store/clear.ts`
- Modify: `src/mcp/tools.ts:283-292` (use the shared helper)
- Test: `test/unit-clear.test.js` (create)

**Interfaces:**
- Consumes: `BaseRef` (Task 3), `createStore` / `Store` from `store/store.js`.
- Produces:
  - `writeDerivedFiles(store: Store): void`
  - `ClearScope { status?: AnnotationStatus }`
  - `selectForClear(annotations: Annotation[], scope: ClearScope): Annotation[]`
  - `ClearResult { slug, url, cleared, remaining, ids: string[] }`
  - `clearBase(base: BaseRef, scope: ClearScope, opts?: { dryRun?: boolean }): ClearResult`

- [ ] **Step 1: Write the failing test**

Create `test/unit-clear.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { selectForClear, clearBase } from '../dist/store/clear.js';
import { ensureBase, openWorkspace } from '../dist/store/workspace.js';
import { createStore } from '../dist/store/store.js';
import { tmpDir } from './helpers/tmp.js';

const ANNS = [
  { id: 'a1', status: 'open', type: 'change-request' },
  { id: 'a2', status: 'verified', type: 'change-request' },
  { id: 'a3', status: 'verified', type: 'comment' },
  { id: 'a4', status: 'wontfix', type: 'change-request' },
];

test('clear: an empty scope selects everything', () => {
  assert.deepEqual(selectForClear(ANNS, {}).map(a => a.id), ['a1', 'a2', 'a3', 'a4']);
});

test('clear: a status scope selects only that status, across types', () => {
  assert.deepEqual(selectForClear(ANNS, { status: 'verified' }).map(a => a.id), ['a2', 'a3']);
  assert.deepEqual(selectForClear(ANNS, { status: 'wontfix' }).map(a => a.id), ['a4']);
  assert.deepEqual(selectForClear(ANNS, { status: 'fixed' }).map(a => a.id), []);
});

/** A base with the four ANNS and a screenshot on the verified a2. */
function seedBase() {
  const dir = tmpDir('nit-clear-');
  const base = ensureBase(dir, 'https://staging.example.com', 'staging');
  const store = createStore(base.dir, { url: base.url, author: 'Kevin' });
  for (const a of ANNS) {
    store.upsert({
      ...a, comment: `c ${a.id}`, author: 'Kevin', viewportScope: 'general',
      viewport: { mode: 'desktop', w: 1440, h: 900 }, route: '/',
      target: { component: 'div', ngComponent: null, selector: '.x', xpath: '/html[1]', tag: 'div', classes: [], text: '', rect: { x: 0, y: 0, w: 1, h: 1 } },
      screenshot: a.id === 'a2' ? 'shots/a2.png' : null, createdAt: '2026-07-20T10:00:00Z',
    });
  }
  store.flush();
  fs.writeFileSync(path.join(base.dir, 'shots', 'a2.png'), 'png-bytes');
  return { dir, base };
}

test('clear: clearBase removes the selected annotations and their screenshots', () => {
  const { dir, base } = seedBase();
  const result = clearBase(base, { status: 'verified' });

  assert.equal(result.cleared, 2);
  assert.equal(result.remaining, 2);
  assert.deepEqual(result.ids, ['a2', 'a3']);
  assert.equal(result.slug, 'staging');

  const data = JSON.parse(fs.readFileSync(base.file, 'utf8'));
  assert.deepEqual(data.annotations.map(a => a.id), ['a1', 'a4']);
  assert.ok(!fs.existsSync(path.join(base.dir, 'shots', 'a2.png')), 'screenshot unlinked');
  assert.ok(fs.existsSync(path.join(base.dir, 'review.md')), 'derived files re-rendered');
  assert.equal(openWorkspace(dir).bases.length, 1, 'the base folder survives');
});

test('clear: an empty-out keeps review metadata and the base folder', () => {
  const { base } = seedBase();
  const result = clearBase(base, {});
  assert.equal(result.cleared, 4);
  assert.equal(result.remaining, 0);
  const data = JSON.parse(fs.readFileSync(base.file, 'utf8'));
  assert.deepEqual(data.annotations, []);
  assert.equal(data.review.url, 'https://staging.example.com');
  assert.deepEqual(data.review.authors, ['Kevin']);
});

test('clear: a dry run reports without writing', () => {
  const { base } = seedBase();
  const result = clearBase(base, { status: 'verified' }, { dryRun: true });
  assert.equal(result.cleared, 2);
  assert.equal(result.remaining, 2);
  const data = JSON.parse(fs.readFileSync(base.file, 'utf8'));
  assert.equal(data.annotations.length, 4, 'nothing removed');
  assert.ok(fs.existsSync(path.join(base.dir, 'shots', 'a2.png')), 'screenshot kept');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/unit-clear.test.js`
Expected: FAIL — cannot find module `../dist/store/clear.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/store/derived.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
// Re-rendering the files derived from annotations.json. Shared by every writer
// outside a browser session (the MCP tools, `nit clear`) so they cannot drift
// apart on which files a write is supposed to refresh.
import fs from 'node:fs';
import path from 'node:path';
import { renderReviewMd, FIX_ANNOTATIONS_MD } from './render.js';
import type { Store } from './store.js';

/**
 * Rewrite `review.md` and `fix-annotations.md` from the store's current data.
 * Best effort: a read-only or full disk must not fail the write that already
 * landed in annotations.json.
 * @param store a store whose data has already been flushed
 */
export function writeDerivedFiles(store: Store): void {
  try {
    fs.writeFileSync(path.join(store.dir, 'review.md'), renderReviewMd(store.data), 'utf8');
    fs.writeFileSync(path.join(store.dir, 'fix-annotations.md'), FIX_ANNOTATIONS_MD, 'utf8');
  } catch { /* best effort */ }
}
```

Create `src/store/clear.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
// Removing annotations from a base: which ones a scope matches (pure), and the
// single operation that applies it. Deletion goes through Store.remove so
// screenshots are unlinked with the existing path-traversal guard rather than by
// a second, less careful path.
import { createStore } from './store.js';
import { writeDerivedFiles } from './derived.js';
import type { Annotation, AnnotationStatus, BaseRef } from '../types.js';

/** What a clear should remove; an empty scope means every annotation. */
export interface ClearScope {
  /** only annotations with this status (`--verified` is `status: 'verified'`) */
  status?: AnnotationStatus;
}

/** What one base's clear removed. */
export interface ClearResult {
  slug: string;
  url: string;
  /** how many annotations were removed */
  cleared: number;
  /** how many are left afterwards */
  remaining: number;
  /** the ids that were (or, on a dry run, would be) removed, in file order */
  ids: string[];
}

/**
 * The annotations a scope matches. Pure — the caller decides what to do with
 * them, so a dry run and a real clear can never disagree about the set.
 * @param annotations the base's annotations
 * @param scope see {@link ClearScope}
 */
export function selectForClear(annotations: Annotation[], scope: ClearScope): Annotation[] {
  return annotations.filter(a => !scope.status || a.status === scope.status);
}

/**
 * Remove the matching annotations from one base and refresh its derived files.
 *
 * The base folder and its review metadata (`id`, `url`, `authors`, `createdAt`)
 * survive even a total empty-out: the request is to clear annotations, not to
 * forget the environment, and keeping the folder means the next review of that
 * url reuses its review id.
 * @param base the base to clear
 * @param scope see {@link ClearScope}
 * @param opts `dryRun` reports the same numbers without writing anything
 * @returns what was removed, or would be
 */
export function clearBase(base: BaseRef, scope: ClearScope, { dryRun = false } = {}): ClearResult {
  const store = createStore(base.dir);
  const doomed = selectForClear(store.annotations, scope);
  const ids = doomed.map(a => a.id);
  const remaining = store.annotations.length - ids.length;

  if (!dryRun && ids.length) {
    for (const id of ids) store.remove(id);
    store.flush();
    writeDerivedFiles(store);
  }
  return { slug: base.slug, url: base.url, cleared: ids.length, remaining, ids };
}
```

Then in `src/mcp/tools.ts`, replace the body of `writeAnnotation`'s file writes (lines 286-290) with the shared helper, adding `import { writeDerivedFiles } from '../store/derived.js';` and dropping the now-unused `renderReviewMd` / `FIX_ANNOTATIONS_MD` / `path` imports if nothing else uses them:

```ts
  store.flush();
  writeDerivedFiles(store);
  return structured({ annotation: ann });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/unit-clear.test.js && node --test test/mcp.test.js`
Expected: PASS both — the MCP tests prove the `writeDerivedFiles` extraction did not change behaviour.

- [ ] **Step 5: Commit**

```bash
git add src/store/derived.ts src/store/clear.ts src/mcp/tools.ts test/unit-clear.test.js
git commit -m "feat(store): clear a base's annotations by status"
```

---

### Task 8: `nit list`

**Files:**
- Create: `src/cli/list.ts`
- Modify: `src/cli/index.ts` (register the command)
- Test: `test/cli-list.test.js` (create)

**Interfaces:**
- Consumes: `openWorkspace`, `resolveBase` (Tasks 3–4), `isActionable` from `store/stats.js`, `resolveAnnotationUrl` from `store/url.js`, `routePath` from `util/route.js`, `ago` / `displayPath` from `cli/status.js`.
- Produces:
  - `ListFilter { status?, type?, route?, author?, actionable? }`
  - `matchesFilter(a: Annotation, f: ListFilter): boolean`
  - `buildListResult(dir: string, opts: ListOptions): ListResult`
  - `runList(dir: string, opts: ListOptions): ListResult`

- [ ] **Step 1: Write the failing test**

Create `test/cli-list.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesFilter, buildListResult, runList } from '../dist/cli/list.js';
import { ensureBase } from '../dist/store/workspace.js';
import { createStore } from '../dist/store/store.js';
import { tmpDir } from './helpers/tmp.js';

/** One annotation, with the fields list cares about. */
function ann(id, over = {}) {
  return {
    id, type: 'change-request', comment: `c ${id}`, status: 'open', author: 'Kevin',
    viewportScope: 'general', viewport: { mode: 'desktop', w: 1440, h: 900 }, route: '/',
    target: { component: 'div', ngComponent: null, selector: '.x', xpath: '/html[1]', tag: 'div', classes: [], text: '', rect: { x: 0, y: 0, w: 1, h: 1 } },
    screenshot: null, createdAt: '2026-07-20T10:00:00Z', ...over,
  };
}

/** A workspace: staging (3 annotations, 2 routes) and localhost-4200 (1). */
function seedWorkspace() {
  const dir = tmpDir('nit-list-');
  const staging = ensureBase(dir, 'https://staging.example.com', 'staging');
  const s = createStore(staging.dir, { url: staging.url, author: 'Kevin' });
  s.upsert(ann('a1', { route: '/checkout' }));
  s.upsert(ann('a2', { route: '/checkout', status: 'verified' }));
  s.upsert(ann('a3', { route: '/', type: 'comment', author: 'Ann' }));
  s.flush();
  const local = ensureBase(dir, 'http://localhost:4200');
  const l = createStore(local.dir, { url: local.url, author: 'Kevin' });
  l.upsert(ann('a1', { route: '/cart' }));
  l.flush();
  return dir;
}

test('list: matchesFilter combines status, type, route, author and actionable', () => {
  const open = ann('a1', { route: '/checkout?tab=1' });
  assert.ok(matchesFilter(open, {}));
  assert.ok(matchesFilter(open, { status: 'open' }));
  assert.ok(!matchesFilter(open, { status: 'verified' }));
  assert.ok(matchesFilter(open, { type: 'change-request' }));
  assert.ok(!matchesFilter(open, { type: 'comment' }));
  assert.ok(matchesFilter(open, { route: '/checkout' }), 'bare pathname matches a route with a query');
  assert.ok(matchesFilter(open, { route: '/checkout?tab=1' }), 'exact route matches');
  assert.ok(!matchesFilter(open, { route: '/cart' }));
  assert.ok(matchesFilter(open, { author: 'kevin' }), 'author is case-insensitive');
  assert.ok(matchesFilter(open, { actionable: true }));
  assert.ok(!matchesFilter(ann('a2', { status: 'verified' }), { actionable: true }));
});

test('list: bases are counted and sorted busiest first', () => {
  const result = buildListResult(seedWorkspace(), {});
  assert.equal(result.layout, 'multi');
  assert.equal(result.total, 4);
  assert.equal(result.actionable, 2); // staging a1 + localhost a1; a2 verified, a3 is a comment
  assert.deepEqual(result.bases.map(b => b.slug), ['staging', 'localhost-4200']);
  assert.equal(result.bases[0].total, 3);
  assert.equal(result.bases[0].byStatus.verified, 1);
});

test('list: --base yields url rows built from base + route', () => {
  const result = buildListResult(seedWorkspace(), { base: 'staging' });
  assert.deepEqual(result.bases.map(b => b.slug), ['staging']);
  assert.deepEqual(result.bases[0].urls.map(u => u.url), [
    'https://staging.example.com/checkout',
    'https://staging.example.com/',
  ]);
  assert.equal(result.bases[0].urls[0].count, 2);
});

test('list: filters narrow the counts and drop empty bases', () => {
  const result = buildListResult(seedWorkspace(), { filter: { status: 'verified' } });
  assert.deepEqual(result.bases.map(b => b.slug), ['staging']);
  assert.equal(result.total, 1);
});

test('list: a flat review folder lists as one base', () => {
  const dir = tmpDir('nit-list-');
  const store = createStore(dir, { url: 'https://fainin.dev/', author: 'Kevin' });
  store.upsert(ann('a1'));
  store.flush();
  const result = buildListResult(dir, {});
  assert.equal(result.layout, 'flat');
  assert.deepEqual(result.bases.map(b => b.slug), ['fainin-dev']);
});

test('list: --json prints the result and the report prints a table', () => {
  const dir = seedWorkspace();
  const json = [];
  runList(dir, { json: true, log: l => json.push(l) });
  const parsed = JSON.parse(json.join('\n'));
  assert.equal(parsed.total, 4);

  const lines = [];
  runList(dir, { log: l => lines.push(l) });
  const text = lines.join('\n');
  assert.match(text, /staging/);
  assert.match(text, /https:\/\/staging\.example\.com/);
  assert.match(text, /4 annotations across 2 base URLs/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/cli-list.test.js`
Expected: FAIL — cannot find module `../dist/cli/list.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/cli/list.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
// nit list — what base urls a workspace holds, and which urls were annotated
// inside one. Read-only: nothing is created, normalized or backed up, so running
// it against a review someone else is editing is always safe.
import fs from 'node:fs';
import { openWorkspace, resolveBase } from '../store/workspace.js';
import { isActionable } from '../store/stats.js';
import { resolveAnnotationUrl } from '../store/url.js';
import { routePath } from '../util/route.js';
import { displayPath, ago } from './status.js';
import type {
  Annotation, AnnotationStatus, AnnotationType, BaseRef, ReviewData, WorkspaceLayout,
} from '../types.js';

/** Which annotations a listing should count. */
export interface ListFilter {
  status?: AnnotationStatus;
  type?: AnnotationType;
  /** an exact route, or a bare pathname that matches routes carrying a query */
  route?: string;
  /** case-insensitive author match */
  author?: string;
  /** only open/reopened change-requests */
  actionable?: boolean;
}

/** One annotated url inside a base. */
export interface UrlRow {
  /** the navigable url: the base's url with the annotation's route applied */
  url: string;
  route: string;
  count: number;
  actionable: number;
  byStatus: Partial<Record<AnnotationStatus, number>>;
}

/** One base and what is annotated inside it. */
export interface BaseRow {
  slug: string;
  url: string;
  total: number;
  actionable: number;
  byStatus: Partial<Record<AnnotationStatus, number>>;
  /** ISO timestamp of the newest annotation change, or null */
  lastChange: string | null;
  /** annotated urls, busiest first */
  urls: UrlRow[];
}

/** What {@link buildListResult} computed. */
export interface ListResult {
  dir: string;
  layout: WorkspaceLayout;
  /** bases that still have annotations after filtering, busiest first */
  bases: BaseRow[];
  total: number;
  actionable: number;
}

/** Options for {@link runList} and {@link buildListResult}. */
export interface ListOptions {
  /** only this base (slug, url or unique prefix); also switches the report to url rows */
  base?: string;
  /** show url rows for every base */
  all?: boolean;
  filter?: ListFilter;
  /** print the result as JSON instead of a report */
  json?: boolean;
  /** log sink */
  log?: (line: string) => void;
  /** clock override for the relative "… ago" column */
  now?: Date;
}

/**
 * Whether one annotation passes a filter. Pure and table-tested — the CLI and
 * any future consumer agree on what `--status open --route /cart` means.
 * @param a the annotation
 * @param filter see {@link ListFilter}
 */
export function matchesFilter(a: Annotation, filter: ListFilter): boolean {
  if (filter.status && a.status !== filter.status) return false;
  if (filter.type && a.type !== filter.type) return false;
  if (filter.actionable && !isActionable(a)) return false;
  if (filter.author && (a.author ?? '').toLowerCase() !== filter.author.toLowerCase()) return false;
  // routes carry query strings: accept an exact match or a path-only filter
  if (filter.route && a.route !== filter.route && routePath(a.route) !== filter.route) return false;
  return true;
}

/**
 * Aggregate a workspace into base rows and url rows.
 * @param dir the workspace directory (or a flat review folder)
 * @param opts see {@link ListOptions}
 * @returns the aggregated counts
 * @throws when `base` names no base in the workspace
 */
export function buildListResult(dir: string, { base, filter = {} }: ListOptions): ListResult {
  const ws = openWorkspace(dir);
  const scope = base ? [resolveBase(ws, base)] : ws.bases;

  const bases = scope.map(ref => buildBaseRow(ref, filter)).filter(row => row.total > 0);
  bases.sort((a, b) => b.total - a.total || a.slug.localeCompare(b.slug));
  return {
    dir: ws.dir,
    layout: ws.layout,
    bases,
    total: bases.reduce((n, b) => n + b.total, 0),
    actionable: bases.reduce((n, b) => n + b.actionable, 0),
  };
}

/** Count one base's annotations, grouped by the url they sit on. */
function buildBaseRow(ref: BaseRef, filter: ListFilter): BaseRow {
  const annotations = readAnnotations(ref.file).filter(a => matchesFilter(a, filter));
  const byStatus: Partial<Record<AnnotationStatus, number>> = {};
  const urls = new Map<string, UrlRow>();
  let lastChange: string | null = null;

  for (const a of annotations) {
    if (a.status) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
    const at = a.updatedAt ?? a.createdAt;
    if (typeof at === 'string' && (!lastChange || at > lastChange)) lastChange = at;

    const route = a.route ?? '/';
    // resolveAnnotationUrl already rejects anything that would leave the base's
    // own origin, so a crafted route cannot fabricate a url in the report
    const url = resolveAnnotationUrl(ref.url, route) ?? route;
    const row = urls.get(url) ?? { url, route, count: 0, actionable: 0, byStatus: {} };
    row.count += 1;
    if (isActionable(a)) row.actionable += 1;
    if (a.status) row.byStatus[a.status] = (row.byStatus[a.status] ?? 0) + 1;
    urls.set(url, row);
  }

  return {
    slug: ref.slug,
    url: ref.url,
    total: annotations.length,
    actionable: annotations.filter(isActionable).length,
    byStatus,
    lastChange,
    urls: [...urls.values()].sort((a, b) => b.count - a.count || a.url.localeCompare(b.url)),
  };
}

/** A review file's annotations; unreadable or odd entries are skipped, not fatal. */
function readAnnotations(file: string): Annotation[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ReviewData>;
    return (Array.isArray(parsed.annotations) ? parsed.annotations : [])
      .filter((a): a is Annotation => Boolean(a) && typeof a === 'object');
  } catch {
    return [];
  }
}

/**
 * Report on a workspace, or on one base's annotated urls.
 * @param dir the workspace directory (default `nit-review`)
 * @param opts see {@link ListOptions}
 * @returns the same result that was printed
 * @throws when the folder holds no review, or `base` names no base
 */
export function runList(
  dir = 'nit-review',
  { log = line => console.log(line), now = new Date(), ...opts }: ListOptions = {},
): ListResult {
  const result = buildListResult(dir, opts);
  if (opts.json) {
    log(JSON.stringify(result, null, 2));
    return result;
  }
  if (!result.bases.length) {
    log(`nit list — ${displayPath(result.dir)}`);
    log('');
    log(result.layout === 'empty'
      ? '  No review here yet — capture one:  nit review <url>'
      : '  Nothing matches that filter.');
    return result;
  }
  // naming a base, or asking for --all, switches the report to url rows
  const urlShape = Boolean(opts.base) || Boolean(opts.all);
  for (const line of urlShape ? urlReport(result, Boolean(opts.all)) : baseReport(result, now)) log(line);
  return result;
}

/** The base table: one row per base url. */
function baseReport(result: ListResult, now: Date): string[] {
  const lines = [`nit list — ${displayPath(result.dir)}`, ''];
  const slugWidth = Math.max(4, ...result.bases.map(b => b.slug.length));
  const urlWidth = Math.max(3, ...result.bases.map(b => b.url.length));
  lines.push(`  ${'base'.padEnd(slugWidth)}  ${'url'.padEnd(urlWidth)}  total  actionable  last change`);
  for (const b of result.bases) {
    lines.push(`  ${b.slug.padEnd(slugWidth)}  ${b.url.padEnd(urlWidth)}  ${String(b.total).padStart(5)}  ${String(b.actionable).padStart(10)}  ${b.lastChange ? ago(b.lastChange, now) : '—'}`);
  }
  lines.push('');
  lines.push(`  ${result.total} annotation${result.total === 1 ? '' : 's'} across ${result.bases.length} base URL${result.bases.length === 1 ? '' : 's'} · ${result.actionable} actionable`);
  lines.push('');
  lines.push(`  Urls in one of them:  nit list --base ${result.bases[0].slug}`);
  return lines;
}

/** The url table: one row per annotated url, optionally grouped by base. */
function urlReport(result: ListResult, grouped: boolean): string[] {
  const lines: string[] = [];
  for (const b of result.bases) {
    lines.push(`nit list — ${b.slug} (${b.url})`, '');
    const urlWidth = Math.max(3, ...b.urls.map(u => u.url.length));
    lines.push(`  ${'url'.padEnd(urlWidth)}  n   status`);
    for (const u of b.urls) {
      const statuses = Object.entries(u.byStatus).map(([s, n]) => `${s} ${n}`).join(' · ');
      lines.push(`  ${u.url.padEnd(urlWidth)}  ${String(u.count).padStart(2)}  ${statuses || '—'}`);
    }
    lines.push('');
    lines.push(`  ${b.total} annotation${b.total === 1 ? '' : 's'} on ${b.urls.length} url${b.urls.length === 1 ? '' : 's'} · ${b.actionable} actionable`);
    if (grouped) lines.push('');
  }
  return lines;
}
```

Register in `src/cli/index.ts` (import `runList` from `./list.js`, place the command after `status`):

```ts
program.command('list')
  .aliases(['ls'])
  .summary('list the base URLs in a review, or the annotated urls in one')
  .description('See what a review workspace holds. With no options it lists every base URL\n'
    + '(local, staging, production …) with its counts; with --base it lists the\n'
    + 'annotated urls inside one of them.\n\n'
    + 'Nothing is written — safe to run against a review someone else is editing.\n'
    + 'Every filter applies to both shapes, and --json feeds the same numbers to a script.')
  .argument('[dir]', 'review workspace (or an annotations.json path)', 'nit-review')
  .option('-b, --base <name>', 'only this base — a slug, a url, or an unambiguous prefix')
  .option('--all', 'show annotated urls for every base')
  .addOption(new Option('--status <status>', 'only annotations with this status')
    .choices(['open', 'fixed', 'wontfix', 'verified', 'reopened']))
  .addOption(new Option('--type <type>', 'only this annotation type').choices(['change-request', 'comment']))
  .option('--route <path>', 'only annotations on this route (exact route or bare pathname)')
  .option('--author <name>', 'only annotations by this author')
  .option('--actionable', 'only open/reopened change-requests')
  .option('--json', 'print the listing as JSON instead of a report')
  .addHelpText('after', `
Examples:
  $ nit list                                  every base URL with its counts
  $ nit list --base staging                   the annotated urls on staging
  $ nit list --all --actionable               everything still waiting, everywhere
  $ nit list --base staging --status verified what is already ruled on staging`)
  .action((dir: string, opts: {
    base?: string; all?: boolean; status?: AnnotationStatus; type?: AnnotationType;
    route?: string; author?: string; actionable?: boolean; json?: boolean;
  }) => {
    runList(dir, {
      base: opts.base,
      all: opts.all,
      json: opts.json,
      filter: {
        status: opts.status,
        type: opts.type,
        route: opts.route,
        author: opts.author,
        actionable: opts.actionable,
      },
    });
  });
```

Add `import type { AnnotationStatus, AnnotationType, SessionMode } from '../types.js';` to the existing type import in `index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/cli-list.test.js`
Expected: PASS (6 tests). Then eyeball it: `node dist/cli/index.js list nit-review` in the repo root prints the one flat base.

- [ ] **Step 5: Commit**

```bash
git add src/cli/list.ts src/cli/index.ts test/cli-list.test.js
git commit -m "feat(cli): nit list for base URLs and annotated urls"
```

---

### Task 9: `nit clear`

**Files:**
- Create: `src/cli/clear.ts`
- Modify: `src/cli/index.ts` (register the command)
- Test: `test/cli-clear.test.js` (create)

**Interfaces:**
- Consumes: `openWorkspace`, `resolveBase`, `describeBases` (Tasks 3–4), `clearBase` / `ClearScope` (Task 7).
- Produces: `runClear(dir: string, opts: ClearOptions): ClearResult[]`

- [ ] **Step 1: Write the failing test**

Create `test/cli-clear.test.js`:

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runClear } from '../dist/cli/clear.js';
import { ensureBase } from '../dist/store/workspace.js';
import { createStore } from '../dist/store/store.js';
import { tmpDir } from './helpers/tmp.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli', 'index.js');

function ann(id, status) {
  return {
    id, type: 'change-request', comment: `c ${id}`, status, author: 'Kevin',
    viewportScope: 'general', viewport: { mode: 'desktop', w: 1440, h: 900 }, route: '/',
    target: { component: 'div', ngComponent: null, selector: '.x', xpath: '/html[1]', tag: 'div', classes: [], text: '', rect: { x: 0, y: 0, w: 1, h: 1 } },
    screenshot: null, createdAt: '2026-07-20T10:00:00Z',
  };
}

/** staging: a1 open, a2 verified. localhost-4200: a1 verified. */
function seedWorkspace() {
  const dir = tmpDir('nit-clear-cli-');
  const staging = ensureBase(dir, 'https://staging.example.com', 'staging');
  const s = createStore(staging.dir, { url: staging.url, author: 'Kevin' });
  s.upsert(ann('a1', 'open'));
  s.upsert(ann('a2', 'verified'));
  s.flush();
  const local = ensureBase(dir, 'http://localhost:4200');
  const l = createStore(local.dir, { url: local.url, author: 'Kevin' });
  l.upsert(ann('a1', 'verified'));
  l.flush();
  return dir;
}

const ids = dir => JSON.parse(fs.readFileSync(path.join(dir, 'annotations.json'), 'utf8')).annotations.map(a => a.id);

test('clear: --base --verified removes only that base\'s verified items', () => {
  const dir = seedWorkspace();
  const results = runClear(dir, { base: 'staging', status: 'verified', yes: true, log: () => {} });
  assert.equal(results.length, 1);
  assert.equal(results[0].cleared, 1);
  assert.deepEqual(ids(path.join(dir, 'staging')), ['a1']);
  assert.deepEqual(ids(path.join(dir, 'localhost-4200')), ['a1'], 'other base untouched');
});

test('clear: --all --verified sweeps every base', () => {
  const dir = seedWorkspace();
  const results = runClear(dir, { all: true, status: 'verified', yes: true, log: () => {} });
  assert.equal(results.reduce((n, r) => n + r.cleared, 0), 2);
  assert.deepEqual(ids(path.join(dir, 'staging')), ['a1']);
  assert.deepEqual(ids(path.join(dir, 'localhost-4200')), []);
});

test('clear: --base with no status empties that base', () => {
  const dir = seedWorkspace();
  runClear(dir, { base: 'staging', yes: true, log: () => {} });
  assert.deepEqual(ids(path.join(dir, 'staging')), []);
});

test('clear: --dry-run reports without writing', () => {
  const dir = seedWorkspace();
  const lines = [];
  const results = runClear(dir, { all: true, status: 'verified', dryRun: true, log: l => lines.push(l) });
  assert.equal(results.reduce((n, r) => n + r.cleared, 0), 2);
  assert.deepEqual(ids(path.join(dir, 'staging')), ['a1', 'a2'], 'nothing removed');
  assert.match(lines.join('\n'), /would/i);
});

test('clear: no scope is an error that names the bases', () => {
  const dir = seedWorkspace();
  assert.throws(() => runClear(dir, { yes: true, log: () => {} }), /--base|--all/);
  assert.throws(() => runClear(dir, { yes: true, log: () => {} }), /staging/);
});

test('clear: --base and --all together are refused', () => {
  const dir = seedWorkspace();
  assert.throws(() => runClear(dir, { base: 'staging', all: true, yes: true, log: () => {} }), /both/i);
});

test('clear: the CLI exits 1 with no scope', () => {
  const dir = seedWorkspace();
  const res = spawnSync(process.execPath, [CLI, 'clear', dir], { encoding: 'utf8', timeout: 30000 });
  assert.equal(res.status, 1);
  assert.match(res.stdout + res.stderr, /--base|--all/);
});

test('clear: --verified is sugar for --status verified', () => {
  const dir = seedWorkspace();
  const res = spawnSync(process.execPath, [CLI, 'clear', dir, '--all', '--verified', '--yes'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.deepEqual(ids(path.join(dir, 'staging')), ['a1']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/cli-clear.test.js`
Expected: FAIL — cannot find module `../dist/cli/clear.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/cli/clear.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
// nit clear — remove annotations from one base or from every base. Destructive,
// so a scope is mandatory (never guessed), the prompt names what is about to go,
// and --dry-run shows the same numbers without writing.
import { confirm, isCancel } from '@clack/prompts';
import { openWorkspace, resolveBase, describeBases } from '../store/workspace.js';
import { clearBase } from '../store/clear.js';
import type { ClearResult } from '../store/clear.js';
import { displayPath } from './status.js';
import type { AnnotationStatus, BaseRef } from '../types.js';

/** Options for {@link runClear}. */
export interface ClearOptions {
  /** clear this base only — a slug, a url, or an unambiguous prefix */
  base?: string;
  /** clear every base */
  all?: boolean;
  /** only annotations with this status (`--verified` maps to `'verified'`) */
  status?: AnnotationStatus;
  /** skip the confirmation prompt */
  yes?: boolean;
  /** report what would go, write nothing */
  dryRun?: boolean;
  /** log sink */
  log?: (line: string) => void;
}

/**
 * Clear annotations from a review workspace.
 *
 * A scope is mandatory: bare `nit clear` lists the bases and refuses, rather
 * than guessing which environment the user meant. The base folder and its review
 * metadata always survive — this clears annotations, not environments.
 * @param dir the workspace directory (default `nit-review`)
 * @param opts see {@link ClearOptions}
 * @returns one result per base that was cleared
 * @throws when no scope (or both scopes) are given, when the base does not
 *   exist, or when a confirmation is needed but stdin is not a terminal
 */
export async function runClear(
  dir = 'nit-review',
  { base, all, status, yes = false, dryRun = false, log = line => console.log(line) }: ClearOptions = {},
): Promise<ClearResult[]> {
  const ws = openWorkspace(dir);
  if (base && all) throw new Error('pass either --base <name> or --all, not both');
  if (!base && !all) {
    throw new Error(`nit clear needs a scope — pass --base <name> or --all\n`
      + `  bases in ${displayPath(ws.dir)}: ${describeBases(ws)}\n`
      + `  e.g.  nit clear --base ${ws.bases[0]?.slug ?? '<name>'} --verified`);
  }
  if (!ws.bases.length) throw new Error(`no review in ${displayPath(ws.dir)} — nothing to clear`);

  const targets: BaseRef[] = base ? [resolveBase(ws, base)] : ws.bases;
  const scope = status ? { status } : {};

  // Count first, so the prompt (and a dry run) state exactly what is at stake.
  const preview = targets.map(t => clearBase(t, scope, { dryRun: true }));
  const total = preview.reduce((n, r) => n + r.cleared, 0);
  const what = status ? `${status} annotation` : 'annotation';
  const where = base ? `base ${targets[0].slug}` : `${targets.length} base${targets.length === 1 ? '' : 's'}`;

  if (!total) {
    log(`nothing to clear — no ${what}s in ${where}`);
    return preview;
  }
  if (dryRun) {
    log(`would clear ${total} ${what}${total === 1 ? '' : 's'} from ${where}:`);
    for (const r of preview.filter(r => r.cleared)) log(`  ${r.slug}  ${r.cleared} (${r.remaining} would remain)`);
    return preview;
  }
  if (!yes) {
    if (!process.stdin.isTTY) {
      throw new Error(`refusing to clear ${total} ${what}${total === 1 ? '' : 's'} without a confirmation — pass --yes for scripts`);
    }
    const ok = await confirm({ message: `Clear ${total} ${what}${total === 1 ? '' : 's'} from ${where}? This cannot be undone.` });
    if (isCancel(ok) || !ok) {
      log('cancelled — nothing was cleared');
      return [];
    }
  }

  const results = targets.map(t => clearBase(t, scope));
  const cleared = results.reduce((n, r) => n + r.cleared, 0);
  log(`cleared ${cleared} ${what}${cleared === 1 ? '' : 's'} from ${where}`);
  for (const r of results.filter(r => r.cleared)) log(`  ${r.slug}  -${r.cleared} (${r.remaining} left)`);
  return results;
}
```

Register in `src/cli/index.ts` (import `runClear` from `./clear.js`, place after `list`):

```ts
program.command('clear')
  .aliases(['rm'])
  .summary('remove annotations from a base, or from every base')
  .description('Remove annotations once they have served their purpose — typically the ones\n'
    + 'already ruled Verified after a fix round.\n\n'
    + 'A scope is always required: --base <name> for one environment, --all for every\n'
    + 'one. Without --status the whole scope is emptied; --verified (or --status) narrows\n'
    + 'it. The base folder and its review metadata always survive, so the next review of\n'
    + 'that url keeps its review id.\n\n'
    + 'Screenshots of removed annotations are deleted too. Use --dry-run to see what\n'
    + 'would go, and --yes to skip the confirmation in scripts.')
  .argument('[dir]', 'review workspace', 'nit-review')
  .option('-b, --base <name>', 'clear this base — a slug, a url, or an unambiguous prefix')
  .option('--all', 'clear every base in the workspace')
  .option('--verified', 'only annotations ruled verified (same as --status verified)')
  .addOption(new Option('--status <status>', 'only annotations with this status')
    .choices(['open', 'fixed', 'wontfix', 'verified', 'reopened']))
  .option('-y, --yes', 'skip the confirmation prompt')
  .option('--dry-run', 'print what would be cleared and exit without writing')
  .addHelpText('after', `
Examples:
  $ nit clear --base staging --verified   drop what is already ruled on staging
  $ nit clear --all --verified            same, across every environment
  $ nit clear --base staging              empty staging entirely (prompts)
  $ nit clear --all --verified --dry-run  see what would go`)
  .action(async (dir: string, opts: {
    base?: string; all?: boolean; verified?: boolean; status?: AnnotationStatus;
    yes?: boolean; dryRun?: boolean;
  }) => {
    await runClear(dir, {
      base: opts.base,
      all: opts.all,
      // --verified is sugar; an explicit --status wins if somebody passes both
      status: opts.status ?? (opts.verified ? 'verified' : undefined),
      yes: opts.yes,
      dryRun: opts.dryRun,
    });
  });
```

Note: `runClear` is async, so the tests calling it must `await`. Update the test file's calls to `await runClear(...)` and mark those test callbacks `async`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/cli-clear.test.js`
Expected: PASS (8 tests). The thrown-error tests use `assert.rejects` rather than `assert.throws` because `runClear` is async — adjust them if they fail on that.

- [ ] **Step 5: Commit**

```bash
git add src/cli/clear.ts src/cli/index.ts test/cli-clear.test.js
git commit -m "feat(cli): nit clear removes annotations by base and status"
```

---

### Task 10: `nit status` and `nit view` / `nit verify` become base-aware

**Files:**
- Modify: `src/cli/status.ts`
- Modify: `src/cli/source.ts`
- Modify: `src/cli/index.ts` (add `--base` to `status`, `view`, `verify`)
- Test: `test/cli-status.test.js`, `test/cli-source.test.js`

**Interfaces:**
- Consumes: `openWorkspace`, `resolveBase`, `describeBases` (Tasks 3–4).
- Produces: `StatusOptions.base?: string`; `resolveFeedbackSource(cmd, input, explicit, base?)`.

- [ ] **Step 1: Write the failing test**

Append to `test/cli-status.test.js`:

```js
test('status: a multi-base workspace reports every base', () => {
  const dir = tmpDir('nit-status-ws-');
  for (const [url, alias] of [['https://staging.example.com', 'staging'], ['http://localhost:4200', undefined]]) {
    const base = ensureBase(dir, url, alias);
    const store = createStore(base.dir, { url: base.url, author: 'Kevin' });
    store.upsert({
      id: 'a1', type: 'change-request', comment: 'c', status: 'open', author: 'Kevin',
      viewportScope: 'general', viewport: { mode: 'desktop', w: 1440, h: 900 }, route: '/',
      target: { component: 'div', ngComponent: null, selector: '.x', xpath: '/html[1]', tag: 'div', classes: [], text: '', rect: { x: 0, y: 0, w: 1, h: 1 } },
      screenshot: null, createdAt: '2026-07-20T10:00:00Z',
    });
    store.flush();
  }
  const lines = [];
  runStatus(dir, { log: l => lines.push(l) });
  const text = lines.join('\n');
  assert.match(text, /staging/);
  assert.match(text, /localhost-4200/);
  assert.match(text, /2 annotations/);
});

test('status: --base narrows to one base', () => {
  const dir = tmpDir('nit-status-ws-');
  const base = ensureBase(dir, 'https://staging.example.com', 'staging');
  createStore(base.dir, { url: base.url, author: 'Kevin' }).flush();
  ensureBase(dir, 'http://localhost:4200');
  const lines = [];
  runStatus(dir, { base: 'staging', log: l => lines.push(l) });
  assert.doesNotMatch(lines.join('\n'), /localhost-4200/);
});
```

Add the imports `ensureBase` from `../dist/store/workspace.js` and `createStore` from `../dist/store/store.js` at the top of that file if they are not already there.

Append to `test/cli-source.test.js`:

```js
test('source: several bases and no --base is an error naming them', () => {
  const dir = tmpDir('nit-source-ws-');
  for (const [url, alias] of [['https://staging.example.com', 'staging'], ['http://localhost:4200', undefined]]) {
    const base = ensureBase(dir, url, alias);
    const store = createStore(base.dir, { url: base.url });
    store.upsert({ id: 'a1', type: 'change-request', status: 'open', comment: 'c', route: '/' });
    store.flush();
  }
  assert.throws(() => resolveFeedbackSource('view', dir, true), /--base/);
  assert.throws(() => resolveFeedbackSource('view', dir, true), /staging/);
});

test('source: one base is used without asking', () => {
  const dir = tmpDir('nit-source-ws-');
  const base = ensureBase(dir, 'https://staging.example.com', 'staging');
  const store = createStore(base.dir, { url: base.url });
  store.upsert({ id: 'a1', type: 'change-request', status: 'open', comment: 'c', route: '/' });
  store.flush();
  assert.equal(resolveFeedbackSource('view', dir, true).file, base.file);
});

test('source: --base picks one of several', () => {
  const dir = tmpDir('nit-source-ws-');
  for (const [url, alias] of [['https://staging.example.com', 'staging'], ['http://localhost:4200', undefined]]) {
    const base = ensureBase(dir, url, alias);
    const store = createStore(base.dir, { url: base.url });
    store.upsert({ id: 'a1', type: 'change-request', status: 'open', comment: 'c', route: '/' });
    store.flush();
  }
  const src = resolveFeedbackSource('view', dir, true, 'staging');
  assert.equal(src.file, path.join(dir, 'staging', 'annotations.json'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/cli-status.test.js test/cli-source.test.js`
Expected: FAIL — `runStatus` throws "no annotations.json in …" for a workspace dir, and `resolveFeedbackSource` takes only three arguments.

- [ ] **Step 3: Write minimal implementation**

In `src/cli/status.ts`, add `base?: string;` to `StatusOptions` with the JSDoc `/** only this base — a slug, a url, or an unambiguous prefix */`, then at the top of `runStatus`, before `resolveReviewFile`:

```ts
  // A workspace holds one review per base url. Resolve which review file this
  // report is about before falling through to the single-review path.
  const ws = openWorkspace(input);
  if (ws.layout === 'multi') {
    const bases = base ? [resolveBase(ws, base)] : ws.bases;
    return reportWorkspace(ws, bases, { json, log, now });
  }
```

Extend the exported `ReviewStats` in `src/store/stats.ts` with:

```ts
  /** per-base breakdown; present only for a multi-base workspace */
  bases?: { slug: string; url: string; total: number; actionable: number }[];
```

Add `reportWorkspace` to `src/cli/status.ts`, keeping the existing single-review path untouched below it:

```ts
/**
 * Report on a workspace: the same numbers as a single review, once per base,
 * plus the totals. The first base's stats carry the aggregate's shape so a
 * `--json` consumer sees one familiar object either way.
 * @param bases the bases to report on (all of them, or the one `--base` named)
 */
function reportWorkspace(
  ws: Workspace,
  bases: BaseRef[],
  { json, log, now }: { json: boolean; log: (line: string) => void; now: Date },
): ReviewStats {
  const per = bases.map(ref => ({
    ref,
    stats: reviewStats(readReviewData(ref.file), ref.file),
  }));
  const total = per.reduce((n, p) => n + p.stats.total, 0);
  const actionable = per.reduce((n, p) => n + p.stats.actionable, 0);
  const byStatus: Partial<Record<AnnotationStatus, number>> = {};
  for (const p of per) {
    for (const [status, count] of Object.entries(p.stats.byStatus)) {
      byStatus[status as AnnotationStatus] = (byStatus[status as AnnotationStatus] ?? 0) + count;
    }
  }

  const aggregate: ReviewStats = {
    ...(per[0]?.stats ?? emptyStats(ws.dir)),
    file: ws.dir,
    dir: ws.dir,
    total,
    actionable,
    byStatus,
    bases: per.map(p => ({
      slug: p.ref.slug,
      url: p.ref.url,
      total: p.stats.total,
      actionable: p.stats.actionable,
    })),
  };

  if (json) {
    log(JSON.stringify(aggregate, null, 2));
    return aggregate;
  }

  log(`nit status — ${displayPath(ws.dir)}`);
  log('');
  for (const { ref, stats } of per) {
    log(row(ref.slug, [
      ref.url,
      `${stats.total} annotation${stats.total === 1 ? '' : 's'}`,
      `${stats.actionable} actionable`,
      stats.lastChange ? ago(stats.lastChange.at, now) : null,
    ]));
  }
  log('');
  log(row('total', `${total} annotation${total === 1 ? '' : 's'} across ${per.length} base URL${per.length === 1 ? '' : 's'} · ${actionable} actionable`));
  log('');
  for (const line of workspaceNextSteps(ws, per)) log(line);
  return aggregate;
}

/** What to do with this workspace right now. */
function workspaceNextSteps(ws: Workspace, per: { ref: BaseRef; stats: ReviewStats }[]): string[] {
  const steps: string[] = [];
  const waiting = per.find(p => p.stats.actionable);
  if (waiting) steps.push(`${waiting.stats.actionable} actionable on ${waiting.ref.slug} — hand them to an agent:  nit mcp ${displayPath(ws.dir)}`);
  const fixed = per.find(p => p.stats.byStatus.fixed);
  if (fixed) steps.push(`${fixed.stats.byStatus.fixed} fixed on ${fixed.ref.slug}, waiting on you:  nit verify ${displayPath(ws.dir)} --base ${fixed.ref.slug}`);
  const verified = per.find(p => p.stats.byStatus.verified);
  if (verified) steps.push(`${verified.stats.byStatus.verified} already ruled on ${verified.ref.slug} — tidy up:  nit clear --base ${verified.ref.slug} --verified`);
  if (!steps.length) steps.push(`Nothing actionable — see what is where:  nit list ${displayPath(ws.dir)}`);
  return steps;
}

/** Parse a review file for stats; an unreadable one counts as empty rather than fatal. */
function readReviewData(file: string): ReviewData {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ReviewData;
  } catch {
    return { review: { id: '', url: '', createdAt: '', authors: [] }, annotations: [] };
  }
}

/** The shape a workspace with no readable base still has to return. */
function emptyStats(dir: string): ReviewStats {
  return {
    file: dir, dir, review: {}, total: 0, actionable: 0, byStatus: {}, byType: {},
    routes: [], lastChange: null, fileUpdatedAt: null, screenshots: { files: 0, bytes: 0 },
  };
}
```

Add `import { openWorkspace, resolveBase } from '../store/workspace.js';` and the `AnnotationStatus`, `BaseRef`, `Workspace` types to the imports at the top of `status.ts`.

In `src/cli/source.ts`, change the signature and add the resolution up front:

```ts
export function resolveFeedbackSource(
  cmd: 'view' | 'verify',
  input: string,
  explicit: boolean,
  base?: string,
): FeedbackSource {
  // view and verify drive a browser at exactly one site, so a workspace has to
  // narrow to a single base first. One base is used silently; several require a
  // choice rather than a guess.
  const ws = openWorkspace(input);
  if (ws.layout === 'multi') {
    if (base) return readSource(cmd, resolveBase(ws, base).file, true);
    if (ws.bases.length === 1) return readSource(cmd, ws.bases[0].file, true);
    throw new Error(`${displayPath(ws.dir)} holds ${ws.bases.length} base URLs — pass --base to pick one\n`
      + `  bases: ${describeBases(ws)}\n`
      + `  e.g.  nit ${cmd} ${input} --base ${ws.bases[0].slug}`);
  }
  return readSource(cmd, resolveReviewFile(input).file, explicit, input);
}
```

Extract the existing body (parse, validate, verify-has-fixed checks) into `readSource(cmd, file, explicit, input?)` so both paths share it.

In `src/cli/index.ts`: add `--base` to `status`, `view` and `verify` (reuse the same option text as `list`), thread `opts.base` into `runStatus` and `resolveFeedbackSource`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/cli-status.test.js test/cli-source.test.js`
Expected: PASS, including the pre-existing tests in both files.

- [ ] **Step 5: Commit**

```bash
git add src/cli/status.ts src/cli/source.ts src/cli/index.ts src/store/stats.ts test/cli-status.test.js test/cli-source.test.js
git commit -m "feat(cli): status, view and verify understand multi-base workspaces"
```

---

### Task 11: MCP aggregation layer

**Files:**
- Create: `src/mcp/aggregate.ts`
- Modify: `src/mcp/server.ts` (accept a workspace, update `INSTRUCTIONS`)
- Test: `test/helpers/mcp.js` (add a workspace fixture), `test/mcp.test.js`

**Interfaces:**
- Consumes: `openWorkspace`, `resolveBase`, `qualifyId`, `parseQualifiedId` (Tasks 2–4).
- Produces:
  - `BaseSummary { slug, url, total, actionable }`
  - `Located { base: BaseRef; store: Store; annotation: Annotation }`
  - `basesOf(dir: string): BaseRef[]`
  - `baseSummaries(dir: string): BaseSummary[]`
  - `isMultiBase(dir: string): boolean`
  - `findAnnotation(dir: string, qualified: string): Located | null`
  - `displayId(multi: boolean, slug: string, id: string): string`

- [ ] **Step 1: Write the failing test**

Add to `test/helpers/mcp.js`:

```js
/**
 * A workspace with two bases: staging (a1 open change-request with a shot, a2
 * comment) and localhost-4200 (a1 verified change-request).
 * @returns {string} the workspace directory
 */
export function makeWorkspaceDir() {
  const dir = tmpDir('nit-mcp-ws-');
  for (const [slug, url, annotations] of [
    ['staging', 'https://staging.example.com', [
      { id: 'a1', type: 'change-request', status: 'open', screenshot: 'shots/a1.png' },
      { id: 'a2', type: 'comment', status: 'open', screenshot: null },
    ]],
    ['localhost-4200', 'http://localhost:4200', [
      { id: 'a1', type: 'change-request', status: 'verified', screenshot: null },
    ]],
  ]) {
    const baseDir = path.join(dir, slug);
    fs.mkdirSync(path.join(baseDir, 'shots'), { recursive: true });
    fs.writeFileSync(path.join(baseDir, 'shots', 'a1.png'), PNG_1PX);
    fs.writeFileSync(path.join(baseDir, 'annotations.json'), JSON.stringify({
      review: { id: `fixture-${slug}`, url, createdAt: '2026-07-20T10:00:00Z', authors: ['Kevin'] },
      annotations: annotations.map(a => ({
        comment: `c ${a.id}`, author: 'Kevin', viewportScope: 'general',
        viewport: { mode: 'desktop', w: 1440, h: 900 }, route: '/checkout',
        target: { component: 'div', ngComponent: null, selector: '.x', xpath: '/html[1]', tag: 'div', classes: [], text: '', rect: { x: 0, y: 0, w: 1, h: 1 } },
        createdAt: '2026-07-20T10:01:00Z', ...a,
      })),
    }, null, 2));
  }
  fs.writeFileSync(path.join(dir, 'bases.json'), JSON.stringify({
    version: 1,
    bases: [
      { slug: 'staging', url: 'https://staging.example.com' },
      { slug: 'localhost-4200', url: 'http://localhost:4200' },
    ],
  }, null, 2));
  return dir;
}

/**
 * A workspace fixture served over MCP, with the same `call` shortcut as
 * {@link startFixtureMcp}.
 * @param {import('node:test').TestContext} t closes the client when the test ends
 */
export async function startWorkspaceMcp(t) {
  const dir = makeWorkspaceDir();
  const client = await startMcpClient(dir);
  t.after(() => client.close());
  return { dir, client, call: (name, args) => client.callTool({ name, arguments: args }) };
}
```

Append to `test/mcp.test.js`:

```js
test('mcp: a workspace lists every base with qualified ids', async (t) => {
  const { call } = await startWorkspaceMcp(t);
  const res = payload(await call('nit_list_annotations', {}));
  assert.equal(res.total, 3);
  assert.equal(res.actionable, 1); // staging a1 only; a2 is a comment, localhost a1 verified
  assert.deepEqual(res.bases.map(b => b.slug).sort(), ['localhost-4200', 'staging']);
  const ids = res.annotations.map(a => a.id).sort();
  assert.deepEqual(ids, ['localhost-4200:a1', 'staging:a1', 'staging:a2']);
  const staging = res.annotations.find(a => a.id === 'staging:a1');
  assert.equal(staging.base, 'staging');
  assert.equal(staging.url, 'https://staging.example.com/checkout');
});

test('mcp: the base filter narrows to one environment', async (t) => {
  const { call } = await startWorkspaceMcp(t);
  for (const base of ['staging', 'https://staging.example.com', 'stag']) {
    const res = payload(await call('nit_list_annotations', { base }));
    assert.deepEqual(res.annotations.map(a => a.id).sort(), ['staging:a1', 'staging:a2'], base);
  }
});

test('mcp: get and mark_fixed take qualified ids across bases', async (t) => {
  const { call } = await startWorkspaceMcp(t);
  const batch = payload(await call('nit_get_annotation', { id: ['staging:a1', 'localhost-4200:a1'] }));
  assert.deepEqual(batch.annotations.map(a => a.id).sort(), ['localhost-4200:a1', 'staging:a1']);

  const fixed = payload(await call('nit_mark_fixed', { id: 'staging:a1', reason: 'done' }));
  assert.equal(fixed.annotation.id, 'staging:a1');
  assert.equal(fixed.annotation.status, 'fixed');

  const after = payload(await call('nit_list_annotations', { base: 'localhost-4200' }));
  assert.equal(after.annotations[0].status, 'verified', 'the other base is untouched');
});

test('mcp: an unknown qualified id is an error naming it', async (t) => {
  const { call } = await startWorkspaceMcp(t);
  const res = await call('nit_get_annotation', { id: 'staging:a99' });
  assert.ok(res.isError);
  assert.match(res.content[0].text, /staging:a99/);
});

test('mcp: a single-base review keeps plain ids and the review envelope', async (t) => {
  const { call } = await startFixtureMcp(t);
  const res = payload(await call('nit_list_annotations', {}));
  assert.deepEqual(res.annotations.map(a => a.id), ['a1', 'a2']);
  assert.ok(res.review, 'single-base output is unchanged');
  assert.equal(payload(await call('nit_mark_fixed', { id: 'a1' })).annotation.id, 'a1');
});
```

Import `startWorkspaceMcp` in `test/mcp.test.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/mcp.test.js`
Expected: FAIL — `nit mcp <workspace>` throws "no annotations.json in …" at startup.

- [ ] **Step 3: Write minimal implementation**

Create `src/mcp/aggregate.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
// Workspace-aware lookup for the MCP layer. A review folder may hold several
// base urls, each its own review folder; the tools present them as one review
// with base-qualified ids. Ids on disk are never rewritten — qualification
// happens here, on the way out, and is undone here, on the way in.
import { openWorkspace, resolveBase, qualifyId, parseQualifiedId } from '../store/workspace.js';
import { createStore } from '../store/store.js';
import type { Store } from '../store/store.js';
import { isActionable } from '../store/stats.js';
import type { Annotation, BaseRef } from '../types.js';

/** One base's headline numbers, as reported by nit_list_annotations. */
export interface BaseSummary {
  slug: string;
  url: string;
  total: number;
  actionable: number;
}

/** An annotation found in a workspace, with the base and store it came from. */
export interface Located {
  base: BaseRef;
  store: Store;
  annotation: Annotation;
}

/**
 * Every base in the workspace, or just the one a `base` argument names.
 * @param dir the workspace directory
 * @param base optional slug, url or unambiguous prefix
 * @throws when `base` names no base
 */
export function basesOf(dir: string, base?: string): BaseRef[] {
  const ws = openWorkspace(dir);
  return base ? [resolveBase(ws, base)] : ws.bases;
}

/**
 * Whether ids need qualifying. A single-base workspace keeps plain `a1` ids and
 * the original `review` envelope, so existing .mcp.json registrations and
 * single-environment users see byte-identical output.
 * @param dir the workspace directory
 */
export function isMultiBase(dir: string): boolean {
  return openWorkspace(dir).bases.length > 1;
}

/** An id as the agent should see it: qualified only when there is more than one base. */
export function displayId(multi: boolean, slug: string, id: string): string {
  return multi ? qualifyId(slug, id) : id;
}

/**
 * Headline counts per base.
 * @param dir the workspace directory
 * @param base optional filter, see {@link basesOf}
 */
export function baseSummaries(dir: string, base?: string): BaseSummary[] {
  return basesOf(dir, base).map(ref => {
    const annotations = createStore(ref.dir).annotations;
    return {
      slug: ref.slug,
      url: ref.url,
      total: annotations.length,
      actionable: annotations.filter(isActionable).length,
    };
  });
}

/**
 * Resolve an id a caller supplied — qualified (`staging:a1`) or bare (`a1`) —
 * to the annotation and the store that owns it.
 *
 * The qualified form is tried first, then the whole string as a plain id across
 * every base. That fallback matters: on a single-base workspace a merged id like
 * `kevin:a1` parses as slug `kevin`, which is not a base.
 * @param dir the workspace directory
 * @param wanted the id as it arrived
 * @returns the located annotation, or null when nothing matches
 */
export function findAnnotation(dir: string, wanted: string): Located | null {
  const bases = basesOf(dir);
  const { slug, id } = parseQualifiedId(wanted);

  if (slug) {
    const ref = bases.find(b => b.slug === slug);
    if (ref) {
      const store = createStore(ref.dir);
      const annotation = store.annotations.find(a => a.id === id);
      if (annotation) return { base: ref, store, annotation };
    }
  }
  for (const ref of bases) {
    const store = createStore(ref.dir);
    const annotation = store.annotations.find(a => a.id === wanted);
    if (annotation) return { base: ref, store, annotation };
  }
  return null;
}
```

In `src/mcp/server.ts`, replace the startup guard so a workspace is accepted:

```ts
  const ws = openWorkspace(absDir);
  if (!ws.bases.length) {
    throw new Error(`no review in ${absDir} — no annotations.json and no base folders`);
  }
```

and extend `INSTRUCTIONS` with:

```
' A review may cover several base URLs (e.g. local, staging, production). When it does, every row '
+ 'carries its base slug and ids are qualified as "<base>:<id>" (e.g. staging:a1) — pass ids back in '
+ 'that exact form, and use the base parameter to work on one environment at a time. A single-base '
+ 'review keeps plain ids. '
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/mcp.test.js`
Expected: the first four new tests still fail (tools.ts is not wired yet) but the server starts. Wire the tools in Task 12; re-run there. If the *existing* single-base tests fail here, fix that before moving on.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/aggregate.ts src/mcp/server.ts test/helpers/mcp.js
git commit -m "feat(mcp): workspace-aware base lookup and qualified id resolution"
```

---

### Task 12: MCP tools over a workspace

**Files:**
- Modify: `src/mcp/tools.ts`
- Modify: `src/mcp/schema.ts` (add `base` to the list shape)
- Test: `test/mcp.test.js` (the tests written in Task 11)

**Interfaces:**
- Consumes: everything Task 11 produced.
- Produces: no new exports; `nit_list_annotations` rows gain `base` and `url`.

- [ ] **Step 1: Write the failing test**

Already written in Task 11. Confirm the four workspace tests fail for the right reason.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/mcp.test.js`
Expected: FAIL on `res.bases` being undefined and ids coming back unqualified.

- [ ] **Step 3: Write minimal implementation**

In `src/mcp/schema.ts`, add to `listInputShape`:

```ts
  base: z.string().optional()
    .describe('only annotations for this base URL — its slug (e.g. staging), its full url, or an unambiguous prefix'),
```

In `src/mcp/tools.ts`:

1. Replace the `createStore(dir)` calls in the handlers with the aggregate helpers.
2. `listAnnotations` becomes workspace-wide:

```ts
function listAnnotations(dir: string, { status, type, route, base }: {
  status?: AnnotationStatus;
  type?: Annotation['type'];
  route?: string;
  base?: string;
}): CallToolResult {
  const multi = isMultiBase(dir);
  const refs = basesOf(dir, base);
  const unfiltered = !status && !type && !route && !base;

  const annotations: AnnotationRow[] = [];
  let actionable = 0;
  for (const ref of refs) {
    for (const a of createStore(ref.dir).annotations) {
      if (status && a.status !== status) continue;
      if (type && a.type !== type) continue;
      // routes carry query strings: accept an exact match or a path-only filter
      if (route && a.route !== route && routePath(a.route) !== route) continue;
      if (isActionable(a)) actionable += 1;
      annotations.push({
        ...toRow(a),
        id: displayId(multi, ref.slug, a.id),
        // the base and the navigable page, so an agent never has to reassemble them
        ...(multi ? { base: ref.slug, url: resolveAnnotationUrl(ref.url, a.route) ?? a.route } : {}),
      });
    }
  }

  return structured({
    // A single-base review keeps the review envelope it has always had; a
    // workspace reports its bases instead, since there is no single review.
    ...(multi ? { bases: baseSummaries(dir, base) } : unfiltered ? { review: createStore(refs[0].dir).data.review } : {}),
    total: annotations.length,
    actionable,
    annotations,
  });
}
```

Extract the existing row mapping into `toRow(a: Annotation): AnnotationRow`, and add `base?: string; url?: string;` to the `AnnotationRow` interface.

3. `getAnnotation` resolves each id through `findAnnotation` and reports the qualified id back:

```ts
function getAnnotation(dir: string, id: string | string[], includeXpath: boolean, includeScreenshot: boolean): CallToolResult {
  const multi = isMultiBase(dir);
  const ids = Array.isArray(id) ? dedupe(id) : [id];
  const found: Located[] = [];
  const missing: string[] = [];
  for (const one of ids) {
    const hit = findAnnotation(dir, one);
    if (hit) found.push(hit);
    else missing.push(one);
  }
  if (found.length === 0) {
    return toolError(`no annotation with id ${Array.isArray(id) ? missing.join(', ') : id}`);
  }
  const records = found.map(({ base, annotation }) => ({
    ...buildAnnotationRecord(annotation, includeXpath),
    id: displayId(multi, base.slug, annotation.id),
    ...(multi ? { base: base.slug, url: resolveAnnotationUrl(base.url, annotation.route) ?? annotation.route } : {}),
  }));
  const result = structured(Array.isArray(id)
    ? { annotations: records, ...(missing.length ? { missing } : {}) }
    : { annotation: records[0] });

  if (includeScreenshot) {
    for (const { base, annotation } of found) {
      for (const rel of [annotation.screenshot, annotation.screenshotAfter]) {
        // shots live in the base's own folder, and the path is still guarded
        const abs = safeShotPath(base.dir, rel);
        if (!abs) continue;
        try {
          result.content.push({ type: 'image', data: fs.readFileSync(abs).toString('base64'), mimeType: 'image/png' });
        } catch { /* screenshot file missing — text is still useful */ }
      }
    }
  }
  return result;
}
```

4. `writeAnnotation` locates first, patches the owning store, and echoes the qualified id:

```ts
function writeAnnotation(dir: string, id: string, changes: Partial<Annotation>): CallToolResult {
  const hit = findAnnotation(dir, id);
  if (!hit) return toolError(`no annotation with id ${id}`);
  const ann = hit.store.patch(hit.annotation.id, changes, 'agent');
  if (!ann) return toolError(`no annotation with id ${id}`);
  hit.store.flush();
  writeDerivedFiles(hit.store);
  return structured({ annotation: { ...ann, id: displayId(isMultiBase(dir), hit.base.slug, ann.id) } });
}
```

`setStatus` and `setIssueRef` now take `dir` instead of a `Store` and delegate to it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/mcp.test.js`
Expected: PASS — all workspace tests plus every pre-existing single-base test.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.ts src/mcp/schema.ts test/mcp.test.js
git commit -m "feat(mcp): serve every base of a workspace from one server"
```

---

### Task 13: `nit_clear_verified`

**Files:**
- Modify: `src/mcp/tools.ts`, `src/mcp/schema.ts`, `src/mcp/server.ts` (INSTRUCTIONS)
- Test: `test/mcp.test.js`

**Interfaces:**
- Consumes: `clearBase` (Task 7), `basesOf` (Task 11).
- Produces: the `nit_clear_verified` tool.

- [ ] **Step 1: Write the failing test**

Append to `test/mcp.test.js`:

```js
test('mcp: nit_clear_verified removes only verified annotations', async (t) => {
  const { dir, call } = await startWorkspaceMcp(t);
  const res = payload(await call('nit_clear_verified', {}));
  assert.equal(res.cleared, 1);   // localhost-4200:a1 is the only verified one
  assert.equal(res.remaining, 2);

  const left = payload(await call('nit_list_annotations', {}));
  assert.deepEqual(left.annotations.map(a => a.id).sort(), ['staging:a1', 'staging:a2']);
  assert.ok(fs.existsSync(path.join(dir, 'localhost-4200', 'annotations.json')), 'the base folder survives');
});

test('mcp: nit_clear_verified can be scoped to one base', async (t) => {
  const { call } = await startWorkspaceMcp(t);
  const res = payload(await call('nit_clear_verified', { base: 'staging' }));
  assert.equal(res.cleared, 0, 'staging has nothing verified');
  assert.deepEqual(payload(await call('nit_list_annotations', {})).annotations.length, 3);
});

test('mcp: nit_clear_verified never touches unruled feedback', async (t) => {
  const { call } = await startWorkspaceMcp(t);
  await call('nit_mark_fixed', { id: 'staging:a1' });
  const res = payload(await call('nit_clear_verified', {}));
  const left = payload(await call('nit_list_annotations', {}));
  assert.ok(left.annotations.some(a => a.id === 'staging:a1'), 'a fixed item is not verified — it stays');
  assert.equal(res.cleared, 1);
});

test('mcp: clearing is advertised as destructive', async (t) => {
  const { client } = await startWorkspaceMcp(t);
  const { tools } = await client.listTools();
  const clear = tools.find(x => x.name === 'nit_clear_verified');
  assert.ok(clear, 'the tool is registered');
  assert.equal(clear.annotations.destructiveHint, true);
  assert.equal(clear.annotations.readOnlyHint, false);
});
```

Add `fs` and `path` imports to `test/mcp.test.js` if absent.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/mcp.test.js`
Expected: FAIL — "Tool nit_clear_verified not found".

- [ ] **Step 3: Write minimal implementation**

In `src/mcp/schema.ts`:

```ts
export const clearVerifiedInputShape = {
  base: z.string().optional()
    .describe('only this base URL — its slug (e.g. staging), its full url, or an unambiguous prefix; omit to clear every base'),
};
```

In `src/mcp/tools.ts`, add the destructive annotation constant and register the tool:

```ts
// The one tool that deletes. Clearing *unruled* feedback stays CLI-only, behind
// a confirmation prompt: an agent must not be able to remove human feedback
// nobody has ruled on yet.
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;
```

```ts
  server.registerTool('nit_clear_verified', {
    title: 'Clear verified annotations',
    description: 'Delete the annotations a human has already ruled "verified" — housekeeping after a fix round, once the '
      + 'work they describe is done and confirmed. Their screenshots are deleted with them. Everything else is left alone: '
      + 'open, reopened, fixed and wontfix annotations are never touched, and the review folder and its metadata survive. '
      + 'Omit `base` to sweep every base URL, or name one to clear a single environment. This cannot be undone.',
    inputSchema: clearVerifiedInputShape,
    annotations: DESTRUCTIVE,
  }, ({ base }) => guard(() => clearVerified(dir, base)));
```

```ts
/** Clear the verified annotations of one base, or of every base. */
function clearVerified(dir: string, base: string | undefined): CallToolResult {
  const results = basesOf(dir, base).map(ref => clearBase(ref, { status: 'verified' }));
  return structured({
    cleared: results.reduce((n, r) => n + r.cleared, 0),
    remaining: results.reduce((n, r) => n + r.remaining, 0),
    bases: results.map(r => ({ slug: r.slug, cleared: r.cleared, remaining: r.remaining })),
  });
}
```

Add the tool to `INSTRUCTIONS` in `src/mcp/server.ts`: `'Once a human has verified fixes, nit_clear_verified tidies those records away.'`

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/mcp.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.ts src/mcp/schema.ts src/mcp/server.ts test/mcp.test.js
git commit -m "feat(mcp): nit_clear_verified for post-verification housekeeping"
```

---

### Task 14: Base-scoped MCP resources

**Files:**
- Modify: `src/mcp/resources.ts`
- Test: `test/mcp-resources.test.js`

**Interfaces:**
- Consumes: `basesOf`, `isMultiBase`, `findAnnotation` (Task 11).
- Produces: `nit://base/{slug}/annotations.json`, `.../review.md`, `.../brief.md`, `nit://review/bases.md`.

- [ ] **Step 1: Write the failing test**

Append to `test/mcp-resources.test.js`:

```js
test('resources: bases.md lists every base with its counts', async (t) => {
  const { client } = await startWorkspaceMcp(t);
  const res = await client.readResource({ uri: 'nit://review/bases.md' });
  const text = res.contents[0].text;
  assert.match(text, /staging/);
  assert.match(text, /https:\/\/staging\.example\.com/);
  assert.match(text, /localhost-4200/);
});

test('resources: a base has its own annotations.json and brief.md', async (t) => {
  const { client } = await startWorkspaceMcp(t);
  const json = await client.readResource({ uri: 'nit://base/staging/annotations.json' });
  const data = JSON.parse(json.contents[0].text);
  assert.deepEqual(data.annotations.map(a => a.id), ['a1', 'a2']);
  assert.equal(data.review.url, 'https://staging.example.com');

  const brief = await client.readResource({ uri: 'nit://base/staging/brief.md' });
  assert.match(brief.contents[0].text, /a1/);
});

test('resources: an unsafe or unknown base slug is refused', async (t) => {
  const { client } = await startWorkspaceMcp(t);
  await assert.rejects(() => client.readResource({ uri: 'nit://base/nope/annotations.json' }), /nope/);
});

test('resources: unprefixed uris still work on a single-base review', async (t) => {
  const { client } = await startFixtureMcp(t);
  const res = await client.readResource({ uri: 'nit://review/annotations.json' });
  assert.deepEqual(JSON.parse(res.contents[0].text).annotations.map(a => a.id), ['a1', 'a2']);
});

test('resources: an unprefixed uri on a workspace says which base to ask for', async (t) => {
  const { client } = await startWorkspaceMcp(t);
  await assert.rejects(() => client.readResource({ uri: 'nit://review/annotations.json' }), /nit:\/\/base\/|staging/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/mcp-resources.test.js`
Expected: FAIL — resource `nit://review/bases.md` is not registered.

- [ ] **Step 3: Write minimal implementation**

In `src/mcp/resources.ts`:

1. Add a `soleBase(dir)` helper that returns the single `BaseRef` or throws a message naming the workspace's bases and the `nit://base/{slug}/…` form. Route every existing unprefixed callback through it instead of using `dir` directly — this keeps single-base reviews byte-identical and makes the multi-base case self-explaining.

```ts
/**
 * The one base an unprefixed `nit://review/…` uri refers to.
 * @throws on a workspace with several bases, naming them and the base-scoped form
 */
function soleBase(dir: string): BaseRef {
  const bases = basesOf(dir);
  if (bases.length === 1) return bases[0];
  throw new Error(`this review covers ${bases.length} base URLs (${bases.map(b => b.slug).join(', ')}) — `
    + `read nit://base/<slug>/annotations.json instead, or nit://review/bases.md for the overview`);
}
```

2. Register `nit://review/bases.md`:

```ts
  server.registerResource('bases-md', 'nit://review/bases.md', {
    title: 'bases.md',
    description: 'Every base URL in this review (e.g. local, staging, production) with its annotation counts — read this first when a review covers more than one environment.',
    mimeType: 'text/markdown',
  }, uri => ({
    contents: [{ uri: uri.href, mimeType: 'text/markdown', text: renderBasesMd(dir) }],
  }));
```

```ts
/** One markdown table row per base: slug, url, totals. */
function renderBasesMd(dir: string): string {
  const summaries = baseSummaries(dir);
  const lines = ['# Bases', '', '| base | url | annotations | actionable |', '| --- | --- | --- | --- |'];
  for (const b of summaries) lines.push(`| \`${b.slug}\` | ${b.url} | ${b.total} | ${b.actionable} |`);
  lines.push('', 'Annotation ids are qualified as `<base>:<id>` (e.g. `staging:a1`) when a review covers more than one base.');
  return lines.join('\n') + '\n';
}
```

3. Register the base-scoped template:

```ts
const BASE_FILES = ['annotations.json', 'review.md', 'brief.md'] as const;

  server.registerResource('base-file', new ResourceTemplate('nit://base/{slug}/{file}', {
    list: () => ({
      resources: basesOf(dir).flatMap(b => BASE_FILES.map(file => ({
        uri: `nit://base/${b.slug}/${file}`,
        name: `${b.slug}/${file}`,
        title: `${b.slug}: ${file}`,
        description: `${file} for ${b.url}`,
        mimeType: file.endsWith('.json') ? 'application/json' : 'text/markdown',
      }))),
    }),
    complete: {
      slug: value => basesOf(dir).map(b => b.slug).filter(s => s.startsWith(value)),
      file: value => BASE_FILES.filter(f => f.startsWith(value)),
    },
  }), {
    title: 'Base file',
    description: 'annotations.json, review.md or brief.md for one base URL of this review.',
  }, (uri, variables) => {
    const base = baseByVariable(dir, variables.slug);
    const file = one(variables.file);
    const json = file === 'annotations.json';
    return {
      contents: [{
        uri: uri.href,
        mimeType: json ? 'application/json' : 'text/markdown',
        text: json
          ? read(base.file)
          : file === 'brief.md'
            ? renderBriefMd(createStore(base.dir).data)
            : readOr(path.join(base.dir, 'review.md'), () => renderReviewMd(createStore(base.dir).data)),
      }],
    };
  });
```

```ts
/**
 * Resolve a `{slug}` template variable to a base by matching the workspace's
 * *enumerated* bases. The slug is never joined into a path directly — it arrives
 * from a client and a crafted `../../` must not resolve to anything.
 * @throws when no base has that slug
 */
function baseByVariable(dir: string, raw: string | string[] | undefined): BaseRef {
  const slug = decodeId(one(raw));
  const base = basesOf(dir).find(b => b.slug === slug);
  if (!base) throw new Error(`no base "${slug}" — known bases: ${basesOf(dir).map(b => b.slug).join(', ')}`);
  return base;
}

/** Template variables arrive as a string or a single-element array. */
function one(raw: string | string[] | undefined): string {
  return (Array.isArray(raw) ? raw[0] : raw) ?? '';
}
```

4. Change `annotationById` so the `nit://annotation/{id}` family accepts qualified ids and reads shots from the owning base's folder:

```ts
/** Resolve the `{id}` variable of a filled-in template to its annotation and base. */
function locate(dir: string, variables: Variables): Located {
  const id = decodeId(one(variables.id));
  const hit = findAnnotation(dir, id);
  if (!hit) throw new Error(`no annotation with id ${id}`);
  return hit;
}
```

Both `registerShotResource`'s callback and the annotation resource callback use it, replacing `annotationById(dir, variables)` with `locate(dir, variables)` and `safeShotPath(dir, …)` with `safeShotPath(hit.base.dir, …)`. Their `list` and `complete` callbacks enumerate every base: `basesOf(dir).flatMap(b => createStore(b.dir).annotations.map(a => ({ base: b, ann: a })))`, using `displayId(isMultiBase(dir), b.slug, a.id)` for the uri fragment so listed ids match what the tools hand out.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/mcp-resources.test.js`
Expected: PASS, including every pre-existing single-base resource test.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/resources.ts test/mcp-resources.test.js
git commit -m "feat(mcp): base-scoped resources and a bases.md overview"
```

---

### Task 15: `nit export` / `nit import` handle a workspace

**Files:**
- Modify: `src/cli/export.ts`, `src/cli/import.ts`, `src/cli/index.ts`
- Test: `test/cli-export-import.test.js`

**Interfaces:**
- Consumes: `openWorkspace`, `resolveBase` (Tasks 3–4).
- Produces: `ExportOptions.base?: string`.

- [ ] **Step 1: Write the failing test**

Append to `test/cli-export-import.test.js`:

```js
test('export/import: a workspace round-trips with every base', () => {
  const dir = tmpDir('nit-ws-export-');
  for (const [url, alias] of [['https://staging.example.com', 'staging'], ['http://localhost:4200', undefined]]) {
    const base = ensureBase(dir, url, alias);
    const store = createStore(base.dir, { url: base.url, author: 'Kevin' });
    store.upsert({ id: 'a1', type: 'change-request', status: 'open', comment: 'c', route: '/', screenshot: null, createdAt: '2026-07-20T10:00:00Z' });
    store.flush();
  }
  const zip = path.join(tmpDir('nit-ws-zip-'), 'ws.nit.zip');
  runExport(dir, { out: zip, log: () => {} });

  const target = path.join(tmpDir('nit-ws-in-'), 'restored');
  runImport(zip, { out: target, log: () => {} });

  const ws = openWorkspace(target);
  assert.equal(ws.layout, 'multi');
  assert.deepEqual(ws.bases.map(b => b.slug), ['localhost-4200', 'staging']);
  assert.ok(fs.existsSync(path.join(target, 'bases.json')));
});

test('export: --base packs one base in the single-review zip format', () => {
  const dir = tmpDir('nit-ws-export-');
  const base = ensureBase(dir, 'https://staging.example.com', 'staging');
  const store = createStore(base.dir, { url: base.url, author: 'Kevin' });
  store.upsert({ id: 'a1', type: 'change-request', status: 'open', comment: 'c', route: '/', screenshot: null, createdAt: '2026-07-20T10:00:00Z' });
  store.flush();
  ensureBase(dir, 'http://localhost:4200');

  const zip = path.join(tmpDir('nit-ws-zip-'), 'one.nit.zip');
  runExport(dir, { base: 'staging', out: zip, log: () => {} });

  const target = path.join(tmpDir('nit-ws-in-'), 'one');
  runImport(zip, { out: target, log: () => {} });
  assert.ok(fs.existsSync(path.join(target, 'annotations.json')), 'a plain review folder, as before');
  assert.equal(openWorkspace(target).layout, 'flat');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/cli-export-import.test.js`
Expected: FAIL — export throws "no annotations.json in …" for the workspace dir.

- [ ] **Step 3: Write minimal implementation**

In `src/cli/export.ts`: add `base?: string` to `ExportOptions`, and branch at the top of `runExport`:

```ts
  const ws = openWorkspace(input);
  // A base named explicitly, or a workspace that only has one, packs the plain
  // single-review zip `nit import` has always produced — shared zips and the
  // co-founder flow are unaffected by the workspace layout.
  if (ws.layout === 'multi') {
    if (base) return packReview(resolveBase(ws, base).dir, out, log);
    return packWorkspace(ws, out, log);
  }
```

Extract today's body verbatim into `packReview(dir, out, log)` — the single-review zip format must not change. Add:

```ts
/**
 * Pack a whole workspace: its base index plus every base's review folder, each
 * under its own slug. The counterpart is `nit import`, which recognises the
 * nested shape and restores the workspace as it was.
 * @param ws the workspace to pack
 * @param out output zip path, or undefined for the derived name
 */
function packWorkspace(ws: Workspace, out: string | undefined, log: (line: string) => void): ExportResult {
  const entries: Record<string, Uint8Array> = {};
  const index = path.join(ws.dir, BASES_FILE);
  if (fs.existsSync(index)) entries[BASES_FILE] = fs.readFileSync(index);

  for (const base of ws.bases) {
    entries[`${base.slug}/annotations.json`] = fs.readFileSync(base.file);
    for (const extra of ['review.md', 'fix-annotations.md']) {
      const p = path.join(base.dir, extra);
      if (fs.existsSync(p)) entries[`${base.slug}/${extra}`] = fs.readFileSync(p);
    }
    const shotsDir = path.join(base.dir, 'shots');
    if (!fs.existsSync(shotsDir)) continue;
    for (const name of fs.readdirSync(shotsDir)) {
      const p = path.join(shotsDir, name);
      if (fs.statSync(p).isFile()) entries[`${base.slug}/shots/${name}`] = fs.readFileSync(p);
    }
  }

  const file = path.resolve(out ?? `${slugify(path.basename(ws.dir))}-workspace.nit.zip`);
  fs.writeFileSync(file, zipSync(entries, { level: 6 }));
  const count = Object.keys(entries).length;
  log(`exported ${count} file${count === 1 ? '' : 's'} from ${ws.bases.length} base URL${ws.bases.length === 1 ? '' : 's'} -> ${file}`);
  log(`share it — the other side runs:  nit import ${path.basename(file)}`);
  return { file, files: count };
}
```

Import `BASES_FILE` and the `Workspace` type from `../store/workspace.js`.

In `src/cli/import.ts`, relax the shape check:

```ts
  const isWorkspace = Object.keys(entries).some(name => /^[^/]+\/annotations\.json$/.test(name));
  if (!entries['annotations.json'] && !isWorkspace) {
    throw new Error(`not a nit export: ${path.basename(absZip)} has no annotations.json`);
  }
```

The existing `safeEntryPath` already handles the nested paths, so unpacking needs no other change. Adjust the closing hints to point at `nit list` for a workspace.

In `src/cli/index.ts`, add `-b, --base <name>` to the `export` command and pass it through.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/cli-export-import.test.js`
Expected: PASS, including the pre-existing single-review round-trip tests.

- [ ] **Step 5: Commit**

```bash
git add src/cli/export.ts src/cli/import.ts src/cli/index.ts test/cli-export-import.test.js
git commit -m "feat(cli): export and import a whole multi-base workspace"
```

---

### Task 16: `nit doctor` reports the layout

**Files:**
- Modify: `src/cli/doctor.ts`
- Test: `test/cli-doctor.test.js`

**Interfaces:**
- Consumes: `openWorkspace` (Task 3).
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Write the failing test**

Append to `test/cli-doctor.test.js`:

```js
test('doctor: reports the review layout it finds', async () => {
  const cwd = tmpDir('nit-doctor-ws-');
  ensureBase(path.join(cwd, 'nit-review'), 'https://staging.example.com', 'staging');
  ensureBase(path.join(cwd, 'nit-review'), 'http://localhost:4200');
  const lines = [];
  await runDoctor({ yes: false, cwd, log: l => lines.push(l) });
  const text = lines.join('\n');
  assert.match(text, /2 base URLs|staging/);
});
```

If `runDoctor` has no `cwd` or `log` option, add both (`cwd` defaulting to `process.cwd()`, `log` to `console.log`) as part of this task — the existing doctor tests will show the current signature.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/cli-doctor.test.js`
Expected: FAIL — no layout line in the output.

- [ ] **Step 3: Write minimal implementation**

Add a check to `runDoctor` that opens `nit-review` (relative to `cwd`) and reports one line:

```ts
  // A confused review folder is much easier to diagnose when doctor says what
  // shape it is in.
  const ws = openWorkspace(path.join(cwd, 'nit-review'));
  log(ws.layout === 'multi'
    ? `  review folder   ${ws.bases.length} base URL${ws.bases.length === 1 ? '' : 's'}: ${ws.bases.map(b => b.slug).join(', ')}`
    : ws.layout === 'flat'
      ? `  review folder   one review (${ws.bases[0].url || 'no url recorded'})`
      : '  review folder   none yet — run: nit review <url>');
```

Match the surrounding formatting of the existing checks rather than copying this verbatim.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/cli-doctor.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/doctor.ts test/cli-doctor.test.js
git commit -m "feat(cli): doctor reports the review folder layout"
```

---

### Task 17: Documentation

**Files:**
- Modify: `README.md`, `docs/wiki/commands.md`, `docs/wiki/mcp.md`, `docs/wiki/annotations.md`, `docs/wiki/getting-started.md`, `docs/wiki/how-it-works.md`, `docs/workflow.md`, `src/README.md`
- Test: `test/cli-help.test.js`

**Interfaces:**
- Consumes: the finished commands.
- Produces: nothing code depends on.

- [ ] **Step 1: Write the failing test**

Append to `test/cli-help.test.js`:

```js
test('cli: list and clear appear in help with their flags', () => {
  const top = run('--help');
  assert.ok(top.out.includes('list'));
  assert.ok(top.out.includes('clear'));

  const list = run('list', '--help');
  assert.equal(list.code, 0);
  for (const flag of ['--base', '--all', '--status', '--actionable', '--json']) {
    assert.ok(list.out.includes(flag), `list help mentions ${flag}`);
  }

  const clear = run('clear', '--help');
  assert.equal(clear.code, 0);
  for (const flag of ['--base', '--all', '--verified', '--dry-run', '--yes']) {
    assert.ok(clear.out.includes(flag), `clear help mentions ${flag}`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/cli-help.test.js`
Expected: PASS if Tasks 8-9 wired the help text correctly; FAIL names the missing flag. Fix `src/cli/index.ts` if it fails — the docs must describe what the CLI actually does.

- [ ] **Step 3: Write the documentation**

Work through each file:

**`README.md`** — add to the command table, after `nit status`:

```markdown
| `nit list [dir]` | `ls` | List the base URLs in a review, or the annotated urls in one |
| `nit clear [dir]` | `rm` | Remove annotations from a base, or from every base |
```

Replace the "What you get" tree with the workspace shape, and keep a one-line note that a single-environment review stays flat:

```
nit-review/
├─ bases.json           # the base URLs this review covers
├─ staging/             # one review folder per base URL
│  ├─ annotations.json  #   structured, agent-readable
│  ├─ review.md         #   human-readable, screenshots embedded
│  ├─ fix-annotations.md#   the contract for the fixing agent
│  └─ shots/*.png       #   context screenshots (+ after-shots from nit verify)
└─ localhost-4200/
   └─ …

A review of a single site stays flat — annotations.json sits directly in nit-review/.
```

Extend the "Agent handoff" paragraph with one sentence: one MCP server covers every environment, rows carry their base, ids are qualified `staging:a1`, and `nit_clear_verified` tidies up after a verify round.

**`docs/wiki/commands.md`** — add `## nit list [dir] (alias: ls)` and `## nit clear [dir] (alias: rm)` sections in the same style as the existing ones, documenting every flag from Tasks 8 and 9 with two or three examples each. Add `--base` to the `nit review`, `nit view`, `nit verify`, `nit status` and `nit export` sections. Add `-v, --version` and `-h, --help` to the top.

**`docs/wiki/mcp.md`** — a "Reviews with several base URLs" section: what a base is, that ids are qualified `<base>:<id>` on a multi-base review and plain on a single-base one, the `base` parameter on `nit_list_annotations` and `nit_clear_verified`, the `base` and `url` fields on each row, the base-scoped resource URIs and `nit://review/bases.md`. State plainly that agents can only clear *verified* annotations and that full clearing is CLI-only.

**`docs/wiki/annotations.md`** — a "Where annotations live" section covering the workspace layout and `bases.json` (with its schema), plus an explicit sentence that the annotation schema itself is unchanged and ids on disk stay `a1`.

**`docs/wiki/getting-started.md`** and **`docs/workflow.md`** — a short "Several environments" section: annotate staging, hand it to the agent, verify, `nit clear --base staging --verified`, repeat on production.

**`docs/wiki/how-it-works.md`** — where the workspace sits (above the store, below the CLI), that `bases.json` is an index rather than the source of truth, that migration is lazy, and that slugs are validated before becoming path segments.

**`src/README.md`** — add `store/workspace.ts`, `store/clear.ts`, `store/derived.ts`, `cli/list.ts`, `cli/clear.ts` and `mcp/aggregate.ts` to the directory map, and bring the map back in sync with the modules it is already missing: `cli/status.ts`, `cli/source.ts`, `store/stats.ts`, `util/user-config.ts`, `util/version.ts`, `mcp/tools.ts`, `mcp/resources.ts`, `mcp/schema.ts`, `mcp/history.ts`, `overlay/frame-shields.ts`. Add `store/workspace.ts`'s pure functions to the "Pure modules stay pure" list.

- [ ] **Step 4: Verify the docs match reality**

Run: `npm run build && node --test test/cli-help.test.js`
Then check every command example in the new docs actually runs:

```bash
node dist/cli/index.js list --help
node dist/cli/index.js clear --help
node dist/cli/index.js list nit-review
```

- [ ] **Step 5: Commit**

```bash
git add README.md docs/ src/README.md test/cli-help.test.js
git commit -m "docs: multi-base workspaces, nit list and nit clear"
```

---

### Task 18: Full-suite gate

**Files:** none (verification only).

- [ ] **Step 1: Build and run everything**

```bash
npm run build && node --test
```

Expected: every test passes. The browser tests need Chromium — run `node dist/cli/index.js doctor --yes` first if they fail to launch.

- [ ] **Step 2: Lint and typecheck**

```bash
npm run lint && npm run typecheck
```

Expected: clean. Fix anything reported — do not disable a rule to get past it.

- [ ] **Step 3: Exercise the real review folder in this repo**

The repo's own `nit-review/` is a flat review of `https://fainin.dev/` with 7 annotations — a genuine migration subject. Copy it (never migrate the original in place) and drive the whole feature through it:

```bash
cp -r nit-review /tmp/nit-ws && node dist/cli/index.js list /tmp/nit-ws
node dist/cli/index.js status /tmp/nit-ws
node dist/cli/index.js clear /tmp/nit-ws --base fainin-dev --verified --dry-run
```

Expected: `list` shows one base `fainin-dev` with 7 annotations; `status` reports as it always has; the dry run reports without writing.

- [ ] **Step 4: Check the published surface**

```bash
npm pack --dry-run
```

Expected: `dist/` contains `store/workspace.js`, `store/clear.js`, `store/derived.js`, `cli/list.js`, `cli/clear.js`, `mcp/aggregate.js` and their `.d.ts` files. Confirm no `.ts` sources or test fixtures leak into the tarball.

- [ ] **Step 5: Commit anything the gate fixed**

```bash
git add -A && git commit -m "chore: lint and typecheck fixes for multi-base workspaces"
```

(Skip if the gate was clean.)

---

## Self-Review Notes

Checked against the spec section by section:

| Spec section | Task |
| --- | --- |
| §1 workspace layout, `bases.json`, slugs, ids, migration, `workspace.ts` | 2, 3, 4, 5, 6 |
| §2 `nit list` | 8 |
| §3 `nit clear` | 7, 9 |
| §4 MCP surface (rows, `base` filter, `nit_clear_verified`, resources, instructions) | 11, 12, 13, 14 |
| §5 review / view / verify / status / export / import / setup / doctor, `-v` and `-h` | 1, 6, 10, 15, 16 |
| §6 documentation | 17 |
| §7 code standards | Global Constraints; enforced in 18 |
| §8 testing | every task's tests, gated in 18 |
| §9 footprint | File Structure |
| §10 risks | mitigations are tested in 5 (migration rollback), 13 (verified-only clearing), 12 (bare-id back-compat), 15 (old zips), 10 (no environment guessing) |

Two deliberate departures from the spec, both noted inline above:

1. **No `alias` field.** `--base staging` names the folder, so the alias *is* the slug (see "One simplification against the spec").
2. **`nit setup` is not modified.** The spec listed it under §5 for a wording tweak only. Nothing in setup breaks on a workspace — it creates and gitignores the folder, which is layout-agnostic — so it is left alone rather than churned. If Task 17's docs pass turns up setup text that misleads, fix it there.
