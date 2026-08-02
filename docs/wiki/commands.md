# Command reference

Every command also has built-in help: `nit <command> --help`.

| Flag | What it does |
| --- | --- |
| `-v, --version` | Print the nit version (`-V` and `--version` do the same) |
| `-h, --help` | Print help for nit, or for one command |

## Reviews with several base URLs

A review folder can cover more than one site — local, staging, production. Each base URL gets its own subfolder (its slug, derived from the host or set with `--base` on `nit review`), and `bases.json` records which is which. A review of a single site stays flat and is never touched.

Wherever a command needs to know *which* environment you mean, it takes `--base <name>`, and the name can be the slug (`staging`), the full url (`https://staging.example.com`), or an unambiguous prefix (`stag`). `nit list` shows what is on offer.

## When nit asks

A command that cannot work out what you meant asks, rather than only telling you what was wrong: which base of a multi-base review, which url to review, which export to unpack, what a `nit clear` should cover. Every row shows what is inside the thing you would be choosing — urls, counts, what is fixed or already ruled — so the choice is made on the numbers rather than on the name. Escape cancels; nothing has happened yet at that point.

The questions only ever appear when a person is there to answer them: a terminal on **both** stdin and stdout, no `--no-input`, and no `--json`. Pipes, scripts, CI and agents shelling out to nit are never prompted — they get the same error, naming the flag to pass, that nit has always printed.

| Flag | What it does |
| --- | --- |
| `--no-input` | Never ask for a missing argument — fail with the flag to pass instead |

`--no-input` is accepted by `review`, `view`, `verify`, `status`, `list`, `clear`, `export` and `import`. `nit setup` and `nit doctor` are wizards by definition and keep their own `--yes`; `nit mcp` never asks, because its stdin is the protocol.

## Shared browser flags

`review`, `view` and `verify` all launch a browser and accept these flags:

| Flag | What it does |
| --- | --- |
| `-m, --mobile` | Start in the mobile viewport (390x844) instead of desktop (1440x900) |
| `--headless` | Run the browser headless, for automation or CI |
| `--debug` | Verbose overlay logging; every page click is logged to stdout |

## nit setup (alias: init)

One-time project setup. An interactive wizard chooses the review directory, offers a `.gitignore` entry, can register the MCP server in the project's `.mcp.json`, and asks for your author name. The author is saved in a per-user config (`~/.config/nit/config.json`), not in the project, so every teammate keeps their own.

| Flag | What it does |
| --- | --- |
| `-y, --yes` | Accept all defaults without prompting |

## nit review [url] (aliases: r, annotate)

Opens the site in a real Chromium with the annotation overlay and the panel window. Alt-click elements, describe changes, finish the review from the panel.

With no url, nit offers the sites this workspace already covers — most recently reviewed first — plus a free text entry. Picking a known url is also how a second round lands in the base folder it belongs to instead of a near-duplicate:

```
$ nit review

◆  Which site do you want to review?
│  ● https://staging.example.com  7 annotations · 3 actionable
│  ○ http://localhost:4200        2 annotations
│  ○ another url…
└
```

| Flag | What it does |
| --- | --- |
| `-o, --out <dir>` | Output directory (default `nit-review`) |
| `-a, --author <name>` | Author recorded on each annotation (default: the name from `nit setup`, else your OS user name) |
| `-b, --base <name>` | Short name for this url's folder inside the review (default: derived from the host) |

Annotations land in `<out>/<base>/`. The first time a *second* url is reviewed into the same `--out`, the review already there is moved into its own base folder — ids, screenshots and review metadata travel with it.

```bash
nit review http://localhost:4200                            # -> nit-review/localhost-4200/
nit review https://staging.example.com --base staging       # -> nit-review/staging/
```

## nit view [source] (aliases: v, replay)

Replays a feedback file. Pins are re-anchored on their routes so you can walk through a teammate's review.

`source` is a review directory, a feedback file, or the name of a base — with no argument, nit looks for `./nit-review`. A missing, empty, or unreadable review fails fast with the next step (start a review, point at a folder, or check `nit status`) instead of opening a browser on nothing.

| Flag | What it does |
| --- | --- |
| `-u, --url <url>` | Open this url instead of the one stored in the feedback file |
| `-b, --base <name>` | Which base URL of the review to open |

Use `--url` whenever you do not fully trust the file, for example one you received from outside your team. It pins the session to an origin you chose yourself.

A browser opens exactly one site, so a review covering several base URLs needs one of them named — without it nit lists the bases and stops rather than guessing an environment. A review with a single base is opened straight away.

A base is named either with `--base`, or as the `source` itself: when what you typed is no path here, nit reads it as a base of `./nit-review` — a slug, a full url, or an unambiguous prefix, exactly what `--base` accepts. A real directory of that name always wins, so the shorthand can never redirect you somewhere else.

