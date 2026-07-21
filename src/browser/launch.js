// Playwright launcher (SPEC §2.1): headed Chromium, persistent context, bypassCSP
// so the overlay runs on CSP-hardened production sites.
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};

/**
 * Launch the Chromium the whole session runs in. `bypassCSP` is essential: the
 * overlay must run on CSP-hardened production sites. The persistent profile
 * keeps logins/cookie choices across nit runs.
 * @param {object} [opts]
 * @param {boolean} [opts.headless] headless run (automation/CI); default headed
 * @param {'desktop' | 'mobile'} [opts.viewportMode] initial viewport (see {@link VIEWPORTS})
 * @param {string} [opts.profileDir] user-data dir override (tests use temp dirs); default `~/.nit/chrome-profile`
 * @returns {Promise<import('playwright').BrowserContext>}
 */
export async function launchBrowser({ headless = false, viewportMode = 'desktop', profileDir } = {}) {
  const userDataDir = profileDir || path.join(os.homedir(), '.nit', 'chrome-profile');
  return chromium.launchPersistentContext(userDataDir, {
    headless,
    bypassCSP: true,
    viewport: VIEWPORTS[viewportMode] || VIEWPORTS.desktop,
    ignoreDefaultArgs: ['--enable-automation'],
  });
}
