# Nit — build prompt for Fable

> Paste the block below into a fresh Claude Fable / Claude Code session whose working directory is
> `D:\Tools\Nit`. `SPEC.md` in this repo is the full design; the prompt tells the agent to follow it.

---

You are building **Nit**, a point-and-click website annotation tool that hands small UI fixes to a
coding agent. The complete design is in `SPEC.md` in this repo — **read it first and treat it as the
source of truth.** Build in this repo (`D:\Tools\Nit`).

## What Nit does

Three verbs, one Playwright-launched Chromium, one injected overlay:

- `nit review <url>` — annotate any site (live, staging, or `localhost:4200`): hover-highlight an
  element, click it, type a comment, pick a **type** (change request / comment) and a **viewport scope**
  (general / current viewport), save. Each note is stored with a stable element reference (nearest
  custom-element / component tag, CSS selector, XPath, classes, text, rect), a cropped screenshot, the
  route, and the viewport. Output: `nit-review/annotations.json` + `review.md` + `shots/`.
- `nit view <file>` — reload a feedback file and re-view the annotations pinned back onto the pages/
  routes where they were made, filtered by the current viewport.
- `nit merge <file...>` — combine co-founder feedback files into one consolidated review.

A coding agent then reads `nit-review/` and fixes each `open` change request.

## Priority rule

Nit must work on any website, but the **fainin Angular storefront is the priority target** — when a
decision forces a trade-off, optimize for the Angular storefront first (especially target resolution:
getting the Angular component class name is the highest-value pointer for the fixing agent).

## Hard requirements (from SPEC.md)

- **Works on live, CSP-hardened sites:** Playwright context with `bypassCSP: true`; inject the overlay
  via `page.addInitScript` (before page scripts, survives SPA route changes). Never inject via a runtime
  `<script>` tag.
- **Overlay is framework-agnostic vanilla JS/CSS in a Shadow DOM** — it runs inside a stranger's page;
  no Angular/React assumptions, no host-CSS collisions. The **same overlay** serves capture and replay.
- **Single delivery path — no bookmarklet.** Co-founders run the same standalone tool, produce a
  feedback file, and send it back; `nit merge` consumes one or more files.
- **Bridge overlay → Node** with `page.exposeBinding` (`__nitSave`, `__nitLoad`, `__nitSetViewport`).
  The save handler resolves the target, captures a CDP element-clip screenshot, appends to the store.
- **Layered target resolution:** always selector/xpath/nearest-custom-element-tag/classes/text/rect;
  additionally, if `window.ng` exists, `window.ng.getComponent(el)?.constructor.name`. Never fail when
  `window.ng` is absent.
- **Annotation types:** every annotation has `type: change-request | comment` (overlay default
  `change-request`). `/fix-annotations` acts only on open `change-request`s; `comment`s are context.
- **Viewports:** desktop/mobile switch within a session (overlay control + `--device`/`--mobile` flag;
  v1 = `page.setViewportSize`). Each annotation records `viewport` and a `viewportScope`
  (`general | desktop | mobile`, default = current mode, toggleable to general). Replay filters by the
  active viewport (desktop shows `{general,desktop}`, mobile shows `{general,mobile}`, toggle for All).
- **Replay re-anchoring** (`anchor/`): resolve `selector` → `xpath` → text heuristic; on failure, drop
  the annotation to a sidebar "couldn't place" list — never crash.
- **Output schema exactly as SPEC.md §3** (`type`, `status`, per-annotation `author`, `viewportScope`,
  `viewport`, `route`, `target`, `screenshot`). Stable ids so a future MCP server wraps the file
  unchanged. Do not build the MCP server now.
- **Zero backend, zero changes to the site under review.** Node ≥18, ESM, Playwright + esbuild the only
  deps, stdlib otherwise.

## Build order — each milestone has a machine-checkable "Done when" (ship 0–5 first)

