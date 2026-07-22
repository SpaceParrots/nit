// SPDX-License-Identifier: AGPL-3.0-or-later
// The nit panel UI. Bundled by esbuild (iife) and injected into the panel window
// after its shell document loads — the same pattern inject.ts uses for the overlay.
// It only talks to Node through the `window.__nit*` bindings; the site page is
// never touched from here.
import css from './panel.css';
import { initList, renderItem } from './list.js';
import type { PanelView } from './list.js';
import { ICONS } from './icons.js';
import { groupAnnotations, defaultExpanded } from './filter.js';
import type { FilterOptions, GroupKey, SortKey } from './filter.js';
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

let opts: FilterOptions = { sort: 'time', group: 'page' };
/** group keys the user has explicitly toggled away from their default */
const toggledGroups = new Set<string>();
let menuOpen = false;
/** the last state we rendered — lets a menu interaction repaint without waiting a tick */
let lastState: PanelState | null = null;

initList({ view, shots: shotCache, call, tick: () => void tick() });

const filterBtn = $('#filter-btn');
const filterMenu = $('#filter-menu');

$('#pick').addEventListener('click', () => call({ cmd: 'togglePick' }));
$('#finish').addEventListener('click', () => finish());
for (const b of document.querySelectorAll<HTMLElement>('[data-vp]')) {
  b.addEventListener('click', () => setViewport(viewportOf(b)));
}
filterBtn.addEventListener('click', () => setMenuOpen(filterMenu.hidden));

document.addEventListener('click', e => {
  if (!menuOpen) return;
  const t = e.target;
  if (t instanceof Node && (filterMenu.contains(t) || filterBtn.contains(t))) return;
  setMenuOpen(false);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && menuOpen) setMenuOpen(false);
});

/** Open or close the filter dropdown, keeping `menuOpen` and the DOM in sync. */
function setMenuOpen(open: boolean): void {
  menuOpen = open;
  filterMenu.hidden = !open;
  filterBtn.setAttribute('aria-expanded', String(open));
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
  // A wholesale repaint mid-typing would steal the caret from the issue input and
  // close the dropdown. Skip; the next tick after focus leaves picks the state up.
  const active = document.activeElement;
  if (menuOpen || active?.tagName === 'INPUT') return;
  let s: PanelState | undefined;
  try { s = await window.__nitPanelState(); } catch { return; }
  if (!s) return;
  const key = JSON.stringify([s, view.expandedId, opts, [...toggledGroups], menuOpen]);
  if (key === view.lastKey) return;
  view.lastKey = key;
  render(s);
}

/** Paint the whole panel from a state snapshot. */
function render(s: PanelState): void {
  lastState = s;
  $('#mode').textContent = s.mode === 'view' ? 'replay' : s.mode === 'verify' ? 'verify' : 'review';
  $('#pick').hidden = s.mode !== 'review';
  $('#finish').hidden = s.mode !== 'review';
  $('#pick').classList.toggle('active', Boolean(s.picking));
  $('#pick-label').textContent = s.picking ? 'Picking… (Esc to stop)' : 'Pick element';
  document.querySelectorAll<HTMLElement>('[data-vp]').forEach(b =>
    b.classList.toggle('active', s.viewportMode === b.dataset.vp));

  const actionable = s.annotations.filter(
    a => a.type === 'change-request' && (a.status === 'open' || a.status === 'reopened'),
  ).length;
  $('#count').textContent = `${s.annotations.length} annotation${s.annotations.length === 1 ? '' : 's'} · ${actionable} actionable`;

  filterMenu.innerHTML = '';
  const scope = document.createElement('label');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.className = 'nit-filter';
  box.checked = !s.showAll;
  box.addEventListener('change', () => { call({ cmd: 'toggleShowAll' }); view.lastKey = ''; });
  scope.append(box, document.createTextNode(`Only general + ${s.viewportMode}`));

  const sortRow = radioRow('Sort', 'nit-sort', 'sort',
    [['time', 'Time'], ['page', 'Page'], ['state', 'State']], opts.sort, v => {
      opts = { ...opts, sort: v as SortKey };
      view.lastKey = '';
      if (lastState) render(lastState);
    });
  const groupRow = radioRow('Group by', 'nit-group-by', 'group',
    [['none', 'None'], ['page', 'Page'], ['state', 'State']], opts.group, v => {
      opts = { ...opts, group: v as GroupKey };
      toggledGroups.clear();
      view.lastKey = '';
      if (lastState) render(lastState);
    });
  filterMenu.append(sortRow, hr(), groupRow, hr(), scope);

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
  const groups = groupAnnotations(listed, opts, s.route || '/');
  for (const g of groups) {
    if (!g.key) {
      for (const ann of g.items) list.append(renderItem(ann, placedIndex.get(ann.id), s, false));
      continue;
    }
    const open = toggledGroups.has(g.key)
      ? !defaultExpanded(g.key, opts, s.route || '/')
      : defaultExpanded(g.key, opts, s.route || '/');
    const section = document.createElement('div');
    section.className = 'nit-group' + (open ? '' : ' nit-group--collapsed');
    section.dataset.group = g.key;
    const head = document.createElement('button');
    head.className = 'nit-group-head';
    head.innerHTML = ICONS.chevronRight;
    head.append(document.createTextNode(`${g.label} (${g.items.length})`));
    head.addEventListener('click', () => {
      if (toggledGroups.has(g.key)) toggledGroups.delete(g.key);
      else toggledGroups.add(g.key);
      view.lastKey = '';
      render(s);
    });
    section.append(head);
    if (open) for (const ann of g.items) section.append(renderItem(ann, placedIndex.get(ann.id), s, false));
    list.append(section);
  }

  const un = s.annotations.filter(a => unplacedSet.has(a.id));
  $('#unplaced').hidden = un.length === 0;
  $('#unplaced-head').textContent = 'Couldn\'t place on this page (' + un.length + ')';
  const ul = $('#unplaced-list');
  ul.innerHTML = '';
  for (const ann of un) ul.append(renderItem(ann, undefined, s, true));
}

/** A labelled row of mutually exclusive buttons. */
function radioRow(
  title: string,
  cls: string,
  dataKey: string,
  choices: readonly (readonly [string, string])[],
  active: string,
  onPick: (value: string) => void,
): HTMLElement {
  const wrap = document.createElement('div');
  const head = document.createElement('div');
  head.className = 'menu-head';
  head.textContent = title;
  const row = document.createElement('div');
  row.className = 'menu-row';
  for (const [value, label] of choices) {
    const b = document.createElement('button');
    b.className = `btn ${cls}`;
    b.dataset[dataKey] = value;
    b.textContent = label;
    b.classList.toggle('active', value === active);
    b.addEventListener('click', () => onPick(value));
    row.append(b);
  }
  wrap.append(head, row);
  return wrap;
}

/** A thin divider between menu sections. */
function hr(): HTMLElement {
  return document.createElement('hr');
}
