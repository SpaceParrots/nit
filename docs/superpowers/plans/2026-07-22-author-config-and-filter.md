# Author Config + Panel Author Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `nit setup` asks for and stores the reviewer's author name (user-level config), and the panel shows/filters by author when a review has more than one distinct author.

**Architecture:** New `src/util/user-config.ts` (read/write `~/.config/nit/config.json`), a wizard prompt in `src/cli/setup.ts`, and config-aware author resolution in `src/cli/index.ts`. Panel side: pure `distinctAuthors`/`filterByAuthor` in `src/panel/filter.ts`, an author chip + detail row in `src/panel/list.ts`, and an Author radio row in `src/panel/main.ts`'s filter menu, all gated on `distinctAuthors(...).length > 1`.

**Tech Stack:** TypeScript strict ESM NodeNext (`.js` import extensions), @clack/prompts wizard, `node:test` + Playwright tests importing from `../dist/**`.

**Spec:** `docs/superpowers/specs/2026-07-22-author-config-and-filter-design.md`

## Global Constraints

- Author config is USER-level (`os.homedir()`/.config/nit/config.json), never project-level. Tests must never write to the real home dir: every config function takes an optional `dir` override.
- Author resolution for `nit review`: `--author` flag first, then user config, then the existing OS-username fallback (do not duplicate the OS fallback; it already lives downstream).
- Panel gating: author chip in the row head AND the Author filter row appear only when the review has MORE THAN ONE distinct author. The expanded detail's author row always renders.
- annotations.json is untrusted: author strings reach the DOM via `textContent` only; `innerHTML` only for static `ICONS.*`.
- `readUserConfig` never throws (missing/corrupt file returns `{}`); `writeUserConfig` merges over the existing content and creates directories.
- BUILD GOTCHA: always `npm run build` explicitly after editing src/ before targeted test runs.
- Commits: Conventional Commits, ONE line, no co-author, scope `(nit)`; `npm run lint` exit 0 before committing.

---

### Task 1: user config + setup prompt + review author resolution

**Files:**
- Create: `D:\Tools\Nit\src\util\user-config.ts`
- Modify: `D:\Tools\Nit\src\cli\setup.ts` (wizard prompt + `--yes` path + summary line)
- Modify: `D:\Tools\Nit\src\cli\index.ts` (review action author resolution; update the `--author` help text to mention the config)
- Test: `D:\Tools\Nit\test\cli-setup.test.js` (extend)

**Interfaces:**
- Produces: `readUserConfig(dir?: string): UserConfig` and `writeUserConfig(patch: UserConfig, dir?: string): void` with `interface UserConfig { author?: string }`; `defaultConfigDir(): string` = `path.join(os.homedir(), '.config', 'nit')`. File name inside the dir: `config.json`.
- `runSetup`/`applySetup` gain an `author` choice: `SetupChoices` gets `author: string | null` (null = do not store). `applySetup` writes it via `writeUserConfig` when non-null; `SetupOptions` gains `configDir?: string` passed through (tests point it at a temp dir).
- Consumes: existing wizard structure in `runSetup`, existing `author: opts.author` pass-through at `src/cli/index.ts:236`.

