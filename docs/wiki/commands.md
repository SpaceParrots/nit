# Command reference

Every command also has built-in help: `nit <command> --help`.

## Shared browser flags

`review`, `view` and `verify` all launch a browser and accept these flags:

| Flag | What it does |
| --- | --- |
| `-m, --mobile` | Start in the mobile viewport (390x844) instead of desktop (1440x900) |
| `--headless` | Run the browser headless, for automation or CI |
| `--debug` | Verbose overlay logging; every page click is logged to stdout |

## nit setup (alias: init)

One-time project setup. An interactive wizard chooses the review directory, offers a
`.gitignore` entry, can register the MCP server in the project's `.mcp.json`, and asks for your
author name. The author is saved in a per-user config (`~/.config/nit/config.json`), not in the
project, so every teammate keeps their own.

| Flag | What it does |
| --- | --- |
| `-y, --yes` | Accept all defaults without prompting |

## nit review \<url\> (aliases: r, annotate)

Opens the site in a real Chromium with the annotation overlay and the panel window. Alt-click
elements, describe changes, finish the review from the panel.

| Flag | What it does |
| --- | --- |
| `-o, --out <dir>` | Output directory (default `nit-review`) |
| `-a, --author <name>` | Author recorded on each annotation (default: the name from `nit setup`, else your OS user name) |

## nit view \<file\> (aliases: v, replay)

Replays a feedback file. Pins are re-anchored on their routes so you can walk through a
teammate's review.

| Flag | What it does |
| --- | --- |
| `-u, --url <url>` | Open this url instead of the one stored in the feedback file |

Use `--url` whenever you do not fully trust the file, for example one you received from outside
your team. It pins the session to an origin you chose yourself.

## nit verify \<file\> (alias: check)

Captures "after" screenshots for every annotation marked `fixed` and lets you rule each one
Verified or Reopen in the panel.

| Flag | What it does |
| --- | --- |
| `-u, --url <url>` | Open this url instead of the one stored in the feedback file |

## nit export [dir] (alias: pack)

Packs a review folder into a shareable zip. The file name is derived from the review id and the
author.

| Flag | What it does |
| --- | --- |
| `-o, --out <file>` | Output zip path |

## nit import \<zip\> (alias: unpack)

Unpacks a teammate's review zip next to your own review.

| Flag | What it does |
| --- | --- |
| `-o, --out <dir>` | Target directory (default: derived from the zip name) |

## nit merge \<file...\> (alias: combine)

Combines several feedback files into one consolidated review with per-author attribution.
Screenshots are copied along.

| Flag | What it does |
| --- | --- |
| `-o, --out <dir>` | Output directory (default `nit-review-merged`) |

## nit mcp [dir] (alias: serve)

Serves a review folder as an MCP server over stdio. This is what coding agents connect to.
Tools: `nit_list_annotations`, `nit_get_annotation`, `nit_mark_fixed`, `nit_set_status`, `nit_set_issue_ref`.

## nit mcp-install [dir] (alias: mcp-config)

Writes the MCP server entry into the project's `.mcp.json`, creating or merging the file. On
Windows the command is wrapped in `cmd /c`, because MCP clients spawn servers without a shell.

| Flag | What it does |
| --- | --- |
| `-n, --name <name>` | Server name inside `.mcp.json` (default `nit`) |

## nit doctor

Checks the environment (Node version, dependencies, Chromium) and offers to install Chromium if
it is missing.

| Flag | What it does |
| --- | --- |
| `-y, --yes` | Install Chromium without asking, for non-interactive setup |
