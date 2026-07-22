# Selector data-id preference + panel selector highlighting — design

Date: 2026-07-22
Status: approved (Kevin, in-session)

## Goal

Two improvements around selectors:

1. **Generation** — `buildSelector` treats `data-id` attributes as a first-class identity,
   one rung below `#id`, so generated selectors anchor on the attributes teams put on
   elements specifically to identify them. Scope decision (Kevin): **`data-id` only** —
   no `data-testid`/`data-test`/`data-cy`, no generic `data-*`.
2. **Display** — the `selector:` line in the panel's expanded annotation detail is
   syntax-highlighted so ids and `data-id` attributes stand out at a glance.

## Part 1 — `data-id` in `buildSelector` (src/capture/target.ts)

`data-id` participates everywhere `id` does today, always ranked below it:

- **Own element** (step 1 of the preference ladder): try `#id` first (unchanged), then
  `tag[data-id="…"]`. Each candidate is verified unique against the live document
  before being returned, as today.
- **Anchors** (`anchorSelectorFor`): new rung between `id` and `custom` — a
  `tag[data-id="…"]` anchor with kind `'data-id'`. Like `id`/`custom` (and unlike
  bare landmarks) it is a *strong* anchor: it can serve as the outer prefix that
  stabilizes a weak landmark anchor.
- **Compressed paths**: `isSignificant` counts elements with a usable `data-id`;
  `sigSegment` renders them as `tag[data-id="…"]` so waypoints like
  `li[data-id="42"]` survive path compression.

Value rules (shared by all three uses):

- Skip empty values and values longer than 100 chars (likely serialized state).
- Escape for the CSS quoted-string context: backslash and double quote
  (`attrEscape`, new — `CSS.escape` is for identifiers, not strings).

No changes to `anchor.ts` (replay): it consumes the stored selector verbatim, and
every candidate is uniqueness-verified before storage.

## Part 2 — selector highlighting in the panel (src/panel/)

New pure module `src/panel/highlight.ts`:

```ts
type SelToken = { kind: 'id' | 'attr' | 'class' | 'tag' | 'pseudo' | 'combinator' | 'text'; text: string };
function tokenizeSelector(sel: string): SelToken[]
```

- Regex-driven scanner over the selector string. Token kinds: `id` (`#…`), `attr`
  (`[…]` including quoted values), `class` (`.…`), `tag` (bare names), `pseudo`
  (`:name` incl. `(…)` argument), `combinator` (`>`, `+`, `~`, whitespace).
- Never throws; any unmatchable stretch is emitted as a `text` token, so a
  malformed selector still renders in full.
- Concatenating all token texts reproduces the input exactly (lossless).

Rendering (`src/panel/list.ts`): the `selector:` meta-line appends one
`<span class="sel-<kind>">` per token, set via **`textContent` only** — the selector
comes from untrusted `annotations.json` and must never hit `innerHTML`.

Styling (`src/panel/panel.css`): the selector line is monospace; colors follow the
existing palette — `id` and `attr` in accent yellow (the things being surfaced),
`class` in comment blue, `tag` in foreground, `pseudo`/`combinator` muted.

## Testing

- Unit table for `tokenizeSelector`: each token kind, quoted attr values with
  escaped quotes/brackets, malformed input falls back lossless, empty string.
- Unit table for `buildSelector` preferences: element with `data-id` (no id) →
  `tag[data-id="…"]`; `#id` still wins over `data-id`; `data-id` anchor used for
  descendants; quote/backslash in value escaped; empty and >100-char values skipped;
  non-unique `data-id` falls through to the next ladder step.
- Browser test: expanded panel item renders `.sel-id` / `.sel-attr` spans for a
  fixture selector, and the concatenated text equals the stored selector.

## Non-goals

- No other data attributes (`data-testid` etc.).
- No highlighting of the component line, xpath, or review.md output.
- No changes to replay anchoring or the MCP surface.