- [ ] **Step 1: Write failing tests** in `test/cli-setup.test.js` (follow the file's existing style; import from `../dist/util/user-config.js` and the existing setup imports):
  - `readUserConfig` on a missing dir returns `{}`.
  - `writeUserConfig({ author: 'Ann' }, tmp)` then `readUserConfig(tmp)` returns `{ author: 'Ann' }`; a second `writeUserConfig({}, tmp)` keeps the author (merge).
  - A corrupt `config.json` (write `'{nope'`) makes `readUserConfig` return `{}`, no throw.
  - `applySetup({ ...defaults, author: 'Ann' }, { projectDir: tmpProj, configDir: tmpCfg })` stores the author; `author: null` stores nothing.
- [ ] **Step 2: Verify they fail** (`npm run build; node --test test/cli-setup.test.js`).
- [ ] **Step 3: Implement.**

`src/util/user-config.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
// The per-user config file (~/.config/nit/config.json). Holds facts about the
// person, not the project — currently just the author name recorded on
// annotations. Reads are tolerant: a missing or corrupt file is an empty config.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** What nit remembers about the user across projects. */
export interface UserConfig {
  /** author name recorded on annotations */
  author?: string;
}

/** Directory of the user config file. */
export function defaultConfigDir(): string {
  return path.join(os.homedir(), '.config', 'nit');
}

/** Read the user config; missing or unreadable files yield `{}`, never a throw. */
export function readUserConfig(dir: string = defaultConfigDir()): UserConfig {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    if (typeof raw !== 'object' || raw === null) return {};
    const author = (raw as Record<string, unknown>).author;
    return typeof author === 'string' && author.trim() ? { author: author.trim() } : {};
  } catch {
    return {};
  }
}

/** Merge `patch` into the stored config, creating the directory when needed. */
export function writeUserConfig(patch: UserConfig, dir: string = defaultConfigDir()): void {
  const merged = { ...readUserConfig(dir), ...patch };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(merged, null, 2) + '\n', 'utf8');
}
```

`src/cli/setup.ts`:
- `SetupChoices` gains `author: string | null`; `SetupOptions` gains `configDir?: string`.
- `applySetup`: when `choices.author` is a non-empty trimmed string, `writeUserConfig({ author: choices.author.trim() }, configDir)`. Add `author: string | null` to `SetupResult` and a summary line `author            <name>  (saved for your user, not the project)` when stored.
- Wizard: after the MCP confirm, add
  ```ts
  const storedAuthor = readUserConfig(configDir).author;
  const author = await p.text({
    message: 'Who is reviewing? (author name recorded on your annotations)',
    placeholder: storedAuthor ?? os.userInfo().username,
    defaultValue: storedAuthor ?? os.userInfo().username,
  });
  if (p.isCancel(author)) return cancelled();
  ```
  and pass `author: author.trim() || null` into `applySetup`.
- `--yes` / non-TTY path: `author: readUserConfig(configDir).author ?? os.userInfo().username` (keeps an existing choice, otherwise stores the OS name).
- `import os from 'node:os';` and the user-config import (`../util/user-config.js`).

`src/cli/index.ts`:
- In the review action, resolve `author: opts.author ?? readUserConfig().author` (line ~236; the OS fallback downstream stays).
- `--author` help text becomes: `'author recorded on each annotation (default: from nit setup, else your OS user name)'`.

- [ ] **Step 4: Verify tests pass**, then run the FULL suite (`npm run build; npm test`) because setup and review flows are covered elsewhere.
- [ ] **Step 5: Lint + commit** `feat(nit): store the reviewer author in a user config via nit setup`.

---

### Task 2: author display + filter in the panel

**Files:**
- Modify: `D:\Tools\Nit\src\panel\filter.ts` (`distinctAuthors`, `filterByAuthor`)
- Modify: `D:\Tools\Nit\src\panel\icons.ts` (lucide `user` icon)
- Modify: `D:\Tools\Nit\src\panel\list.ts` (author chip in head when multi-author; author row in detail)
- Modify: `D:\Tools\Nit\src\panel\main.ts` (Author radio row in the menu; apply the filter)
- Test: `D:\Tools\Nit\test\unit-panel-filter.test.js`, `D:\Tools\Nit\test\browser-panel.test.js`, `D:\Tools\Nit\test\browser-view.test.js`

**Interfaces:**
- Produces (filter.ts):
  ```ts
  /** Distinct, sorted author names; missing/empty authors are ignored. */
  export function distinctAuthors(items: readonly Annotation[]): string[]
  /** Keep only `author`'s annotations; `null` keeps everything. */
  export function filterByAuthor(items: readonly Annotation[], author: string | null): Annotation[]
  ```
- DOM contract: `.nit-author-chip` on row heads (multi-author only); a `.meta-row` labeled `author` in the expanded detail (always); menu radio row `.nit-author[data-author]` with `data-author="*"` for All (row only when multi-author).
- Consumes: `renderItem`/`ListDeps` in list.ts, the `radioRow` helper and `opts`/`view.lastKey` pattern in main.ts (mirror how sort/group rows work), `ICONS`.

- [ ] **Step 1: Failing unit tests** in `unit-panel-filter.test.js`: `distinctAuthors` dedupes, sorts, ignores missing/empty authors; `filterByAuthor(items, null)` returns all, `filterByAuthor(items, 'Ann')` returns only Ann's.
- [ ] **Step 2: Failing browser tests.**
  - `browser-panel.test.js`: change annotation `a2`'s author in `makeFeedback` to `'Alice'`. Append a subtest asserting: `.nit-author-chip` count is 2 (one per row, group-by is 'none' at that point); the filter menu (open it via `.nit-filter-btn`) shows a `.nit-author[data-author="Alice"]` option; clicking it leaves only a2 visible (`.nit-item` count 1); clicking `.nit-author[data-author="*"]` restores 2. Check whether earlier subtests assert author-free markup and adjust only if they break for that reason.
  - `browser-view.test.js`: in an existing subtest (single-author fixture), assert `.nit-author-chip` count 0, and after opening the filter menu, `.nit-author` count 0 (close the menu again to not disturb later subtests).
- [ ] **Step 3: Verify they fail** (build first).
- [ ] **Step 4: Implement.**
  - filter.ts: the two pure functions (dedupe via Set, filter out non-string/empty, sort with `localeCompare`).
  - icons.ts: `user: svg('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),`
  - list.ts: `ListDeps` gains `multiAuthor: () => boolean` (main.ts supplies it from the latest polled state). In `renderItem`'s head, after the route chip: `if (d.multiAuthor() && ann.author) head.append(span('nit-author-chip', ann.author));`. In the expanded meta, after the `id` row: `if (ann.author) meta.append(metaRow(ICONS.user, 'author', ann.author));`. CSS in panel.css: `.nit-author-chip` styled like `.route-chip` (muted, 10px, ellipsis, max-width 64px).
  - main.ts: module state `let authorFilter: string | null = null;`. In the menu build, when `distinctAuthors(s.annotations).length > 1` append a radio row `radioRow('Author', 'nit-author', 'author', [['*', 'All'], ...authors.map(a => [a, a])], authorFilter ?? '*', v => { authorFilter = v === '*' ? null : v; view.lastKey = ''; })` (mirror the sort/group rows; include it in the render key so menu state repaints: add `authorFilter` to the `JSON.stringify` key at ~line 135). Apply `filterByAuthor(...)` to the annotation lists before grouping (both placed and unplaced lists). Reset `authorFilter` to null when the selected author is no longer in `distinctAuthors`. Wire `multiAuthor` into `initList`.
- [ ] **Step 5: Verify** targeted tests pass, then FULL suite.
- [ ] **Step 6: Changelog** (`## Unreleased` section, new): setup author prompt + panel author display/filter. **Step 7: Lint + commit** `feat(nit): show and filter panel annotations by author when several exist`.

---

## Self-Review Notes

- Spec coverage: config module/prompt/resolution → Task 1; chip/detail row/filter row/pure fns/gating → Task 2; all four test files named; non-goals respected (no bridge change: the panel derives authors from `s.annotations`).
- Assumption to verify at implementation time: `PanelState` exposes the annotations array to the panel (main.ts already renders from it); whatever its field name is (`s.annotations` or similar), use that.
