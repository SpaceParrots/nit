# src/ — nit's source scaffolding

Everything in here is **TypeScript in strict mode**, compiled by `tsc` to `dist/`
(`npm run build`). The published package and the tests run the compiled output;
nothing in `src/` executes directly.

## The two runtimes

nit's code runs in two very different places, and the directory layout follows that split:

| Runtime | Directories | Constraints |
|---|---|---|
| **Node** (CLI process) | `cli/`, `browser/`, `store/`, `mcp/`, `util/`, `capture/screenshot.ts` | Node ≥ 18, may use `node:*` modules and Playwright |
| **Browser** (injected into the inspected page) | `overlay/`, `anchor/`, `capture/target.ts` | Bundled by esbuild into a single IIFE, injected via `addInitScript`. No Node APIs, no framework, never throw into or break the host page |

The overlay bundle is built at runtime: `browser/inject.ts` points esbuild at the
*compiled* `dist/overlay/main.js` (plus `overlay.css`, copied into `dist/` by the
build) and injects the result into every page of the session. The two sides talk
exclusively through the `window.__nit*` bindings wired in `browser/bridge.ts`.

## Directory map

```
src/
├─ types.ts     # THE shared contract: annotations.json schema types (Annotation,
│               # Target, ReviewData, …) + the bridge contract (SavePayload,
│               # PanelState, OverlayEvent, …) + Window augmentation for __nit*
├─ css.d.ts     # lets TS import .css as a string (esbuild `text` loader)
│
├─ cli/         # commander CLI — the entrypoints
│  ├─ index.ts  # `nit` binary: review / view / verify / merge / mcp / doctor
│  ├─ merge.ts  # `nit merge`: read feedback files, merge, copy screenshots
│  └─ doctor.ts # `nit doctor`: env checks + optional Chromium install
│
├─ browser/     # Node side of a live session (Playwright)
│  ├─ launch.ts   # Chromium launcher: persistent profile, bypassCSP, viewports
│  ├─ session.ts  # startSession(): owns the store, wires everything, `NitSession`
│  ├─ inject.ts   # esbuild-bundles the overlay and registers it as an init script
│  ├─ bridge.ts   # exposeBinding handlers — the ONLY page↔Node channel; validates
│  │              # every payload (pages can forge calls) and guards by frame/page
│  ├─ panel.ts    # the side panel popup window (self-contained HTML string)
│  └─ verify.ts   # `nit verify` after-shot capture for `fixed` annotations
│
├─ overlay/     # injected page UI — vanilla DOM in an open Shadow DOM
│  ├─ main.ts     # entrypoint: boot guard, state, wiring, route watcher, resync
│  ├─ state.ts    # OverlayState / OverlayActions / part interfaces (types only)
│  ├─ picker.ts   # Alt-toggled element picking (capture-phase listeners)
│  ├─ popover.ts  # the annotation form (comment, type, viewport scope)
│  ├─ pins.ts     # numbered pins for re-anchored annotations
│  ├─ chip.ts     # bottom-left status chip
│  ├─ dom.ts      # tiny DOM helpers (div/span/button/segmented)
│  └─ overlay.css # overlay styles, bundled as text into the IIFE
│
├─ capture/     # how an annotation gets its element reference + screenshot
│  ├─ target.ts     # (browser) element → layered Target reference — pure
│  └─ screenshot.ts # (node) CDP element-clip screenshots with context padding
│
├─ anchor/      # replay: Target → live element (selector → xpath → text) — pure
│  └─ anchor.ts
│
├─ store/       # the review folder on disk
│  ├─ store.ts  # annotations.json read/write: stable ids, atomic flush,
│  │            # concurrent-writer status merge, path-traversal-safe shot paths
│  ├─ render.ts # pure ReviewData → review.md renderer + fix-annotations.md
│  └─ merge.ts  # pure merge of N feedback files (author-namespaced ids)
│
├─ mcp/         # `nit mcp` — stdio MCP server over a review folder
│  └─ server.ts # newline-delimited JSON-RPC 2.0, stdlib only, re-reads per call
│
└─ util/
   └─ error.ts  # errorMessage(unknown) — safe narrowing for catch blocks
```

## Conventions

- **`types.ts` is the public contract.** The annotations.json schema is consumed by
  coding agents, the MCP server and other people's feedback files — additive
  changes only. The bridge types in the same file keep both runtimes honest about
  what crosses `exposeBinding`.
- **Trust boundaries are typed as `unknown`.** Anything that arrives from a page
  (bridge payloads), from disk (annotation files) or over stdio (MCP messages) is
  `unknown` first and narrowed/validated before use — annotation files are shared
  and agent-edited, and the inspected site's own JS can call the bindings.
- **Pure modules stay pure.** `anchor/`, `capture/target.ts`, `store/render.ts` and
  `store/merge.ts` have no side effects and are covered by table-driven tests.
- **Imports use `.js` extensions** (`import … from '../types.js'`) — TypeScript
  NodeNext resolution: specifiers name the *emitted* files, so the compiled output
  runs on plain Node without rewriting.
- **The overlay ships self-contained.** No runtime dependencies, all UI inside a
  closed-off shadow root, capture-phase listeners, and nothing that can take the
  host page down.
