# Annotation file reference

A review folder is plain files. This page explains what is in them and what each field means.
The authoritative type definitions live in [`src/types.ts`](../../src/types.ts).

## The folder

```
nit-review/
├─ annotations.json     # the structured review, read and written by tools and agents
├─ review.md            # the same review rendered as readable markdown with screenshots
├─ fix-annotations.md   # the instruction sheet for a fixing agent
└─ shots/               # one screenshot per annotation, plus -after shots from nit verify
```

`annotations.json` is the source of truth. `review.md` and `fix-annotations.md` are re-rendered
from it on every write.

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
  "createdAt": "2026-07-21T02:28:11.550Z",
  "updatedAt": "2026-07-22T09:01:00.000Z",
  "updatedBy": "agent",
  "issueRef": "FAI-1234",
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
| `viewportScope` | `desktop`, `mobile` or `general`: where the issue applies. |
| `viewport` | The exact viewport the annotation was made in. |
| `route` | The page it was made on, as pathname plus query and hash. |
| `target` | The layered element reference, see below. |
| `screenshot` | Path of the context screenshot, relative to the review folder. |
| `screenshotAfter` | The "after" screenshot captured by `nit verify`, when one exists. |
| `createdAt` | ISO timestamp of capture. |
| `updatedAt` / `updatedBy` | Set on every status, comment or issue-ref change. `updatedBy` is `"agent"` when the change came through MCP. |
| `issueRef` | Optional tracker reference, a key like `FAI-1234` or a url. Settable from the panel and by agents through MCP. |
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

Replay (`nit view`, `nit verify`) re-anchors in that order: selector, then xpath, then text. If
nothing matches anymore, the annotation lands in a "couldn't place" list instead of breaking the
session.

## The status lifecycle

```
open ──► fixed ──► verified   (done)
  ▲          │
  │          └──► reopened ──► (actionable again, like open)
  └── wontfix is a terminal decision a human makes
```

An annotation is **actionable** when it is a `change-request` with status `open` or `reopened`.
The fixing agent's contract (`fix-annotations.md`) is: fix every actionable annotation at the
referenced element, then set its status to `fixed`. Humans rule `verified` or `reopened` during
`nit verify`.

## Trust

Annotation files travel between people and are edited by agents, so nit treats them as
untrusted input everywhere: fields are validated and sanitized before they reach the browser,
review.md, or navigation. If you review a file from outside your team, prefer
`nit view --url <your-staging-url>` so the session opens an origin you chose, not one from the
file.
