# Panel meta icons + badges — design

Date: 2026-07-22
Status: approved (Kevin, in-session; layout "mixed badges + icon rows", status badges color-coded)

## Goal

The expanded annotation detail currently runs its metadata together as plain text lines
(`a1 · open · scope desktop`, `component: …`). Replace them with visually labeled fields:
badges for categorical values, icon + label rows for the rest.

## Badge row (src/panel/list.ts)

First line under the editable comment textarea, two chips:

- **Status badge** — text = the status verbatim, uppercased via CSS. Base class
  `badge-status` plus modifier `badge-status--<status>` ONLY for the five known statuses
  (`open`, `fixed`, `verified`, `reopened`, `wontfix`); an unknown status from the
  untrusted file gets the neutral base style — no class name is ever built from
  unvalidated file data. Colors: open = accent yellow (`--accent`), fixed = comment blue
  (`--comment`), verified = green (#34c759), reopened = orange (#ff9f0a),
  wontfix = gray (`--muted`). Also carries `data-status="<status>"` (set via dataset,
  safe) for tests.
- **Scope badge** — inline lucide icon + text: `desktop` → existing `monitor` icon,
  `mobile` → existing `smartphone`, `general` → new `globe`. Class `badge-scope`.

## Key-value rows (src/panel/list.ts)

Replace the three `line(...)` meta lines and the `selectorLine` label with uniform rows:
icon (13px, muted) · muted label (fixed ~64px column) · value.

| Icon (lucide) | Label | Value |
| --- | --- | --- |
| `clock` | created | `shortTime(ann.createdAt)` |
| `pencil` | updated | `shortTime(ann.updatedAt)` + ` by <updatedBy>` when present — row only rendered when `updatedAt` exists |
| `box` | component | `ann.target?.component \|\| '?'` + ` (<ngComponent>)` when present |
| `code` | selector | the existing highlighted `.sel-code` element (tokenizer output unchanged) — row only when a selector exists |
| `hash` | id | `ann.id` |

Helpers: `metaRow(icon: string, label: string, value: string | HTMLElement): HTMLElement`
and `badges(ann): HTMLElement`. Icon markup is static trusted code (`innerHTML = ICONS.x`,
the pattern the issue row already uses); every VALUE is set via `textContent` (or is the
already-safe `.sel-code` span tree). `line()` stays for the screenshot captions.

## Icons (src/panel/icons.ts)

Add six lucide icons to `ICONS`, inlined with the existing `svg()` helper, no dependency:
`clock`, `pencil`, `box`, `code`, `hash`, `globe`.

## CSS (src/panel/panel.css)

- `.meta-badges` — flex row, gap 5px.
- `.badge-status` — chip like `.badge` (9px bold, radius 4, padding 2/5), uppercase,
  neutral base (border + muted text); modifiers set background + `--accent-fg` text
  (wontfix/gray keeps muted text on transparent).
- `.badge-scope` — neutral chip with 11px inline icon.
- `.meta-row` — grid `14px 64px 1fr`, gap 6px, align-items start; icon muted; label
  muted 10px uppercase; value 11px `overflow-wrap: anywhere` (keeps the long-selector
  behavior). `.sel-code` styling unchanged.

## Testing

- Extend the existing `browser-panel.test.js` highlighted-selector subtest (or add a
  sibling): expanded item shows `.badge-status[data-status="open"]`, a `.badge-scope`,
  a `.meta-row` whose label column reads `selector` and still contains the lossless
  `.sel-code`, and an `id` row showing `a1`.
- Headless panel screenshot (scratch script, like the panel rebuild) for visual
  verification of spacing/colors; not committed as a test.

## Non-goals

- No changes to the collapsed item head, screenshots, issue row, goto button, or verify
  verdict buttons. No new information — same fields, better labels.
