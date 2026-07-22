// SPDX-License-Identifier: AGPL-3.0-or-later
// The installed package version, read once from package.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | undefined;

/**
 * nit's version as published — used for `--version` and for the MCP handshake's
 * `serverInfo.version`, so a client always reports the version it is really
 * talking to. Falls back to `0.0.0` if package.json is unreadable (a broken
 * install shouldn't take the CLI down).
 */
export function pkgVersion(): string {
  if (cached === undefined) {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    try {
      cached = (JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: string }).version ?? '0.0.0';
    } catch {
      cached = '0.0.0';
    }
  }
  return cached;
}
