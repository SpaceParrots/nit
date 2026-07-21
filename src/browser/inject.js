// SPDX-License-Identifier: AGPL-3.0-or-later
// Bundle the overlay (vanilla JS/CSS, Shadow DOM) with esbuild and inject it via
// page.addInitScript — before page scripts, on every navigation, never a <script> tag.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const OVERLAY_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'overlay', 'main.js');

let cachedBundle = null;

/**
 * Bundle the overlay (src/overlay/main.js + CSS) into a single self-contained
 * IIFE string with esbuild. Built once per process and cached.
 * @returns {Promise<string>} the injectable script source
 */
export async function buildOverlayBundle() {
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
 * @param {import('playwright').BrowserContext} context
 * @param {{mode: 'review' | 'view' | 'verify', debug: boolean}} config exposed as `window.__NIT_CONFIG`
 * @returns {Promise<void>}
 */
export async function injectOverlay(context, config) {
  await context.addInitScript(`window.__NIT_CONFIG = ${JSON.stringify(config)};`);
  await context.addInitScript(await buildOverlayBundle());
}
