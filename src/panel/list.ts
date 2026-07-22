// SPDX-License-Identifier: AGPL-3.0-or-later
// One rendered annotation row of the panel list, plus its small DOM helpers.
// Split out of main.ts so the list markup can grow (groups, filters) without the
// poll loop growing with it. Runs inside the panel window, bundled by esbuild.
import type { Annotation, PanelCmd, PanelState } from '../types.js';
import { ICONS } from './icons.js';
import { routeKey } from '../util/route.js';

/** The panel's shared view state: what is expanded, and the last rendered key. */
export interface PanelView {
  /** id of the currently expanded item, or `null` */
  expandedId: string | null;
  /** JSON key of the last render; set to `''` to force the next poll to re-render */
  lastKey: string;
}

/**
 * What the renderer needs from the panel shell (main.ts): the shared state and
 * the senders to Node. Injected once at boot rather than imported, so list.ts
 * never has to import back from its own entry point.
 */
export interface ListDeps {
  view: PanelView;
  /** screenshot data-URIs already fetched, keyed `<id>:<before|after>` */
  shots: Map<string, string>;
  /** send a command to the overlay, through Node */
  call: (c: PanelCmd) => void;
  /** re-render now instead of waiting for the next poll */
  tick: () => void;
}

let deps: ListDeps | null = null;

/** Wire the renderer to the panel's state and senders. Called once, at boot. */
export function initList(d: ListDeps): void {
  deps = d;
}

function use(): ListDeps {
  if (!deps) throw new Error('[nit] panel list rendered before initList()');
  return deps;
}

/**
 * Render one annotation row.
 * @param ann the annotation to render
 * @param num its pin number on the current page, or `undefined` when it has none
 * @param s the polled panel state (mode drives which controls appear)
 * @param unplaced whether it is rendered in the "couldn't place" list
 * @returns the row element
 */
export function renderItem(
  ann: Annotation,
  num: number | undefined,
  s: PanelState,
  unplaced: boolean,
): HTMLElement {
  const d = use();
  const it = document.createElement('div');
  it.className = 'nit-item'
    + (unplaced ? ' nit-item--unplaced' : '')
    + (ann.status !== 'open' ? ' nit-item--closed' : '');
  it.dataset.id = ann.id;

  const head = document.createElement('div');
  head.className = 'item-head';
  head.append(
    span('num', num != null ? String(num) : '·'),
    span(ann.type === 'change-request' ? 'badge badge-cr' : 'badge badge-c', ann.type === 'change-request' ? 'CR' : 'C'),
    span('comment', ann.comment),
    span('route-chip', ann.route || '/'),
  );
  if (ann.issueRef) head.append(span('issue-chip nit-issue-chip', ann.issueRef));
  if (s.mode === 'review') {
    const del = document.createElement('button');
    del.className = 'nit-del';
    del.textContent = '×';
    del.addEventListener('click', e => {
      e.stopPropagation();
      try { void window.__nitDelete?.(ann.id); } catch { /* bridge gone */ }
      d.view.lastKey = '';
    });
    head.append(del);
  }
  it.append(head);
  it.addEventListener('click', () => {
    d.view.expandedId = d.view.expandedId === ann.id ? null : ann.id;
    d.view.lastKey = '';
    if (d.view.expandedId) d.call({ cmd: 'focus', id: ann.id });
    d.tick();
  });

  if (d.view.expandedId === ann.id) {
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.append(
      line(`${ann.id} · ${ann.status} · scope ${ann.viewportScope}`),
      line(stamps(ann)),
      line('component: ' + (ann.target?.component || '?')
        + (ann.target?.ngComponent ? ' (' + ann.target.ngComponent + ')' : '')),
    );
    if (ann.target?.selector) meta.append(line('selector: ' + ann.target.selector));
    appendShot(meta, ann.id, 'before', ann.screenshot, ann.screenshotAfter ? 'before' : null);
    appendShot(meta, ann.id, 'after', ann.screenshotAfter, 'after');

    const issueRow = document.createElement('div');
    issueRow.className = 'issue-row';
    issueRow.innerHTML = ICONS.tag;
    const input = document.createElement('input');
    input.className = 'nit-issue';
    input.type = 'text';
    input.placeholder = 'issue ref';
    input.value = ann.issueRef ?? '';
    const commit = (): void => {
      if (input.value.trim() === (ann.issueRef ?? '')) return;
      try { void window.__nitSetIssueRef?.(ann.id, input.value); } catch { /* bridge gone */ }
    };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = ann.issueRef ?? ''; input.blur(); }
    });
    input.addEventListener('blur', commit);
    input.addEventListener('click', e => e.stopPropagation());
    issueRow.append(input);
    meta.append(issueRow);

    const goto = document.createElement('button');
    goto.className = 'btn nit-goto';
    goto.innerHTML = ICONS.externalLink;
    goto.append(document.createTextNode(ann.route || '/'));
    goto.title = `Open ${ann.route || '/'}`;
    // Must agree with __nitGoTo's own "already on this page" rule (bridge.ts) —
    // pathname and search, hash ignored — or the button can refuse a navigation
    // the binding would have happily performed (or vice versa).
    goto.disabled = routeKey(s.route) === routeKey(ann.route);
    goto.addEventListener('click', e => {
      e.stopPropagation();
      try { void window.__nitGoTo?.(ann.id); } catch { /* bridge gone */ }
    });
    meta.append(goto);

    if (s.mode === 'verify' && ann.status === 'fixed') {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:6px;margin-top:6px';
      const ok = document.createElement('button');
      ok.className = 'btn nit-verdict-verified';
      ok.textContent = '✓ Verified';
      ok.addEventListener('click', e => {
        e.stopPropagation();
        try { void window.__nitVerdict?.(ann.id, 'verified'); } catch { /* bridge gone */ }
        d.view.lastKey = '';
      });
      const re = document.createElement('button');
      re.className = 'btn nit-verdict-reopen';
      re.textContent = '↺ Reopen';
      re.addEventListener('click', e => {
        e.stopPropagation();
        try { void window.__nitVerdict?.(ann.id, 'reopened'); } catch { /* bridge gone */ }
        d.view.lastKey = '';
      });
      row.append(ok, re);
      meta.append(row);
    }
    it.append(meta);
  }
  return it;
}

