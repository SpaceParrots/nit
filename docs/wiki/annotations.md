# Annotation file reference

A review folder is plain files. This page explains what is in them and what each field means. The authoritative type definitions live in [`src/types.ts`](../../src/types.ts).

## The folder

```
nit-review/
├─ annotations.json     # the structured review, read and written by tools and agents
├─ review.md            # the same review rendered as readable markdown with screenshots
├─ fix-annotations.md   # the instruction sheet for a fixing agent
└─ shots/               # one screenshot per annotation, plus -after shots from nit verify
```

`annotations.json` is the source of truth. `review.md` and `fix-annotations.md` are re-rendered from it on every write.

## Where annotations live: one folder per base URL

A review can cover several sites — local, staging, production. Each base URL then gets its own subfolder, and that subfolder is byte-for-byte the folder above:

```
nit-review/
├─ bases.json           # the index of base URLs (see below)
├─ staging/             # a complete review folder, exactly as described above
│  ├─ annotations.json
│  ├─ review.md
│  ├─ fix-annotations.md
│  └─ shots/
└─ localhost-4200/
   └─ …
```

**The annotation schema itself does not change**, and neither do the ids: `staging/annotations.json` holds a plain `a1`, and each base counts its own ids from `a1` up. The qualified `staging:a1` form exists only where output spans bases — the MCP tools and `nit list` — and is translated back the moment it reaches a file.

A review of a single site stays flat: `annotations.json` sits directly in `nit-review/`, with no `bases.json`. It becomes a folder-per-base layout only when a *second*, genuinely different base url is reviewed into it, at which point the existing review is moved into its own subfolder, screenshots and all.

`bases.json` records which folder is which:

