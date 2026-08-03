# Dialog opener detection — record how the reviewer got into the dialog

Date: 2026-08-03 · Status: approved for implementation

## Problem

An annotation captured inside a dialog is supposed to carry `context.reopen`: the
clicks `nit verify` replays to get back into that dialog before taking the
after-shot. In practice it never does.

Ground truth from a real review of the fainin storefront
(`nit-review/localhost-4201/annotations.json`, 20 annotations): **eight have
`context.kind: "dialog"` and not one has `reopen`.** Two independent causes, each
fatal on its own.

### 1. "Did a dialog open?" uses a strictly weaker test than "is this a dialog?"

`detectDialog()` (`src/capture/context.ts`) walks the picked element's ancestors and
has a suspected tier: a modal-ish class name, or a fixed/absolute box while the page
is scroll-locked. That is what puts the dialog checkbox on the popover.

`openSurfaces()` — the only thing that ever sets `TrailStep.opened` — scans something
else entirely: `querySelectorAll(CONFIDENT_SELECTOR)` plus `document.body.children`.
An element that is neither a declared dialog nor a direct child of `<body>` is
invisible to it, no matter what `detectDialog` thinks.

The storefront's mobile sheet is exactly that element:

```html
<!-- src/app/@shared/components/action-sheet/action-sheet.component.html -->
<div class="action-sheet" [@fadeInOut]="open()" cdkDrag …>
```

Nested inside `fainin-action-sheet` inside `fainin-account-order-detail`; no
`role=dialog`, no `.modal`, not a body child. `detectDialog` finds it — annotations
a17–a20 record it as the container — and `openSurfaces` structurally cannot. So
`opened` stays `false`, `selectReopenSteps()` returns `[]`, and no `reopen` is saved.

Worse, that sheet is **permanently mounted** and toggled by an Angular animation, so
its element identity never changes. Merely broadening the scan would not help: the
before/after diff compares element identity and would see the same node both times.

### 2. The opener is evicted by the reviewer's own clicks

The desktop modal *is* `role="dialog" aria-modal="true"`, so its opener is observed
correctly. It still produces no `reopen`, because the opener lives in the same
`MAX_HISTORY`-bounded rolling window as every ordinary click.

Annotation a2's history is ten consecutive in-wizard clicks (`🤩Super`, `Weiter`,
`Weiter`, …). The `Feedback geben` click that opened the modal has fallen off the
end. a18/a19/a20 show the same shape.

Neither cause is reachable by tuning the 150 ms / 600 ms probe delays.

## Design

### A. One predicate, two callers

`src/capture/context.ts` exports:

```ts
export function isDialogSurface(el: Element): DialogConfidence | null;
```

The union of the confident and suspected tiers, extracted from the body of
`detectDialog`'s ancestor loop. `detectDialog` calls it in its walk; the new watcher
calls it per candidate.

This is the structural fix. Detection and observation are currently two different
definitions of "dialog surface" and the second is strictly weaker; one exported
predicate means they cannot drift apart again.

### B. `src/overlay/surfaces.ts` — observe instead of poll

A new module owning a single `MutationObserver` on `documentElement`, seeded at
install with `openSurfaces(document)`, maintaining a small `Set` of the surfaces
currently visible.

```ts
export interface SurfaceWatcher {
  /** Call `onOpen` with the first surface to become visible within the settle
   *  window. At most once per call. */
  watch(onOpen: (surface: Element) => void): void;
}

export function installSurfaceWatcher(doc: Document): SurfaceWatcher;
```

Mutations feeding it:

- **`childList` additions** — the added element, plus a hint query over its subtree
  (portal mounts, `@if` / `v-if` mounts).
- **`attributes`** (`class`, `style`, `hidden`, `open`, `aria-modal`, `popover`) —
  that one element. This is the half that catches the action sheet: permanently
  mounted, shown by a class/style flip, identity never changes.

Both paths run a cheap CSS **hint** before the expensive predicate:

