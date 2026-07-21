// SPDX-License-Identifier: AGPL-3.0-or-later
// Bundle the overlay (vanilla JS/CSS, Shadow DOM) with esbuild and inject it via
// page.addInitScript — before page scripts, on every navigation, never a <script> tag.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import type { BrowserContext } from 'playwright';
import type { OverlayConfig } from '../types.js';

// Compiled overlay entry next to this file (dist/overlay/main.js at runtime);
// overlay.css is copied there by the build so esbuild can inline it.
const OVERLAY_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'overlay', 'main.js');

let cachedBundle: string | null = null;

/**
 * Bundle the overlay (overlay/main.js + CSS) into a single self-contained
 * IIFE string with esbuild. Built once per process and cached.
 * @returns the injectable script source
 */
export async function buildOverlayBundle(): Promise<string> {
  if (!cachedBundle) {
    const result = await esbuild.build({
      entryPoints: [OVERLAY_ENTRY],
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      target: 'es2020',
      loader: { '.css': 'text' },
      legalComments: 'none',
    });
    cachedBundle = result.outputFiles[0].text;
  }
  return cachedBundle;
}

/**
 * Register the overlay as init scripts on the context: config first, then the
 * bundle. Init scripts run before page scripts on every navigation, which is
 * what lets the overlay survive SPA route changes and full reloads alike.
 * @param context the session's browser context
 * @param config exposed as `window.__NIT_CONFIG`
 */
export async function injectOverlay(context: BrowserContext, config: OverlayConfig): Promise<void> {
  await context.addInitScript(`window.__NIT_CONFIG = ${JSON.stringify(config)};`);
  await context.addInitScript(await buildOverlayBundle());
}
