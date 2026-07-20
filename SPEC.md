# Nit — Design Spec

> Point-and-click annotation for websites, built to hand small UI fixes to a coding agent.

**Status:** LOCKED 2026-07-20 (rev 2) · **Author:** Kevin · **Codename:** `nit`

> Defaults locked: annotation `type` defaults to `change-request`; `viewportScope` defaults to the
> current viewport (toggleable to `general`).

---

## 1. Purpose

While browsing any website — a live deployed site, a staging URL, or a local `ng serve` — you
click UI elements, type short comments, **categorize each as a change request or a comment**, and Nit
records it tied to a **stable reference to the element** (component name, CSS selector, XPath,
screenshot) plus the **viewport** it was made in. It writes those annotations to a structured file that
a coding agent (Claude Code / Fable) reads to fix each change request directly. You can also **reload a
feedback file and re-view the annotations pinned back onto the pages/routes** where they were made.

The name is from code-review culture: reviewers prefix minor comments with `nit:`.

### Priority rule

Nit is meant to work on **any** website, but the **fainin Angular storefront is the priority target**.
When a design or technical decision forces a trade-off, **optimize for the Angular storefront first.**

### Success criteria

1. Run one command; a real browser opens at any URL with an annotation overlay. No changes to the site
   under review.
2. Clicking an element + typing a comment produces an annotation that has: a **type**
   (`change-request` | `comment`), an element reference precise enough for an agent to locate the source
   (component name at minimum; Angular class name when the build exposes it), a cropped screenshot, the
   **route**, and the **viewport** it was captured in.
3. Output is a plain `annotations.json` + a readable `review.md` that an agent fixes with no extra
   tooling.
4. **Co-founders use the same standalone tool** (no bookmarklet), produce a feedback file, and send it
   back; Nit **consumes/merges** one or more feedback files into a single review.
5. **Replay mode:** load a feedback file and re-view every annotation re-anchored on the pages/routes
   where it was given.
6. **Mobile + desktop:** switch viewport within a session; each annotation is scoped **general |
   desktop | mobile**, and replay filters by the viewport currently in use.
7. Self-hosted, open-source, framework-agnostic (verified on the Angular storefront). Zero backend.

### Non-goals (v1 — YAGNI)

- No auth, no hosted server, no cloud account, no real-time multi-user sync.
- No MCP server yet (schema is designed so one can wrap the file later without rework).
- No automatic fix-verification (see §10, v2 "close the loop").

### Known ergonomics trade-off

Dropping the bookmarklet means co-founders run the standalone tool, which needs Node + a Chromium
download (~1st run). Acceptable per Kevin. If that friction bites, the fast-follow is packaging Nit as a
**single-file executable** (e.g. `pkg`/SEA + a pinned browser) so a co-founder double-clicks one app —
tracked as a v1.1 idea, not v1 scope.

---

## 2. Architecture

One delivery path (Playwright-launched Chromium), one overlay, and three verbs.

```
nit review <url>          # capture: annotate a site, write a feedback file
nit view <file> [--url]   # replay: reload a feedback file, re-anchor annotations across routes
nit merge <file...>       # consume: combine co-founder feedback files into one review

nit/
├─ src/
│  ├─ overlay/     # injected annotation UI — vanilla JS/CSS in a Shadow DOM (capture AND replay)
│  ├─ cli/         # arg parsing + the three verbs
│  ├─ browser/     # Playwright: launch Chromium, bypassCSP, inject overlay, viewport switching, bridge
│  ├─ capture/     # element → target reference (§4) + CDP element screenshot
│  ├─ store/       # read/write annotations.json, render review.md, merge, screenshot files
│  └─ anchor/      # re-anchor an annotation to a live element for replay (selector → xpath → text)
└─ nit-review/     # OUTPUT
   ├─ annotations.json
   ├─ review.md
   └─ shots/*.png
```

### The overlay is one shared, framework-agnostic asset

It runs inside a stranger's page (the deployed storefront), so it is **vanilla JS/CSS in a Shadow DOM**
— no Angular/React assumptions, no host-CSS collisions. The same overlay serves **capture** (pick +
comment) and **replay** (show existing pins). It talks to Node through `page.exposeBinding`.

### 2.1 `browser/` — Playwright launcher

- Launch **headed** Chromium, persistent context, `bypassCSP: true` (so the overlay runs on
  CSP-hardened production sites), overlay injected via `page.addInitScript` (before page scripts, on
  every navigation — survives SPA route changes).
- **Viewport switching:** an overlay control (and a `--device` flag) flips **desktop ↔ mobile**. v1
  switches viewport size (e.g. 1440×900 ↔ 390×844) via `page.setViewportSize`; full device emulation
  (touch, UA via a new context from Playwright `devices[...]`) is a nice-to-have, not required.
- **Bridge:** `page.exposeBinding('__nitSave', ...)`, plus `__nitLoad` (replay) and `__nitSetViewport`.

