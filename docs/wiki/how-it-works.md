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

An annotation stores a layered element reference: a verified-unique CSS selector (preferring `#id` and `data-id` anchors), an absolute XPath, and the element text. Replay tries them in that order. When nothing matches anymore (the site changed too much), the annotation lands in a "couldn't place" list in the panel instead of breaking the session.

## Trust model

Annotation files are shared between teammates and written by AI agents, so nit treats them as untrusted input end to end:

- Navigation from a file is origin-gated against the url the session actually opened, so a hostile file cannot steer the browser to another origin.
- Free-text fields (issue refs, selectors, click history) are sanitized before they are rendered into `review.md`.
- Screenshot paths are confined to the review directory.
- Everything that arrives from a page, from disk or over stdio is typed `unknown` first and validated before use.

## No backend

The output is plain files in a folder. Sharing is a zip. The MCP server is a thin stdio process over the same folder. There is nothing to host and nothing to sign up for.
