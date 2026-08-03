// SPDX-License-Identifier: AGPL-3.0-or-later
// Detect whether a picked element lives inside a modal/dialog/drawer surface.
// Two tiers: 'confident' (the element says it is a dialog — semantics or a known
// framework class) and 'suspected' (it only looks like one — a modal-ish class
// name, or a fixed-position ancestor). The popover shows a pre-checked box for
// the first and an unchecked one for the second, so custom modals with no ARIA
// still get a dialog context when the reviewer confirms it.
//
// Pure DOM-method walks over a small member set (tagName, getAttribute,
// classList.contains, parentElement, querySelector, textContent,
// ownerDocument.getElementById, ownerDocument.defaultView.getComputedStyle) so
// the unit tests can fake elements — keep it that way. Runs inside the inspected
// page (bundled into the overlay); never throws.

const MAX_LABEL = 60;

/**
 * Attributes an app can add so nit needs no heuristics at all. Deliberately
 * unprefixed: a generic name is far likelier to be adopted in real markup than a
 * vendor-prefixed one, and the cost of a collision is one unticked checkbox.
 *
 * `data-dialog` marks the surface; `data-dialog-trigger` marks the control that
 * opens it (read by the overlay's trail, see overlay/trail.ts). A shared value
 * pairs the two, which disambiguates a page with several dialogs.
 */
export const DATA_DIALOG = 'data-dialog';
export const DATA_DIALOG_TRIGGER = 'data-dialog-trigger';

/** class names of common overlay containers (Angular CDK, Bootstrap) */
const DIALOG_CLASSES = ['cdk-overlay-pane', 'modal', 'offcanvas'];

/**
 * Modal-ish words in a class attribute. Word-ish boundaries (start/end, space,
 * `-`, `_`) keep `modal-body` and `app_drawer` in while keeping `modality` out.
 * Deliberately excludes `overlay`, which decorative scrims and gradients use as
 * often as modals do — a real `.overlay` modal is caught by the fixed-position
 * tier below instead.
 *
 * A class match is never enough on its own: `mat-drawer-content` matches this,
 * and in an Angular Material sidenav app that class wraps *every* routed page,
 * which would put a dialog checkbox on every annotation ever made. See
 * {@link isSuspectedContainer} for the corroboration that rules it out.
 */
const SUSPECT_CLASS = /(^|[-_ ])(modal|dialog|drawer|sheet|popup|lightbox|flyout)([-_ ]|$)/i;

/** Elements the suspected tier must never claim as the dialog surface. */
const NEVER_CONTAINER = ['BODY', 'HTML'];

/**
 * Positions an overlay surface is drawn at. A dialog is lifted out of the page
 * flow; the shell that *contains* one is not (Angular Material's
 * `.mat-drawer-container` / `.mat-drawer-content` both compute to `relative`,
 * while the real `.mat-drawer` is `absolute` and Vuetify's
 * `.v-navigation-drawer` is `fixed`).
 */
const OVERLAY_POSITION = ['fixed', 'absolute'];

/**
 * Classes pages set on `<body>`/`<html>` while a modal holds the screen.
 * Utility class names (Tailwind's `overflow-hidden`) are deliberately absent:
 * they say nothing about *why* the page does not scroll, and plenty of app
 * shells carry them permanently.
 */
const SCROLL_LOCK_CLASS = /(^|[-_ ])(modal-open|no-scroll|noscroll|scroll-lock|scroll-locked)([-_ ]|$)/i;

/**
 * How sure we are that the container really is a dialog: `confident` when the
 * element declares it (semantics or a known framework class), `suspected` when
 * it only looks like one.
 */
export type DialogConfidence = 'confident' | 'suspected';

/** A dialog-like ancestor of a picked element. */
export interface DialogContainer {
  container: Element;
  /** aria-label → resolved aria-labelledby → first heading text; null when unnamed */
  label: string | null;
  confidence: DialogConfidence;
}

/**
 * Nearest ancestor (incl. self) that is a dialog-like container. A confident
 * match anywhere in the chain beats a nearer suspected one, so a `.modal-body`
 * inside a `role=dialog` still reports the real dialog — and reports it as
 * confident, which is what pre-checks the popover's box.
 * @returns the container, its human-readable label and how sure we are, or null
 *   when nothing in the chain looks like a dialog
 */
export function detectDialog(el: Element): DialogContainer | null {
  const scrollLocked = memoLock(el);
  let suspected: Element | null = null;
  for (let n: Element | null = el; n?.nodeType === 1; n = n.parentElement) {
    const kind = classify(n, scrollLocked);
    if (kind === 'confident') return { container: n, label: dialogLabel(n), confidence: 'confident' };
    if (kind === 'suspected' && !suspected) suspected = n;
  }
  return suspected ? { container: suspected, label: dialogLabel(suspected), confidence: 'suspected' } : null;
}

