// SPDX-License-Identifier: AGPL-3.0-or-later
// The nit panel: a separate popup window (devtools-style, docked next to the browser
// window) hosting the annotation list and session controls. It is our own page, so it
// never overlays or competes with the site under review — important on mobile viewports.
// The UI itself lives in src/panel and is injected as a bundle.
import type { BrowserContext, Page } from 'playwright';
import { PANEL_HTML } from '../panel/shell.js';
import { buildPanelBundle } from './panel-bundle.js';
import type { NitSession } from './session.js';

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
    sitePage.evaluate(() => {
      window.open(
        'about:blank',
        'nit-panel',
        `width=360,height=${Math.max(600, window.outerHeight || 900)},`
        + `left=${(window.screenX || 0) + (window.outerWidth || 1200) + 8},top=${window.screenY || 0}`,
      );
    }),
  ]);
  try {
    await panel.setViewportSize({ width: 344, height: 860 }).catch(() => {});
    await panel.setContent(PANEL_HTML, { waitUntil: 'domcontentloaded' });
    await panel.addScriptTag({ content: bundle });
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