```
[role=dialog], [role=alertdialog], [aria-modal=true], [popover], dialog,
[data-dialog], [class*=modal], [class*=dialog], [class*=drawer], [class*=sheet],
[class*=popup], [class*=lightbox], [class*=flyout]
```

plus any direct child of `<body>`. Hint wide, decide narrow: Angular rewrites class
attributes constantly, so `getComputedStyle` must never run on the general mutation
stream. The hint is a substring match; the real word-boundary test stays in
`isDialogSurface`.

Each batch also prunes entries that are no longer connected or no longer rendered, so
re-opening the *same* element emits again. The set holds 0–3 entries in practice, so
pruning is free.

The two fixed probes at 150/600 ms become one settle window of ~1500 ms per click. An
event-driven watch costs nothing while idle, so the window can be generous — which
also covers modals that mount past 600 ms behind a lazy chunk or a data fetch.

Two scans survive that, both bounded and both only for a click that is actually
being watched:

- **At `watch()` time**, `openSurfaces()` reconciles the visible set before the watch
  is registered, and its result is discarded. Between clicks the set only ever
  shrinks, so a dialog that opened with nothing pending (a fetch, a timer, a hover)
  would otherwise still be missing from it — and the next click's first mutation
  naming it would report it as just opened and credit an unrelated click.
- **Late in the window**, one `openSurfaces()` pass runs if the watch is still
  pending, and credits a newly visible surface exactly as a mutation would. Not
  every opening mutates anything the observer can see: `showPopover()` changes no
  attribute, and a CSS-only `:target`/`:checked` modal changes nothing at all. The
  old probes caught those by polling; this buys that back at one scan per pending
  click instead of two per click ever. It is cancelled the moment the watch is
  credited or superseded.

### C. The opener chain gets its own storage

`Trail` grows a `chain: TrailStep[]` beside the evictable `steps`:

| event | chain |
|---|---|
| click opens a surface, none was open | `[click]` |
| click opens a surface from inside one | `[...chain, click]` |
| click inside a surface, opens nothing | unchanged |
| pathname changes | `[]` |

`steps` keeps its current meaning and its `MAX_HISTORY` bound — it is the
reproduction narrative written to `history`. Ten `Weiter` clicks can no longer evict
the opener, which is cause 2 fixed.

Each chain entry also holds the surface `Element` it opened, in memory only, exactly
as `TrailStep.surface` already is — nothing new crosses the bridge.

```ts
reopenSteps(surface: Element): ClickStep[]
```

returns the chain **only if** the last opener's surface relates to the annotation's
container (`===`, contains, or contained-by), so a chain that opened some *other*
dialog is discarded rather than replayed. Beyond `MAX_REOPEN_STEPS` it still returns
`[]` — the existing "an honest failure beats a truncated sequence" rule is preserved
verbatim.

### D. The opt-in attributes

Two plain `data-*` attributes an app can add so no heuristic is needed. Deliberately
unprefixed: a generic name is far likelier to get added to a codebase than a
vendor-prefixed one, and the storefront's own modal already uses bare `data-backdrop`.

**`data-dialog`** on the surface → confident tier unconditionally. The popover
pre-checks its box and the watcher accepts the element regardless of position or
class heuristics. The label chain is unaffected: it still stays `aria-label` →
`aria-labelledby` → first heading.

**`data-dialog-trigger`** on the opener → the click is recorded as an opener
**immediately, with no observation at all**, matched via `closest()` so an icon
inside the button works. This independence is the whole point: the attribute exists
to work where the heuristics fail, so it must not depend on them.

It is nonetheless **verified when it can be**. A watch is still registered for a
declared click; if a surface does appear, it is recorded on the chain entry the
click already created, and `reopenSteps` applies its ordinary surface-relation
check to it. Only an entry with *no* observed surface is trusted blindly. The
attribute asserts "this click opens *a* dialog", not "*the* dialog you are
annotating" — click a declared trigger, close what it opened, reach a different
dialog by a route the watcher cannot see, and blind trust would hand verify the
wrong opener to replay and then report success on the wrong surface, which this
design ranks as worse than an honest failure. The blind path survives exactly
where it was meant to: the surfaces nothing can observe.

