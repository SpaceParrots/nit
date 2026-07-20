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

## Build order (ship 0–5 first; they satisfy the core solo workflow)

Each milestone has a **machine-checkable "Done when"** — treat it as the definition of done and do not
move on until an *external* check (a test, a file assertion, a fresh agent) confirms it, not your own
say-so. Grading your own output is the failure mode to avoid.

0. **Prove the schema by hand (no code).** Before writing capture code, hand-author 2–3
   `nit-review/annotations.json` entries against my real deployed storefront (I will give the URL and
   the comments), then fix those items in the storefront codebase using only the JSON. This validates
   that the §3/§4 reference is actually *fixable*. If a hand-written entry is not enough to locate and
   fix the component, change the schema now — this is the real spec for target resolution.
   **Done when:** a hand-authored `annotations.json` leads to a correct code fix with no extra context.
1. **Walking skeleton** — `nit review <url>` launches Chromium with `bypassCSP` and injects a trivial
   overlay that logs a click to the Node console.
   **Done when:** a Playwright smoke test navigates a fixture page AND a manual run against the live
   storefront both log an overlay click to stdout.
2. **Pick + comment + save** — hover-highlight element picker (Alt-to-toggle, Esc-to-cancel), comment
   popover, `__nitSave` bridge writing one annotation (no screenshot yet) to `annotations.json`.
   **Done when:** an automated run clicks a fixture element, saves a comment, and the written
   `annotations.json` matches the expected object (assert in a test).
3. **Target resolution** — the layered reference incl. stable selector generation and the `window.ng`
   enrichment. This is a **pure function** (element/DOM → target object) — unit-test it hard.
   **Done when:** a unit-test table of ≥8 fixture cases (with `id`, with custom-element ancestor,
   deeply nested, `window.ng` present vs absent) all return the expected `target`.
4. **Screenshots** — CDP element-clip capture into `nit-review/shots/`.
   **Done when:** each saved annotation has a non-empty PNG whose dimensions match the element rect
   (±padding), asserted in a test.
5. **review.md renderer** + write a `/fix-annotations` instruction file explaining the agent contract.
   **Done when:** `review.md` renders one section per annotation with the embedded shot and refs, and
   the pure renderer (annotations → markdown string) passes a snapshot test.
6. **Bookmarklet build** — same overlay via esbuild, localStorage store, Export button.
   **Done when:** the bookmarklet-built bundle loads the overlay on a fixture page and Export produces
   an `annotations.json` byte-identical in shape to the CLI output (assert schema equality).
7. **Polish** — sidebar with delete, "Finish review" flush, idempotent append across runs.
   **Done when:** running `nit review` twice against the same `--out` appends a second review block and
   never clobbers the first (assert in a test).

## Working agreement

- Follow test-driven development where it's cheap (target resolution and the store are pure functions
  — unit-test those). The browser/overlay integration can be verified with a Playwright smoke test
  against a small static fixture page plus one manual run against the real storefront.
- Keep files small and single-purpose per the module layout in SPEC.md §2.
- After each milestone, stop and show me it working (a command to run + what I should see) before
  moving on.
- Commit after each green milestone with Conventional Commits (one line, no co-author).

## The acceptance test that matters — use an EXTERNAL verifier (SPEC.md §8)

Run `nit review` against my deployed Angular storefront, annotate a real element, close the browser.
Then judge the reference quality with a check you do NOT control: open a **fresh agent session with no
memory of this build**, point it at `nit-review/`, and see whether it locates and fixes the referenced
component from the annotation alone. That fresh agent is the verifier — do not let the session that
wrote the resolver also certify that the resolver is good enough. If the reference doesn't survive to
a successful fix, target resolution (milestone 3) is the unit to harden.

## Mindset (loop-engineering)

Building Nit is chain-shaped — the milestones are known up front — so run it as a chain, not an open
loop. But apply two loop-engineering disciplines throughout: (1) every milestone has a machine-checkable
"Done when", and (2) the verifier is external wherever it can be (a test, a file assertion, a fresh
agent), never the builder grading itself. Note also that **Nit is loop infrastructure**: its
`annotations.json` is the state layer and my review is the human checkpoint for a website-fixing loop —
see SPEC.md §9 for the v2 "close the loop" verifier, which is out of scope for this build.

Start by reading `SPEC.md`, then do milestone 0 with me (hand-author the schema and prove it's
fixable), and only after that propose the concrete file tree and milestone-1 implementation. Wait for
my go-ahead before writing code.