```bash
nit view staging                       # = nit view --base staging
nit view localhost-4200                # the other base of ./nit-review
nit view review-merged --base staging  # a base of some other folder needs --base
```

If nothing you passed lands on one base — several bases and no pick, a `--base` that matches nothing or several, a name that is neither a path nor a base — nit asks in the terminal instead of stopping. Each row shows the base's url and what is waiting inside it, and the cursor starts on the first base that has work for the command you ran:

```
$ nit verify

◆  nit-review holds 2 base URLs — which one?
│  ● localhost-4200 (http://localhost:4200 · 3 fixed · 1 actionable)
│  ○ staging (https://staging.example.com · 0 fixed · 2 actionable)
└
```

Escape cancels without opening anything. The picker needs a terminal on both stdin and stdout: piped, scripted and CI runs are never prompted — they fail with the same message and next steps as before, so `--base` stays the way to be explicit.

## nit verify [source] (alias: check)

Walks you through every annotation marked `fixed` in a guided queue: the panel shows one item at a time with its before and after screenshots, the site page visits each item's route automatically, and you rule each one Verified, Reopen (with an optional note, stored as `statusReason`) or Skip. After-shots are captured for you — of the re-found element, or of the originally recorded region when the element is gone. General-scoped items get one after-shot per viewport (desktop and mobile), and the session switches the viewport automatically to capture the missing one; scoped items are only ever shot in their own viewport. When the session ends, a one-line summary prints what was verified, reopened and still fixed.

`source` works like in `nit view`: a directory, a file, or a base name of `./nit-review` (`nit verify localhost-4200`), defaulting to `./nit-review`. When there is nothing to rule yet, nit says so and suggests the step that is actually missing — hand the actionable items to your agent (`nit mcp`), or capture a review first.

| Flag | What it does |
| --- | --- |
| `-u, --url <url>` | Open this url instead of the one stored in the feedback file |
| `-b, --base <name>` | Which base URL of the review to verify |

## nit status [dir] (alias: stats)

A quick read on a review folder, without opening a browser: where the annotations file is, when it last changed and by whom, how many annotations there are by status and type, which routes they sit on, how much the screenshots weigh — and what to do next (hand the actionable ones to an agent, rule the fixed ones, or capture some).

```
nit status — nit-review/annotations.json

  review      2026-07-21-example.com
  url         https://example.com
  created     2026-07-21 · authors: Kevin, Ann
  last change 2026-07-22 (2 hours ago) · by agent

  annotations 12 total · 5 actionable
  by status   open 4 · reopened 1 · fixed 5 · verified 2
  by type     change-request 10 · comment 2
  routes      /products 6 · / 4 · /cart 2
  screenshots 11 files · 2.3 MB

5 actionable change-requests — hand them to an agent:  nit mcp nit-review
5 fixed, waiting on you to rule:  nit verify nit-review/annotations.json
```

The argument takes a review directory or an annotations.json path, so a feedback file with its own name works too: `nit status feedback-ann.json`. Nothing is written — it is safe to run against a review someone else is editing.

A review covering several base URLs reports one line per base plus the totals:

```
nit status — nit-review

  staging     https://staging.example.com · 7 annotations · 3 actionable · 2 hours ago
  localhost-4200  http://localhost:4200 · 2 annotations · 0 actionable · 1 day ago

  total       9 annotations across 2 base URLs · 3 actionable

3 actionable on staging — hand them to an agent:  nit mcp nit-review
2 already ruled on staging — tidy up:  nit clear nit-review --base staging --verified
```

`--base staging` narrows to one of them and reports it exactly like the single review above.

| Flag | What it does |
| --- | --- |
| `-b, --base <name>` | Only this base |
| `--json` | Print the same stats as JSON, for scripts and CI |

The JSON keeps the same shape either way: the counts are the totals across the reported bases, and a `bases` array carries the per-base breakdown when there is more than one.

## nit list [dir] (alias: ls)

Shows what a review holds. With no options it lists the base URLs with their counts; with `--base` (or `--all`) it lists the annotated urls inside them. Nothing is written.

```
nit list — nit-review

  base            url                          total  actionable  last change
  staging         https://staging.example.com      7           3  2 hours ago
  localhost-4200  http://localhost:4200            2           0  1 day ago

  9 annotations across 2 base URLs · 3 actionable

  Urls in one of them:  nit list --base staging
```

| Flag | What it does |
| --- | --- |
| `-b, --base <name>` | Only this base — and list the annotated urls inside it |
| `--all` | Show the annotated urls for every base |
| `--status <status>` | Only annotations with this status (`open`, `fixed`, `wontfix`, `verified`, `reopened`) |
| `--type <type>` | Only `change-request` or `comment` |
| `--route <path>` | Only annotations on this route (exact route or bare pathname) |
| `--author <name>` | Only annotations by this author |
| `--actionable` | Only open/reopened change-requests |
| `--json` | Print the listing as JSON instead of a report |

