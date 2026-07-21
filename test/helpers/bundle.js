// SPDX-License-Identifier: AGPL-3.0-or-later
// Bundle a single src module as an IIFE global for in-page unit tables.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

export async function bundleModule(relPath, globalName) {
  const result = await esbuild.build({
    entryPoints: [path.join(SRC, relPath)],
    bundle: true,
    write: false,
    format: 'iife',
    globalName,
    platform: 'browser',
    target: 'es2020',
  });
  return result.outputFiles[0].text;
}
