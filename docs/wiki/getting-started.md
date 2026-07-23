# Getting started

This page takes you from nothing to a finished first review in about five minutes.

## 1. Install

```bash
npm install -g @spaceparrots/nit
nit doctor
```

`nit doctor` checks that Node is version 20.12 or newer, verifies the dependencies, and offers to install Chromium if Playwright does not have one yet. You only need this once per machine.

If you would rather not install globally, every command also works through npx:

```bash
npx @spaceparrots/nit review https://example.com
```

## 2. Set up your project (optional but recommended)

Run this once in the repository the review belongs to:

```bash
nit setup
```

The wizard picks a review directory (default `nit-review/`), adds it to `.gitignore` if you want, can register the MCP server in the project's `.mcp.json` so coding agents find the review without any extra setup, and asks for your author name. The name is stored per user, not per project, and is recorded on every annotation you make.

## 3. Run a review

```bash
nit review https://staging.example.com
```

A real Chromium window opens with the site, and a small panel window opens next to it.

- Press **Alt** (or click the chip in the bottom-left corner) to start picking elements.
- Hover an element. It gets highlighted, and its component tag is shown.
- **Click** the element. A small form opens.
- Type what should change, choose the type, and save:
  - a **change request** is something an agent should fix,
  - a **comment** is context for a human or an agent, not a task.
- Press **Esc** at any time to cancel picking.

Browse the site normally between annotations. Navigation, logins and client-side routing all work; annotations remember the route they were made on. If your issue only shows on mobile, switch the viewport from the panel (or start with `nit review --mobile`).

When you are done, press **Finish review** at the bottom of the panel.

## 4. Look at what you produced

```
nit-review/
├─ annotations.json     # the structured data agents read
├─ review.md            # the same review as readable markdown with screenshots
├─ fix-annotations.md   # instructions for the fixing agent
└─ shots/               # a screenshot per annotation
```

Open `review.md` to double-check your notes. The [annotation file reference](./annotations.md) explains every field.

## 5. Hand it to an agent

Point your coding agent at the review folder and tell it to follow `fix-annotations.md`. Or, if you registered the MCP server during setup, just tell the agent to fix the open nit annotations; it will find the review through the `nit` MCP tools. The [MCP guide](./mcp.md) explains the tools and what a good agent prompt looks like.

## 6. Verify the fixes

```bash
nit verify
```

nit reopens the site, takes an "after" screenshot for every annotation the agent marked `fixed`, and shows both screenshots side by side in the panel. You rule each one **Verified** or **Reopen**. Reopened items become actionable again, so the next agent run picks them up.

That is the whole loop. For sharing reviews with teammates and other day-to-day patterns, read the [workflow guide](../workflow.md).