```bash
nit list                                    # every base URL with its counts
nit list --base staging                     # the annotated urls on staging
nit list --all --actionable                 # everything still waiting, everywhere
nit list --base staging --status verified   # what is already ruled on staging
```

## nit clear [dir] (alias: rm)

Removes annotations once they have served their purpose — typically the ones already ruled `verified` after a fix round. Screenshots of removed annotations are deleted with them; the base folder and its review metadata always survive, so the next review of that url keeps its review id.

A scope is always required: `--base <name>` for one environment, `--all` for every one — it is never guessed. On a terminal, bare `nit clear` asks for one instead of refusing: which base (or every base), then what should go, with both answers counting what they would remove before you commit to them. The confirmation still follows.

```
$ nit clear

◆  Clear which base of nit-review?
│  ● localhost-4200  http://localhost:4200        1 verified · 2 total
│  ○ staging         https://staging.example.com  2 verified · 3 total
│  ○ every base  (5 annotations)
└
◆  What should go?
│  ● only what is already ruled  (2 verified annotations)
│  ○ everything  (3 annotations)
└
◆  Clear 2 verified annotations from base staging? This cannot be undone.
```

Without a terminal — or with `--yes`, which means "no questions" — the missing scope is still an error that lists the bases, so scripts and CI cannot drift into clearing the wrong thing.

| Flag | What it does |
| --- | --- |
| `-b, --base <name>` | Clear this base |
| `--all` | Clear every base in the review |
| `--verified` | Only annotations ruled verified (same as `--status verified`) |
| `--status <status>` | Only annotations with this status |
| `-y, --yes` | Skip the confirmation prompt (required in scripts and CI) |
| `--dry-run` | Print what would be cleared and exit without writing |

```bash
nit clear --base staging --verified    # drop what is already ruled on staging
nit clear --all --verified             # same, across every environment
nit clear --all --verified --dry-run   # see what would go first
nit clear --base staging               # empty staging entirely (prompts)
```

An agent can do the verified-only sweep itself through the `nit_clear_verified` MCP tool. Clearing anything a human has *not* ruled on stays here, behind the prompt.

## nit export [dir] (alias: pack)

Packs a review folder into a shareable zip. The file name is derived from the review id and the author.

A review covering several base URLs packs all of them, each under its own folder, plus `bases.json`; `nit import` restores it as a workspace. `--base` packs one base as a plain single-review zip — the format nit has always produced, and the one to send a teammate who only cares about staging.

| Flag | What it does |
| --- | --- |
| `-b, --base <name>` | Pack only this base, as a single-review zip |
| `-o, --out <file>` | Output zip path |

## nit import [zip] (alias: unpack)

Unpacks a teammate's review zip next to your own review. Both shapes are recognised — a single review and a whole multi-base workspace — and an existing non-empty target is never overwritten.

With no argument, nit offers the zips in the current directory, its own `.nit.zip` exports first and newest first. When the target folder is already in use it offers a free name beside it (`review` → `review-2`); declining stops the import, and overwriting is not on the menu.

| Flag | What it does |
| --- | --- |
| `-o, --out <dir>` | Target directory (default: derived from the zip name) |

## nit merge \<file...\> (alias: combine)

Combines several feedback files into one consolidated review with per-author attribution. Screenshots are copied along.

| Flag | What it does |
| --- | --- |
| `-o, --out <dir>` | Output directory (default `nit-review-merged`) |

## nit mcp [dir] (alias: serve)

Serves a review folder as an MCP server over stdio. This is what coding agents connect to. Tools: `nit_list_annotations`, `nit_get_annotation`, `nit_mark_fixed`, `nit_set_status`, `nit_set_issue_ref`, `nit_clear_verified`. The review is also readable as resources: `nit://review/annotations.json`, `nit://review/review.md`, `nit://review/fix-annotations.md` and `nit://annotation/<id>` (plus its screenshots).

One server covers every base URL of a review: rows carry their `base`, ids are qualified `staging:a1`, and `nit://review/bases.md` plus `nit://base/<slug>/…` expose the bases as resources. See [MCP server and coding agents](./mcp.md).

## nit mcp-install [dir] (alias: mcp-config)

Writes the MCP server entry into the project's `.mcp.json`, creating or merging the file. On Windows the command is wrapped in `cmd /c`, because MCP clients spawn servers without a shell.

| Flag | What it does |
| --- | --- |
| `-n, --name <name>` | Server name inside `.mcp.json` (default `nit`) |

## nit doctor

Checks the environment (Node version, dependencies, Chromium) and offers to install Chromium if it is missing. It also reports what shape this project's `nit-review/` is in — one review, or how many base URLs it covers — which is the quickest way to see why a command asked for a `--base`.

| Flag | What it does |
| --- | --- |
| `-y, --yes` | Install Chromium without asking, for non-interactive setup |