/** One query covering every container the confident tier recognises. */
const CONFIDENT_SELECTOR = 'dialog,[role=dialog],[role=alertdialog],[aria-modal=true],[popover],'
  + `[${DATA_DIALOG}],.cdk-overlay-pane,.modal,.offcanvas`;

/**
 * A deliberately over-wide CSS pre-filter for {@link isDialogSurface}. The
 * surface watcher (overlay/surfaces.ts) runs on the page's whole mutation
 * stream, and a framework like Angular rewrites `class` attributes constantly —
 * so `getComputedStyle` must never run on that stream directly. This narrows it
 * to a handful of elements with a pure selector match; the real word-boundary
 * and position tests stay in {@link isDialogSurface}.
 *
 * Substring matches on purpose (`[class*="sheet"]` catches `action-sheet`,
 * `bottom-sheet` and `sheet-open` alike): a hint that misses is a dialog nit
 * never sees, while a hint that over-matches only costs one style read.
 */
export const SURFACE_HINT_SELECTOR = `${CONFIDENT_SELECTOR},`
  + '[class*="modal"],[class*="dialog"],[class*="drawer"],[class*="sheet"],'
  + '[class*="popup"],[class*="lightbox"],[class*="flyout"]';

/**
 * How this one element classifies as a dialog surface, or null when it is not
 * one. The single definition of "dialog surface": {@link detectDialog} asks it
 * per ancestor when the reviewer picks an element, and the surface watcher
 * (overlay/surfaces.ts) asks it per mutation candidate to decide that a dialog
 * has just opened.
 *
 * Those two used to be different tests, and the second was strictly weaker —
 * it only ever looked at declared surfaces and `<body>`'s own children, so a
 * custom modal nested in a component tree was detectable but never observably
 * *opened*, and its annotations got no re-open steps. One exported predicate is
 * what keeps them from drifting apart again.
 */
export function isDialogSurface(n: Element): DialogConfidence | null {
  return classify(n, memoLock(n));
}

/** {@link isDialogSurface} with a scroll-lock check shared across a whole walk. */
function classify(n: Element, scrollLocked: () => boolean): DialogConfidence | null {
  if (isDialogContainer(n)) return 'confident';
  return isSuspectedContainer(n, scrollLocked) ? 'suspected' : null;
}

/**
 * A scroll-lock check evaluated lazily and at most once. It is the same answer
 * for every element in a document, and on a plain page nothing ever asks for it.
 */
function memoLock(el: Element): () => boolean {
  let locked: boolean | null = null;
  return () => locked ??= isScrollLocked(el);
}

/**
 * The dialog surfaces currently on screen. Used to tell whether a click
 * *caused* a dialog to open — the trail compares this before and after each
 * click, which is the only honest way to know which click is the opener (see
 * `overlay/trail.ts`).
 *
 * The candidate scan is deliberately bounded rather than a walk of the whole
 * DOM: one `querySelectorAll` for the declared surfaces, plus `<body>`'s direct
 * children, which is where portal-mounted custom modals land. It runs a couple
 * of times per page click, so it must stay cheap.
 * @param doc the document to scan
 * @returns the rendered dialog-like containers, deduplicated
 */
export function openSurfaces(doc: Document): Element[] {
  const candidates = new Set<Element>();
  try {
    for (const n of doc.querySelectorAll(CONFIDENT_SELECTOR)) candidates.add(n);
  } catch { /* querySelectorAll unavailable (faked document) — body children still apply */ }
  for (const n of doc.body?.children ?? []) candidates.add(n);

  const out: Element[] = [];
  for (const n of candidates) {
    if (!classify(n, memoLock(n))) continue;
    if (isRendered(n)) out.push(n);
  }
  return out;
}

/**
 * Whether the element occupies space — an animating-in dialog starts at zero.
 * Shared with the surface watcher, which uses it as the "is it actually on
 * screen now?" half of open/closed.
 */
export function isRendered(n: Element): boolean {
  try {
    const r = n.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  } catch {
    return false;
  }
}

function isDialogContainer(n: Element): boolean {
  // An explicit declaration by the page author outranks everything below it.
  if (n.getAttribute(DATA_DIALOG) !== null) return true;
  if (n.tagName === 'DIALOG') return true;
  const role = n.getAttribute('role');
  if (role === 'dialog' || role === 'alertdialog') return true;
  if (n.getAttribute('aria-modal') === 'true') return true;
  // The HTML popover API puts the element in the top layer — as much an overlay
  // surface as a <dialog>, and just as reliably re-openable.
  if (n.getAttribute('popover') !== null) return true;
  return DIALOG_CLASSES.some(c => n.classList.contains(c));
}

