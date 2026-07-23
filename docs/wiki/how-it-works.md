# How nit works

A short tour of the architecture. For the source layout, see [src/README.md](../../src/README.md).

## One browser, one overlay

`nit review` launches a single Playwright Chromium with a persistent profile and `bypassCSP: true`. A vanilla-JS overlay is bundled with esbuild at startup and injected into every page of the session via `addInitScript`. All overlay UI lives inside an isolated Shadow DOM, so it works on any site without touching the page's own DOM, styles or scripts. The same overlay serves capture (`review`), replay (`view`) and verification (`verify`).

The panel is a separate popup window with its own bundled UI. It talks to the same Node process, never to the inspected page directly.

## The bridge

The overlay and the panel communicate with Node exclusively through Playwright's `exposeBinding`. Every payload that crosses that bridge is validated on the Node side, because a page's own JavaScript could call the bindings too. Bindings are guarded by frame and page, so only the top frame of the session's own pages gets through.

## Screenshots

Screenshots are CDP element clips, expanded to a minimum context window (480x360, centered on the element) and captured at pick time, so transient states like open dropdowns survive. `nit verify` captures after-shots with the same rules, which makes before and after directly comparable.

## Replay and anchoring

An annotation stores a layered element reference: a verified-unique CSS selector (preferring `#id` and `data-id` anchors), an absolute XPath, and the element text. Replay tries them in that order, preferring a visible match over a hidden one, so a responsive layout's hidden desktop-only twin never steals a pin from the markup actually rendered on the current viewport.

On every route the overlay classifies each annotation into one of three placement states. **Placed**: the element was re-found and is visible — it gets a numbered pin. **Approximate**: the element wasn't re-found, but the annotation wasn't captured inside a dialog and the current viewport mode matches the one it was captured at — a dashed ghost pin marks the originally recorded position. **Hidden**: the annotation is scoped to the other viewport, was captured inside a dialog that isn't currently open, or the element is simply gone. Annotations are filtered to the current viewport by default in every mode (a show-all toggle overrides this), and being out of viewport scope is itself one of the hidden reasons.

Hidden annotations are never dropped silently. In the overlay, a small "x hidden" pill next to the nit chip counts them; clicking it lists each one with its reason. In the panel, the same annotations surface as "couldn't place" rows carrying the same reasons, and clicking a row focuses the annotation. Dialog-captured annotations carry a `context` field recording the dialog's own selector and label (see [annotations.md](annotations.md)), which is what lets replay tell "the dialog is closed" apart from "the element is gone" instead of reporting a generic miss.

The overlay keeps pins current as the page changes: a MutationObserver re-anchors them after an SPA re-renders or replaces DOM nodes, and a retry cycle re-attempts anchoring across all viewport modes so a route change or late-loading content doesn't leave a pin stuck. Elements that become detached hide instead of drifting to a stale position.

**Known limitation:** while a native `<dialog>` opened with `showModal()` is open, it sits in the browser's top layer above everything else, so nit's own popover can't be clicked from inside it. Pick the element while the dialog is open (the screenshot is staged at pick time), then close the dialog and save. Overlay-based dialogs (Angular CDK, Bootstrap, `.offcanvas`) aren't affected.

## Trust model

Annotation files are shared between teammates and written by AI agents, so nit treats them as untrusted input end to end:

- Navigation from a file is origin-gated against the url the session actually opened, so a hostile file cannot steer the browser to another origin.
- Free-text fields (issue refs, selectors, click history) are sanitized before they are rendered into `review.md`.
- Screenshot paths are confined to the review directory.
- Everything that arrives from a page, from disk or over stdio is typed `unknown` first and validated before use.

## No backend

The output is plain files in a folder. Sharing is a zip. The MCP server is a thin stdio process over the same folder. There is nothing to host and nothing to sign up for.
