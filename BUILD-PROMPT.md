# Nit — build prompt for Fable

> Paste the block below into a fresh Claude Fable / Claude Code session whose working directory is
> `D:\Tools\Nit`. `SPEC.md` in this repo is the full design; the prompt tells the agent to follow it.

---

You are building **Nit**, a point-and-click website annotation tool that hands small UI fixes to a
coding agent. The complete design is in `SPEC.md` in this repo — **read it first and treat it as the
source of truth.** Build in this repo (`D:\Tools\Nit`).

## What Nit does

`nit review <url>` launches a real (headed) Chromium at any URL — live site, staging, or
`localhost:4200`. An injected overlay lets me hover-highlight elements, click one, type a comment,
and save. Each saved comment is stored with a stable reference to the element (nearest custom-element
/ component tag, CSS selector, XPath, classes, text, bounding rect) plus a cropped screenshot, in
`nit-review/annotations.json` and a readable `nit-review/review.md`. I then tell a coding agent to
read that file and fix each `open` annotation.

## Hard requirements (from SPEC.md)

- **Works on live, CSP-hardened sites.** Launch the Playwright browser context with
  `bypassCSP: true` and inject the overlay via `page.addInitScript` so it loads before page scripts
  and survives SPA route changes. Do NOT inject via a `<script>` tag appended at runtime.
- **Overlay is framework-agnostic vanilla JS/CSS in a Shadow DOM.** It runs inside a stranger's page
  and must not assume Angular/React or collide with host CSS.
- **The overlay is ONE shared asset** bundled by esbuild and delivered two ways: (a) injected by the
  Playwright CLI, (b) a bookmarklet build for non-technical reviewers (localStorage + an Export
  button producing the same JSON shape).
- **Bridge overlay → disk** with `page.exposeBinding('__nitSave', ...)`. The Node handler resolves
  the target reference, captures a CDP element-clip screenshot (`Page.captureScreenshot` with a
  clip), and appends to the store.
- **Layered target resolution:** always capture selector/xpath/nearest-custom-element-tag/rect;
  additionally, if `window.ng` exists, enrich with the Angular component class name
  (`window.ng.getComponent(el)?.constructor.name`). Never fail when `window.ng` is absent.
- **Output schema exactly as in SPEC.md §3**, with `status: open|fixed|wontfix` and stable ids so a
  future MCP server can wrap the file unchanged. Do not build the MCP server now.
- **Zero backend, zero changes to the site under review.** Node ≥18, ESM, Playwright + esbuild the
  only deps, stdlib otherwise.

## Build order (ship 1–5 first; they satisfy the core solo workflow)

1. **Walking skeleton** — `nit review <url>` launches Chromium with `bypassCSP` and injects a trivial
   overlay that logs a click to the Node console. Verify against a real deployed site.
2. **Pick + comment + save** — hover-highlight element picker (Alt-to-toggle, Esc-to-cancel), comment
   popover, `__nitSave` bridge writing one annotation (no screenshot yet) to `annotations.json`.
3. **Target resolution** — the layered reference incl. stable selector generation and the `window.ng`
   enrichment.
4. **Screenshots** — CDP element-clip capture into `nit-review/shots/`.
5. **review.md renderer** + write a `/fix-annotations` instruction file explaining the agent
   contract.
6. **Bookmarklet build** — same overlay via esbuild, localStorage store, Export button.
7. **Polish** — sidebar with delete, "Finish review" flush, idempotent append across runs.

## Working agreement

- Follow test-driven development where it's cheap (target resolution and the store are pure functions
  — unit-test those). The browser/overlay integration can be verified with a Playwright smoke test
  against a small static fixture page plus one manual run against the real storefront.
- Keep files small and single-purpose per the module layout in SPEC.md §2.
- After each milestone, stop and show me it working (a command to run + what I should see) before
  moving on.
- Commit after each green milestone with Conventional Commits (one line, no co-author).

## The acceptance test that matters (SPEC.md §8)

Run `nit review` against my deployed Angular storefront, annotate a real element, close the browser,
then in a separate agent session point at `nit-review/` and confirm the agent locates and fixes the
referenced component from the annotation alone. If the reference doesn't survive to a successful fix,
target resolution is the unit to harden.

Start by reading `SPEC.md`, then propose the concrete file tree and the milestone-1 implementation,
and wait for my go-ahead before writing code.
