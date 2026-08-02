// SPDX-License-Identifier: AGPL-3.0-or-later
// The nit panel: a separate popup window (devtools-style, docked next to the browser
// window) hosting the annotation list and session controls. It is our own page, so it
// never overlays or competes with the site under review — important on mobile viewports.
// The UI itself lives in src/panel and is injected as a bundle.
import type { BrowserContext, Page } from 'playwright';
import { PANEL_HTML } from '../panel/shell.js';
import { buildPanelBundle } from './panel-bundle.js';
import type { NitSession } from './session.js';

/** CSS width of the panel's content area. */
export const PANEL_WIDTH = 360;
/**
 * Floor for the fitted panel viewport. Only reachable on a degenerately small
 * window; the panel's stylesheet keeps the footer (and its Finish button)
 * on screen down to about this height.
 */
const PANEL_MIN_HEIGHT = 320;
/**
 * Viewport height used to measure the window's chrome. Small enough that the
 * probe window fits on any display that could show the panel at all — if it
 * ever were clamped, the chrome would be over-measured, which only yields a
 * slightly shorter panel and never a clipped one.
 */
const CHROME_PROBE_HEIGHT = 400;
/** How often the panel re-fits itself to a window the user resized by hand. */
const REFIT_POLL_MS = 1000;

/** Size of a window, or of the frame drawn around its content area. */
export interface WindowChrome {
  width: number;
  height: number;
}

/**
 * The viewport that exactly fills a window of `outer` whose frame measures
 * `chrome` — the panel's whole defence against laying itself out taller than
 * the window a laptop screen could actually grant it.
 * @param outer the window's real outer size
 * @param chrome the frame (title bar, borders) around its content area
 */
export function panelContentSize(outer: WindowChrome, chrome: WindowChrome): WindowChrome {
  return {
    width: Math.max(PANEL_WIDTH, outer.width - chrome.width),
    height: Math.max(PANEL_MIN_HEIGHT, outer.height - chrome.height),
  };
}

/**
 * Open the panel as a popup window docked next to the browser window and load
 * its UI. The popup approach (vs. a tab) is what gives nit a devtools-like layout
 * without overlaying the site under review.
 * @param context the session's browser context
 * @param sitePage the page under review (opens the popup, provides window geometry)
 * @param session the live session; `session.panelPage` is cleared when the user closes the panel
 * @returns the panel page
 */
export async function openPanel(context: BrowserContext, sitePage: Page, session: NitSession): Promise<Page> {
  // Build (or reuse the cached) bundle BEFORE opening any window: if esbuild fails
  // (e.g. a missing dist/panel/panel.css), we must fail here with no popup ever
  // created, so the caller's existing "side panel unavailable" fallback degrades
  // cleanly instead of leaving an unowned, unstyled window on screen.
  const bundle = await buildPanelBundle();
  const [panel] = await Promise.all([
    context.waitForEvent('page', { timeout: 8000 }),
    sitePage.evaluate(width => {
      window.open(
        'about:blank',
        'nit-panel',
        `width=${width},height=${Math.max(600, window.outerHeight || 900)},`
        + `left=${(window.screenX || 0) + (window.outerWidth || 1200) + 8},top=${window.screenY || 0}`,
      );
    }, PANEL_WIDTH),
  ]);
  try {
    const chrome = await fitPanel(panel);
    await panel.setContent(PANEL_HTML, { waitUntil: 'domcontentloaded' });
    await panel.addScriptTag({ content: bundle });
    watchWindowSize(panel, chrome);
  } catch (e) {
    // The window already exists at this point; if populating it fails, close it
    // ourselves rather than stranding an unowned, unstyled shell on screen.
    await panel.close().catch(() => {});
    throw e;
  }
  panel.on('close', () => {
    if (session.panelPage === panel) session.panelPage = null;
  });
  return panel;
}

/**
 * Size the panel's viewport to the window the OS actually granted it.
 *
 * The window manager clamps a popup to the display's work area, but Chromium
 * keeps laying the page out at the size that was *asked* for — so on a laptop
 * screen the bottom of the panel (the footer, with the Finish button) ends up
 * below the visible edge and can only be reached by scrolling. A viewport is
 * mandatory here, because the panel would otherwise inherit the context's
 * 1440px-wide site viewport, so we measure instead of assuming: `outerHeight`
 * reports the real window, and a short probe resize reveals how much of it the
 * frame takes, leaving the content area we can safely fill.
 * @param panel the freshly opened, still-blank panel window
 * @returns the measured window chrome, for later re-fits
 */
async function fitPanel(panel: Page): Promise<WindowChrome> {
  const granted = await windowSize(panel);
  await panel.setViewportSize({ width: PANEL_WIDTH, height: CHROME_PROBE_HEIGHT });
  const probed = await windowSize(panel);
  const chrome: WindowChrome = {
    width: Math.max(0, probed.width - PANEL_WIDTH),
    height: Math.max(0, probed.height - CHROME_PROBE_HEIGHT),
  };
  await panel.setViewportSize(panelContentSize(granted, chrome));
  return chrome;
}

/** The panel window's real outer size — unaffected by the emulated viewport. */
async function windowSize(panel: Page): Promise<WindowChrome> {
  return panel.evaluate(() => ({ width: window.outerWidth, height: window.outerHeight }));
}

/**
 * Keep the panel fitted while the session runs. The emulated viewport does not
 * follow a window the user drags larger or smaller, so dragging it down would
 * otherwise push the footer off screen exactly as an over-sized initial fit did.
 * Polling is how the panel already tracks session state; the window size rides
 * along on the same cheap round trip.
 */
function watchWindowSize(panel: Page, chrome: WindowChrome): void {
  let busy = false;
  const timer = setInterval(() => {
    void (async () => {
      // A resize is two round trips; skipping a tick that would overlap one keeps
      // the panel from queueing redundant fits behind a slow window manager.
      if (busy || panel.isClosed()) return;
      busy = true;
      try {
        const outer = await windowSize(panel);
        const want = panelContentSize(outer, chrome);
        const has = panel.viewportSize();
        if (has && Math.abs(has.width - want.width) < 2 && Math.abs(has.height - want.height) < 2) return;
        await panel.setViewportSize(want);
      } catch { /* the window is closing, or mid-navigation */ }
      finally { busy = false; }
    })();
  }, REFIT_POLL_MS);
  // Node keeps running for the session, not for this timer.
  timer.unref?.();
  panel.on('close', () => clearInterval(timer));
}