A matching value pairing trigger to surface — to disambiguate a page → menu →
dialog chain on a page with several dialogs — was considered here and dropped
during implementation: presence alone already covers every case the heuristics
leave open, so no code path reads either attribute's value. Bare `data-dialog` /
`data-dialog-trigger` with no value is the whole contract.

**Collision trade-off.** An app already using `data-dialog` for something unrelated
gets a false confident detection. Accepted: the attribute only decides whether the
checkbox arrives pre-checked and whether the watcher runs its predicate, so a false
positive costs the reviewer one untick.

### E. Blast radius

`OverlayActions.reopenSnapshot` takes a surface argument; `popover.ts` passes
`dialog.container`. That is the entire plumbing change.

**No file-format change and no migration.** `CaptureContext.reopen` keeps its shape,
`store.ts`'s `sanitizeContext` is untouched, and `browser/reopen.ts` — the replay
with all its origin, route, volume and serialization guards — is not modified at all.
Reviews written before this change stay readable and behave exactly as they do today.

## Residual gap (documented, not hidden)

A surface detectable *only* by the weakest signal — fixed/absolute on a scroll-locked
page, no modal-ish class, no dialog role, not a body child — is reachable by
`detectDialog`'s ancestor walk but not by any hint the watcher can afford on the
general mutation stream. Those annotations still get a checkbox and still get no
`reopen`.

That is precisely the case `data-dialog` closes, and the wiki will say so rather than
implying the heuristic is total.

`data-dialog` closing it depends on one thing being right: "on screen" must mean
*painted*, not merely *measurable*. A permanently-mounted sheet hidden with
`visibility: hidden` still measures its full size, so a rendered test built on the
box alone read it as open from install — and since declaring it puts it in the seed
scan, following this advice used to *remove* the way back into it. `isRendered`
therefore rejects computed `visibility: hidden` as well as a zero box. `opacity: 0`
is deliberately not rejected: a dialog fading in is genuinely opening, and must
still be credited to the click that opened it.

## Out of scope

Decided against for this change, both recorded here so the next reader knows they
were considered:

- **`context.fromRoute`** — remembering the route the opener was clicked on, for
  route-driven modals (`?modal=`, router outlets, intercepting routes) where
  `appendStep` wipes the trail on the pathname change. The storefront's dialogs do
  not change the URL, so this buys nothing here.
- **Replaying in-dialog wizard steps** — the chain stops at the opener by design, so
  an annotation on step 3 of the feedback wizard re-opens at step 1 and still fails
  to anchor. Extending the chain through `Weiter` clicks means replaying more clicks
  unattended against a live page, which is the exact blast radius `MAX_REOPEN_STEPS`
  exists to bound.

## Testing

The regression test that must fail before the fix: a fixture in the storefront's
shape — a permanently-mounted `div.action-sheet`, three levels deep, no `role`, shown
by a class flip — annotated and checked for a non-empty `context.reopen`.

- `test/unit-context.test.js` — `isDialogSurface` across both tiers and `data-dialog`,
  on the existing faked elements (the module's DOM-method discipline must hold).
- New unit coverage for the chain: survives 20 in-surface clicks, resets on pathname
  change, rejected on surface mismatch, accepted when declared, `[]` beyond the cap.
- `test/browser-verify-dialog.test.js` — the new fixture end to end, plus a
  `data-dialog-trigger` case proving the attribute path needs no observation.
- Existing `test/fixtures/dialog.html` stays as the confident-tier path.

## Docs

- `docs/wiki/annotations.md` — the two attributes, when to reach for them, and the
  residual gap they close.
- `src/README.md` — `surfaces.ts` in the module map.
