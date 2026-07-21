// SPDX-License-Identifier: AGPL-3.0-or-later
// Overlay → Node bridge via page.exposeBinding (SPEC §2.1).
import fs from 'node:fs';
import path from 'node:path';
import { captureElementShot } from '../capture/screenshot.js';
import { captureAfterShots } from './verify.js';
import { safeShotPath } from '../store/store.js';

const SCOPES = ['general', 'desktop', 'mobile'];

/**
 * Expose the `window.__nit*` bindings on the context — the only channel between
 * the injected overlay / panel window and Node. Bindings are context-wide, so
 * every page (site + panel) can call them:
 *  - `__nitSave(payload)`         validate, screenshot, persist an annotation
 *  - `__nitLoad()`                session config + current annotations (overlay boot/resync)
 *  - `__nitSetViewport(mode)`     switch desktop/mobile (panel window excluded)
 *  - `__nitShot(id, which?)`      screenshot as data-uri ('after' for the verify shot)
 *  - `__nitVerdict(id, verdict)`  verify ruling: 'verified' | 'reopened'
 *  - `__nitDelete(id)`            remove annotation + screenshot files
 *  - `__nitFinish()`              flush review and close the session
 *  - `__nitEvent(evt)`            overlay telemetry: clicks (debug), ui state, focus requests
 *  - `__nitPanelState()`          state polled by the panel window
 *  - `__nitPanelCmd(cmd)`         panel → overlay commands, relayed via the site page
 * @param {import('playwright').BrowserContext} context
 * @param {object} session the live session (see startSession in session.js)
 * @returns {Promise<void>}
 */
