# MCP server and coding agents

nit ships an MCP (Model Context Protocol) server so coding agents can consume a review as tools and resources instead of raw files. It is built on the official `@modelcontextprotocol/sdk`, runs over stdio, reads the review folder fresh on every call, and needs no backend.

## Setting it up

Pick one of three ways:

```bash
nit setup            # the project wizard offers MCP registration as one of its steps
nit mcp-install      # just write the server entry into this project's .mcp.json
claude mcp add nit -- nit mcp ./nit-review    # user-scoped, via the Claude CLI
```

`nit mcp-install` creates `.mcp.json` or merges into an existing one. On Windows the command is wrapped in `cmd /c`, because MCP clients spawn servers without a shell and the globally installed `nit` is a `.cmd` shim there.

You can also run the server by hand, for example to test it: `nit mcp ./nit-review` speaks newline-delimited JSON-RPC 2.0 on stdin/stdout.

## The tools

All tool names carry a `nit_` prefix, so they stay unambiguous when an agent sees them next to tools from other MCP servers.

| Tool | Arguments | What it does |
| --- | --- | --- |
| `nit_list_annotations` | `status?`, `type?`, `route?`, `base?` | Lists the annotations, optionally filtered (`route` accepts an exact route or a bare pathname; `base` narrows to one base URL). Reports the actionable count. Rows carry the working record — id, type, status, comment, route, `viewportScope`, `issueRef`, `statusReason`, the target's component, `ngComponent`, selector, `classes` and `text`, plus `historyCount` — so for most fixes the list alone is enough to start working. |
| `nit_get_annotation` | `id`, `includeXpath?`, `includeScreenshot?` | Returns annotations in full: `id` takes one id or an array (batch results come back in request order, with a `missing` list for unknown ids). Includes the screenshot (and after-shot, if any) as images and the compressed click history. `target.xpath` is omitted unless `includeXpath: true`; `includeScreenshot: false` skips the images on a re-fetch. |
| `nit_mark_fixed` | `id`, `reason?` | Sets the status to `fixed`. The agent calls this after making the change. |
| `nit_set_status` | `id`, `status`, `reason?` | Sets any status explicitly: `open`, `fixed`, `wontfix`, `verified` or `reopened`. `reason` is persisted as `statusReason` — give one with `wontfix` so the next session knows why. |
| `nit_set_issue_ref` | `id`, `ref` | Attaches a tracker key or url to an annotation. An empty string clears it. |
| `nit_clear_verified` | `base?` | Deletes the annotations a human already ruled `verified`, with their screenshots — housekeeping after a fix round. Everything else is left alone, and the review folder survives. Omit `base` to sweep every base URL. |

"Actionable" always means: type `change-request` with status `open` or `reopened`. Comments are context, not tasks.

`nit_clear_verified` is the one tool that deletes, and it is marked `destructiveHint: true` so clients ask before running it. It can only ever remove annotations a human has already ruled — clearing anything else stays in the CLI (`nit clear`), behind a confirmation prompt. An agent must not be able to delete feedback nobody has ruled on yet.

Results are a single compact JSON text block — deliberately lean, because agents pay for every token. The click history an annotation carries over MCP is compressed the same way: clicks on the annotated element itself are dropped, consecutive clicks on the same selector collapse into one, repeated text is elided, and the trail caps at the last 5 steps (`historyCount` still reports the original length; the file on disk keeps the full trail). Arguments are validated against each tool's schema before a handler runs, so a wrong type comes back as a clear error instead of a surprising write. The tools also carry the standard MCP hints: `nit_list_annotations` and `nit_get_annotation` are marked read-only, the three writers are marked non-destructive and idempotent, and none of them touches anything outside the review folder. Clients use those hints to decide what may run without asking you first.

## Resources

The same review is readable as resources — mainly for clients and sessions where the tools are not available, since reading a resource costs a call of its own in most MCP clients.

| URI | What it is |
| --- | --- |
| `nit://review/brief.md` | One line per annotation — the token-lean overview an agent should read first. |
| `nit://review/annotations.json` | The whole review as nit stores it. |
| `nit://review/review.md` | The human-readable review, rendered on the fly if the file is not there yet. Agents should prefer `brief.md` and the tools. |
| `nit://review/fix-annotations.md` | The instruction sheet for fixing a review from the files alone. |
| `nit://annotation/<id>` | One annotation in full (`nit://annotation/a1`). Clients offer id completion. |
| `nit://annotation/<id>/screenshot` | The cropped element screenshot as a PNG. |
| `nit://annotation/<id>/screenshot-after` | The after-shot from `nit verify`, where one exists. |
| `nit://review/bases.md` | Every base URL of the review with its counts — read this first when a review covers more than one environment. |
| `nit://base/<slug>/annotations.json` | One base's review file (`nit://base/staging/annotations.json`). Also `/review.md` and `/brief.md`. Clients offer slug completion. |

On a review with several base URLs the unprefixed `nit://review/annotations.json`, `/review.md` and `/brief.md` refuse rather than pick an environment: the error names the bases and points at the `nit://base/<slug>/…` form. A single-base review serves them exactly as before.