Verify each with an **external** check (a test, a file assertion, a fresh agent), never your own
say-so — grading your own output is the failure mode to avoid.

0. **Prove the schema by hand (no code).** Before any capture code, hand-author 2–3
   `nit-review/annotations.json` entries (incl. `type`, `viewportScope`, `viewport`) against my real
   deployed storefront (I'll give the URL + comments), then fix them in the storefront codebase using
   only the JSON. This is the real spec for target resolution — if a hand-written entry isn't enough to
   locate and fix the component, change the schema now.
   **Done when:** a hand-authored `annotations.json` leads to a correct code fix with no extra context.
1. **Walking skeleton** — `nit review <url>` launches Chromium (`bypassCSP`) + trivial overlay logs a
   click. **Done when:** a Playwright smoke test on a fixture AND a manual run on the live storefront
   both log an overlay click to stdout.
2. **Pick + comment + save** — picker (Alt-toggle, Esc-cancel), popover with **type** selector +
   **viewport-scope** toggle, `__nitSave` writes one annotation (no screenshot yet). **Done when:** an
   automated run saves a comment and the written object (incl. `type`, `viewportScope`) matches expected.
3. **Target resolution** — pure fn (element/DOM → target). **Done when:** a ≥8-case unit table (id /
   custom-element ancestor / deep nest / `window.ng` present vs absent) returns the expected `target`.
4. **Screenshots** — CDP element-clip → `shots/`. **Done when:** each annotation has a non-empty PNG
   sized to the element rect (±padding), asserted in a test.
5. **review.md renderer** + `/fix-annotations` file. **Done when:** the pure renderer passes a snapshot
   test and marks only `change-request` items actionable.
6. **Viewports** — desktop/mobile switch + per-annotation `viewport`. **Done when:** switching mode
   changes the page viewport and a saved annotation records the active `viewport`.
7. **Replay (`nit view`)** — re-anchor + route/viewport filtering. **Done when:** loading a fixture
   feedback file shows the right pins on the right route/viewport, and a missing element degrades to the
   "couldn't place" list instead of crashing (both asserted).
8. **Merge (`nit merge`)** — combine files, namespaced ids, shared shots. **Done when:** merging two
   fixture files yields one review with no id collisions and both authors preserved.
9. **Polish** — sidebar delete, Finish-review flush, idempotent append.

## Working agreement

- TDD where cheap: `capture/` (target resolution), `store/` (merge, render), and `anchor/` (re-anchor)
  are pure/near-pure — unit-test them hard. Browser/overlay integration → Playwright smoke tests on a
  small static fixture page + one manual run on the real storefront.
- Keep files small and single-purpose per SPEC.md §2.
- After each milestone, stop and show me it working (a command + what I should see) before moving on.
- Commit after each green milestone with Conventional Commits (one line, no co-author).

## Acceptance test — EXTERNAL verifier (SPEC.md §11)

`nit review` the deployed Angular storefront, annotate a real element as a `change-request`, close the
browser, then in a **fresh agent session with no memory of this build** point at `nit-review/` and
confirm it locates and fixes the referenced component from the annotation alone. That fresh agent is the
verifier — the session that wrote the resolver must not certify it. If the reference doesn't survive to a
fix, harden target resolution (milestone 3).

## Mindset (loop-engineering)

Building Nit is chain-shaped (milestones known up front) — run it as a chain, but apply two loop
disciplines: every milestone has a machine-checkable "Done when", and the verifier is external wherever
possible. Note that **Nit is itself loop infrastructure** (`annotations.json` = state layer, my review =
human checkpoint); the v2 "close the loop" fix-verifier is described in SPEC.md §12 and is out of scope
here.

Start by reading `SPEC.md`, then do milestone 0 with me (hand-author the schema and prove it's fixable),
and only after that propose the concrete file tree and milestone-1 implementation. Wait for my go-ahead
before writing code.
