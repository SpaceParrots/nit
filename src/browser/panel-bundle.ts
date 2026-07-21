// SPDX-License-Identifier: AGPL-3.0-or-later
// Bundle the panel UI with esbuild, mirroring inject.ts's overlay bundle.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

// Compiled panel entry next to this file (dist/panel/main.js at runtime);
// panel.css is copied there by the build so esbuild can inline it.
const PANEL_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'panel', 'main.js');

let cachedBundle: string | null = null;

/**
 * Bundle the panel UI (panel/main.js + CSS) into a single self-contained IIFE
 * string with esbuild. Built once per process and cached.
 * @returns the injectable script source
 */
export async function buildPanelBundle(): Promise<string> {
  if (!cachedBundle) {
    const result = await esbuild.build({
      entryPoints: [PANEL_ENTRY],
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