Resources are read-only: every change still goes through the tools, so `updatedAt` / `updatedBy` stay honest and `review.md` is re-rendered.

The server also announces standing instructions during the MCP handshake, so a connected agent already knows the intended flow (list, get, fix, mark fixed), that comments are not tasks, and that `wontfix` is the right answer for changes that should not be made. You get sensible agent behavior even without writing any prompt yourself.

Writes made through these tools go through the same store as the panel, so `review.md` is re-rendered, `updatedAt` is stamped, and `updatedBy` is set to `"agent"`. You can see in the panel afterwards exactly what the agent touched.

## Reviews with several base URLs

A review folder can cover more than one site — local, staging, production — with one review folder per base URL inside it (see [the command reference](./commands.md#reviews-with-several-base-urls)). One MCP server serves all of them; you never register a server per environment.

What changes for an agent when a review has more than one base:

- **Ids are qualified** as `<base>:<id>` — `staging:a1`, `localhost-4200:a1`. Pass them back in exactly that form; every tool accepts them, and every result echoes them. The ids stored on disk are never rewritten, so `staging/annotations.json` still holds a plain `a1`. An *unqualified* id is only accepted when exactly one base holds it: every base numbers its own annotations from `a1`, so a bare `a1` usually names different feedback in each environment, and nit refuses it with the qualified form to use rather than ruling on whichever base sorts first.
- **Rows carry `base` and `url`.** `base` is the slug, `url` is the annotation's own page (the base url with its route applied), so the agent never has to reassemble one.
- **`bases` replaces `review`.** An unfiltered `nit_list_annotations` reports a `bases` array (slug, url, total, actionable) instead of the single-review `review` envelope.
- **`base` narrows any of it.** `nit_list_annotations` and `nit_clear_verified` take `base` — a slug, a full url, or an unambiguous prefix — to work one environment at a time.

A review of a single site is unaffected: plain `a1` ids, the `review` envelope, no `base` column. Existing `.mcp.json` registrations keep working unchanged, and the server's handshake instructions explain the qualified-id form to the agent by itself.

```jsonc
// nit_list_annotations {} on a two-base review
{
  "bases": [
    { "slug": "localhost-4200", "url": "http://localhost:4200", "total": 2, "actionable": 0 },
    { "slug": "staging", "url": "https://staging.example.com", "total": 7, "actionable": 3 }
  ],
  "total": 9,
  "actionable": 3,
  "annotations": [
    { "id": "staging:a1", "base": "staging", "url": "https://staging.example.com/checkout", "status": "open" }
  ]
}
```

## How an agent should work through a review

The intended tool loop looks like this:

1. `nit_list_annotations` to see what is actionable. The rows already carry the locating fields (component tag, Angular class name, CSS selector, classes, element text), so this is usually enough to start. Filtering by `route` helps when the agent wants to work page by page.
2. `nit_get_annotation` — one id or a whole batch — for the items it works on: the context screenshot and, when present, the click `history` that reproduces the state. The CSS selector is verified unique at capture time except in its last-resort nth-of-type fallback form, so treat it as a strong hint, not a guarantee.
3. Make the change in the source code.
4. `nit_mark_fixed` for that annotation, and optionally `nit_set_issue_ref` if a ticket exists.
5. Repeat until `nit_list_annotations` reports zero actionable items.

On a review with several base URLs, do this one environment at a time: `nit_list_annotations { "base": "staging" }`, fix, then move on. The same UI bug often exists on every environment, but the fix belongs to whichever branch that environment runs.

A prompt that works well:

> Use the nit MCP tools. List the annotations, then fix every actionable change request at the referenced element and mark each one fixed when you are done. Treat comments as context, do not act on them. If you decide something should not be fixed, set its status to wontfix with a reason.

Tips for better agent results:

- **Let the agent look at the screenshots.** `nit_get_annotation` returns them as images. The screenshot shows the element in context, which resolves most ambiguity about what the comment refers to.
- **The click history is the reproduction recipe.** If an annotation was made inside a dropdown or a wizard step, `history` lists the clicks that led there, oldest first.
- **`wontfix` is allowed.** It is better for an agent to set `wontfix` with a reason than to force a bad change. The reason is stored on the annotation as `statusReason`, so a human (or the next agent session) sees why instead of re-litigating it. A human can always reopen.
- **Verification stays human.** Agents mark things `fixed`; a person runs `nit verify` and rules `verified` or `reopened`. Reopened items show up as actionable again in the next `nit_list_annotations` call.
- **Tidy up after a verify round.** Once a human has ruled items `verified`, `nit_clear_verified` removes those records so the next round starts on a short list. It never touches anything unruled.

## Working with files instead

Agents without MCP support get the same contract from the files: `annotations.json` is the data, and `fix-annotations.md` in the review folder is a ready-made instruction sheet. Point the agent at the folder and tell it to follow `fix-annotations.md`. The status writes work the same way, because the agent edits `annotations.json` directly and nit merges concurrent writers safely.

See the [annotation file reference](./annotations.md) for what each field means.
