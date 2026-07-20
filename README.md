# Nit

Point-and-click annotation for websites, built to hand small UI fixes straight to a coding agent.

The name is from code review: reviewers prefix minor comments with `nit:`. Nit is a tool for
capturing the little things on any website and getting them fixed fast.

```bash
nit review <url>          # annotate any site (live, staging, or http://localhost:4200)
nit view <file>           # replay: reload a feedback file and see the pins back on their routes
nit merge <file...>       # consume: combine co-founder feedback files into one review
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

## Status

Pre-implementation. See:

- **[SPEC.md](./SPEC.md)** — the full design (source of truth).
- **[BUILD-PROMPT.md](./BUILD-PROMPT.md)** — paste into a fresh Fable / Claude Code session in this
  repo to build it.

## Design in one line

One vanilla-JS annotation overlay (Shadow-DOM isolated), injected by a Playwright-launched Chromium
(`bypassCSP` so it runs on hardened live sites), serving both capture and replay. Everyone — including
co-founders — runs the same standalone tool; feedback files merge into one review. Zero backend, zero
changes to the site under review.

## License

MIT
