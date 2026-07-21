// Playwright launcher (SPEC §2.1): headed Chromium, persistent context, bypassCSP
// so the overlay runs on CSP-hardened production sites.
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};

export async function launchBrowser({ headless = false, viewportMode = 'desktop', profileDir } = {}) {
  const userDataDir = profileDir || path.join(os.homedir(), '.nit', 'chrome-profile');
  return chromium.launchPersistentContext(userDataDir, {
    headless,
    bypassCSP: true,
    viewport: VIEWPORTS[viewportMode] || VIEWPORTS.desktop,
    ignoreDefaultArgs: ['--enable-automation'],
  });
}
