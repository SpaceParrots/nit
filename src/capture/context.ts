// SPDX-License-Identifier: AGPL-3.0-or-later
// Detect whether a picked element lives inside a modal/dialog/drawer surface.
// Pure DOM-method walks over a small member set (tagName, getAttribute,
// classList.contains, parentElement, querySelector, textContent,
// ownerDocument.getElementById) so the unit tests can fake elements — keep it
// that way. Runs inside the inspected page (bundled into the overlay); never throws.

const MAX_LABEL = 60;

/** class names of common overlay containers (Angular CDK, Bootstrap) */
const DIALOG_CLASSES = ['cdk-overlay-pane', 'modal', 'offcanvas'];

/** A dialog-like ancestor of a picked element. */
export interface DialogContainer {
  container: Element;
  /** aria-label → resolved aria-labelledby → first heading text; null when unnamed */
  label: string | null;
}

/**
 * Nearest ancestor (incl. self) that is a dialog-like container: `<dialog>`,
 * `role=dialog|alertdialog`, `aria-modal=true`, or a known overlay class.
 * @returns the container and its human-readable label, or null on a plain page
 */
export function detectDialog(el: Element): DialogContainer | null {
  for (let n: Element | null = el; n && n.nodeType === 1; n = n.parentElement) {
    if (isDialogContainer(n)) return { container: n, label: dialogLabel(n) };
  }
  return null;
}

function isDialogContainer(n: Element): boolean {
  if (n.tagName === 'DIALOG') return true;
  const role = n.getAttribute('role');
  if (role === 'dialog' || role === 'alertdialog') return true;
  if (n.getAttribute('aria-modal') === 'true') return true;
  return DIALOG_CLASSES.some(c => n.classList.contains(c));
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
