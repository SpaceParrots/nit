# Nit — Design Spec

> Point-and-click annotation for websites, built to hand small UI fixes straight to a coding agent.

**Status:** design approved 2026-07-20 · **Author:** Kevin · **Codename:** `nit`

---

## 1. Purpose

While browsing any website — a live deployed site, a staging URL, or a local `ng serve` — you
click UI elements, type short comments ("this badge should be yellow, not gray"), and Nit records
each comment tied to a **stable reference to the element** (component name, CSS selector, XPath,
screenshot). It writes those annotations to a structured file that a coding agent (Claude Code /
Fable) reads to fix each item directly.

The name is from code-review culture: reviewers prefix minor comments with `nit:`. Nit is a tool
for capturing the little things and getting them fixed fast.

### Success criteria

1. Run one command, a real browser opens at any URL, and an annotation overlay is available.
2. Clicking an element + typing a comment produces an annotation with an element reference precise
   enough for an agent to locate the source (component name at minimum; Angular class name when the
   build exposes it) plus a cropped screenshot.
3. The output is a plain `annotations.json` + a readable `review.md` that an agent fixes with no
   extra tooling.
4. A non-technical co-founder can annotate the **live** site via a bookmarklet (no install) and send
   the exported file back.
5. Zero backend, zero storefront changes, self-hosted, framework-agnostic (verified on an Angular
   storefront).

### Non-goals (v1 — YAGNI)

- No auth, no hosted server, no cloud account.
- No real-time multi-user sync. Co-founder round-trip is file-based (export → send → merge).
- No MCP server yet (the schema is designed so one can wrap the file later without rework).

---

## 2. Architecture

Five small units and **one shared overlay** delivered two ways.

```
nit/
├─ src/
│  ├─ overlay/      # the injected annotation UI — vanilla JS/CSS, NO framework
│  ├─ cli/          # Node + Playwright: launch Chromium, inject overlay, bridge to disk
│  ├─ capture/      # element → target reference (selector/xpath/component) + CDP screenshot
│  ├─ store/        # write annotations.json, render review.md, save PNGs
│  └─ bookmarklet/  # same overlay bundled for co-founders (localStorage + export button)
└─ nit-review/      # OUTPUT (gitignored by default in consuming repos)
   ├─ annotations.json
   ├─ review.md
   └─ shots/*.png
```

### The load-bearing idea

The **overlay is a single vanilla-JS asset**. It must run inside a stranger's page (the deployed
storefront), so it cannot depend on Angular/React or any global the host page might not have. Two
thin wrappers deliver it:

- **CLI wrapper (Playwright):** the rich path for Kevin. Launches headed Chromium, injects the
  overlay, persists to disk, captures crisp screenshots via CDP.
- **Bookmarklet wrapper:** the co-founder path. The same overlay, but it stores annotations in
  `localStorage` and adds an **Export** button that downloads `annotations.json` + a screenshots zip.

Build both from the same source with esbuild. Fix a bug in the overlay once, both paths get it.

### 2.1 `cli/` — Playwright launcher

```
nit review <url> [--out ./nit-review] [--browser chromium] [--author Kevin]
```

- Launch **headed** Chromium via Playwright with a persistent context.
- `browserContext({ bypassCSP: true })` — disables the page's Content-Security-Policy so the injected
  overlay runs even on hardened production sites. **This is the key that makes live sites work.**
- `page.addInitScript({ path: overlayBundle })` — injects the overlay **before** page scripts, on
  every navigation, so it survives SPA route changes without re-injection glue.
- `page.exposeBinding('__nitSave', handler)` — the overlay calls this to hand an annotation back to
  Node; the handler resolves the target, triggers a CDP screenshot, and appends to the store.
- On browser close (or a "Finish review" overlay button), flush the store and print the output path.

### 2.2 `overlay/` — the injected UI

- **Element picker:** hover highlights the element under the cursor (outline + dimmed rest); click
  selects it. `Esc` cancels. A modifier (e.g. hold `Alt`) toggles picking so normal page interaction
  still works.
- **Comment popover:** anchored near the selected element; textarea + Save/Cancel.
- **Sidebar:** list of pending annotations for this session with delete; a "Finish review" button.
- Must be **Shadow-DOM isolated** so the host page's CSS can't style the overlay and vice-versa.
- On Save, gather the element handle's reference data (§4) locally, then call `__nitSave` (CLI) or
  push to `localStorage` (bookmarklet).

### 2.3 `capture/` — target resolution + screenshot

- Compute the **target reference** (§4) for the selected element.
- Screenshot: CDP `Page.captureScreenshot` clipped to the element's bounding rect (+ small padding),
  saved as `shots/<id>.png`. In the bookmarklet path, fall back to `html2canvas` or the element's
  `getBoundingClientRect` + a full-frame capture (co-founder screenshots can be lower fidelity).

### 2.4 `store/` — persistence

- Append annotations to `annotations.json` (schema §3), stable incrementing ids (`a1`, `a2`, …).
- Render `review.md` (§5) after each flush.
- Idempotent: re-running `nit review` on the same `--out` appends a new review block, never clobbers.

