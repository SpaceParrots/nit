# src/: nit's source layout

Everything in here is **TypeScript in strict mode**, compiled by `tsc` to `dist/` (`npm run build`). The published package and the tests run the compiled output; nothing in `src/` executes directly.

## The two runtimes

nit's code runs in two very different places, and the directory layout follows that split:

| Runtime | Directories | Constraints |
|---|---|---|
| **Node** (CLI process) | `cli/`, `browser/`, `store/`, `mcp/`, `util/`, `capture/screenshot.ts` | Node 20.12 or newer, may use `node:*` modules and Playwright |
| **Browser** (injected into the inspected page, or the panel popup window) | `overlay/`, `panel/`, `anchor/`, `capture/target.ts` | Bundled by esbuild into a single IIFE. No Node APIs, no framework, and nothing that can throw into or break the host page |

The overlay bundle is built at runtime: `browser/inject.ts` points esbuild at the *compiled* `dist/overlay/main.js` (plus `overlay.css`, which the build copies into `dist/`) and injects the result into every page of the session via `addInitScript`. The panel window gets the same treatment from `browser/panel-bundle.ts`, which bundles `dist/panel/main.js` (plus `panel.css`) into the popup document opened by `browser/panel.ts`. Both sides talk exclusively through the `window.__nit*` bindings wired in `browser/bridge.ts`.

## Directory map

