// SPDX-License-Identifier: AGPL-3.0-or-later
// The per-user config file (~/.config/nit/config.json). Holds facts about the
// person, not the project — currently just the author name recorded on
// annotations. Reads are tolerant: a missing or corrupt file is an empty config.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** What nit remembers about the user across projects. */
export interface UserConfig {
  /** author name recorded on annotations */
  author?: string;
}

/** Directory of the user config file. */
export function defaultConfigDir(): string {
  return path.join(os.homedir(), '.config', 'nit');
}

/** Read the user config; missing or unreadable files yield `{}`, never a throw. */
export function readUserConfig(dir: string = defaultConfigDir()): UserConfig {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    if (typeof raw !== 'object' || raw === null) return {};
    const author = (raw as Record<string, unknown>).author;
    return typeof author === 'string' && author.trim() ? { author: author.trim() } : {};
  } catch {
    return {};
  }
}

/** Merge `patch` into the stored config, creating the directory when needed. */
export function writeUserConfig(patch: UserConfig, dir: string = defaultConfigDir()): void {
  const merged = { ...readUserConfig(dir), ...patch };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(merged, null, 2) + '\n', 'utf8');
}
