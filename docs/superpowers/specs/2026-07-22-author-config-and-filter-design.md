# Author in setup + author display/filter in the panel — design

Date: 2026-07-22
Status: implementing (Kevin's direct request, mid-session)

## Goal

1. `nit setup` also asks for the reviewer's author name.
2. The panel list shows author names and can filter by author, but only when the review contains
   more than one distinct author.

## Part 1: author in setup (user-level config)

An author is a per-person fact, not a per-project one: a committed project config carrying one
name would be wrong for every teammate. So the author lives in a **user-level config**:

- Path: `~/.config/nit/config.json` (all platforms; `os.homedir()` based).
- New pure-ish module `src/util/user-config.ts`: `readUserConfig(): { author?: string }` and
  `writeUserConfig(patch)` (merge + create directories; tolerant of missing/corrupt files;
  a `dir` override parameter for tests).
- `nit setup` wizard gains a text prompt "Who is reviewing? (author name on your annotations)"
  after the MCP question, defaulting to the stored author or the OS username. Saved to the user
  config (noted in the summary as "saved for your user, not the project"). `--yes` keeps the
  existing stored author, or stores the OS username if none exists.
- Author resolution for `nit review` becomes: `--author` flag, then user config, then OS
  username (existing fallback in the session).

## Part 2: author in the panel

The panel computes distinct authors from the annotations it already has (`ann.author`); no
bridge or schema change. Let `multiAuthor = distinctAuthors(annotations).length > 1`.

- **Display** (only when `multiAuthor`): each collapsed row gets a small `.nit-author-chip`
  with the author name. The expanded detail always gets an "author" icon row (lucide `user`
  icon), because the detail view is meant to be complete.
- **Filter** (only when `multiAuthor`): the filter dropdown gains an "Author" radio row:
  `All` plus one option per distinct author (sorted). Selecting an author filters the list
  (and the unplaced list) before sorting/grouping. The choice lives in panel view state like
  sort/group; it resets to `All` if the selected author disappears from the data.
- Pure logic in `src/panel/filter.ts`: `distinctAuthors(items): string[]` and
  `filterByAuthor(items, author: string | null): Annotation[]`, both unit-tested.
- New `user` icon in `src/panel/icons.ts` (inlined lucide, like the others).

## Testing

- `cli-setup.test.js`: user-config read/write round-trip, corrupt file tolerated, `--yes`
  stores the OS username when no config exists (config dir pointed at a temp dir).
- `unit-panel-filter.test.js`: tables for `distinctAuthors` (dedupe, sort, missing authors) and
  `filterByAuthor` (null = all).
- `browser-panel.test.js`: fixture becomes two-author (Kevin + Alice); assert author chips
  appear, the Author filter row exists, and selecting Alice narrows the list.
- `browser-view.test.js` (single-author fixture): assert no author chip and no Author filter
  row.

## Non-goals

No project-level config file, no MCP surface change, no changes to merge (it already preserves
per-annotation authors).