```
src/
├─ types.ts     # THE shared contract: annotations.json schema types (Annotation,
│               # Target, ReviewData, ...), the bridge contract (SavePayload,
│               # PanelState, OverlayEvent, ...), and the Window augmentation for __nit*
├─ css.d.ts     # lets TS import .css as a string (esbuild `text` loader)
│
├─ cli/         # commander CLI, the entrypoints
│  ├─ index.ts       # `nit` binary: setup / review / view / verify / status / list /
│  │                 # clear / export / import / merge / mcp / mcp-install / doctor
│  ├─ setup.ts       # `nit setup`: @clack/prompts wizard (review dir, .gitignore, MCP)
│  ├─ status.ts      # `nit status`: read-only report (single review or per base), --json;
│  │                 # also owns displayPath()/ago(), reused by list.ts and source.ts
│  ├─ source.ts      # resolves the [source] of view/verify to one annotations file:
│  │                 # directory, feedback file, or a base of a multi-base review —
│  │                 # named with --base, or as the source itself once it is no path.
│  │                 # Never prompts: a choice it cannot make is an
│  │                 # AmbiguousSourceError carrying the bases to offer
│  ├─ prompt.ts      # when nit may ask (canAsk: a TTY at both ends, no --no-input,
│  │                 # no --json) and how (the Prompts seam over @clack, injected
│  │                 # in tests so no flow needs a terminal to be covered)
│  ├─ pick.ts        # what nit asks when an argument is missing or fits nothing:
│  │                 # which base (view/verify/status/list/export/clear), which
│  │                 # scope to clear, which url to review, which zip to import.
│  │                 # Every fallback is a no-op without a terminal and hands back
│  │                 # a plain value the command just uses, so no command has to
│  │                 # learn how to ask (clear.ts keeps its own confirmation,
│  │                 # gated by the same canAsk)
│  ├─ list.ts        # `nit list`: base URLs with counts, or the annotated urls in one
│  ├─ clear.ts       # `nit clear`: scope validation, confirmation prompt, dry run
│  ├─ merge.ts       # `nit merge`: read feedback files, merge, copy screenshots
│  ├─ export.ts      # `nit export`: pack a review folder — or a whole workspace — into
│  │                 # a shareable zip (fflate)
│  ├─ import.ts      # `nit import`: unpack a review zip (zip-slip guarded), either shape
│  ├─ mcp-install.ts # `nit mcp-install`: OS-aware .mcp.json entry (create or merge)
│  └─ doctor.ts      # `nit doctor`: environment checks, optional Chromium install, and
│                    # what shape the project's review folder is in
│
├─ browser/     # Node side of a live session (Playwright)
│  ├─ launch.ts       # Chromium launcher: persistent profile, bypassCSP, viewports
│  ├─ session.ts      # startSession(): owns the store, wires everything, `NitSession`
│  ├─ inject.ts       # esbuild-bundles the overlay and registers it as an init script
│  ├─ bridge.ts       # exposeBinding handlers, the ONLY page/Node channel; validates
│  │                  # every payload (pages can forge calls) and guards by frame/page
│  ├─ panel.ts        # opens the panel as a popup window and loads its bundled UI
│  ├─ panel-bundle.ts # esbuild-bundles src/panel into the panel popup's script (cached)
│  ├─ verify.ts       # `nit verify` after-shot capture for `fixed` annotations
│  └─ reopen.ts       # replays an annotation's `context.reopen` clicks to bring its
│                     # dialog back on screen — the one place nit clicks a page itself
│
├─ overlay/     # injected page UI, vanilla DOM in an open Shadow DOM
│  ├─ main.ts     # entrypoint: boot guard, state, wiring, route watcher, resync
│  ├─ hidden-pill.ts # the "N hidden here" pill for pins whose element is not visible
│  ├─ state.ts    # OverlayState / OverlayActions / part interfaces (types only)
│  ├─ picker.ts   # Alt-toggled element picking (capture-phase listeners)
│  ├─ popover.ts  # the annotation form (comment, type, viewport scope, dialog confirm)
│  ├─ trail.ts    # click-history recorder: the last 10 page clicks on this pathname and
│  │              # the dialog surface each happened on, snapshotted into the save
│  │              # payload as `history` + `context.reopen` (pure appendStep /
│  │              # selectReopenSteps + a DOM shell)
│  ├─ pins.ts     # numbered pins for re-anchored annotations
│  ├─ chip.ts     # bottom-left status chip
│  ├─ dom.ts      # tiny DOM helpers (div/span/button/segmented/checkboxRow)
│  └─ overlay.css # overlay styles, bundled as text into the IIFE
│
├─ panel/       # panel window UI, vanilla DOM, bundled by esbuild and injected into
│  │            # the panel popup (browser/panel-bundle.ts)
│  ├─ shell.ts    # PANEL_HTML: the static document set before the bundle is injected
│  ├─ main.ts     # entrypoint: polls `__nitPanelState`, wires controls, renders the list
│  ├─ list.ts     # renderItem(): one annotation row (expand, issue ref, go to page, verdicts)
│  ├─ filter.ts   # pure sort/group logic (SortKey, GroupKey, groupAnnotations), unit-tested;
│  │              # the reason the panel is bundled TypeScript rather than an inline string
│  ├─ highlight.ts # pure CSS-selector tokenizer (SelToken) behind list.ts's highlighted
│  │               # selector line. Lossless, never throws, unit-tested
│  ├─ icons.ts    # Lucide icons (lucide.dev, ISC) inlined as SVG: no npm dep, no network call
│  ├─ logo.ts     # GENERATED by `scripts/gen-logo.mjs` from assets/nit-32.png, do not hand-edit
│  └─ panel.css   # panel styles, bundled as text into the IIFE
│
├─ capture/     # how an annotation gets its element reference and screenshot
│  ├─ target.ts     # (browser) element to layered Target reference, pure
│  └─ screenshot.ts # (node) CDP element-clip screenshots with context padding
│
├─ anchor/      # replay: Target to live element (selector, then xpath, then text), pure
│  └─ anchor.ts
│
├─ store/       # the review folder on disk
│  ├─ store.ts  # annotations.json read/write: stable ids, atomic flush,
│  │            # concurrent-writer status merge, path-traversal-safe shot paths
│  ├─ workspace.ts       # the layer ABOVE the store: a review folder holding one review
│  │                     # per base URL. Layout detection, the bases.json index, slug
│  │                     # derivation, base resolution, qualified ids (read half)
│  ├─ workspace-write.ts # ensureBase()/writeIndex(): create a base folder, migrate a
│  │                     # flat review lazily (rolled back on failure). Re-exported by
│  │                     # workspace.ts so callers import one path
│  ├─ read.ts   # the one tolerant reader for annotations.json, shared by every
│  │            # read-only consumer (status, list, a clear dry run): narrows
│  │            # parsed JSON into ReviewData field by field, never casts, and
│  │            # degrades an unreadable file to an empty review. Writers use
│  │            # createStore instead — it owns normalization and the backup
│  ├─ stats.ts  # pure reviewStats() + isActionable(), what `nit status` reports
│  ├─ clear.ts  # pure selectForClear() + clearBase(): what a clear scope matches, and
│  │            # the one operation that applies it (deletes via Store.remove)
│  ├─ derived.ts # writeDerivedFiles(): re-render review.md + fix-annotations.md after a
│  │             # write, shared by the MCP tools and `nit clear`
│  ├─ render.ts # pure ReviewData to review.md renderer, plus fix-annotations.md (issueRef
│  │            # sanitized to a safe-url link or inline code, capped at 200 chars)
│  ├─ url.ts    # resolveAnnotationUrl(): route to navigable url, rejects anything
│  │            # off the review's own http(s) origin; feeds `__nitGoTo`
│  └─ merge.ts  # pure merge of N feedback files (author-namespaced ids)
│
├─ mcp/         # `nit mcp`, a stdio MCP server over a review folder
│  ├─ server.ts    # the SDK server: handshake, standing INSTRUCTIONS, stdio transport
│  ├─ aggregate.ts # workspace-aware lookup for this layer: basesOf/baseSummaries/
│  │                # isMultiBase/findAnnotation/displayId. Qualified ids are made here
│  │                # on the way out and undone here on the way in
│  ├─ tools.ts     # the six nit_* tools over one review or every base of a workspace
│  ├─ schema.ts    # zod input shapes (inputs only — results are plain JSON text)
│  ├─ resources.ts # nit://review/*, nit://base/{slug}/{file} and nit://annotation/{id}
│  └─ history.ts   # compressHistory(): the click trail an agent actually needs
│
└─ util/
   ├─ error.ts   # errorMessage(unknown), safe narrowing for catch blocks
   ├─ history.ts # MAX_HISTORY / MAX_REOPEN_STEPS + sanitizeSteps(), the click caps
   │             # shared by the overlay (bounds as it records), the bridge
   │             # (re-validates saves) and the store (re-validates loads — reopen
   │             # steps are the only selectors nit ever clicks)
   ├─ route.ts   # currentRoute/routePath/routeKey, pure route helpers shared by the
   │             # overlay (captures routes) and the panel (groups and navigates by them)
   ├─ after-shots.ts # pure after-shot bookkeeping: which viewports a `fixed` annotation
   │                 # still needs shot, and where each one is filed
   ├─ user-config.ts # per-user config (~/.config/nit/config.json): the author name
   ├─ version.ts     # pkgVersion(), the one place package.json's version is read
   └─ slug.ts    # slugify() for author-derived ids and export file names
```