export async function wireBridge(context, session) {
  const { store } = session;

  // The bindings are exposed context-wide, so the site under review (and any
  // third-party iframe on it) can reach them too. Only accept calls from the top
  // frame of nit's own site/panel pages — arbitrary page/ad JS must not be able
  // to save/delete annotations, force verdicts, or close the session.
  const trusted = source =>
    source
    && source.frame === source.page.mainFrame()
    && (source.page === session.sitePage || source.page === session.panelPage);

  /** Wrap a binding handler so untrusted callers get a rejection, never the action. */
  const guard = handler => (source, ...args) => {
    if (!trusted(source)) return { ok: false, error: 'nit: call rejected (untrusted frame)' };
    return handler(source, ...args);
  };

  await context.exposeBinding('__nitSave', guard(async (source, payload) => {
    const error = validateSave(payload);
    if (error) return { ok: false, error };

    // Reserve the id synchronously (before any await) so concurrent saves can't
    // collide on the same id and overwrite each other.
    const id = store.nextId();
    const viewport = source.page.viewportSize() || { width: 0, height: 0 };
    const annotation = {
      id,
      type: payload.type === 'comment' ? 'comment' : 'change-request',
      comment: String(payload.comment).trim(),
      status: 'open',
      author: session.author,
      viewportScope: SCOPES.includes(payload.viewportScope) ? payload.viewportScope : session.viewportMode,
      viewport: { mode: session.viewportMode, w: viewport.width, h: viewport.height },
      route: typeof payload.route === 'string' && payload.route ? payload.route : '/',
      target: payload.target,
      screenshot: null,
      createdAt: new Date().toISOString(),
    };
    store.upsert(annotation); // claim the id immediately

    if (payload.target.rect) {
      try {
        const shotFile = store.shotPath(id);
        await captureElementShot(source.page, payload.target.rect, shotFile);
        annotation.screenshot = `shots/${path.basename(shotFile)}`;
      } catch (e) {
        session.log(`! screenshot failed for ${id}: ${e.message}`);
      }
    }

    store.upsert(annotation);
    session.flush();
    session.log(`+ ${annotation.type} ${id} [${annotation.viewportScope}] ${annotation.comment.slice(0, 70)}`);
    return { ok: true, annotation };
  }));

  await context.exposeBinding('__nitLoad', guard(async () => ({
    mode: session.mode,
    author: session.author,
    viewportMode: session.viewportMode,
    debug: !!session.debug,
    annotations: store.annotations,
  })));

  await context.exposeBinding('__nitSetViewport', guard(async (source, mode) => session.setViewport(mode)));

  await context.exposeBinding('__nitShot', guard(async (source, id, which) => {
    const ann = store.annotations.find(a => a.id === id);
    const rel = which === 'after' ? ann?.screenshotAfter : ann?.screenshot;
    const abs = safeShotPath(store.dir, rel);
    if (!abs) return null;
    try {
      return `data:image/png;base64,${fs.readFileSync(abs).toString('base64')}`;
    } catch {
      return null;
    }
  }));

  await context.exposeBinding('__nitVerdict', guard(async (source, id, verdict) => {
    if (verdict !== 'verified' && verdict !== 'reopened') {
      return { ok: false, error: 'verdict must be "verified" or "reopened"' };
    }
    const ann = store.annotations.find(a => a.id === id);
    if (!ann) return { ok: false, error: `no annotation ${id}` };
    ann.status = verdict;
    ann.verifiedAt = new Date().toISOString();
    session.flush();
    session.log(`${verdict === 'verified' ? '+ verified' : '~ reopened'} ${id}`);
    return { ok: true, annotation: ann };
  }));

  await context.exposeBinding('__nitDelete', guard(async (source, id) => {
    const ok = store.remove(id);
    if (ok) {
      session.flush();
      session.log(`- deleted ${id}`);
    }
    return { ok };
  }));

  await context.exposeBinding('__nitFinish', guard(async () => {
    session.flush();
    session.log(`review written to ${store.dir}`);
    setTimeout(() => session.close().catch(() => {}), 100);
    return { ok: true };
  }));

  await context.exposeBinding('__nitEvent', guard(async (source, evt) => {
    if (!evt || typeof evt !== 'object') return;
    if (evt.type === 'click') {
      session.log(`overlay: click at ${evt.x},${evt.y} on <${evt.tag}>`);
    } else if (evt.type === 'ui') {
      session.uiState = {
        route: evt.route,
        picking: Boolean(evt.picking),
        showAll: Boolean(evt.showAll),
        placed: Array.isArray(evt.placed) ? evt.placed : [],
        unplaced: Array.isArray(evt.unplaced) ? evt.unplaced : [],
      };
      if (session.mode === 'verify') {
        await captureAfterShots(session, source.page, evt)
          .catch(e => session.log(`! after-shot capture failed: ${e.message}`));
      }
    } else if (evt.type === 'focus' && session.panelPage) {
      await session.panelPage
        .evaluate(id => window.__nitPanelFocus && window.__nitPanelFocus(id), evt.id)
        .catch(() => {});
    }
    session.onEvent?.(evt);
  }));

  // ---- panel window support ----

  await context.exposeBinding('__nitPanelState', guard(async () => ({
    mode: session.mode,
    author: session.author,
    viewportMode: session.viewportMode,
    picking: session.uiState.picking || false,
    showAll: session.uiState.showAll ?? (session.mode !== 'view'),
    route: session.uiState.route || '/',
    placed: (session.uiState.placed || []).map(p => (typeof p === 'string' ? p : p.id)),
    unplaced: session.uiState.unplaced || [],
    annotations: store.annotations,
  })));

  await context.exposeBinding('__nitPanelCmd', guard(async (source, cmd) => {
    const page = session.sitePage;
    if (!page) return { ok: false, error: 'no site page' };
    try {
      await page.evaluate(c => window.__nitOverlay && window.__nitOverlay.cmd(c), cmd);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }));
}

function validateSave(p) {
  if (!p || typeof p !== 'object') return 'payload must be an object';
  if (!p.comment || !String(p.comment).trim()) return 'comment is required';
  if (!p.target || typeof p.target !== 'object') return 'target is required';
  return null;
}
