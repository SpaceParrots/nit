// One review/view session: launch, inject overlay, wire bridge, own the store.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser, VIEWPORTS } from './launch.js';
import { injectOverlay } from './inject.js';
import { wireBridge } from './bridge.js';
import { openPanel } from './panel.js';
import { createStore } from '../store/store.js';
import { renderReviewMd, FIX_ANNOTATIONS_MD } from '../store/render.js';

/**
 * @param {object} opts
 *   mode: 'review' | 'view'
 *   url: page to open (review: required; view: optional override)
 *   reviewFile: feedback file to replay (view mode)
 *   out: output dir (review mode, default nit-review)
 */
export async function startSession(opts) {
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

  let store;
  let targetUrl = url;
  if (mode === 'view') {
    if (!reviewFile) throw new Error('view mode needs a feedback file');
    const filePath = path.resolve(reviewFile);
    if (!fs.existsSync(filePath)) throw new Error(`feedback file not found: ${filePath}`);
    store = createStore(path.dirname(filePath), { file: filePath });
    targetUrl = url || store.data.review.url;
    if (!targetUrl) throw new Error('feedback file has no review.url — pass --url <url>');
  } else {
    if (!url) throw new Error('review mode needs a url');
    store = createStore(path.resolve(out), { url, author });
  }

  const session = {
    mode,
    author,
    debug,
    onEvent,
    log,
    store,
    viewportMode,
    context: null,
    page: null,
    sitePage: null,
    panelPage: null,
    uiState: {},
    _closing: false,

    flush() {
      store.flush();
      try {
        fs.writeFileSync(path.join(store.dir, 'review.md'), renderReviewMd(store.data), 'utf8');
        fs.writeFileSync(path.join(store.dir, 'fix-annotations.md'), FIX_ANNOTATIONS_MD, 'utf8');
      } catch (e) {
        log(`! could not write review.md: ${e.message}`);
      }
    },

    async setViewport(m) {
      if (!VIEWPORTS[m]) return { ok: false, error: `unknown viewport mode: ${m}` };
      session.viewportMode = m;
      const vp = VIEWPORTS[m];
      for (const p of session.context.pages()) {
        if (p === session.panelPage) continue; // the panel keeps its own size
        await p.setViewportSize(vp).catch(() => {});
      }
      log(`viewport -> ${m} ${vp.width}x${vp.height}`);
      return { ok: true, mode: m, w: vp.width, h: vp.height };
    },

    async close() {
      session._closing = true;
      await session.context.close().catch(() => {});
    },
  };

  const context = await launchBrowser({ headless, viewportMode, profileDir });
  session.context = context;
  await wireBridge(context, session);
  await injectOverlay(context, { mode, debug });

  session.done = new Promise(resolve => {
    context.on('close', () => {
      session.flush();
      resolve();
    });
  });

  const page = context.pages()[0] || await context.newPage();
  session.page = page;
  session.sitePage = page;
  // Closing the site window ends the session (the panel alone is useless).
  page.on('close', () => {
    if (!session._closing) session.close();
  });
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
    .catch(e => log(`! navigation failed: ${e.message}`));

  // Devtools-style side panel in its own window — the page overlay stays minimal.
  try {
    session.panelPage = await openPanel(context, page, session);
  } catch (e) {
    log(`! side panel unavailable (${e.message}) — the in-page chip and Alt picking still work`);
  }

  return session;
}

export function defaultAuthor() {
  if (process.env.NIT_AUTHOR) return process.env.NIT_AUTHOR;
  try { return os.userInfo().username; } catch { return 'anonymous'; }
}