### 2.2 `overlay/` — the injected UI

- **Capture mode:** hover highlights the element (Alt-to-toggle picking so the page stays usable,
  Esc-cancels), click selects, a popover collects: the **comment text**, a **type** selector
  (Change request / Comment), and a **viewport-scope** toggle (General / current viewport).
- **Replay mode:** renders existing annotations as numbered pins anchored to their elements on the
  current route, filtered by the active viewport; a sidebar lists them; clicking a pin shows the
  comment, type, author, and screenshot. Unanchorable items (element gone) drop to a "couldn't place"
  list in the sidebar, still showing their screenshot.
- Sidebar always shows the running list with type badges; a filter toggles All / current-viewport-only.

### 2.3 `capture/` — target resolution + screenshot

- Compute the **target reference** (§4).
- CDP `Page.captureScreenshot` clipped to the element rect (+ small padding) → `shots/<id>.png`.

### 2.4 `anchor/` — replay re-anchoring (pure-ish, testable)

- Given an annotation + the live DOM, resolve the element: try `selector`, then `xpath`, then a
  text-match heuristic on `target.text` scoped to `target.component`. Return the element or `null`.
- Degrade gracefully: `null` → the annotation goes to the sidebar "couldn't place" list, never crashes.

### 2.5 `store/` — persistence, render, merge

- Read/write `annotations.json` (§3), stable ids, idempotent append.
- `review.md` renderer (§5).
- **Merge:** combine N feedback files → one review; namespace ids by author to avoid collisions
  (`kevin:a1`, `ann:a1`), copy screenshots into a shared `shots/`, preserve each annotation's `author`,
  `route`, and `viewport`.

---

## 3. Data format (`annotations.json`) — MCP-ready

```json
{
  "review": {
    "id": "2026-07-20-storefront",
    "url": "https://storefront.fainin.com",
    "createdAt": "2026-07-20T14:12:00Z",
    "authors": ["Kevin"]
  },
  "annotations": [
    {
      "id": "a1",
      "type": "change-request",
      "comment": "Badge should be the yellow accent, not gray",
      "status": "open",
      "author": "Kevin",
      "viewportScope": "general",
      "viewport": { "mode": "desktop", "w": 1440, "h": 900 },
      "route": "/products/xyz",
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
      "screenshot": "shots/a1.png",
      "createdAt": "2026-07-20T14:12:03Z"
    }
  ]
}
```

Field notes:
- **`type`** ∈ `change-request | comment`. Default in the overlay: `change-request` (the actionable one).
- **`status`** ∈ `open | fixed | wontfix`. Agent flips `open → fixed`; future MCP `mark_fixed` writes it.
- **`author`** is per-annotation (so merged files keep attribution); `review.authors` is the union.
- **`viewportScope`** ∈ `general | desktop | mobile` — which views the note applies to. Overlay default:
  the current viewport mode, toggleable to `general`.
- **`viewport`** — the actual size/mode the annotation was captured at.
- **`route`** — path the annotation belongs to; replay uses it to know which page to show it on.
- **`ngComponent`** is `null` when `window.ng` isn't exposed (production builds).

Stable ids + `status` are exactly what a thin MCP wrapper needs (`list_annotations` / `get_annotation`
/ `mark_fixed`) — v1 ships the file, v2 wraps it, no schema change.

---

## 4. Target resolution — layered (Angular is the priority)

Always capture (framework-agnostic, works on production builds):

- **`component`** — nearest ancestor whose tag contains a hyphen (custom element / Angular selector),
  e.g. `app-product-tile`; falls back to the element's own tag.
- **`selector`** — short, stable CSS path (prefer `id`, then custom-element tag + `nth-of-type`, avoid
  brittle deep chains). Also used as the primary replay anchor, so favor stability.
- **`xpath`**, **`tag`**, **`classes`**, **`text`** (trimmed/capped), **`rect`**.

Then enrich **if `window.ng` is present** (Angular dev/staging builds expose it; prod strips it):

- **`ngComponent`** — `window.ng.getComponent(el)?.constructor.name` walked to the nearest component
  instance → the real class name (`ProductTileComponent`), which an agent greps straight to the source.

Result: prod site → `app-product-tile` (enough to locate code); `localhost:4200` → also
`ProductTileComponent`. Never fail when `window.ng` is absent. Because the storefront is the priority,
invest here first: the Angular class name is the single most valuable pointer for the fixing agent.

---

## 5. Claude Code handoff

`review.md` is human- and agent-readable:

```markdown
# Nit review — storefront.fainin.com — 2026-07-20

## a1 · change-request · open · desktop — Badge should be the yellow accent, not gray
![a1](shots/a1.png)
- component: `app-product-tile` (ProductTileComponent)
- selector: `app-product-tile:nth-of-type(3) > .badge`
- route: `/products/xyz` · author: Kevin · scope: general
```

