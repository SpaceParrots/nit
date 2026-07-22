# MCP server and coding agents

nit ships an MCP (Model Context Protocol) server so coding agents can consume a review as tools
and resources instead of raw files. It is built on the official `@modelcontextprotocol/sdk`, runs
over stdio, reads the review folder fresh on every call, and needs no backend.

## Setting it up

Pick one of three ways:

```bash
nit setup            # the project wizard offers MCP registration as one of its steps
nit mcp-install      # just write the server entry into this project's .mcp.json
claude mcp add nit -- nit mcp ./nit-review    # user-scoped, via the Claude CLI
```

`nit mcp-install` creates `.mcp.json` or merges into an existing one. On Windows the command is
wrapped in `cmd /c`, because MCP clients spawn servers without a shell and the globally installed
`nit` is a `.cmd` shim there.

You can also run the server by hand, for example to test it: `nit mcp ./nit-review` speaks
newline-delimited JSON-RPC 2.0 on stdin/stdout.

## The tools

All tool names carry a `nit_` prefix, so they stay unambiguous when an agent sees them next to
tools from other MCP servers.

| Tool | Arguments | What it does |
| --- | --- | --- |
| `nit_list_annotations` | `status?`, `type?`, `route?` | Lists annotation summaries, optionally filtered (`route` accepts an exact route or a bare pathname). Reports the actionable count. Summaries include id, type, status, route, comment, `issueRef`, timestamps and `historyCount`. |
| `nit_get_annotation` | `id` | Returns one annotation in full, including its screenshot (and after-shot, if any) as images the agent can look at, plus the click history when present. |
| `nit_mark_fixed` | `id` | Sets the status to `fixed`. The agent calls this after making the change. |
| `nit_set_status` | `id`, `status` | Sets any status explicitly: `open`, `fixed`, `wontfix`, `verified` or `reopened`. |
| `nit_set_issue_ref` | `id`, `ref` | Attaches a tracker key or url to an annotation. An empty string clears it. |

"Actionable" always means: type `change-request` with status `open` or `reopened`. Comments are
context, not tasks.

Every tool declares an output schema, so results arrive as `structuredContent` (typed data) as
well as the JSON text block older clients read — an agent never has to parse a blob to get at a
status. Arguments are validated against the tool's schema before a handler runs, so a wrong type
comes back as a clear error instead of a surprising write. The tools also carry the standard MCP
hints: `nit_list_annotations` and `nit_get_annotation` are marked read-only, the three writers are
marked non-destructive and idempotent, and none of them touches anything outside the review
folder. Clients use those hints to decide what may run without asking you first.

## Resources

The same review is readable as resources, for when an agent wants context without spending a tool
call — for example to read the whole review once at the start.

| URI | What it is |
| --- | --- |
| `nit://review/annotations.json` | The whole review as nit stores it. |
| `nit://review/review.md` | The human-readable review, rendered on the fly if the file is not there yet. |
| `nit://review/fix-annotations.md` | The instruction sheet for fixing a review from the files alone. |
| `nit://annotation/<id>` | One annotation in full (`nit://annotation/a1`). Clients offer id completion. |
| `nit://annotation/<id>/screenshot` | The cropped element screenshot as a PNG. |
| `nit://annotation/<id>/screenshot-after` | The after-shot from `nit verify`, where one exists. |

Resources are read-only: every change still goes through the tools, so `updatedAt` / `updatedBy`
stay honest and `review.md` is re-rendered.

The server also announces standing instructions during the MCP handshake, so a connected agent
already knows the intended flow (list, get, fix, mark fixed), that comments are not tasks, and
that `wontfix` is the right answer for changes that should not be made. You get sensible agent
behavior even without writing any prompt yourself.

Writes made through these tools go through the same store as the panel, so `review.md` is
re-rendered, `updatedAt` is stamped, and `updatedBy` is set to `"agent"`. You can see in the
panel afterwards exactly what the agent touched.

## How an agent should work through a review

The intended tool loop looks like this:

1. `nit_list_annotations` to see what is actionable. Filtering by `route` helps when the agent
   wants to work page by page.
2. `nit_get_annotation` for each actionable item. The record carries several ways to locate the
   element (component tag, Angular class name, unique CSS selector, XPath, element text) plus
   the context screenshot and, when present, the click `history` that reproduces the state.
3. Make the change in the source code.
4. `nit_mark_fixed` for that annotation, and optionally `nit_set_issue_ref` if a ticket exists.
5. Repeat until `nit_list_annotations` reports zero actionable items.

A prompt that works well:

> Use the nit MCP tools. List the annotations, then fix every actionable change request at the
> referenced element and mark each one fixed when you are done. Treat comments as context, do
> not act on them. If you decide something should not be fixed, set its status to wontfix and
> say why.

Tips for better agent results:

- **Let the agent look at the screenshots.** `nit_get_annotation` returns them as images. The
  screenshot shows the element in context, which resolves most ambiguity about what the comment
  refers to.
- **The click history is the reproduction recipe.** If an annotation was made inside a dropdown
  or a wizard step, `history` lists the clicks that led there, oldest first.
- **`wontfix` is allowed.** It is better for an agent to set `wontfix` with a reason than to
  force a bad change. A human sees the status in the panel and can reopen.
- **Verification stays human.** Agents mark things `fixed`; a person runs
  `nit verify` and rules `verified` or `reopened`. Reopened items show up as actionable again in
  the next `nit_list_annotations` call.

## Working with files instead

Agents without MCP support get the same contract from the files: `annotations.json` is the data,
and `fix-annotations.md` in the review folder is a ready-made instruction sheet. Point the agent
at the folder and tell it to follow `fix-annotations.md`. The status writes work the same way,
because the agent edits `annotations.json` directly and nit merges concurrent writers safely.

See the [annotation file reference](./annotations.md) for what each field means.
