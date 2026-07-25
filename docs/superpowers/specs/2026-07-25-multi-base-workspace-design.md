# Multi-base-URL workspaces, `nit list`, `nit clear`

**Date:** 2026-07-25
**Status:** approved, ready for planning

## Problem

A storefront is reviewed at three URLs — local, staging and production. Today a review
folder holds exactly one site: `review.url` is a single string, and `resolveAnnotationUrl`
rejects any route that leaves that origin. Reviewing three environments means three
unrelated folders, three MCP registrations, and no way to ask "which environments do I have
annotations for" or "drop everything I already verified on staging".

This spec adds:

1. A **workspace** layout: one review folder holding one self-contained review per base URL.
2. `nit list` — enumerate base URLs, or the annotated URLs within one, with filters.
3. `nit clear` — remove all annotations for a base, or only those in a given status
   (`--verified` being the shorthand that motivated the feature).
4. `nit_clear_verified` — the same verified-only cleanup, exposed to coding agents.
5. `-v` as an alias for `--version`, and a regression test pinning `-h`.

## Non-goals

- Cross-base annotation identity. An annotation made on staging is *not* linked to "the same"
  annotation on production; they are independent records that happen to share a route.
- Promoting or copying annotations between bases.
- Changing the `annotations.json` schema. See [Ids](#ids-stay-plain-on-disk).

## 1. The workspace layout

A review folder becomes a **workspace**. Each base URL gets a subfolder that is byte-for-byte
today's review folder.

```
nit-review/                        the workspace
  bases.json                       index: slug -> url (+ alias, timestamps)
  fainin-dev/                      a base review — exactly today's layout
    annotations.json               review.url = https://fainin.dev/
    review.md
    fix-annotations.md
    shots/
  localhost-4200/
    annotations.json               review.url = http://localhost:4200
    review.md
    fix-annotations.md
    shots/
```

Because a base folder *is* a review folder, `store/store.ts`, `store/render.ts`,
`store/merge.ts`, `anchor/`, `capture/`, the overlay and the panel need no changes at all.
Everything new sits above them.

### `bases.json` is an index, not the source of truth

```json
{
  "version": 1,
  "bases": [
    {
      "slug": "staging",
      "url": "https://staging.example.com",
      "createdAt": "2026-07-25T09:00:00.000Z",
      "lastSeenAt": "2026-07-25T14:12:00.000Z"
    },
    {
      "slug": "localhost-4200",
      "url": "http://localhost:4200",
      "createdAt": "2026-07-25T09:30:00.000Z",
      "lastSeenAt": "2026-07-25T09:30:00.000Z"
    }
  ]
}
```

The index exists for the two things a folder name cannot carry: the user's alias
(`staging` → `https://staging.example.com`) and a fast URL→folder lookup so
`nit review <url>` lands in the right place. It is never authoritative about existence:

- A subfolder containing an `annotations.json` **is** a base, listed or not. It is adopted on
  read, taking its URL from its own `review.url` and its slug from the folder name.
- An entry naming a folder that is gone is ignored (and dropped on the next write).
- A malformed or unreadable `bases.json` is rebuilt from the subfolders rather than failing.

This keeps a workspace robust against `git clone`, unzipping, and hand-editing — the same
tolerance `store.ts` already applies to `annotations.json`.

### Slugs and how a base is named

The slug is derived from the URL: hostname, plus `-<port>` when the port is not the scheme
default, lowercased with non-alphanumerics collapsed to `-` (reusing `util/slug.ts`).

| URL | slug |
| --- | --- |
| `http://localhost:4200` | `localhost-4200` |
| `https://staging.example.com` | `staging-example-com` |
| `https://fainin.dev/` | `fainin-dev` |

`nit review https://staging.example.com --base staging` overrides it on first capture and the
alias is recorded in `bases.json`, so every later command can say `--base staging`.

Anywhere a base is named — `--base`, the MCP `base` argument — the value resolves against, in
order: exact slug, exact alias, exact URL, URL origin, then unique case-insensitive prefix of
a slug or alias. An ambiguous prefix is an error naming the candidates; an unresolvable value
is an error listing the workspace's bases. Resolution is one function, used by CLI and MCP
alike, so the rules never drift apart.

### Ids stay plain on disk

`annotations.json` keeps `a1`, `a2`. There is **no schema change** — `types.ts` gains
workspace types but the annotation contract is untouched, so every existing consumer, shared
zip and agent-written file keeps working.

The qualified `staging:a1` form is a presentation concern applied only where results cross
bases: MCP tool output and `nit list`. Parsing splits on the **first** colon, so a base that
was itself produced by `nit merge` still resolves: `staging:kevin:a1` → base `staging`,
id `kevin:a1`. Slugs are alphanumerics-and-dashes only, so the split is never ambiguous.

When a workspace has exactly one base, MCP tools accept a bare `a1` as well as the qualified
form. Existing `.mcp.json` registrations and single-environment users see no change.

### Migration is lazy and rare

A flat `nit-review/annotations.json` is read as a workspace with exactly one base — forever.
`nit list`, `nit clear`, `nit status`, `nit mcp`, `nit view` and `nit verify` all work against
it unchanged, and running `nit review` against the *same* URL appends exactly as today.
Nothing moves.

The relocation fires only when a write would introduce a **second** base URL. At that point
the flat review is moved into `<slug>/` (slug derived from its own `review.url`), `bases.json`
is written, and the new base folder is created. If any step fails the move is rolled back and
no new base is created, so a failed migration never leaves a half-workspace.

`nit doctor` reports the layout it finds, so a confused folder is diagnosable.

### New module: `src/store/workspace.ts`

Owns layout detection, the index, resolution and migration. Filesystem access is confined to
a handful of functions; slug derivation, resolution and id qualification are pure and
table-tested.

```ts
/** Where a workspace's annotations actually live. */
export type WorkspaceLayout = 'empty' | 'flat' | 'multi';

/** One base URL inside a workspace, and the review folder that holds it. */
export interface BaseRef {
  /** folder name inside the workspace; also the id used by --base and qualified ids */
  slug: string;
  /** the site under review for this base, from its own review.url */
  url: string;
  /** absolute path of the base's review folder */
  dir: string;
  /** absolute path of its annotations.json */
  file: string;
  createdAt?: string;
  lastSeenAt?: string;
}

export interface Workspace {
  dir: string;
  layout: WorkspaceLayout;
  bases: BaseRef[];
}

export function baseSlug(url: string): string;
export function openWorkspace(dir: string): Workspace;
export function resolveBase(ws: Workspace, nameOrUrl: string): BaseRef;
export function ensureBase(dir: string, url: string, alias?: string): BaseRef;
export function qualifyId(slug: string, id: string): string;
export function parseQualifiedId(qualified: string): { slug: string | null; id: string };
```

## 2. `nit list`

```
nit list [dir]                          every base URL, with counts
nit list [dir] --base staging           every annotated URL under staging
nit list [dir] --all                    every annotated URL, across all bases
nit list --status open --type change-request --route /checkout --author Kevin
nit list --actionable                   the open|reopened change-requests
nit list --json
```

Bare `nit list` answers "which environments do I have":

```
nit list — nit-review

  base                 url                               total  actionable  last change
  staging              https://staging.example.com          12           5  2 hours ago
  localhost-4200       http://localhost:4200                 4           4  20 minutes ago
  fainin-dev           https://fainin.dev/                   7           0  4 days ago

  23 annotations across 3 base URLs · 9 actionable
```

`--base` (or `--all`) switches to URL rows. The URL is reconstructed as base + route, which is
the pasteable thing the user wants; `route` already carries the query string.

```
nit list — nit-review/staging (https://staging.example.com)

  url                                              n   status
  https://staging.example.com/checkout             5   open 3 · fixed 1 · verified 1
  https://staging.example.com/product/42?tab=spec  4   open 2 · reopened 2
  https://staging.example.com/                     3   verified 3

  12 annotations on 3 urls · 5 actionable
```

With `--all`, rows are grouped under a base heading and prefixed with the base slug.

Filters compose and apply to both shapes: on the bare form they narrow the counts and hide
bases left with nothing. `--json` emits the same data structured, for scripts and CI. Nothing
is written — `nit list` is safe against a review someone else is editing, like `nit status`.

Ordering is deterministic: bases by annotation count descending then slug; URL rows by count
descending then URL. Reports never depend on filesystem enumeration order.

## 3. `nit clear`

```
nit clear [dir] --base staging                every annotation in staging   (prompts)
nit clear [dir] --base staging --verified     just the verified ones        (prompts)
nit clear [dir] --all --verified              verified ones, every base
nit clear [dir] --base staging --status wontfix
nit clear [dir] --all --yes                   no prompt, for scripts
nit clear [dir] --base staging --dry-run      print what would go, change nothing
```

`--verified` is sugar for `--status verified`. Offering `--status` as the general form makes
`wontfix` cleanup free rather than a second feature later.

**A scope is mandatory.** Bare `nit clear` prints the base list and exits 1 rather than
guessing; `--base` and `--all` are mutually exclusive. The confirmation prompt names the base
and the exact count before anything happens, and `--yes` skips it for scripts. `--dry-run`
prints the same summary and exits 0 without writing.

Clearing goes through `store.remove`, so screenshots are unlinked with the existing
path-traversal guard rather than by a second, less careful deletion path. Afterwards
`review.md` and `fix-annotations.md` are re-rendered and `annotations.json` is flushed
atomically.

The base folder and its review metadata (`id`, `url`, `authors`, `createdAt`) survive an
empty-out. The request is to clear annotations, not to forget the environment — and keeping
the folder means the next `nit review` against that URL reuses its review id.

`src/store/clear.ts` holds the pure selection (`which annotations does this scope match`) and
the single clearing operation over a `Store`; `src/cli/clear.ts` holds argument validation and
the prompt. Selection is table-tested without touching disk.

## 4. MCP surface

`nit mcp nit-review` serves the whole workspace.

```
nit_list_annotations()
  → { bases: [{ slug: "staging", url: "https://staging.example.com", total: 12, actionable: 5 }, …],
      total: 23, actionable: 9,
      annotations: [{ id: "staging:a1", base: "staging",
                      url: "https://staging.example.com/checkout", … }] }

nit_list_annotations({ base: "staging", status: "open" })
nit_get_annotation({ id: ["staging:a1", "localhost-4200:a3"] })   batch across bases
nit_mark_fixed({ id: "staging:a1" })
nit_clear_verified({ base: "staging" })                  → { cleared: 4, remaining: 8 }
```

- Every row gains `base` (the slug) and `url` (base + route, the navigable page).
- `nit_list_annotations` gains an optional `base` filter accepting slug, alias or URL, and
  reports a `bases` summary. The existing `review` envelope on an unfiltered call is replaced
  by `bases` on a multi-base workspace and kept as-is on a single-base one.
- Per-annotation tools take qualified ids, and bare ids on a single-base workspace.
- `nit_clear_verified` is the only new tool and the only destructive one:
  `destructiveHint: true`, `idempotentHint: true`, optional `base` (omitted = all bases).
  Clearing *unruled* feedback stays CLI-only, where the confirmation prompt lives — an agent
  must not be able to delete human feedback nobody has ruled on.
- The server `instructions` string gains a sentence explaining bases and qualified ids, so the
  agent does not have to infer the format.

Resources become base-scoped — `nit://base/{slug}/annotations.json`,
`nit://base/{slug}/review.md`, `nit://base/{slug}/brief.md` — plus a new
`nit://review/bases.md` overview listing every base with its counts. The existing unprefixed
`nit://review/*` and `nit://annotation/<id>` URIs keep resolving on a single-base workspace,
so nothing breaks for today's users.

## 5. The rest of the CLI

| Command | Change |
| --- | --- |
| `nit review <url>` | Routes into the base folder for `<url>`, creating and registering it (and migrating a flat folder) as needed. New `--base <alias>` names it on first use. `--out` still names the workspace. |
| `nit view` / `nit verify` | Need exactly one base to open a browser at. One base → used silently. Several → `--base` required; the error lists them with counts. `--url` implies its own base. |
| `nit status` | Aggregates across bases with a per-base breakdown; `--base` narrows it to today's single-review report. `--json` gains a `bases` array. |
| `nit export` | `--base staging` packs one base in exactly today's zip format. On a multi-base workspace with no `--base`, packs the whole workspace (`bases.json` + every base folder). |
| `nit import` | Detects which kind of zip it is unpacking. Existing single-review zips are unaffected. |
| `nit setup` | Mentions the workspace layout when the chosen folder already holds one; otherwise unchanged. |
| `nit mcp-install` | Unchanged behaviour, updated help text (one entry now covers every environment). |
| `nit doctor` | Reports the detected layout and base count. |

`nit export` / `nit import` are in scope because without them both commands would simply fail
on a migrated folder — this is repair, not scope creep.

### `-v` and `-h`

`-h, --help` already works via commander and gains a regression test so it stays that way.
`-v` is added as an alias for `--version` alongside the existing `-V`; both are asserted
against the built binary rather than assumed, since commander's flag-string parsing decides
which shorts actually bind.

`nit view`'s `v` alias is a command, not an option, so `nit v` and `nit -v` do not collide.

## 6. Documentation

Docs ship with the feature, not after it.

- `README.md` — command table gains `list` and `clear`; the "What you get" tree shows the
  workspace layout; the agent-handoff paragraph mentions bases and `nit_clear_verified`.
- `docs/wiki/commands.md` — full sections for `nit list` and `nit clear` (every flag), plus
  `--base` added to `review`, `view`, `verify`, `status` and `export`.
- `docs/wiki/mcp.md` — bases, qualified ids, the `base` filter, `nit_clear_verified`, and the
  base-scoped resource URIs.
- `docs/wiki/annotations.md` — the workspace layout, `bases.json`, and the explicit statement
  that the annotation schema is unchanged.
- `docs/wiki/getting-started.md` and `docs/workflow.md` — a short multi-environment section
  (annotate staging, fix, verify, clear the verified ones, repeat on prod).
- `docs/wiki/how-it-works.md` — the workspace above the store, and where migration happens.
- `src/README.md` — the directory map gains `store/workspace.ts`, `store/clear.ts`,
  `cli/list.ts`, `cli/clear.ts`, `mcp/aggregate.ts`. (It is also currently missing
  `cli/status.ts`, `cli/source.ts`, `store/stats.ts`, `util/user-config.ts`,
  `util/version.ts`, `mcp/tools.ts`, `mcp/resources.ts`, `mcp/schema.ts`, `mcp/history.ts` and
  `overlay/frame-shields.ts` — brought up to date in the same pass.)
- `CHANGELOG.md` is generated by release-please from Conventional Commit messages; no manual
  edit.

## 7. Code standards

The package is published to npm, so the new code holds to what is already there:

- **JSDoc on every exported symbol** — what it does, `@param` for each parameter,
  `@returns`, and `@throws` where a function throws. Matching the existing house style in
  `store/store.ts` and `store/stats.ts`, including the short "why" comments where a decision
  is non-obvious (why `bases.json` is not authoritative, why migration is lazy, why agents
  cannot clear unruled feedback).
- **TypeScript strict mode**, `unknown` at every trust boundary — `bases.json` is
  hand-editable and arrives from zips, so it is validated, never cast.
- **Imports carry `.js` extensions** (NodeNext resolution).
- **Files stay focused**: each new module has one job and is well under the 400-line mark the
  existing modules keep to.
- **Immutability**: resolution and selection return new values; only the store mutates, and
  only through its existing `patch`/`remove`/`flush` API.
- `npm run lint`, `npm run typecheck` and `npm test` must all pass before the branch is done.

## 8. Testing

Unit, table-driven, no disk where avoidable:

- `unit-workspace.test.js` — slug derivation (ports, default ports, unicode hosts, unparseable
  URLs); base resolution by slug / alias / URL / origin / unique prefix / ambiguous prefix /
  miss; layout detection for empty, flat and multi; index self-healing (unlisted folder
  adopted, stale entry ignored, malformed JSON rebuilt); `qualifyId` / `parseQualifiedId`
  round-trips including merged `author:id` forms.
- `unit-clear.test.js` — the selection set across scope × status, that screenshots are
  unlinked, and that review metadata survives an empty-out.

End-to-end over tmp fixtures:

- `cli-list.test.js` — both output shapes, every filter, `--json`, and a flat folder.
- `cli-clear.test.js` — `--verified`, `--all`, `--status`, `--dry-run`, `--yes`, and the
  no-scope refusal exiting 1.
- `cli-migrate.test.js` — a real flat folder with screenshots gains a second base: ids,
  annotation contents, `review.md` and every shot survive; a forced mid-move failure rolls
  back cleanly.
- `cli-help.test.js` (extended) — `-v`, `-V`, `-h`, and `list` / `clear` appearing in help.
- `mcp.test.js` (extended) — qualified ids, the `base` filter, `nit_clear_verified`,
  cross-base batch `nit_get_annotation`, and plain-id back-compat on a single-base workspace.
- `mcp-resources.test.js` (extended) — base-scoped URIs and `nit://review/bases.md`.
- `cli-export-import.test.js` (extended) — a workspace round-trip, and that a single-base zip
  from a previous nit version still imports.

## 9. Footprint

**New:** `src/store/workspace.ts`, `src/store/clear.ts`, `src/cli/list.ts`,
`src/cli/clear.ts`, `src/mcp/aggregate.ts`.

**Changed:** `src/cli/index.ts`, `src/cli/source.ts`, `src/cli/status.ts`,
`src/cli/export.ts`, `src/cli/import.ts`, `src/cli/setup.ts`, `src/cli/doctor.ts`,
`src/mcp/server.ts`, `src/mcp/tools.ts`, `src/mcp/schema.ts`, `src/mcp/resources.ts`,
`src/types.ts` (additive only), plus the docs listed in §6.

**Untouched:** the entire `overlay/`, `panel/`, `anchor/`, `capture/`, and
`store/store.ts` / `store/render.ts` / `store/merge.ts` — which is the point of putting each
base in its own folder.

## 10. Risks

| Risk | Mitigation |
| --- | --- |
| Migration corrupts an existing review | Fires only when a second base URL is actually introduced; rolled back on failure; covered by an explicit test with screenshots. |
| An agent deletes unruled feedback | MCP can only clear `verified`. Full clearing is CLI-only behind a prompt. |
| Qualified ids confuse an agent | Bare ids still accepted on single-base workspaces; the format is stated in the server instructions and in every row's `base` field. |
| Old zips or shared folders stop working | Flat layout is read forever; single-base zips import unchanged; both are regression-tested. |
| `nit view` / `nit verify` pick the wrong environment | They never guess — one base is used silently, several require `--base`. |
