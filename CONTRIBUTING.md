# Contributing to nit

Thanks for helping make nit better!

## Setup

```bash
git clone https://github.com/SpaceParrots/nit.git
cd nit
npm install
npm run build                   # compile TypeScript (src/ -> dist/)
node dist/cli/index.js doctor   # verifies Node/deps and installs Chromium if needed
```

## Development loop

```bash
npm run build   # tsc -> dist/ (npm test does this automatically)
npm test        # unit tables + headless Playwright integration tests (node --test, against dist/)
npm run lint    # eslint (flat config, typescript-eslint type-checked + @stylistic rules)
npm run lint:fix
npm run typecheck
```

Try your changes for real: `npm run build && node dist/cli/index.js review https://example.com`.

## Project layout

The source is TypeScript (strict mode) under `src/` and compiles to `dist/`. See
[src/README.md](./src/README.md) for the full walkthrough.

```
src/
├─ cli/        # commander CLI: review / view / verify / merge / mcp / doctor
├─ browser/    # Playwright session: launch, overlay injection, bridge, panel window, verify capture
├─ overlay/    # injected page UI: vanilla TS/CSS in a Shadow DOM (highlight, popover, pins, chip)
├─ panel/      # the panel window UI, bundled by esbuild
├─ capture/    # element-to-target references and CDP element screenshots
├─ anchor/     # re-anchor targets to live elements for replay (selector, then xpath, then text)
├─ store/      # annotations.json read/write, review.md renderer, merge
├─ mcp/        # stdio MCP server over a review folder
├─ util/       # small shared helpers
└─ types.ts    # the annotations.json schema types and the overlay/Node bridge contract
```

Guidelines:

- `capture/target.ts`, `anchor/` and `store/` are pure or near-pure. Please keep them that way
  and cover changes with the existing table-driven tests.
- The overlay runs inside arbitrary third-party pages. Use no framework and no runtime
  dependencies, keep everything scoped to the shadow root, and never break the host page.
- The `annotations.json` schema (see `src/types.ts`) is a public contract consumed by coding
  agents and the MCP server. Make additive changes only.

## Commits and PRs

- Conventional Commits, one line: `feat(nit): ...`, `fix(nit): ...`, `docs(nit): ...`. Releases are
  cut by [release-please](https://github.com/googleapis/release-please) from these messages, so the
  type and scope decide the version bump and the changelog entry. Do not bump the version or edit
  `CHANGELOG.md` by hand.
- PRs should pass `npm run lint`, `npm run typecheck` and `npm test` (CI enforces all three) and
  include tests for behavior changes.
- `main` is protected: land changes through a pull request.

## Code of Conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md). Security issues go to
[SECURITY.md](./SECURITY.md), never into a public issue.

## Licensing of contributions

nit is licensed under the [GNU AGPL-3.0](./LICENSE). By submitting a contribution you agree that
it is licensed under the same terms. The project maintainer (spaceparrots) also offers nit under
a separate commercial license; by contributing you grant spaceparrots the right to include your
contribution in those commercially licensed distributions as well. If you are contributing on
behalf of an employer, make sure you have the right to do so.
