// SPDX-License-Identifier: AGPL-3.0-or-later
// Overlay → Node bridge via page.exposeBinding (SPEC §2.1).
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Frame, Page } from 'playwright';
import { captureElementBuffer, captureElementShot } from '../capture/screenshot.js';
import { captureAfterShots } from './verify.js';
import { safeShotPath } from '../store/store.js';
import { sanitizeHistory } from '../util/history.js';
import { errorMessage } from '../util/error.js';
import { resolveAnnotationUrl } from '../store/url.js';
import { currentRoute, routeKey } from '../util/route.js';
import type { NitSession } from './session.js';
import type {
  Annotation,
  OverlayClickEvent,
  OverlayEvent,
  OverlayFocusEvent,
  OverlayUiEvent,
  PanelCmd,
  PanelState,
  PlacedRef,
  Rect,
  Target,
  ViewportScope,
} from '../types.js';

/** The caller of an exposed binding, as reported by Playwright. */
interface BindingSource {
  context: BrowserContext;
  page: Page;
  frame: Frame;
}

const SCOPES: readonly ViewportScope[] = ['general', 'desktop', 'mobile'];

/** How long a pick-time staged screenshot stays usable for the next save. */
const PENDING_SHOT_TTL_MS = 120_000;

function isViewportScope(v: unknown): v is ViewportScope {
  return typeof v === 'string' && (SCOPES as readonly string[]).includes(v);
}

/** What an untrusted `__nitSave` payload looks like before validation. */
interface RawSavePayload {
  comment?: unknown;
  type?: unknown;
  viewportScope?: unknown;
  route?: unknown;
  target?: unknown;
  history?: unknown;
}

/**
 * Expose the `window.__nit*` bindings on the context — the only channel between
 * the injected overlay / panel window and Node. Bindings are context-wide, so
 * every page (site + panel) can call them:
 *  - `__nitSave(payload)`         validate, screenshot, persist an annotation
 *  - `__nitLoad()`                session config + current annotations (overlay boot/resync)
 *  - `__nitSetViewport(mode)`     switch desktop/mobile (panel window excluded)
 *  - `__nitShot(id, which?)`      screenshot as data-uri ('after' for the verify shot)
 *  - `__nitVerdict(id, verdict)`  verify ruling: 'verified' | 'reopened'
 *  - `__nitSetIssueRef(id, ref)`  attach/clear a tracker issue reference
 *  - `__nitGoTo(id)`              navigate the site page to an annotation's route
 *  - `__nitDelete(id)`            remove annotation + screenshot files
 *  - `__nitFinish()`              flush review and close the session
 *  - `__nitEvent(evt)`            overlay telemetry: clicks (debug), ui state, focus requests
 *  - `__nitPanelState()`          state polled by the panel window
 *  - `__nitPanelCmd(cmd)`         panel → overlay commands, relayed via the site page
 * @param context the session's browser context
 * @param session the live session (see startSession in session.ts)
 */
