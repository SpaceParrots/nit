// SPDX-License-Identifier: AGPL-3.0-or-later
// The nit panel UI. Bundled by esbuild (iife) and injected into the panel window
// after its shell document loads — the same pattern inject.ts uses for the overlay.
// It only talks to Node through the `window.__nit*` bindings; the site page is
// never touched from here.
import css from './panel.css';
import { initList, renderItem } from './list.js';
import type { PanelView } from './list.js';
import type { PanelCmd, PanelState, ViewportMode } from '../types.js';

const TICK_MS = 600;

const style = document.createElement('style');
style.textContent = css;
document.head.append(style);

/** Typed query helper — the panel owns its own markup, so the assertion is safe. */
const $ = <T extends HTMLElement = HTMLElement>(sel: string): T =>
  document.querySelector<T>(sel)!;

const view: PanelView = { expandedId: null, lastKey: '' };
const shotCache = new Map<string, string>();

initList({ view, shots: shotCache, call, tick: () => void tick() });

$('#pick').addEventListener('click', () => call({ cmd: 'togglePick' }));
$('#filter').addEventListener('click', () => call({ cmd: 'toggleShowAll' }));
$('#finish').addEventListener('click', () => finish());
for (const b of document.querySelectorAll<HTMLElement>('[data-vp]')) {
  b.addEventListener('click', () => setViewport(viewportOf(b)));
}

// Node calls this when the overlay reports a focus request from the page.
window.__nitPanelFocus = (id: string): void => {
  view.expandedId = id;
  view.lastKey = '';
};

setInterval(() => void tick(), TICK_MS);
void tick();

/** Send a command to the overlay through Node; a dead bridge is not an error. */
function call(c: PanelCmd): void {
  try { void window.__nitPanelCmd?.(c); } catch { /* bridge gone */ }
}

/** End the session from the panel. Not a `PanelCmd` — its own binding. */
function finish(): void {
  try { void window.__nitFinish?.(); } catch { /* bridge gone */ }
}

/** Switch the site page's viewport preset. Not a `PanelCmd` — its own binding. */
function setViewport(mode: ViewportMode | null): void {
  if (!mode) return;
  try { void window.__nitSetViewport?.(mode); } catch { /* bridge gone */ }
}

/** Read a viewport button's `data-vp`, narrowed to the two presets we render. */
function viewportOf(b: HTMLElement): ViewportMode | null {
  const vp = b.dataset.vp;
  return vp === 'desktop' || vp === 'mobile' ? vp : null;
}

/**
 * Poll Node for the session state and re-render when anything the panel shows
 * has changed. The state key includes the expanded item so opening a row
 * repaints even though the session itself did not change.
 */
async function tick(): Promise<void> {
  if (typeof window.__nitPanelState !== 'function') return;
  let s: PanelState | undefined;
  try { s = await window.__nitPanelState(); } catch { return; }
  if (!s) return;
  const key = JSON.stringify([s, view.expandedId]);
  if (key === view.lastKey) return;
  view.lastKey = key;
  render(s);
}

/** Paint the whole panel from a state snapshot. */
function render(s: PanelState): void {
  $('#mode').textContent = s.mode === 'view' ? 'replay' : s.mode === 'verify' ? 'verify' : 'review';
  $('#pick').hidden = s.mode !== 'review';
  $('#finish').hidden = s.mode !== 'review';
  $('#pick').classList.toggle('active', Boolean(s.picking));
  $('#pick').textContent = s.picking ? 'Picking… (Esc to stop)' : 'Pick element (Alt)';
  document.querySelectorAll<HTMLElement>('[data-vp]').forEach(b =>
    b.classList.toggle('active', s.viewportMode === b.dataset.vp));
  $('#filter').textContent = s.showAll ? 'Showing: all scopes' : 'Showing: general + ' + s.viewportMode;
  $('#filter').classList.toggle('active', Boolean(s.showAll));

  const placedIndex = new Map<string, number>();
  (s.placed || []).forEach((id, i) => placedIndex.set(id, i + 1));
  const unplacedSet = new Set(s.unplaced || []);

  const list = $('#list');
  list.innerHTML = '';
  const listed = s.annotations.filter(a => !unplacedSet.has(a.id));
  if (!listed.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = s.mode === 'review'
      ? 'Press Alt in the page (or the nit chip), click an element, describe the change.'
      : 'No annotations for this view.';
    list.append(empty);
  }
  for (const ann of listed) list.append(renderItem(ann, placedIndex.get(ann.id), s, false));

  const un = s.annotations.filter(a => unplacedSet.has(a.id));
  $('#unplaced').hidden = un.length === 0;
  $('#unplaced-head').textContent = 'Couldn\'t place on this page (' + un.length + ')';
  const ul = $('#unplaced-list');
  ul.innerHTML = '';
  for (const ann of un) ul.append(renderItem(ann, undefined, s, true));
}
