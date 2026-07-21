// SPDX-License-Identifier: AGPL-3.0-or-later
// Playwright launcher (SPEC §2.1): headed Chromium, persistent context, bypassCSP
// so the overlay runs on CSP-hardened production sites.
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import type { BrowserContext } from 'playwright';
import type { ViewportMode } from '../types.js';

/** Pixel size of a viewport preset. */
export interface ViewportSize {
  width: number;
  height: number;
}

export const VIEWPORTS: Record<ViewportMode, ViewportSize> = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};

/** Narrow an arbitrary string to a {@link ViewportMode}. */
export function isViewportMode(mode: string): mode is ViewportMode {
  return mode === 'desktop' || mode === 'mobile';
}

/** Options for {@link launchBrowser}. */
export interface LaunchOptions {
  /** headless run (automation/CI); default headed */
  headless?: boolean;
  /** initial viewport (see {@link VIEWPORTS}) */
  viewportMode?: ViewportMode;
  /** user-data dir override (tests use temp dirs); default `~/.nit/chrome-profile` */
  profileDir?: string;
}

/**
 * Launch the Chromium the whole session runs in. `bypassCSP` is essential: the
 * overlay must run on CSP-hardened production sites. The persistent profile
 * keeps logins/cookie choices across nit runs.
 */
export async function launchBrowser({ headless = false, viewportMode = 'desktop', profileDir }: LaunchOptions = {}): Promise<BrowserContext> {
  const userDataDir = profileDir ?? path.join(os.homedir(), '.nit', 'chrome-profile');
  return chromium.launchPersistentContext(userDataDir, {
    headless,
    bypassCSP: true,
    viewport: VIEWPORTS[viewportMode],
    ignoreDefaultArgs: ['--enable-automation'],
  });
}
