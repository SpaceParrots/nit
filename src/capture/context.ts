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

/** class names of common overlay containers (Angular CDK, Bootstrap) */
const DIALOG_CLASSES = ['cdk-overlay-pane', 'modal', 'offcanvas'];

/**
 * Modal-ish words in a class attribute. Word-ish boundaries (start/end, space,
 * `-`, `_`) keep `modal-body` and `app_drawer` in while keeping `modality` out.
 * Deliberately excludes `overlay`, which decorative scrims and gradients use as
 * often as modals do — a real `.overlay` modal is caught by the fixed-position
 * tier below instead.
 */
const SUSPECT_CLASS = /(^|[-_ ])(modal|dialog|drawer|sheet|popup|lightbox|flyout)([-_ ]|$)/i;

/** Elements a fixed-position walk must not claim as the dialog surface. */
const NEVER_CONTAINER = ['BODY', 'HTML'];

/** Classes pages set on `<body>`/`<html>` while a modal holds the screen. */
const SCROLL_LOCK_CLASS = /(^|[-_ ])(modal-open|no-scroll|noscroll|scroll-lock|scroll-locked|overflow-hidden)([-_ ]|$)/i;

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
  // Evaluated lazily and once: it is the same answer for every ancestor, and on
  // a plain page no ancestor ever asks for it.
  let locked: boolean | null = null;
  const scrollLocked = (): boolean => locked ??= isScrollLocked(el);

  let suspected: Element | null = null;
  for (let n: Element | null = el; n?.nodeType === 1; n = n.parentElement) {
    if (isDialogContainer(n)) return { container: n, label: dialogLabel(n), confidence: 'confident' };
    if (!suspected && isSuspectedContainer(n, scrollLocked)) suspected = n;
  }
  return suspected ? { container: suspected, label: dialogLabel(suspected), confidence: 'suspected' } : null;
}

function isDialogContainer(n: Element): boolean {
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
 * The weak tier — how hand-rolled modals without any ARIA usually look. Either
 * a modal-ish class name, or an element lifted out of the page flow by
 * `position: fixed` *while the page is scroll-locked*. The scroll-lock
 * corroboration is what keeps sticky headers, cookie banners and floating
 * action buttons — all fixed, none of them dialogs — from putting a checkbox on
 * every second annotation.
 * @param scrollLocked lazily evaluated page-level scroll-lock check
 */
function isSuspectedContainer(n: Element, scrollLocked: () => boolean): boolean {
  if (NEVER_CONTAINER.includes(n.tagName)) return false;
  if (SUSPECT_CLASS.test(n.getAttribute('class') ?? '')) return true;
  return styleOf(n)?.position === 'fixed' && scrollLocked();
}

/**
 * Whether the page is scroll-locked: `<body>`/`<html>` either carries a known
 * lock class or computes to a non-scrolling overflow. Nearly every modal
 * implementation does one of the two while it holds the screen.
 */
function isScrollLocked(el: Element): boolean {
  const doc = el.ownerDocument;
  for (const n of [doc?.body, doc?.documentElement]) {
    if (!n) continue;
    if (SCROLL_LOCK_CLASS.test(n.getAttribute('class') ?? '')) return true;
    const overflow = styleOf(n)?.overflow;
    if (overflow === 'hidden' || overflow === 'clip') return true;
  }
  return false;
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
