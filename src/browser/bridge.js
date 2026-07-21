// Overlay → Node bridge via page.exposeBinding (SPEC §2.1).
import fs from 'node:fs';
import path from 'node:path';
import { captureElementShot } from '../capture/screenshot.js';

const SCOPES = ['general', 'desktop', 'mobile'];

export async function wireBridge(context, session) {
  const { store } = session;

  await context.exposeBinding('__nitSave', async (source, payload) => {
    const error = validateSave(payload);
    if (error) return { ok: false, error };

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
  });

  await context.exposeBinding('__nitLoad', async () => ({
    mode: session.mode,
    author: session.author,
    viewportMode: session.viewportMode,
    debug: !!session.debug,
    annotations: store.annotations,
  }));

  await context.exposeBinding('__nitSetViewport', async (source, mode) => session.setViewport(mode));

  await context.exposeBinding('__nitShot', async (source, id) => {
    const ann = store.annotations.find(a => a.id === id);
    if (!ann || !ann.screenshot) return null;
    try {
      const buf = fs.readFileSync(path.join(store.dir, ann.screenshot));
      return `data:image/png;base64,${buf.toString('base64')}`;
    } catch {
      return null;
    }
  });

  await context.exposeBinding('__nitDelete', async (source, id) => {
    const ok = store.remove(id);
    if (ok) {
      session.flush();
      session.log(`- deleted ${id}`);
    }
    return { ok };
  });

  await context.exposeBinding('__nitFinish', async () => {
    session.flush();
    session.log(`review written to ${store.dir}`);
    setTimeout(() => session.close().catch(() => {}), 100);
    return { ok: true };
  });

  await context.exposeBinding('__nitEvent', async (source, evt) => {
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
    } else if (evt.type === 'focus' && session.panelPage) {
      await session.panelPage
        .evaluate(id => window.__nitPanelFocus && window.__nitPanelFocus(id), evt.id)
        .catch(() => {});
    }
    session.onEvent?.(evt);
  });

  // ---- panel window support ----

  await context.exposeBinding('__nitPanelState', async () => ({
    mode: session.mode,
    author: session.author,
    viewportMode: session.viewportMode,
    picking: session.uiState.picking || false,
    showAll: session.uiState.showAll ?? (session.mode !== 'view'),
    route: session.uiState.route || '/',
    placed: session.uiState.placed || [],
    unplaced: session.uiState.unplaced || [],
    annotations: store.annotations,
  }));

  await context.exposeBinding('__nitPanelCmd', async (source, cmd) => {
    const page = session.sitePage;
    if (!page) return { ok: false, error: 'no site page' };
    try {
      await page.evaluate(c => window.__nitOverlay && window.__nitOverlay.cmd(c), cmd);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

function validateSave(p) {
  if (!p || typeof p !== 'object') return 'payload must be an object';
  if (!p.comment || !String(p.comment).trim()) return 'comment is required';
  if (!p.target || typeof p.target !== 'object') return 'target is required';
  return null;
}
