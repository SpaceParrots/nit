// Bundle the overlay (vanilla JS/CSS, Shadow DOM) with esbuild and inject it via
// page.addInitScript — before page scripts, on every navigation, never a <script> tag.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const OVERLAY_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'overlay', 'main.js');

let cachedBundle = null;

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

export async function injectOverlay(context, config) {
  await context.addInitScript(`window.__NIT_CONFIG = ${JSON.stringify(config)};`);
  await context.addInitScript(await buildOverlayBundle());
}