### 2.5 `bookmarklet/` — co-founder path

- `nit bookmarklet` prints/writes the `javascript:` bookmarklet (loads the hosted overlay bundle) and
  a short "drag this to your bookmark bar" instruction page.
- Overlay runs in the co-founder's own browser on the live site; **Export** downloads the same
  `annotations.json` shape so Kevin merges it into his `nit-review/`.

---

## 3. Data format (`annotations.json`) — MCP-ready

```json
{
  "review": {
    "id": "2026-07-20-storefront",
    "url": "https://storefront.fainin.com/products/xyz",
    "createdAt": "2026-07-20T14:12:00Z",
    "author": "Kevin",
    "viewport": { "w": 1440, "h": 900 }
  },
  "annotations": [
    {
      "id": "a1",
      "comment": "Badge should be the yellow accent, not gray",
      "status": "open",
      "target": {
        "component": "app-product-tile",
        "ngComponent": "ProductTileComponent",
        "selector": "app-product-tile:nth-of-type(3) > .badge",
        "xpath": "/html/body/.../app-product-tile[3]/div/span",
        "tag": "span",
        "classes": ["badge", "badge--muted"],
        "text": "New",
        "rect": { "x": 812, "y": 340, "w": 48, "h": 22 }
      },
      "route": "/products/xyz",
      "screenshot": "shots/a1.png",
      "createdAt": "2026-07-20T14:12:03Z"
    }
  ]
}
```

- `status` ∈ `open | fixed | wontfix`. The agent flips `open → fixed` as it resolves items; a future
  MCP server's `mark_fixed` writes the same field.
- `ngComponent` is `null` when the build doesn't expose `window.ng` (see §4).
- Stable `id`s + `status` are exactly what a thin MCP wrapper (`list_annotations` / `get_annotation`
  / `mark_fixed`) needs — v1 ships the file, v2 wraps it, no schema change.

---

## 4. Target resolution — layered

Always capture (framework-agnostic, works on production builds):

- **`component`** — nearest ancestor whose tag contains a hyphen (custom element / Angular selector),
  e.g. `app-product-tile`. Falls back to the element's own tag if none.
- **`selector`** — a short, stable CSS path (prefer `id`, then custom-element tag + `nth-of-type`,
  avoid brittle deep chains).
- **`xpath`**, **`tag`**, **`classes`**, **`text`** (trimmed, capped), **`rect`**.

Then enrich **if `window.ng` is present** (Angular dev/staging builds expose it; production strips it):

- **`ngComponent`** — `window.ng.getComponent(el)?.constructor.name` walked up to the nearest
  component instance → the real class name (`ProductTileComponent`), which an agent greps directly
  to the source file.

Result: on the live prod site you still get `app-product-tile` (enough to locate the code); on
`localhost:4200` you additionally get `ProductTileComponent`. Never fail if `window.ng` is absent.

---

## 5. Claude Code handoff

`review.md` is the human- and agent-readable artifact:

```markdown
# Nit review — storefront.fainin.com — 2026-07-20

## a1 · open — Badge should be the yellow accent, not gray
![a1](shots/a1.png)
- component: `app-product-tile` (ProductTileComponent)
- selector: `app-product-tile:nth-of-type(3) > .badge`
- route: `/products/xyz`
```

v1 ships a `/fix-annotations` convention — a one-line instruction to the agent: *"Read
`nit-review/annotations.json`. For each annotation with `status: open`, make the change described in
`comment` at the referenced element, then set its `status` to `fixed`."* No custom tooling required.

---

## 6. Stack

- Node ≥ 18, ES modules.
- **Playwright** — the only heavy dependency (browser automation + CDP screenshots).
- **esbuild** — bundles `overlay/` into the CLI-injected script and the bookmarklet.
- Otherwise stdlib only. Output is plain files.

---

## 7. Build milestones

1. **Walking skeleton:** `nit review <url>` launches Chromium with `bypassCSP`, injects a trivial
   overlay that logs a click. Proves injection works on the live storefront.
2. **Pick + comment + save:** element picker, comment popover, `exposeBinding` → write one annotation
   (no screenshot yet) to `annotations.json`.
3. **Target resolution:** layered reference (§4) + stable selector generation.
4. **Screenshots:** CDP element-clip capture → `shots/`.
5. **review.md renderer** + `/fix-annotations` instruction.
6. **Bookmarklet build:** same overlay via esbuild, `localStorage` + export.
7. **Polish:** sidebar, delete, Finish-review flush, idempotent append.

Ship 1–5 first; that alone satisfies the core solo workflow. 6 is the co-founder unlock. 7 is nice-to-have.

## 8. Acceptance test (the one that matters)

Run `nit review https://<deployed-storefront>`, annotate a real element, close the browser, then in a
Claude Code session point it at `nit-review/` and confirm it locates and fixes the referenced
component from the annotation alone. If the selector/component reference doesn't survive to a
successful fix, target resolution (§4) needs work — that's the highest-risk unit.
