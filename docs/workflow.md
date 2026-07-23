# The nit workflow guide

How a review actually flows through nit, from the first click to a verified fix. The short version:

```
┌────────────┐      ┌───────────────────┐      ┌────────────┐
│ nit review │ ───► │ your coding agent │ ───► │ nit verify │ ─── reopened? ──┐
│  annotate  │      │  fixes each open  │      │  before /  │                 │
│  the site  │      │  change-request   │      │   after    │ ◄───────────────┘
└────────────┘      └───────────────────┘      └────────────┘
```

## Solo: review, fix, verify

### 1. Collect the nits

```bash
nit review https://staging.example.com
```

Browse your product the way a user would. Whenever something bugs you, Alt-click it and write it down. Good annotations are small and concrete: "this badge should use the warning color", "this star icon should be filled". If a state is hard to reach (a dropdown, a wizard step), just click your way there first; nit records your click trail with each annotation so the agent can reproduce the state.

Use **change request** for things an agent should fix and **comment** for context you want to keep, like "this section is fine, don't touch it".

Finish the review from the panel. Your `nit-review/` folder now contains the structured review (`annotations.json`), a readable version (`review.md`), the agent instructions (`fix-annotations.md`), and a screenshot per annotation.

### 2. Let the agent fix

Two ways to hand the work over:

- **Files.** Tell your agent: "Read nit-review/fix-annotations.md and do what it says." The contract is: fix every change request with status `open` or `reopened` at the referenced element, then set its status to `fixed`.
- **MCP.** Run `nit mcp-install` once (or let `nit setup` do it), then tell the agent to fix the open nit annotations. The agent uses the `nit` MCP tools: `nit_list_annotations` to see what is actionable, `nit_get_annotation` for the full record including the screenshot, and `nit_mark_fixed` when it is done. It can also file the issue reference back with `nit_set_issue_ref`. The [MCP guide](./wiki/mcp.md) covers the tools and good agent prompts in detail.

Each annotation gives the agent several ways to find the element: the component tag, the Angular class name when available, a verified-unique CSS selector, an XPath, the element text, and a context screenshot. In practice the component name plus the selector is enough to land in the right file.

### 3. Verify

```bash
nit verify
```

nit opens the site again and walks you through everything the agent marked `fixed`, one item at a time: the panel's queue card shows before and after screenshots, navigates to each item's route automatically, and tracks your progress. Rule each fix:

- **Verified**: the fix is good, the annotation is done.
- **Reopen**: not quite. An optional one-line note is stored as `statusReason`, so the agent reads why it failed instead of guessing. The annotation becomes actionable again, with your original comment and both screenshots still attached.
- **Skip**: decide later. The item moves to the end of the queue for this session and keeps its `fixed` status.

When the session ends, nit prints a summary: verified, reopened, still fixed.

Run the agent again on the reopened items, verify again, and repeat until the list is empty. This loop is cheap; each round is usually a single command plus one agent run.

## With a team

Everyone reviews on their own, then one person merges:

```bash
# each reviewer
nit review https://staging.example.com --author Alice
nit export                       # produces something like 2026-07-22-example.com-alice.nit.zip

# the person merging
nit import 2026-07-22-example.com-alice.nit.zip
nit merge nit-review/annotations.json 2026-07-22-example.com-alice/annotations.json
```

`nit merge` writes a consolidated review (default `nit-review-merged/`) where every annotation keeps its author. Ids are namespaced per author, so nothing collides. From there the flow is the same as solo: hand the merged folder to the agent, then `nit verify` it.

To walk through someone else's review before merging, replay it:

```bash
nit view 2026-07-22-example.com-alice
```

Pins appear on the pages they were made on, and clicking an item in the panel navigates to its route.

## Everyday tips

- **Mobile issues**: start with `nit review --mobile`, or switch the viewport from the panel. Scope annotations to the viewport where they matter.
- **Issue tracking**: put a ticket key or url into an annotation's issue-ref field from the panel, or let the agent do it through `nit_set_issue_ref`. It shows up as a chip in the list and as a link in `review.md`.
- **Keep review folders out of git**: `nit setup` offers the `.gitignore` entry. The zips from `nit export` are the sharing format instead.
- **Untrusted files**: annotation files are treated as untrusted input by design. When you replay a file that did not come from your own team, prefer `nit view --url <your-staging-url>` so the browser opens the origin you chose rather than the one stored in the file.
- **CI or scripted runs**: every browser command accepts `--headless`.
