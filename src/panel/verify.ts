// SPDX-License-Identifier: AGPL-3.0-or-later
// DOM rendering of the verify-mode queue card: progress header, the current
// item with its before/after shots, and the always-visible verdict row. All
// annotation-derived text goes through textContent — comments, routes and ids
// come from annotations.json and are untrusted. The queue math itself lives in
// verify-queue.ts; main.ts wires the two together in verify mode.
import type { Annotation, PanelState } from '../types.js';
import type { VerifyQueueResult } from './verify-queue.js';
import { appendShot, span } from './list.js';
import { afterShotFor, wantedAfterModes } from '../util/after-shots.js';

/**
 * What the card needs from the panel shell (main.ts). The screenshot cache is
 * not passed here — `appendShot` already closes over the shared cache through
 * `initList`, so the card reuses the exact images the list fetched.
 */
export interface VerifyDeps {
  /** add an id to the session-local skip set (main.ts owns the set) */
  onSkip: (id: string) => void;
  /** force an immediate repaint after a ruling (`view.lastKey = ''` + tick) */
  repaint: () => void;
}

/**
 * Render the verify queue card into `host`, replacing whatever was there.
 * @param host the `#verify` container from the shell
 * @param s the polled panel state
 * @param q the computed queue snapshot
 * @param skipped the session-local skip set (for the done-state summary)
 * @param placedIndex pin numbers on the current page, as main.ts builds them
 * @param deps the shell callbacks
 */
export function renderVerifyCard(
  host: HTMLElement,
  s: PanelState,
  q: VerifyQueueResult,
  skipped: ReadonlySet<string>,
  placedIndex: ReadonlyMap<string, number>,
  deps: VerifyDeps,
): void {
  host.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'nit-vq';

  const ruled = q.ruled.verified + q.ruled.reopened;
  const head = document.createElement('div');
  head.className = 'vq-head';
  head.textContent = `Verify fixes — ${ruled} of ${q.total} ruled`;

  const bar = document.createElement('div');
  bar.className = 'vq-bar';
  const fill = document.createElement('div');
  fill.className = 'vq-fill';
  fill.style.width = q.total > 0 ? `${Math.round((ruled / q.total) * 100)}%` : '0%';
  bar.append(fill);
  card.append(head, bar);

  if (q.total === 0) {
    card.append(statusLine('Nothing to verify yet — the agent has not marked any annotation fixed.'));
  } else if (q.currentId) {
    const ann = s.annotations.find(a => a.id === q.currentId);
    if (ann) card.append(currentItem(ann, s, placedIndex, deps));
  } else {
    // Skipped items keep status 'fixed', so they are what remains in the queue
    // once done — exactly the count the summary owes the reviewer.
    const stillSkipped = q.queue.filter(id => skipped.has(id)).length;
    card.append(statusLine('All fixed items ruled — '
      + `${q.ruled.verified} verified · ${q.ruled.reopened} reopened · ${stillSkipped} skipped`));
  }
  host.append(card);
}

/** The current queue item: head, shots, verdict row, and the reopen-note row. */
function currentItem(
  ann: Annotation,
  s: PanelState,
  placedIndex: ReadonlyMap<string, number>,
  deps: VerifyDeps,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'vq-item';

  const num = placedIndex.get(ann.id);
  const head = document.createElement('div');
  head.className = 'item-head';
  head.append(
    span('num', num != null ? String(num) : '·'),
    span('comment', ann.comment),
    span('route-chip', ann.route || '/'),
  );
  wrap.append(head);

  if ((s.unplaced || []).includes(ann.id)) {
    wrap.append(statusLine('element couldn\'t be re-found — showing the originally recorded region', 'vq-unplaced'));
  }

  const shots = document.createElement('div');
  shots.className = 'vq-shots';
  // `viewport.mode` comes from a hand-editable file — only a recognized mode
  // earns a caption suffix; anything else degrades to the bare "before" label.
  const beforeMode = ann.viewport?.mode;
  const beforeCaption = beforeMode === 'desktop' || beforeMode === 'mobile'
    ? `before · ${beforeMode}` : 'before';
  appendShot(shots, ann.id, 'before', ann.screenshot, beforeCaption);
  // One after-slot per wanted viewport, primary first: a captured shot renders
  // captioned with its mode; a missing one pulses until the capture side (or
  // the auto viewport switch in main.ts) fills it in on a later poll.
  for (const mode of wantedAfterModes(ann)) {
    const rel = afterShotFor(ann, mode);
    if (rel) {
      appendShot(shots, ann.id, `after-${mode}`, rel, `after · ${mode}`);
    } else {
      shots.append(statusLine(`capturing after-shot (${mode})…`, 'vq-capturing'));
    }
  }
  wrap.append(shots);

  // The reopen-note row lives below the verdict row and stays hidden until the
  // Reopen button reveals it. Revealing also focuses the input, which engages
  // main.ts's editor guard (the nit-vq-note class) and pauses the poll loop —
  // otherwise the next tick would repaint the card and eat the half-typed note.
  const noteRow = document.createElement('div');
  noteRow.className = 'vq-note-row';
  noteRow.hidden = true;
  const note = document.createElement('input');
  note.className = 'nit-vq-note';
  note.type = 'text';
  note.placeholder = 'why is it not fixed? (optional)';
  const confirmReopen = (): void => {
    const value = note.value.trim();
    try { void window.__nitVerdict?.(ann.id, 'reopened', value || undefined); } catch { /* bridge gone */ }
    note.blur();
    deps.repaint();
  };
  const cancelReopen = (): void => {
    note.value = '';
    noteRow.hidden = true;
    note.blur();
  };
  note.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); confirmReopen(); }
    if (e.key === 'Escape') cancelReopen();
  });
  const confirm = document.createElement('button');
  confirm.className = 'btn nit-vq-note-confirm';
  confirm.textContent = 'Reopen';
  confirm.addEventListener('click', confirmReopen);
  const cancel = document.createElement('button');
  cancel.className = 'btn nit-vq-note-cancel';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', cancelReopen);
  noteRow.append(note, confirm, cancel);

  const actions = document.createElement('div');
  actions.className = 'vq-actions';
  const ok = document.createElement('button');
  ok.className = 'btn nit-vq-verified';
  ok.textContent = '✓ Verified';
  ok.addEventListener('click', () => {
    try { void window.__nitVerdict?.(ann.id, 'verified'); } catch { /* bridge gone */ }
    deps.repaint();
  });
  const re = document.createElement('button');
  re.className = 'btn nit-vq-reopen';
  re.textContent = '↺ Reopen';
  re.addEventListener('click', () => {
    noteRow.hidden = false;
    note.focus();
  });
  const skip = document.createElement('button');
  skip.className = 'btn nit-vq-skip';
  skip.textContent = 'Skip →';
  skip.addEventListener('click', () => deps.onSkip(ann.id));
  actions.append(ok, re, skip);
  wrap.append(actions, noteRow);
  return wrap;
}

/** One muted status line of the card (empty, done, capturing, unplaced note). */
function statusLine(text: string, cls = ''): HTMLElement {
  const el = document.createElement('div');
  el.className = 'vq-status' + (cls ? ` ${cls}` : '');
  el.textContent = text;
  return el;
}
