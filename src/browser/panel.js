// SPDX-License-Identifier: AGPL-3.0-or-later
// The nit panel: a separate popup window (devtools-style, docked next to the browser
// window) hosting the annotation list and session controls. It is our own page, so it
// never overlays or competes with the site under review — important on mobile viewports.
// It talks to Node through the same context-wide bindings as the overlay.

/**
 * Open the panel as a popup window docked next to the browser window and load
 * its self-contained UI. The popup approach (vs. a tab) is what gives nit a
 * devtools-like layout without overlaying the site under review.
 * @param {import('playwright').BrowserContext} context
 * @param {import('playwright').Page} sitePage the page under review (opens the popup, provides window geometry)
 * @param {object} session the live session; `session.panelPage` is cleared when the user closes the panel
 * @returns {Promise<import('playwright').Page>} the panel page
 */
export async function openPanel(context, sitePage, session) {
  const [panel] = await Promise.all([
    context.waitForEvent('page', { timeout: 8000 }),
    sitePage.evaluate(() => {
      window.open(
        'about:blank',
        'nit-panel',
        `width=360,height=${Math.max(600, window.outerHeight || 900)},` +
        `left=${(window.screenX || 0) + (window.outerWidth || 1200) + 8},top=${window.screenY || 0}`,
      );
    }),
  ]);
  await panel.setViewportSize({ width: 344, height: 860 }).catch(() => {});
  await panel.setContent(panelHtml(), { waitUntil: 'domcontentloaded' });
  panel.on('close', () => {
    if (session.panelPage === panel) session.panelPage = null;
  });
  return panel;
}

