# Reviewing in the browser

What you can do while `nit review` (or `nit view` / `nit verify`) has the browser open.

## Picking elements

- Press **Alt**, or click the chip in the bottom-left corner, to toggle picking mode.
- Hovering highlights the element under the cursor and shows its component tag.
- **Click** selects the element and opens the annotation form.
- **Esc** cancels picking or closes the form.

The screenshot is taken the moment you pick, not when you save. Open dropdowns and hover states are captured before they can close, and the shot is expanded to a minimum context window (480x360, centered on the element) so the surroundings stay visible.

## The annotation form

Three things are recorded:

- Your **comment**: what should change.
- The **type**: a *change request* is actionable and will be fixed by an agent; a *comment* is context that should not be acted on.
- The **viewport scope**: whether the issue is **general** (the default — most fixes apply everywhere) or belongs to the current viewport (desktop or mobile).

A fourth row appears **only when the element looks like it lives in a dialog**, so the form stays this short everywhere else:

- **In dialog "Checkout"** — already ticked. The element declares itself: a `<dialog>`, `role="dialog"`, `aria-modal`, `[popover]`, or a framework overlay class (Angular CDK, Bootstrap). Untick it if it is a false positive.
- **Inside a dialog / modal?** — not ticked. Only a hint: a modal-ish class name (`.checkout-drawer`, `.bottom-sheet`), or a scroll-locked page. Hand-rolled modals with no ARIA look like this; tick it if it is one.

Confirming it is what makes the fix **verifiable later**. nit stores the dialog's selector, its name, and the clicks that opened it, so `nit verify` can click its way back in instead of screenshotting a page the dialog is no longer on.

The hint never fires on a name alone. The box also has to be drawn as an overlay (`position: fixed` or `absolute`) and must not wrap the whole page, which is what keeps the row off every annotation in an Angular Material app, where `.mat-drawer-content` wraps every routed page. A fixed box with no modal-ish name additionally needs the page to be scroll-locked *and* to have content it is withholding, so sticky headers, cookie banners and app shells that clip their overflow permanently stay quiet.

## The panel window

The panel opens next to the browser and never overlays the page under review.

- **Viewport toggle**: switch the site between desktop (1440x900) and mobile (390x844).
- **Filter dropdown** (the funnel icon): sort by time, page or state; group by page or state; filter to the current viewport scope. When the review has annotations from more than one author, an Author row appears here too, and each list row shows a small author chip. Page groups collapse, and the page you are on is first and expanded.
- **Expanded item**: click any annotation to expand it. You see status and scope badges, the created/updated stamps, the component, the highlighted selector, the screenshot (before and after, once verify ran), and you can:
  - edit the comment text,
  - attach an issue reference (a tracker key or url),
  - jump to the page the annotation was made on,
  - delete the annotation.
- **Finish review** at the bottom writes the final state and closes the session (shown in review and verify mode).

## Verifying fixes

In `nit verify`, a queue card at the top of the panel walks you through every annotation the agent marked `fixed` — no expanding rows, no hunting:

- A **progress header** (`Verify fixes — 2 of 5 ruled`) with a progress bar.
- The **current item** with its comment, route, and the before and after screenshots stacked, each captioned with its viewport. A general item is captured and shown on **both** viewports (`after · desktop` / `after · mobile`) — the fix must hold on desktop and mobile alike — and the session **switches the viewport automatically** to collect the missing shot. A scoped item only ever gets its own viewport's shot, so the after-shot always matches the before-shot's viewport. While a shot is still being captured the card says "capturing after-shot (…)…"; when the element can't be re-found on the page, it notes that the originally recorded region was captured instead.
- **Dialogs re-open themselves.** When the fixed item was annotated inside a modal, nit replays the clicks you originally made to get in there (once per item and viewport), waits for the after-shot, then presses Escape to leave the page as it found it. The card says which dialog is in the way and offers a **Re-open** button — the retry, and the only option when the trail holds no way in (a dialog opened before the trail started, or on another route: then you open it yourself and the shot follows). The same button appears on "couldn't place" rows in `nit view`.

  This is the one thing nit clicks on your site by itself, so it is fenced in: only clicks that were *observed* to open something are ever recorded (an ordinary button you pressed inside the dialog is not), at most three of them, one attempt per item and viewport, one replay at a time. Every step re-checks where the page ended up — a replay that navigates off the review origin is abandoned and the page is brought back, because bridge access is granted by page identity and must never follow the page somewhere else.
- **Always-visible actions**: **Verified**, **Reopen** and **Skip**.
  - *Verified* rules the item immediately (and clears a stale reason from an earlier round).
  - *Reopen* reveals an optional one-line note ("why is it not fixed?"). The note is stored on the annotation as `statusReason`, so the fixing agent reads why instead of guessing.
  - *Skip* moves the item to the end of the queue for this session; its status stays `fixed`.
- The queue is ordered to minimize navigation — the current route's items first, the rest grouped by route — and the site page **navigates to each item's route automatically**.
- Once everything is ruled the card sums the session up (`X verified · Y reopened · Z skipped`) and points you at the **Finish review** button.

The regular list stays below the card, so you can still expand any annotation for its details.

## Where it works

- CSP-hardened production sites: the overlay is injected with `bypassCSP`, so strict sites work.
- SPAs: annotations are pinned to client-side routes, and route changes are tracked without page reloads.
- Plain static pages, dev servers, staging environments: anything Chromium can open.

## The Angular bonus

nit is framework-agnostic, but on Angular dev and staging builds that expose `window.ng`, each annotation additionally records the component **class name** (for example `ProductTileComponent`). That is the single best pointer a fixing agent can get. On production builds the custom-element tag (for example `app-product-tile`) is captured instead; both are enough to locate the source.