The `/fix-annotations` contract: *"Read `nit-review/annotations.json`. For each annotation with
`status: open` **and `type: change-request`**, make the change described in `comment` at the referenced
element, then set `status` to `fixed`. Treat `type: comment` as context — do not change code for it;
surface it to the user instead."*

---

## 6. Viewports (mobile + desktop)

- One session can switch **desktop ↔ mobile** via an overlay control (and a `--device` / `--mobile`
  launch flag). v1 = viewport-size switch; device emulation is optional.
- Each annotation records the `viewport` it was made at and a `viewportScope` (general / desktop /
  mobile). In **replay**, the active viewport filters what's shown: desktop shows `{general, desktop}`,
  mobile shows `{general, mobile}`, with an overlay toggle to show All.

## 7. Replay (`nit view <file>`)

- Load a feedback file, open its `url` (or `--url` override), inject the overlay in **replay mode**.
- As you navigate routes, the overlay shows the annotations whose `route` matches the current path,
  re-anchored via `anchor/` and filtered by the current viewport. This is how Kevin re-reads
  co-founder feedback in situ and how anyone reviews what's been reported before.

## 8. Consume / merge (`nit merge <file...>`)

- Combine co-founder feedback files into one consolidated review with namespaced ids and a shared
  `shots/`. Preserves per-annotation `author`, `route`, `viewport`. Output feeds `review`, `view`
  (replay the merged set), and the agent handoff identically.

---

## 9. Stack

- Node ≥ 18, ES modules.
- **Playwright** — the only heavy dependency (browser automation + CDP screenshots + device sizes).
- **esbuild** — bundles `overlay/` into the injected script.
- Otherwise stdlib only. Output is plain files.

---

## 10. Build milestones (ship 0–5 first: the solo capture→fix loop)

Each milestone has a **machine-checkable "Done when"**; verify with an *external* check, never the
builder's own say-so.

0. **Prove the schema by hand (no code).** Hand-author 2–3 `annotations.json` entries (incl. `type`,
   `viewportScope`, `viewport`) against the real storefront and fix them from the JSON alone.
   **Done when:** a hand-authored entry leads to a correct code fix with no extra context.
1. **Walking skeleton** — `nit review <url>` launches Chromium (`bypassCSP`) + trivial overlay logs a
   click. **Done when:** a Playwright smoke test on a fixture AND a manual run on the live storefront
   both log an overlay click.
2. **Pick + comment + save** — picker, popover with **type** selector + **viewport-scope** toggle,
   `__nitSave` writes one annotation (no screenshot yet). **Done when:** an automated run saves a
   comment and the written object (incl. `type`, `viewportScope`) matches expected in a test.
3. **Target resolution** — pure fn (§4). **Done when:** a ≥8-case unit table (id / custom-element
   ancestor / deep nest / `window.ng` present vs absent) returns the expected `target`.
4. **Screenshots** — CDP element-clip → `shots/`. **Done when:** each annotation has a non-empty PNG
   sized to the element rect (±padding), asserted in a test.
5. **review.md renderer** + `/fix-annotations` file. **Done when:** renderer (annotations → markdown)
   passes a snapshot test and only `change-request` items are marked actionable.
6. **Viewports** — desktop/mobile switch + per-annotation `viewport`. **Done when:** switching mode
   changes `page` viewport and a saved annotation records the active `viewport`.
7. **Replay (`nit view`)** — re-anchor + route/viewport filtering. **Done when:** loading a fixture
   feedback file shows the right pins on the right route/viewport, and a missing element degrades to
   the "couldn't place" list instead of crashing (both asserted).
8. **Merge (`nit merge`)** — combine files, namespaced ids, shared shots. **Done when:** merging two
   fixture files yields one review with no id collisions and both authors preserved (test).
9. **Polish** — sidebar delete, Finish-review flush, idempotent append.

## 11. Acceptance test (external verifier)

`nit review` the deployed storefront, annotate a real element as a `change-request`, close the browser,
then in a **fresh agent session with no build memory** point at `nit-review/` and confirm it locates and
fixes the referenced component from the annotation alone. The fresh agent is the verifier — the session
that wrote the resolver must not certify it. If the reference doesn't survive to a fix, harden §4.

---

## 12. v2 — close the loop (out of scope for v1; schema supports it)

Nit is loop infrastructure: `annotations.json` is the **state layer**, your review is the **human
checkpoint**, the agent walking `open → fixed` is the **loop**. The missing part is the **verifier** —
v1 lets the agent flip `status` on its own claim. v2: after a `fixed` mark, `nit verify` re-launches at
the same route/viewport, captures an **after** screenshot, and diffs / re-presents before/after for a
`verified` | `reopened` decision by an external check. Additive schema only: add `verifiedAt` and
`screenshotAfter`; `status` gains `verified` | `reopened`. No v1 field changes; still feeds the MCP
server.