function panelHtml() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>nit panel</title>
<style>
  :root {
    --bg: #1c1c1e; --fg: #f5f5f7; --muted: #9a9aa2; --accent: #ffcc00;
    --accent-fg: #1c1c1e; --comment: #6ec1ff; --border: #3a3a3e;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  [hidden] { display: none !important; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: var(--bg); color: var(--fg); font-size: 13px;
    display: flex; flex-direction: column; height: 100vh; overflow: hidden;
  }
  header { display: flex; align-items: baseline; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--border); }
  .logo { font-weight: 800; font-size: 15px; color: var(--accent); }
  .mode { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
  .controls { display: flex; flex-direction: column; gap: 6px; padding: 10px 14px; border-bottom: 1px solid var(--border); }
  .vp { display: flex; gap: 6px; }
  .vp .btn { flex: 1; }
  .btn {
    background: #2a2a2e; color: var(--fg); border: 1px solid var(--border);
    border-radius: 6px; font-size: 12px; padding: 7px 10px; cursor: pointer;
  }
  .btn:hover { border-color: var(--muted); }
  .btn.active { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); font-weight: 600; }
  .list { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 6px; }
  .empty { color: var(--muted); font-size: 12px; text-align: center; padding: 16px 8px; }
  .nit-item {
    background: #26262a; border: 1px solid var(--border); border-radius: 8px;
    padding: 8px; cursor: pointer; font-size: 12px;
  }
  .nit-item--closed { opacity: 0.55; }
  .nit-item--unplaced { border-style: dashed; }
  .item-head { display: flex; align-items: flex-start; gap: 6px; }
  .num {
    flex: none; width: 18px; height: 18px; border-radius: 50%; background: #3a3a3e;
    font-size: 10px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center;
  }
  .badge { flex: none; font-size: 9px; font-weight: 700; border-radius: 4px; padding: 2px 5px; margin-top: 1px; }
  .badge-cr { background: var(--accent); color: var(--accent-fg); }
  .badge-c { background: var(--comment); color: var(--accent-fg); }
  .comment { flex: 1; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .route-chip { flex: none; color: var(--muted); font-size: 10px; margin-top: 2px; max-width: 70px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .nit-del { flex: none; background: none; border: none; color: var(--muted); font-size: 14px; cursor: pointer; padding: 0 2px; }
  .nit-del:hover { color: #ff5f57; }
  .meta { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 4px; }
  .meta-line { font-size: 11px; color: var(--muted); word-break: break-all; }
  .shot { max-width: 100%; border-radius: 6px; border: 1px solid var(--border); }
  .unplaced { border-top: 1px solid var(--border); padding: 10px; max-height: 34%; overflow-y: auto; }
  .unplaced-head { font-size: 11px; color: var(--muted); margin-bottom: 6px; }
  .unplaced .nit-item { margin-bottom: 6px; }
</style>
</head>
<body>
<header><span class="logo">nit</span><span class="mode" id="mode"></span></header>
<div class="controls">
  <button id="pick" class="btn nit-pick">Pick element (Alt)</button>
  <div class="vp">
    <button class="btn nit-vp-desktop" data-vp="desktop">Desktop</button>
    <button class="btn nit-vp-mobile" data-vp="mobile">Mobile</button>
  </div>
  <button id="filter" class="btn nit-filter"></button>
  <button id="finish" class="btn nit-finish">Finish review</button>
</div>
<div id="list" class="list"></div>
<div id="unplaced" class="unplaced" hidden>
  <div class="unplaced-head" id="unplaced-head"></div>
  <div id="unplaced-list"></div>
</div>
<script>
(() => {
  const $ = s => document.querySelector(s);
  let expandedId = null;
  let lastKey = '';
  const shotCache = new Map();

  $('#pick').addEventListener('click', () => call('__nitPanelCmd', { cmd: 'togglePick' }));
  $('#filter').addEventListener('click', () => call('__nitPanelCmd', { cmd: 'toggleShowAll' }));
  $('#finish').addEventListener('click', () => call('__nitFinish'));
  document.querySelectorAll('[data-vp]').forEach(b =>
    b.addEventListener('click', () => call('__nitSetViewport', b.dataset.vp)));

  window.__nitPanelFocus = id => { expandedId = id; lastKey = ''; };

  function call(name, arg) {
    try { return window[name] ? window[name](arg) : null; } catch (e) { return null; }
  }

  async function tick() {
    if (typeof window.__nitPanelState !== 'function') return;
    let s;
    try { s = await window.__nitPanelState(); } catch { return; }
    if (!s) return;
    const key = JSON.stringify([s, expandedId]);
    if (key === lastKey) return;
    lastKey = key;
    render(s);
  }
  setInterval(tick, 600);
  tick();

  function render(s) {
    $('#mode').textContent = s.mode === 'view' ? 'replay' : s.mode === 'verify' ? 'verify' : 'review';
    $('#pick').hidden = s.mode !== 'review';
    $('#finish').hidden = s.mode !== 'review';
    $('#pick').classList.toggle('active', Boolean(s.picking));
    $('#pick').textContent = s.picking ? 'Picking… (Esc to stop)' : 'Pick element (Alt)';
    document.querySelectorAll('[data-vp]').forEach(b =>
      b.classList.toggle('active', s.viewportMode === b.dataset.vp));
    $('#filter').textContent = s.showAll ? 'Showing: all scopes' : 'Showing: general + ' + s.viewportMode;
    $('#filter').classList.toggle('active', Boolean(s.showAll));

    const placedIndex = new Map();
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
    for (const ann of listed) list.append(item(ann, placedIndex.get(ann.id), s, false));

    const un = s.annotations.filter(a => unplacedSet.has(a.id));
    $('#unplaced').hidden = un.length === 0;
    $('#unplaced-head').textContent = "Couldn't place on this page (" + un.length + ')';
    const ul = $('#unplaced-list');
    ul.innerHTML = '';
    for (const ann of un) ul.append(item(ann, null, s, true));
  }

  function item(ann, num, s, unplaced) {
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
    if (s.mode === 'review') {
      const del = document.createElement('button');
      del.className = 'nit-del';
      del.textContent = '\\u00d7';
      del.addEventListener('click', e => {
        e.stopPropagation();
        call('__nitDelete', ann.id);
        lastKey = '';
      });
      head.append(del);
    }
    it.append(head);
    it.addEventListener('click', () => {
      expandedId = expandedId === ann.id ? null : ann.id;
      lastKey = '';
      if (expandedId) call('__nitPanelCmd', { cmd: 'focus', id: ann.id });
      tick();
    });

    if (expandedId === ann.id) {
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.append(
        line(ann.id + ' \\u00b7 ' + ann.status + ' \\u00b7 scope ' + ann.viewportScope + ' \\u00b7 ' + (ann.route || '/')),
        line('component: ' + ((ann.target && ann.target.component) || '?')
          + ((ann.target && ann.target.ngComponent) ? ' (' + ann.target.ngComponent + ')' : '')),
      );
      if (ann.target && ann.target.selector) meta.append(line('selector: ' + ann.target.selector));
      appendShot(meta, ann.id, 'before', ann.screenshot, ann.screenshotAfter ? 'before' : null);
      appendShot(meta, ann.id, 'after', ann.screenshotAfter, 'after');
      if (s.mode === 'verify' && ann.status === 'fixed') {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:6px;margin-top:6px';
        const ok = document.createElement('button');
        ok.className = 'btn nit-verdict-verified';
        ok.textContent = '\\u2713 Verified';
        ok.addEventListener('click', e => {
          e.stopPropagation();
          try { window.__nitVerdict(ann.id, 'verified'); } catch {}
          lastKey = '';
        });
        const re = document.createElement('button');
        re.className = 'btn nit-verdict-reopen';
        re.textContent = '\\u21ba Reopen';
        re.addEventListener('click', e => {
          e.stopPropagation();
          try { window.__nitVerdict(ann.id, 'reopened'); } catch {}
          lastKey = '';
        });
        row.append(ok, re);
        meta.append(row);
      }
      it.append(meta);
    }
    return it;
  }

  function appendShot(meta, id, which, rel, caption) {
    if (!rel) return;
    if (caption) meta.append(line(caption + ':'));
    const img = document.createElement('img');
    img.className = 'shot';
    img.alt = id + ' ' + which;
    const key = id + ':' + which;
    if (shotCache.has(key)) {
      img.src = shotCache.get(key);
    } else {
      Promise.resolve((() => {
        try { return window.__nitShot(id, which === 'after' ? 'after' : undefined); } catch { return null; }
      })()).then(src => {
        if (src) { shotCache.set(key, src); img.src = src; } else img.remove();
      }).catch(() => img.remove());
    }
    meta.append(img);
  }

  function span(cls, text) {
    const el = document.createElement('span');
    el.className = cls;
    el.textContent = text;
    return el;
  }
  function line(text) {
    const el = document.createElement('div');
    el.className = 'meta-line';
    el.textContent = text;
    return el;
  }
})();
</script>
</body>
</html>`;
}