## Conventions

- **`types.ts` is the public contract.** The annotations.json schema is consumed by coding agents, the MCP server and other people's feedback files, so make additive changes only. The bridge types in the same file keep both runtimes honest about what crosses `exposeBinding`.
- **Trust boundaries are typed as `unknown`.** Anything that arrives from a page (bridge payloads), from disk (annotation files) or over stdio (MCP messages) is `unknown` first and narrowed or validated before use. Annotation files are shared and agent-edited, and the inspected site's own JS can call the bindings.
- **Pure modules stay pure.** `anchor/`, `capture/target.ts`, `store/render.ts`, `store/merge.ts`, `store/url.ts`, `store/stats.ts`, `workspace.ts`'s slug/id half (`baseSlug`, `qualifyId`, `parseQualifiedId`, `isSafeSlug`, `matchBases`, `resolveBase`, `safeOrigin`), `store/clear.ts`'s `selectForClear`, `util/route.ts`, `util/history.ts`, `panel/filter.ts` and `panel/highlight.ts` have no side effects and are covered by table-driven tests.
- **A slug becomes a path segment.** Anything that names a base folder is validated against `/^[a-z0-9][a-z0-9-]*$/` before it is joined into a path, and base lists always come from enumerating real directories — `bases.json` is hand-editable and travels inside shared zips, so a crafted `"slug": "../../.ssh"` must never resolve to a real path.
- **Imports use `.js` extensions** (`import ... from '../types.js'`). TypeScript NodeNext resolution means specifiers name the *emitted* files, so the compiled output runs on plain Node without rewriting.
- **The overlay ships self-contained.** No runtime dependencies, all UI inside its shadow root, capture-phase listeners, and nothing that can take the host page down.