/**
 * The weak tier — how hand-rolled modals without any ARIA usually look. Two
 * signals, and **both** need the element to actually be drawn as an overlay
 * (`position: fixed`/`absolute`) and to not wrap the whole document:
 *
 * - a modal-ish class name, or
 * - a fixed box while the page is scroll-locked.
 *
 * The corroboration carries the weight here. A bare class match matches
 * `mat-drawer-content`, which wraps every routed page in an Angular Material
 * app; a bare `position: fixed` matches every sticky header, cookie banner and
 * floating action button. Neither is a dialog, and either one alone would put a
 * checkbox on nearly every annotation.
 *
 * Checked cheapest-first so a plain page costs no per-ancestor style reads: the
 * class test is a string match, and the memoized scroll-lock check (two reads
 * for the whole walk) gates the tier that would otherwise measure every
 * ancestor.
 * @param scrollLocked lazily evaluated page-level scroll-lock check
 */
function isSuspectedContainer(n: Element, scrollLocked: () => boolean): boolean {
  if (NEVER_CONTAINER.includes(n.tagName)) return false;
  const named = SUSPECT_CLASS.test(n.getAttribute('class') ?? '');
  if (!named && !scrollLocked()) return false;
  const position = styleOf(n)?.position;
  if (!position || !OVERLAY_POSITION.includes(position)) return false;
  // A named-but-static shell is out by the check above; a named overlay that
  // still spans the entire document (a full-page fixed app shell) is out here.
  if (wrapsDocument(n)) return false;
  return named || position === 'fixed';
}

/**
 * Whether the element spans the document's whole content — the shape of an app
 * shell, never of a dialog. A dialog is mounted beside the app root (usually
 * appended last), so it cannot contain both ends of the body.
 */
function wrapsDocument(n: Element): boolean {
  const body = n.ownerDocument?.body;
  const first = body?.firstElementChild;
  const last = body?.lastElementChild;
  if (!first || !last || typeof n.contains !== 'function') return false;
  return n.contains(first) && n.contains(last);
}

/**
 * Whether the page is scroll-locked *because something is holding the screen*.
 *
 * A lock class on `<body>`/`<html>` is explicit intent and counts on its own.
 * A computed non-scrolling overflow does not: app shells with an inner scroll
 * container set `html, body { overflow: hidden }` permanently. That only means
 * a lock when there is content being withheld — a permanent shell has none,
 * because its overflow lives in the inner scroller, so its `scrollHeight` never
 * exceeds its `clientHeight`.
 */
function isScrollLocked(el: Element): boolean {
  const doc = el.ownerDocument;
  for (const n of [doc?.body, doc?.documentElement]) {
    if (!n) continue;
    if (SCROLL_LOCK_CLASS.test(n.getAttribute('class') ?? '')) return true;
    if (hidesOverflow(n) && withholdsContent(doc?.documentElement)) return true;
  }
  return false;
}

/**
 * Whether an element clips its overflow. Reads the longhands on purpose: with
 * only `overflow-y: hidden` set, the shorthand serializes as `"auto hidden"`
 * and never equals `'hidden'`, so testing it would miss half the scroll-lock
 * implementations in the wild.
 */
function hidesOverflow(n: Element): boolean {
  const s = styleOf(n);
  return [s?.overflowY, s?.overflowX].some(v => v === 'hidden' || v === 'clip');
}

/** Whether the document has content it is currently refusing to scroll to. */
function withholdsContent(root: Element | null | undefined): boolean {
  return Boolean(root && root.scrollHeight > root.clientHeight);
}

/** Computed style, or null when the element cannot be measured (detached, faked in tests). */
function styleOf(n: Element): CSSStyleDeclaration | null {
  try {
    return n.ownerDocument?.defaultView?.getComputedStyle(n) ?? null;
  } catch {
    return null;
  }
}

function dialogLabel(container: Element): string | null {
  const aria = norm(container.getAttribute('aria-label'));
  if (aria) return aria.slice(0, MAX_LABEL);
  const labelledby = norm(
    (container.getAttribute('aria-labelledby') ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map(id => container.ownerDocument?.getElementById(id)?.textContent ?? '')
      .join(' '),
  );
  if (labelledby) return labelledby.slice(0, MAX_LABEL);
  const heading = container.querySelector('h1,h2,h3,h4,h5,h6');
  const text = norm(heading?.textContent);
  return text ? text.slice(0, MAX_LABEL) : null;
}

function norm(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}