export async function wireBridge(context: BrowserContext, session: NitSession): Promise<void> {
  const { store } = session;

  // The bindings are exposed context-wide, so the site under review (and any
  // third-party iframe on it) can reach them too. Only accept calls from the top
  // frame of nit's own site/panel pages — arbitrary page/ad JS must not be able
  // to save/delete annotations, force verdicts, or close the session.
  const trusted = (source: BindingSource): boolean =>
    Boolean(source)
    && source.frame === source.page.mainFrame()
    && (source.page === session.sitePage || source.page === session.panelPage);

  /** Wrap a binding handler so untrusted callers get a rejection, never the action. */
  const guard = <A extends unknown[], R>(handler: (source: BindingSource, ...args: A) => R | Promise<R>) =>
    (source: BindingSource, ...args: A): R | Promise<R> | { ok: false; error: string } => {
      if (!trusted(source)) return { ok: false, error: 'nit: call rejected (untrusted frame)' };
      return handler(source, ...args);
    };

  await context.exposeBinding('__nitSave', guard(async (source, payload: unknown) => {
    const error = validateSave(payload);
    if (error) return { ok: false, error };
    const p = payload as RawSavePayload & { comment: string };

    // Reserve the id synchronously (before any await) so concurrent saves can't
    // collide on the same id and overwrite each other.
    const id = store.nextId();
    const viewport = source.page.viewportSize() ?? { width: 0, height: 0 };
    // The target shape is produced by our own overlay; beyond the object check
    // in validateSave it is stored as-is (replay re-validates every layer).
    const target = p.target as Target;
    const annotation: Annotation = {
      id,
      type: p.type === 'comment' ? 'comment' : 'change-request',
      comment: p.comment.trim(),
      status: 'open',
      author: session.author,
      viewportScope: isViewportScope(p.viewportScope) ? p.viewportScope : session.viewportMode,
      viewport: { mode: session.viewportMode, w: viewport.width, h: viewport.height },
      route: typeof p.route === 'string' && p.route ? p.route : '/',
      target,
      screenshot: null,
      createdAt: new Date().toISOString(),
      // untrusted like the rest of the payload — re-validated, capped, or dropped
      history: sanitizeHistory(p.history),
    };
    store.upsert(annotation); // claim the id immediately

    if (target.rect) {
      try {
        const shotFile = store.shotPath(id);
        // Prefer the shot staged at pick time — it shows transient state (an open
        // dropdown) that collapsed while the reviewer typed the comment.
        const pending = session.pendingShot;
        if (pending && Date.now() - pending.at < PENDING_SHOT_TTL_MS) {
          fs.writeFileSync(shotFile, pending.buffer);
        } else {
          await captureElementShot(source.page, target.rect, shotFile);
        }
        session.pendingShot = null;
        annotation.screenshot = `shots/${path.basename(shotFile)}`;
      } catch (e) {
        session.log(`! screenshot failed for ${id}: ${errorMessage(e)}`);
      }
    }

    store.upsert(annotation);
    session.flush();
    session.log(`+ ${annotation.type} ${id} [${annotation.viewportScope}] ${annotation.comment.slice(0, 70)}`);
    return { ok: true, annotation };
  }));

  await context.exposeBinding('__nitLoad', guard(() => ({
    mode: session.mode,
    author: session.author,
    viewportMode: session.viewportMode,
    debug: session.debug,
    annotations: store.annotations,
  })));

  await context.exposeBinding('__nitSetViewport', guard((source, mode: unknown) =>
    session.setViewport(typeof mode === 'string' ? mode : '')));

  await context.exposeBinding('__nitShot', guard((source, id: unknown, which: unknown) => {
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

  await context.exposeBinding('__nitVerdict', guard((source, id: unknown, verdict: unknown) => {
    if (verdict !== 'verified' && verdict !== 'reopened') {
      return { ok: false, error: 'verdict must be "verified" or "reopened"' };
    }
    if (typeof id !== 'string') return { ok: false, error: 'id must be a string' };
    const ann = store.patch(id, { status: verdict, verifiedAt: new Date().toISOString() }, session.author);
    if (!ann) return { ok: false, error: `no annotation ${id}` };
    session.flush();
    session.log(`${verdict === 'verified' ? '+ verified' : '~ reopened'} ${ann.id}`);
    return { ok: true, annotation: ann };
  }));

  await context.exposeBinding('__nitSetIssueRef', guard((source, id: unknown, ref: unknown) => {
    if (typeof id !== 'string') return { ok: false, error: 'id must be a string' };
    // free-form text that ends up in review.md and MCP output — bound its length
    const value = typeof ref === 'string' ? ref.trim().slice(0, 200) : '';
    const ann = store.patch(id, { issueRef: value || undefined }, session.author);
    if (!ann) return { ok: false, error: `no annotation ${id}` };
    session.flush();
    session.log(value ? `~ ${id} issue ${value}` : `~ ${id} issue cleared`);
    return { ok: true, annotation: ann };
  }));

  await context.exposeBinding('__nitGoTo', guard(async (source, id: unknown) => {
    const ann = store.annotations.find(a => a.id === id);
    if (!ann) return { ok: false, error: `no annotation ${String(id)}` };
    // Gate on the origin this session actually opened, not on `review.url`:
    // that field lives in the same shared/agent-written file as `ann.route`, so
    // trusting it would let a crafted file navigate the site page off-origin —
    // and the page-identity `trusted()` check above would then hand that origin
    // full bridge access. It also keeps `--url` honest: a session opened on
    // localhost must never jump to the staging url recorded in the file.
    const url = resolveAnnotationUrl(session.targetUrl, ann.route);
    if (!url) return { ok: false, error: `route is not on the review origin: ${String(ann.route)}` };
    const page = session.sitePage;
    if (!page) return { ok: false, error: 'no site page' };
    try {
      const target = new URL(url);
      const current = new URL(page.url());
      const samePage = routeKey(currentRoute(current)) === routeKey(currentRoute(target));
      if (!samePage) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      return { ok: false, error: errorMessage(e) };
    }
    // The overlay has not re-anchored yet; the `ui` event below focuses the pin
    // as soon as it reports this id placed.
    session.pendingFocus = { id: ann.id, expiresAt: Date.now() + 10000 };
    return { ok: true, url };
  }));

  await context.exposeBinding('__nitStageShot', guard(async (source, rect: unknown) => {
    // Site page only: the picker calls this the moment an element is selected, so
    // transient state (an open dropdown) is captured before the popover steals it.
    if (source.page !== session.sitePage) return { ok: false, error: 'staging is site-page only' };
    if (session.mode !== 'review') return { ok: false, error: 'staging is review-mode only' };
    try {
      // rect is page-supplied; captureElementBuffer re-validates and clamps it
      const { buffer } = await captureElementBuffer(source.page, rect as Rect);
      session.pendingShot = { buffer, at: Date.now() };
      return { ok: true };
    } catch (e) {
      session.pendingShot = null;
      return { ok: false, error: errorMessage(e) };
    }
  }));

  await context.exposeBinding('__nitDelete', guard((source, id: unknown) => {
    const ok = typeof id === 'string' && store.remove(id);
    if (ok) {
      session.flush();
      session.log(`- deleted ${String(id)}`);
    }
    return { ok };
  }));

  await context.exposeBinding('__nitFinish', guard(() => {
    session.flush();
    session.log(`review written to ${store.dir}`);
    setTimeout(() => { session.close().catch(() => {}); }, 100);
    return { ok: true };
  }));

  await context.exposeBinding('__nitEvent', guard(async (source, evt: unknown) => {
    if (!evt || typeof evt !== 'object') return;
    const type = (evt as { type?: unknown }).type;
    if (type === 'click') {
      const click = evt as OverlayClickEvent;
      session.log(`overlay: click at ${click.x},${click.y} on <${click.tag}>`);
    } else if (type === 'ui') {
      // The site page can forge events — sanitize before this state feeds the
      // panel and the verify screenshot capture.
      const ui = evt as Partial<OverlayUiEvent>;
      session.uiState = {
        route: typeof ui.route === 'string' ? ui.route : undefined,
        picking: Boolean(ui.picking),
        showAll: Boolean(ui.showAll),
        placed: Array.isArray(ui.placed) ? ui.placed.filter(isPlacedRef) : [],
        unplaced: Array.isArray(ui.unplaced) ? ui.unplaced.filter((u): u is string => typeof u === 'string') : [],
      };
      const pending = session.pendingFocus;
      if (pending) {
        if (Date.now() > pending.expiresAt) {
          session.pendingFocus = null;
        } else if ((session.uiState.placed ?? []).some(p => p.id === pending.id)) {
          session.pendingFocus = null;
          await source.page
            .evaluate(fid => window.__nitOverlay?.cmd({ cmd: 'focus', id: fid }), pending.id)
            .catch(() => {});
        }
      }
      if (session.mode === 'verify') {
        await captureAfterShots(session, source.page, session.uiState)
          .catch((e: unknown) => session.log(`! after-shot capture failed: ${errorMessage(e)}`));
      }
    } else if (type === 'focus' && session.panelPage) {
      const focus = evt as OverlayFocusEvent;
      await session.panelPage
        .evaluate(id => window.__nitPanelFocus?.(id), focus.id)
        .catch(() => {});
    }
    session.onEvent?.(evt as OverlayEvent);
  }));

  // ---- panel window support ----

  await context.exposeBinding('__nitPanelState', guard((): PanelState => ({
    mode: session.mode,
    author: session.author,
    viewportMode: session.viewportMode,
    picking: session.uiState.picking ?? false,
    showAll: session.uiState.showAll ?? (session.mode !== 'view'),
    route: session.uiState.route ?? '/',
    placed: (session.uiState.placed ?? []).map(p => p.id),
    unplaced: session.uiState.unplaced ?? [],
    annotations: store.annotations,
  })));

  await context.exposeBinding('__nitPanelCmd', guard(async (source, cmd: unknown) => {
    const page = session.sitePage;
    if (!page) return { ok: false, error: 'no site page' };
    try {
      await page.evaluate(c => window.__nitOverlay?.cmd(c), cmd as PanelCmd);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errorMessage(e) };
    }
  }));
}

function isPlacedRef(v: unknown): v is PlacedRef {
  return Boolean(v) && typeof v === 'object'
    && typeof (v as PlacedRef).id === 'string'
    && typeof (v as PlacedRef).rect === 'object' && (v as PlacedRef).rect !== null;
}

function validateSave(p: unknown): string | null {
  if (!p || typeof p !== 'object') return 'payload must be an object';
  const o = p as RawSavePayload;
  if (typeof o.comment !== 'string' || !o.comment.trim()) return 'comment is required';
  if (!o.target || typeof o.target !== 'object') return 'target is required';
  return null;
}
