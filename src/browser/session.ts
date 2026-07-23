// SPDX-License-Identifier: AGPL-3.0-or-later
// One review/view session: launch, inject overlay, wire bridge, own the store.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { launchBrowser, VIEWPORTS, isViewportMode } from './launch.js';
import { injectOverlay } from './inject.js';
import { wireBridge } from './bridge.js';
import { openPanel } from './panel.js';
import { createStore } from '../store/store.js';
import type { Store } from '../store/store.js';
import { renderReviewMd, FIX_ANNOTATIONS_MD } from '../store/render.js';
import { errorMessage } from '../util/error.js';
import type { OverlayEvent, PlacedRef, HiddenRef, SessionMode, ViewportMode, ViewportResult } from '../types.js';

/**
 * Overlay UI state as last reported through `__nitEvent` — sanitized by the
 * bridge before it lands here (the site page can forge events).
 */
export interface SessionUiState {
  route?: string;
  picking?: boolean;
  showAll?: boolean;
  placed?: PlacedRef[];
  unplaced?: string[];
  approx?: PlacedRef[];
  hidden?: HiddenRef[];
}

/** The live browser session returned by {@link startSession}. */
export interface NitSession {
  mode: SessionMode;
  author: string;
  debug: boolean;
  /** observer for overlay events (tests) */
  onEvent?: (evt: OverlayEvent) => void;
  log: (line: string) => void;
  store: Store;
  viewportMode: ViewportMode;
  /**
   * The url this session actually opened — `--url` when given, else the feedback
   * file's `review.url`. Navigation gating (see `__nitGoTo`) resolves against
   * this, never against `store.data.review.url`: that value comes out of a file
   * that teammates share and agents write, so it is untrusted, and a `--url`
   * override must not be able to send the reviewer to the file's origin.
   * Anchored to what the user asked to review, not to `sitePage.url()`, which
   * the site may legitimately have changed (e.g. a login redirect).
   */
  readonly targetUrl: string;
  context: BrowserContext;
  /** the initial page (same as `sitePage`) */
  page: Page | null;
  /** the page under review */
  sitePage: Page | null;
  /** the side panel window; null when unavailable or closed */
  panelPage: Page | null;
  uiState: SessionUiState;
  /**
   * @internal set by `__nitGoTo`: focus this annotation as soon as the overlay
   * reports it placed on the newly loaded page. Expires so a pin that never
   * anchors cannot fire a stale focus on some unrelated later page.
   */
  pendingFocus?: { id: string; expiresAt: number } | null;
  /**
   * @internal set by `__nitStageShot` at pick time: the screenshot captured while
   * transient state (an open dropdown) was still visible. Consumed by the next
   * save; expires so a stale pick cannot become some later annotation's shot.
   */
  pendingShot?: { buffer: Buffer; at: number } | null;
  /** resolves when the browser closes */
  done: Promise<void>;
  /** persist annotations.json + the derived review.md / fix-annotations.md */
  flush(): void;
  /** switch every page (except the panel) to a viewport preset */
  setViewport(mode: string): Promise<ViewportResult>;
  close(): Promise<void>;
  /** @internal true while the session is shutting down */
  _closing: boolean;
  /**
   * @internal verify mode: how each after-shot was captured, keyed
   * `${annotationId}:${viewportMode}` — a general-scoped annotation collects
   * one shot per viewport. An `'anchored'` shot (of the re-found element) is
   * final for its viewport; a `'fallback'` shot (of the originally recorded
   * region) is upgraded in place if the element anchors later — SPAs often
   * render it well after the first overlay event.
   */
  _afterCaptured?: Map<string, 'anchored' | 'fallback'>;
  /**
   * @internal verify mode: timestamps of when a fixed annotation was first/last
   * reported unplaced, keyed `${annotationId}:${viewportMode}` like
   * `_afterCaptured` — the grace clock only runs at viewports the annotation
   * wants a shot in. Drives the fallback grace period in `captureAfterShots` —
   * a gap between reports means the user left the route, so the clock restarts
   * on return instead of capturing a still-blank page.
   */
  _afterUnplacedSeen?: Map<string, { first: number; last: number }>;
}

