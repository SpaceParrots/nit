# Contributing to nit

Thanks for helping make nit better!

## Setup

```bash
git clone https://github.com/spaceparrots/nit.git
cd nit
npm install
node src/cli/index.js doctor   # verifies Node/deps and installs Chromium if needed
```

## Development loop

```bash
npm test        # unit tables + headless Playwright integration tests (node --test)
npm run lint    # eslint (flat config, @stylistic rules)
npm run lint:fix
```

Try your changes for real: `node src/cli/index.js review https://example.com`.

## Project layout

```
src/
├─ cli/        # commander CLI: review / view / verify / merge / mcp / doctor
├─ browser/    # Playwright session: launch, overlay injection, bridge, panel window, verify capture
├─ overlay/    # injected page UI — vanilla JS/CSS in a Shadow DOM (highlight, popover, pins, chip)
├─ capture/    # element → target reference + CDP element screenshots
├─ anchor/     # re-anchor targets to live elements for replay (selector → xpath → text)
├─ store/      # annotations.json read/write, review.md renderer, merge
├─ mcp/        # stdio MCP server over a review folder
└─ types.js    # JSDoc typedefs for the annotations.json schema (the public contract)
```

Guidelines:

- `capture/target.js`, `anchor/`, `store/` are pure or near-pure — please keep them that way
  and cover changes with the existing table-driven tests.
- The overlay runs inside arbitrary third-party pages: vanilla JS only, everything scoped to
  the shadow root, no framework assumptions, never break the host page.
- The `annotations.json` schema (see `src/types.js`) is a public contract consumed by coding
  agents and the MCP server — additive changes only.

## Commits & PRs

- Conventional Commits, one line: `feat(nit): …`, `fix(nit): …`, `docs(nit): …`.
- PRs should pass `npm run lint` and `npm test` (CI enforces both) and include tests for
  behavior changes.
