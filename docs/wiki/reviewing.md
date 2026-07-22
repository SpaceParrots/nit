# Reviewing in the browser

What you can do while `nit review` (or `nit view` / `nit verify`) has the browser open.

## Picking elements

- Press **Alt**, or click the chip in the bottom-left corner, to toggle picking mode.
- Hovering highlights the element under the cursor and shows its component tag.
- **Click** selects the element and opens the annotation form.
- **Esc** cancels picking or closes the form.

The screenshot is taken the moment you pick, not when you save. Open dropdowns and hover states
are captured before they can close, and the shot is expanded to a minimum context window
(480x360, centered on the element) so the surroundings stay visible.

## The annotation form

Three things are recorded:

- Your **comment**: what should change.
- The **type**: a *change request* is actionable and will be fixed by an agent; a *comment* is
  context that should not be acted on.
- The **viewport scope**: whether the issue belongs to this viewport (desktop or mobile) or is
  general.

## The panel window

The panel opens next to the browser and never overlays the page under review.

- **Viewport toggle**: switch the site between desktop (1440x900) and mobile (390x844).
- **Filter dropdown** (the funnel icon): sort by time, page or state; group by page or state;
  filter to the current viewport scope. When the review has annotations from more than one
  author, an Author row appears here too, and each list row shows a small author chip. Page
  groups collapse, and the page you are on is first and expanded.
- **Expanded item**: click any annotation to expand it. You see status and scope badges, the
  created/updated stamps, the component, the highlighted selector, the screenshot (before and
  after, once verify ran), and you can:
  - edit the comment text,
  - attach an issue reference (a tracker key or url),
  - jump to the page the annotation was made on,
  - delete the annotation.
- **Finish review** at the bottom writes the final state and closes the session.

## Where it works

- CSP-hardened production sites: the overlay is injected with `bypassCSP`, so strict sites work.
- SPAs: annotations are pinned to client-side routes, and route changes are tracked without page
  reloads.
- Plain static pages, dev servers, staging environments: anything Chromium can open.

## The Angular bonus

nit is framework-agnostic, but on Angular dev and staging builds that expose `window.ng`, each
annotation additionally records the component **class name** (for example
`ProductTileComponent`). That is the single best pointer a fixing agent can get. On production
builds the custom-element tag (for example `app-product-tile`) is captured instead; both are
enough to locate the source.