```json
{
  "version": 1,
  "bases": [
    {
      "slug": "staging",
      "url": "https://staging.example.com",
      "createdAt": "2026-07-25T09:00:00.000Z",
      "lastSeenAt": "2026-07-27T14:12:03.000Z"
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `slug` | The folder name, and what `--base` and a qualified id name. Lowercase letters, digits and dashes only. |
| `url` | The site this base covers. A base's own `review.url` wins when the two disagree. |
| `createdAt` | When the base was first registered. |
| `lastSeenAt` | When a session last reviewed this base. |

It is an *index*, not the source of truth: a subfolder holding an `annotations.json` is a base whether or not it is listed, and an entry naming a folder that is gone is ignored. So a review survives a `git clone`, an unzip, or a hand-edit — the same tolerance `annotations.json` itself gets. If you delete `bases.json`, nit rebuilds what it needs from the folders.

## One annotation

```json
{
  "id": "a1",
  "type": "change-request",
  "comment": "Star icons are not filled. They read as 0/5 ratings.",
  "status": "open",
  "author": "Kevin",
  "viewportScope": "desktop",
  "viewport": { "mode": "desktop", "w": 1440, "h": 900 },
  "route": "/auth/sign-in",
  "target": { "…": "see below" },
  "screenshot": "shots/a1.png",
  "screenshotAfter": "shots/a1-after.png",
  "screenshotsAfter": { "desktop": "shots/a1-after.png" },
  "createdAt": "2026-07-21T02:28:11.550Z",
  "updatedAt": "2026-07-22T09:01:00.000Z",
  "updatedBy": "agent",
  "issueRef": "FAI-1234",
  "context": {
    "kind": "dialog",
    "selector": "#checkout-dialog",
    "label": "Checkout",
    "reopen": [
      { "selector": "button.cart", "tag": "button", "component": "app-nav",
        "text": "Open checkout", "at": "2026-07-21T02:27:44.000Z" }
    ]
  },
  "history": [
    { "selector": "button.menu", "tag": "button", "component": "app-nav",
      "text": "Menu", "at": "2026-07-21T02:27:41.000Z" }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `id` | Stable id, unique within the file. Merged reviews namespace ids by author. |
| `type` | `change-request` (actionable, an agent should fix it) or `comment` (context only). |
| `comment` | The reviewer's text. Editable later from the panel. |
| `status` | `open`, `fixed`, `verified`, `reopened` or `wontfix`. See the lifecycle below. |
| `author` | Who recorded the annotation. |
| `viewportScope` | `desktop`, `mobile` or `general`: where the issue applies. New annotations default to `general`. |
| `viewport` | The exact viewport the annotation was made in. |
| `route` | The page it was made on, as pathname plus query and hash. |
| `target` | The layered element reference, see below. |
| `context` | Optional, additive. Where the element lived at capture time; absent on plain pages. For dialogs: `{ "kind": "dialog", "selector": "#checkout-dialog", "label": "Checkout", "reopen": [ … ] }` — `selector` re-finds the dialog container, `label` comes from `aria-label` → `aria-labelledby` → the dialog's first heading (trimmed to 60 characters). Replay uses it to tell "the dialog is closed" apart from "the element is gone" and shows such annotations under the "x hidden" pill instead of dropping them silently. |
| `context.reopen` | Optional. Up to 3 clicks that open that dialog, oldest first, in the same shape as `history`. A click is only recorded when nit has a reason to believe it opened something: the overlay *watched* a surface appear after it, or your markup declared the control with `data-dialog-trigger`. Recorded are the last such click made on the plain page, plus any later ones that opened a further surface (page → menu → dialog). Ordinary interactions inside the dialog are not included, and a chain that needs more than 3 clicks is dropped rather than truncated. `nit verify` replays them so a fix inside a modal can be screenshotted; the **Re-open** button in the panel replays the same steps on demand, in `nit view` too. **These are the only selectors nit ever clicks by itself** — they are re-validated and re-capped every time the file is loaded, and a replay that navigates the page off the review origin is abandoned. Keep the list short and honest if you hand-edit it. |
| `screenshot` | Path of the context screenshot, relative to the review folder. |
| `screenshotAfter` | The primary "after" screenshot captured by `nit verify`, when one exists — taken at the same viewport as the before-shot (or at the scope viewport for scoped annotations). Always mirrors the primary `screenshotsAfter` entry. |
| `screenshotsAfter` | All `nit verify` after-shots, keyed by viewport (`desktop` / `mobile`). General-scoped annotations get one per viewport (the fix must hold on both); scoped ones only ever their own. Additive to the schema — older consumers can keep reading `screenshotAfter`. |
| `createdAt` | ISO timestamp of capture. |
| `updatedAt` / `updatedBy` | Set on every status, comment or issue-ref change. `updatedBy` is `"agent"` when the change came through MCP. |
| `issueRef` | Optional tracker reference, a key like `FAI-1234` or a url. Settable from the panel and by agents through MCP. |
| `statusReason` | Optional rationale for the current status — most useful on `wontfix`, so the decision is not re-litigated later. Set with the status via MCP (`nit_set_status`/`nit_mark_fixed` `reason`); replaced on every status change. |
| `history` | The click trail: the reviewer's last clicks (up to 10) on that pathname before capturing. Use it to reproduce states hidden behind menus or tabs. |

## The target

The target is a layered reference to the element, ordered roughly from most to least meaningful:

| Field | Meaning |
| --- | --- |
| `component` | The nearest custom-element tag, for example `app-product-tile`. Falls back to the element's own tag. |
| `ngComponent` | The Angular component class name, when the site exposes `window.ng` (dev and staging builds). Otherwise `null`. |
| `selector` | A verified-unique CSS selector. Generation prefers the element's own `#id`, then `[data-id="…"]`, then anchored paths. It was checked to match exactly one element at capture time. |
| `xpath` | An absolute XPath, the fallback anchor when the selector no longer matches. |
| `tag`, `classes`, `text` | The element's tag, cleaned class list, and trimmed text content. The text is the last-resort anchor for replay. |
| `rect` | The element's page coordinates at capture time. |

Replay (`nit view`, `nit verify`) re-anchors in that order: selector, then xpath, then text — preferring a visible match over a hidden one, so a responsive layout's hidden twin never steals a pin from what's actually rendered. If nothing matches, the annotation surfaces in a "couldn't place" list instead of breaking the session. See [how-it-works.md](how-it-works.md#replay-and-anchoring) for the full placed/approximate/hidden classification, including how a `context` dialog is detected as closed rather than gone.

## Helping nit find your dialogs

nit detects dialogs on its own: anything with `role="dialog"`, `aria-modal`, a
`<dialog>` element, the HTML popover API, or a known framework class is
recognised outright, and a modal-ish class name on an overlay-positioned box is
offered to you as a checkbox to confirm.

What it cannot always see is the moment a dialog *opens* — which is what lets
`nit verify` click its way back in later. A surface that is detectable only by
its position (fixed on a scroll-locked page, with no dialog role and no
modal-ish class name, mounted somewhere other than directly under `<body>`)
gets a checkbox but no recorded way back in.

Two optional attributes close that gap:

```html
<button data-dialog-trigger>Give feedback</button>
…
<div class="action-sheet" data-dialog>…</div>
```

- **`data-dialog`** on the dialog itself. nit treats it as a dialog with no
  guesswork, so the confirmation box arrives already ticked.
- **`data-dialog-trigger`** on the control that opens it. The click is recorded
  as the way back in without nit having to observe anything — put it on the
  button, not on an icon inside it (a click on a child still counts). If nit
  *does* see a dialog appear after that click, it checks that it is the one you
  went on to annotate: the attribute says the click opens *a* dialog, not which,
  so an observation that contradicts it wins.

Presence is the whole contract — nit never reads either attribute's value. Add
one anyway if it helps whoever reads your markup next; it doesn't change
anything nit does.

The names are deliberately generic rather than nit-specific: they describe your
markup, not our tool, and nothing else in nit depends on them.

## The status lifecycle

```
open ──► fixed ──► verified   (done)
  ▲          │
  │          └──► reopened ──► (actionable again, like open)
  └── wontfix is a terminal decision a human makes
```

An annotation is **actionable** when it is a `change-request` with status `open` or `reopened`. The fixing agent's contract (`fix-annotations.md`) is: fix every actionable annotation at the referenced element, then set its status to `fixed`. Humans rule `verified` or `reopened` during `nit verify`.

## Trust

Annotation files travel between people and are edited by agents, so nit treats them as untrusted input everywhere: fields are validated and sanitized before they reach the browser, review.md, or navigation. If you review a file from outside your team, prefer `nit view --url <your-staging-url>` so the session opens an origin you chose, not one from the file.