/**
 * Append a screenshot (and its caption) to an expanded item's meta block. The
 * image is fetched through the bridge on first view and cached for the session;
 * an image that cannot be fetched removes itself rather than showing broken.
 * @param meta the meta block to append to
 * @param id the annotation id
 * @param which which shot to fetch
 * @param rel the stored relative path — nothing is appended when it is absent
 * @param caption a caption line to append first, or `null` for none
 */
export function appendShot(
  meta: HTMLElement,
  id: string,
  which: 'before' | 'after',
  rel: string | null | undefined,
  caption: string | null,
): void {
  if (!rel) return;
  const d = use();
  if (caption) meta.append(line(caption + ':'));
  const img = document.createElement('img');
  img.className = 'shot';
  img.alt = id + ' ' + which;
  const key = id + ':' + which;
  const cached = d.shots.get(key);
  if (cached) {
    img.src = cached;
  } else {
    void (async () => {
      let src: string | null = null;
      try { src = (await window.__nitShot?.(id, which === 'after' ? 'after' : undefined)) ?? null; } catch { /* bridge gone */ }
      if (src) {
        d.shots.set(key, src);
        img.src = src;
      } else {
        img.remove();
      }
    })();
  }
  meta.append(img);
}

/** A `<span>` with a class and text — the item head is built from these. */
export function span(cls: string, text: string): HTMLElement {
  const el = document.createElement('span');
  el.className = cls;
  el.textContent = text;
  return el;
}

/** One line of an expanded item's meta block. */
export function line(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'meta-line';
  el.textContent = text;
  return el;
}

/** "created 2026-07-21 14:22 · updated 2026-07-22 09:01 by Kevin" */
function stamps(ann: Annotation): string {
  const parts = [`created ${shortTime(ann.createdAt)}`];
  if (ann.updatedAt) {
    parts.push(`updated ${shortTime(ann.updatedAt)}${ann.updatedBy ? ` by ${ann.updatedBy}` : ''}`);
  }
  return parts.join(' · ');
}

/** ISO timestamp → `2026-07-21 14:22` in local time; the raw value if unparseable. */
function shortTime(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
