# Nit

Point-and-click annotation for websites, built to hand small UI fixes straight to a coding agent.

The name is from code review: reviewers prefix minor comments with `nit:`. Nit is a tool for
capturing the little things on any website and getting them fixed fast.

```bash
nit review https://your-site.example        # live, staging, or http://localhost:4200
```

A real Chromium opens with an annotation overlay. Hover to highlight an element, click it, type a
comment ("this badge should be yellow, not gray"), and save. Nit records each comment tied to a
stable element reference (component name, CSS selector, XPath, screenshot) and writes:

```
nit-review/
├─ annotations.json   # structured, agent-readable
├─ review.md          # human-readable, screenshots embedded
└─ shots/*.png
```

Then point a coding agent at `nit-review/` and tell it to fix the `open` annotations.

## Status

Pre-implementation. See:

- **[SPEC.md](./SPEC.md)** — the full design (source of truth).
- **[BUILD-PROMPT.md](./BUILD-PROMPT.md)** — paste into a fresh Fable / Claude Code session in this
  repo to build it.

## Design in one line

One vanilla-JS annotation overlay (Shadow-DOM isolated), delivered two ways — injected by a
Playwright-launched Chromium (`bypassCSP` so it runs on hardened live sites) for the developer, and a
bookmarklet for non-technical reviewers. Zero backend, zero changes to the site under review.

## License

MIT
