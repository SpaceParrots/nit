# Nit

Point-and-click annotation for websites, built to hand small UI fixes straight to a coding agent.

The name is from code review: reviewers prefix minor comments with `nit:`. Nit is a tool for
capturing the little things on any website and getting them fixed fast.

```bash
nit review <url>          # annotate any site (live, staging, or http://localhost:4200)
nit view <file>           # replay: reload a feedback file and see the pins back on their routes
nit merge <file...>       # consume: combine co-founder feedback files into one review
nit verify <file>         # close the loop: after-shots for fixed items, rule Verified / Reopen
nit mcp [dir]             # stdio MCP server over annotations.json for coding agents
```

A real Chromium opens with an annotation overlay. Hover to highlight an element, click it, type a
comment ("this badge should be yellow, not gray"), pick a **type** (change request / comment) and a
**viewport scope** (general / desktop / mobile), and save. Nit records each note tied to a stable
element reference (component name, CSS selector, XPath, screenshot), the route, and the viewport, then
writes:

```
nit-review/
├─ annotations.json   # structured, agent-readable
├─ review.md          # human-readable, screenshots embedded
└─ shots/*.png
```

Then point a coding agent at `nit-review/` and tell it to fix the `open` change requests. Co-founders
run the same tool and send their feedback file back; `nit merge` folds it in; `nit view` replays the
whole set in situ. Desktop/mobile is a toggle, and annotations can be scoped general or to one viewport.

## Install & run

```bash
npm install                      # installs playwright + esbuild
npx playwright install chromium  # first run only

node src/cli/index.js review https://your-site.com
node src/cli/index.js review http://localhost:4200 --mobile --author Ann
node src/cli/index.js view nit-review/annotations.json
node src/cli/index.js merge feedback-kevin.json feedback-ann.json --out review-merged
```

In the browser: **Alt** toggles element picking, **Esc** cancels, click an element to annotate.
A devtools-style **nit panel** opens in its own window next to the browser — it lists annotations,
switches desktop/mobile, filters by viewport scope, deletes annotations, and finishes the review, so
the page itself stays uncovered (only a slim chip and the pins live in-page). `nit view` shows saved
annotations as numbered pins re-anchored on the routes where they were made; anything that can't be
re-anchored lands in the panel's "couldn't place" list instead of crashing.

Angular tip: on dev/staging builds that expose `window.ng`, every annotation also records the
component class name (`ProductTileComponent`) — on production builds the custom-element tag
(`app-product-tile`) is captured instead. Both are enough for an agent to locate the source.

Handoff: point your coding agent at `nit-review/` — `fix-annotations.md` in the output contains the
contract (fix each open/reopened `change-request`, flip its `status` to `fixed`; treat `comment`s as
context). Or wire it up as an MCP server so the agent works through tools instead of raw files:

```bash
claude mcp add nit -- node D:/Tools/Nit/src/cli/index.js mcp ./nit-review
# tools: list_annotations · get_annotation (returns the screenshots as images) · mark_fixed · set_status
```

Close the loop: after the agent marked items `fixed`, run `nit verify nit-review/annotations.json`.
Nit re-opens the site, re-anchors each fixed annotation on its route, captures an **after** screenshot
next to the original (element gone? the originally recorded region is captured instead), and the panel
shows before/after with **Verified / Reopen** buttons. Reopened items become actionable again for the
next fix round.

## Development

```bash
npm test    # unit tables (target/anchor/store/render/merge) + headless browser integration tests
```

See **[SPEC.md](./SPEC.md)** for the full design (source of truth) and `examples/milestone-0-fainin/`
for a hand-authored review that was proven fixable before any code existed.

## Design in one line

One vanilla-JS annotation overlay (Shadow-DOM isolated), injected by a Playwright-launched Chromium
(`bypassCSP` so it runs on hardened live sites), serving both capture and replay. Everyone — including
co-founders — runs the same standalone tool; feedback files merge into one review. Zero backend, zero
changes to the site under review.

## License

MIT
