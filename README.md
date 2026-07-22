# nit

> Point-and-click website annotation that hands small UI fixes straight to a coding agent.

[![CI](https://github.com/spaceparrots/nit/actions/workflows/ci.yml/badge.svg)](https://github.com/spaceparrots/nit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40spaceparrots%2Fnit)](https://www.npmjs.com/package/@spaceparrots/nit)
[![license: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](./LICENSE)

You're browsing your product and spot the little things — a badge in the wrong color, an unfilled
star icon, a dead active-state. Filing tickets for those is overkill; describing them to an AI agent
in prose is lossy ("the third tile… no, on the landing page…").

**nit** is the missing input device: click the element, type the nit, done. Every annotation is
recorded with a stable reference to the element (component tag, Angular class name when available,
verified-unique CSS selector, XPath, screenshot), the route, and the viewport — precise enough for a
coding agent to find the source and fix it without any further context.

The name is from code-review culture: reviewers prefix minor comments with `nit:`.

## The loop

```
┌────────────┐      ┌───────────────────┐      ┌────────────┐
│ nit review │ ───► │ your coding agent │ ───► │ nit verify │ ─── reopened? ──┐
│  annotate  │      │  fixes each open  │      │  before /  │                 │
│  the site  │      │  change-request   │      │   after    │ ◄───────────────┘
└────────────┘      └───────────────────┘      └────────────┘
```

1. `nit review https://staging.example.com` — a real Chromium opens with an annotation overlay
   and a devtools-style panel window beside it. Alt-click elements, describe changes, save.
2. Hand the produced `nit-review/` folder to a coding agent (Claude Code, etc.) — or serve it as
   an MCP server with `nit mcp`. The agent fixes each open change request and marks it `fixed`.
3. `nit verify nit-review/annotations.json` — nit reopens the site, captures **after** screenshots
   next to the originals, and you rule each fix **Verified** or **Reopen**. Reopened items become
   actionable again for the next agent round.

Teammates run the same tool, `nit export` their review as a zip, and after `nit import` a
`nit merge` folds everything into one consolidated review with per-author attribution.

## Install

```bash
npm install -g @spaceparrots/nit
nit doctor        # checks Node ≥ 18 + dependencies, offers to install Chromium (one-time)
nit setup         # per project: review dir + .gitignore + MCP server (interactive wizard)
```

Or without installing: `npx @spaceparrots/nit review https://example.com`

## Commands

| Command | Alias | What it does |
| --- | --- | --- |
| `nit setup` | `init` | One-time project setup: review dir, .gitignore, MCP (wizard) |
| `nit review <url>` | `r`, `annotate` | Open a browser and annotate a site |
| `nit view <file>` | `v`, `replay` | Replay a feedback file — pins re-anchored on their routes |
| `nit verify <file>` | `check` | Capture after-shots for fixed items, rule Verified / Reopen |
| `nit export [dir]` | `pack` | Pack a review into a shareable zip |
| `nit import <zip>` | `unpack` | Unpack a co-founder's review zip |
| `nit merge <file...>` | `combine` | Combine feedback files into one consolidated review |
| `nit mcp [dir]` | `serve` | Serve a review folder as an MCP server (stdio) |
| `nit mcp-install [dir]` | `mcp-config` | Register the MCP server in this project's .mcp.json |
| `nit doctor` | — | Check the environment, install Chromium if missing |

Sharing a review between people:

```bash
nit export                        # → 2026-07-21-example.com-ann.nit.zip (id + author)
nit import 2026-07-21-example.com-ann.nit.zip
nit merge nit-review/annotations.json 2026-07-21-example.com-ann/annotations.json
```

Every command has detailed help: `nit <command> --help`. Common flags: `--mobile` (start in a
390×844 viewport), `--headless`, `--out <dir>`, `--author <name>`.

### Reviewing

- **Alt** (or the chip bottom-left) toggles element picking; hover highlights with the component
  tag; **click** selects; **Esc** cancels.
- The popover records the comment, a **type** — *change request* (actionable) or *comment*
  (context) — and a **viewport scope** (this viewport / general).
- The **panel window** next to the browser lists everything, switches desktop ↔ mobile, and — from
  a dropdown behind the filter icon — sorts by page, time or state, groups by page or state, and
  filters to the current viewport scope. It jumps to the page an annotation was found on, records an
  issue reference, edits comment texts, deletes items and finishes the review — nothing overlays
  the page under review.
- Works on CSP-hardened production sites, plain static pages, and SPAs (annotations are pinned to
  client-side routes).

## What you get

```
nit-review/
├─ annotations.json     # structured, agent-readable (schema below)
├─ review.md            # human-readable, screenshots embedded, ACTIONABLE markers
├─ fix-annotations.md   # the contract for the fixing agent
└─ shots/*.png          # cropped element screenshots (+ after-shots from nit verify)
```

One annotation:

```json
{
  "id": "a1",
  "type": "change-request",
  "comment": "Star icons are not filled — they read as 0/5 ratings.",
  "status": "open",
  "author": "Kevin",
  "viewportScope": "desktop",
  "viewport": { "mode": "desktop", "w": 1440, "h": 900 },
  "route": "/auth/sign-in",
  "target": {
    "component": "app-testimonial-card",
    "ngComponent": null,
    "selector": "app-auth-shell aside app-testimonial-card span:nth-of-type(3)",
    "xpath": "/html[1]/body[1]/app-root[1]/…/span[3]",
    "tag": "span",
    "classes": ["inline-flex", "items-center", "text-accent-400"],
    "text": "",
    "rect": { "x": 209, "y": 613, "w": 280, "h": 12 }
  },
  "screenshot": "shots/a1.png",
  "createdAt": "2026-07-21T02:28:11.550Z",
  "issueRef": "FAI-1234",
  "updatedAt": "2026-07-22T09:01:00.000Z",
  "updatedBy": "agent",
  "history": [
    { "selector": "button.menu", "tag": "button", "component": "app-nav",
      "text": "Menu", "at": "2026-07-21T02:27:41.000Z" }
  ]
}
```

The full schema is documented in [`src/types.ts`](./src/types.ts). Statuses flow
`open → fixed → verified | reopened` (plus `wontfix`), and `reopened` change-requests are
actionable again. `history` is the reproduction trail: the reviewer's last clicks (≤10) on that
page before capturing the annotation — states behind "open menu → pick tab" become replayable
instead of lost. Query-param changes keep the trail; a pathname change resets it.

## Agent handoff

Point your agent at the folder — `fix-annotations.md` contains the contract: *fix every
`change-request` with status `open` or `reopened` at the referenced element, then set its status to
`fixed`; treat `comment`s as context.*

Or let the agent work through MCP tools instead of raw files:

```bash
nit mcp-install                  # writes the server into this project's .mcp.json
                                 # (created or merged; OS-aware — uses cmd /c on Windows)
claude mcp add nit -- nit mcp ./nit-review   # alternative: user-scoped via the Claude CLI
```

Tools: `list_annotations` (filterable, reports the actionable count) · `get_annotation` (full
record — screenshots are returned as images) · `mark_fixed` · `set_status` · `set_issue_ref`.

## Angular?

nit is framework-agnostic, with one bonus for Angular apps: on dev/staging builds that expose
`window.ng`, each annotation also records the component **class name** (`ProductTileComponent`) —
the single best pointer for a fixing agent. On production builds the custom-element tag
(`app-product-tile`) is captured instead; both are enough to locate the source.

## How it works

One Playwright-launched Chromium (persistent profile, `bypassCSP: true`), one vanilla-JS overlay
injected via `addInitScript` into an isolated Shadow DOM — it runs on any site without touching it
and serves capture, replay and verify alike. The overlay talks to Node through `exposeBinding`;
screenshots are CDP element-clips; replay re-anchors elements selector → XPath → text heuristic and
degrades to a "couldn't place" list instead of breaking. Zero backend, zero changes to the site
under review; output is plain files.

## Development

```bash
npm install
npm run build   # compile TypeScript (src/ -> dist/)
node dist/cli/index.js doctor
npm test        # builds first, then unit tables (target/anchor/store/render/merge/route/url/panel-filter) + headless browser integration
npm run lint
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines and [src/README.md](./src/README.md) for the project layout.

## License

nit is licensed under the [GNU AGPL-3.0](./LICENSE). It's free to use, modify and self-host, but the
copyleft terms mean any distributed or **network-hosted** modified version must make its source
available under the same license — so nobody can take nit closed-source and resell it.

Need to use nit in a way AGPL-3.0 doesn't allow (e.g. embedding it in a closed-source or commercial
product)? A separate commercial license is available — reach out to
[kevin.mattutat@spaceparrots.de](mailto:kevin.mattutat@spaceparrots.de).