/** Options for {@link startSession}. */
export interface StartSessionOptions {
  /** capture, replay, or fix-verification */
  mode?: SessionMode;
  /** page to open (required for review; optional override for view/verify) */
  url?: string;
  /** feedback file to load (required for view/verify) */
  reviewFile?: string;
  /** output directory for review mode (default `nit-review`) */
  out?: string;
  /** recorded on every annotation (default: OS user name) */
  author?: string;
  /** initial viewport */
  viewportMode?: ViewportMode;
  /** run headless (automation/CI) */
  headless?: boolean;
  /** verbose overlay logging (page clicks hit stdout) */
  debug?: boolean;
  /** browser profile override (tests) */
  profileDir?: string;
  /** observer for overlay events (tests) */
  onEvent?: (evt: OverlayEvent) => void;
  /** log sink (default console.log) */
  log?: (line: string) => void;
}

/**
 * Start one nit browser session: launch Chromium, wire the bridge, inject the
 * overlay, open the side panel window, and navigate to the target url.
 * The returned session owns the store and resolves `done` when the browser closes.
 */
export async function startSession(opts: StartSessionOptions): Promise<NitSession> {
  const {
    url,
    mode = 'review',
    out = 'nit-review',
    author = defaultAuthor(),
    viewportMode = 'desktop',
    headless = false,
    debug = false,
    profileDir,
    onEvent,
    reviewFile,
    log = line => console.log(line),
  } = opts;

  let store: Store;
  let targetUrl: string;
  if (mode === 'view' || mode === 'verify') {
    if (!reviewFile) throw new Error(`${mode} mode needs a feedback file`);
    const filePath = path.resolve(reviewFile);
    if (!fs.existsSync(filePath)) throw new Error(`feedback file not found: ${filePath}`);
    store = createStore(path.dirname(filePath), { file: filePath });
    targetUrl = url ?? store.data.review.url;
    if (!targetUrl) throw new Error('feedback file has no review.url — pass --url <url>');
  } else {
    if (!url) throw new Error('review mode needs a url');
    store = createStore(path.resolve(out), { url, author });
    targetUrl = url;
  }

  const context = await launchBrowser({ headless, viewportMode, profileDir });

  const session: NitSession = {
    mode,
    author,
    debug,
    onEvent,
    log,
    store,
    viewportMode,
    targetUrl,
    context,
    page: null,
    sitePage: null,
    panelPage: null,
    uiState: {},
    pendingFocus: null,
    pendingShot: null,
    _closing: false,

    done: new Promise<void>(resolve => {
      context.on('close', () => {
        session.flush();
        resolve();
      });
    }),

    flush(): void {
      store.flush();
      try {
        fs.writeFileSync(path.join(store.dir, 'review.md'), renderReviewMd(store.data), 'utf8');
        fs.writeFileSync(path.join(store.dir, 'fix-annotations.md'), FIX_ANNOTATIONS_MD, 'utf8');
      } catch (e) {
        log(`! could not write review.md: ${errorMessage(e)}`);
      }
    },

    async setViewport(m: string): Promise<ViewportResult> {
      if (!isViewportMode(m)) return { ok: false, error: `unknown viewport mode: ${m}` };
      session.viewportMode = m;
      const vp = VIEWPORTS[m];
      for (const p of session.context.pages()) {
        if (p === session.panelPage) continue; // the panel keeps its own size
        await p.setViewportSize(vp).catch(() => {});
      }
      log(`viewport -> ${m} ${vp.width}x${vp.height}`);
      return { ok: true, mode: m, w: vp.width, h: vp.height };
    },

    async close(): Promise<void> {
      session._closing = true;
      await session.context.close().catch(() => {});
    },
  };

  await wireBridge(context, session);
  await injectOverlay(context, { mode, debug });

  const page = context.pages()[0] ?? await context.newPage();
  session.page = page;
  session.sitePage = page;
  // Closing the site window ends the session (the panel alone is useless).
  page.on('close', () => {
    if (!session._closing) void session.close();
  });
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
    .catch((e: unknown) => log(`! navigation failed: ${errorMessage(e)}`));

  // Devtools-style side panel in its own window — the page overlay stays minimal.
  try {
    session.panelPage = await openPanel(context, page, session);
  } catch (e) {
    log(`! side panel unavailable (${errorMessage(e)}) — the in-page chip and Alt picking still work`);
  }

  return session;
}

/**
 * Author recorded on annotations when `--author` is not given: the `NIT_AUTHOR`
 * env var, else the OS user name, else `'anonymous'`.
 */
export function defaultAuthor(): string {
  if (process.env.NIT_AUTHOR) return process.env.NIT_AUTHOR;
  try { return os.userInfo().username; } catch { return 'anonymous'; }
}
