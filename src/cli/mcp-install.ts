// SPDX-License-Identifier: AGPL-3.0-or-later
// nit mcp-install — register the nit MCP server in the current project's .mcp.json
// (the project-scoped MCP config Claude Code and other MCP clients pick up).
import fs from 'node:fs';
import path from 'node:path';
import { errorMessage } from '../util/error.js';

/** One MCP server entry as written to .mcp.json. */
export interface McpServerEntry {
  command: string;
  args: string[];
}

/** The (partial) shape of a .mcp.json file; unknown keys are preserved as-is. */
export interface McpConfigFile {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

/** Options for {@link runMcpInstall}. */
export interface McpInstallOptions {
  /** project root holding .mcp.json (default: the current working directory) */
  projectDir?: string;
  /** OS override for tests (default: process.platform) */
  platform?: NodeJS.Platform;
  /** server name inside .mcp.json (default `nit`) */
  name?: string;
  /** log sink */
  log?: (line: string) => void;
}

/** What {@link runMcpInstall} did. */
export interface McpInstallResult {
  /** absolute path of the .mcp.json written */
  file: string;
  /** true when .mcp.json did not exist and was created */
  created: boolean;
  /** true when an existing server entry of the same name was replaced */
  replaced: boolean;
  entry: McpServerEntry;
}

/**
 * The server entry for the current OS. MCP clients spawn the command directly
 * (no shell) — on Windows the globally linked/installed `nit` is a `.cmd` shim
 * that only cmd.exe can execute, so the entry is wrapped in `cmd /c` there.
 * @param reviewDir review directory the server should expose (stored verbatim)
 * @param platform the platform to build the entry for
 */
export function buildMcpServerEntry(reviewDir: string, platform: NodeJS.Platform): McpServerEntry {
  return platform === 'win32'
    ? { command: 'cmd', args: ['/c', 'nit', 'mcp', reviewDir] }
    : { command: 'nit', args: ['mcp', reviewDir] };
}

/**
 * Write the nit MCP server into the project's .mcp.json: the file is created
 * when missing and merged when present — other servers and unknown top-level
 * keys are preserved, and an existing entry of the same name is replaced
 * (re-running is idempotent). A file with invalid JSON is left untouched and
 * reported instead of being overwritten.
 * @param reviewDir review directory the server should expose (kept relative for
 *   a shareable, machine-independent config)
 * @throws when .mcp.json exists but cannot be parsed
 */
export function runMcpInstall(
  reviewDir: string,
  { projectDir = process.cwd(), platform = process.platform, name = 'nit', log = line => console.log(line) }: McpInstallOptions = {},
): McpInstallResult {
  const file = path.join(path.resolve(projectDir), '.mcp.json');
  const entry = buildMcpServerEntry(reviewDir, platform);

  const created = !fs.existsSync(file);
  let config: McpConfigFile = {};
  if (!created) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`${file} exists but is not valid JSON (${errorMessage(e)}) — fix or delete it, then re-run`, { cause: e });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${file} exists but is not a JSON object — fix or delete it, then re-run`);
    }
    config = parsed as McpConfigFile;
  }

  const servers: Record<string, McpServerEntry> =
    config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {};
  const replaced = name in servers;
  servers[name] = entry;
  config.mcpServers = servers;

  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', 'utf8');

  const action = created ? 'created' : replaced ? `updated server "${name}" in` : `added server "${name}" to`;
  log(`${action} ${file}`);
  log(`  ${name}: ${entry.command} ${entry.args.join(' ')}`);
  if (!fs.existsSync(path.resolve(projectDir, reviewDir, 'annotations.json'))) {
    log(`  note: ${reviewDir}/annotations.json does not exist yet — run: nit review <url> --out ${reviewDir}`);
  }
  log('Restart your MCP client (e.g. Claude Code) in this directory to pick it up.');
  return { file, created, replaced, entry };
}
