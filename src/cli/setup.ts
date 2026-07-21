// SPDX-License-Identifier: AGPL-3.0-or-later
// nit setup — interactive project onboarding (@clack/prompts): pick the review
// directory, keep it out of git, and register the MCP server in .mcp.json.
// All effects live in applySetup() so the wizard stays a thin prompt layer.
import fs from 'node:fs';
import path from 'node:path';
import * as p from '@clack/prompts';
import { runMcpInstall } from './mcp-install.js';
import type { McpInstallResult } from './mcp-install.js';

export const DEFAULT_REVIEW_DIR = 'nit-review';

/** What the wizard (or `--yes`) decided. */
export interface SetupChoices {
  /** review directory, relative to the project root */
  reviewDir: string;
  /** add the review dir to .gitignore */
  gitignore: boolean;
  /** register the nit MCP server in .mcp.json */
  mcp: boolean;
}

/** Options for {@link applySetup} / {@link runSetup}. */
export interface SetupOptions {
  /** project root (default: the current working directory) */
  projectDir?: string;
  /** OS override for the MCP entry (tests) */
  platform?: NodeJS.Platform;
  /** log sink */
  log?: (line: string) => void;
}

/** What {@link applySetup} did. */
export interface SetupResult {
  reviewDir: string;
  /** true when the review directory was newly created */
  reviewDirCreated: boolean;
  gitignore: GitignoreOutcome | 'skipped';
  mcp: McpInstallResult | null;
}

export type GitignoreOutcome = 'created' | 'added' | 'present';

/**
 * Make sure `.gitignore` lists `entry`: the file is created when missing,
 * appended when present, and left alone when the entry (with or without a
 * trailing slash) is already covered.
 */
export function ensureGitignoreEntry(projectDir: string, entry: string): GitignoreOutcome {
  const file = path.join(projectDir, '.gitignore');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, entry + '\n', 'utf8');
    return 'created';
  }
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split(/\r?\n/).map(l => l.trim());
  const bare = entry.replace(/\/$/, '');
  if (lines.includes(bare) || lines.includes(bare + '/')) return 'present';
  const sep = content === '' || content.endsWith('\n') ? '' : '\n';
  fs.appendFileSync(file, `${sep}${entry}\n`, 'utf8');
  return 'added';
}

/** A review dir must stay inside the project: relative, no `..` segments. */
export function validateReviewDir(dir: string): string | undefined {
  if (!dir.trim()) return 'directory must not be empty';
  if (path.isAbsolute(dir)) return 'use a path relative to the project root';
  if (dir.split(/[\\/]/).includes('..')) return 'directory must stay inside the project';
  return undefined;
}

/**
 * Apply the setup choices: create the review directory, extend .gitignore and
 * register the MCP server. Pure effects, no prompting — the wizard and the
 * `--yes` path both end up here.
 */
export function applySetup(choices: SetupChoices, { projectDir = process.cwd(), platform = process.platform }: SetupOptions = {}): SetupResult {
  const invalid = validateReviewDir(choices.reviewDir);
  if (invalid) throw new Error(`invalid review directory "${choices.reviewDir}": ${invalid}`);

  const abs = path.resolve(projectDir, choices.reviewDir);
  const reviewDirCreated = !fs.existsSync(abs);
  if (reviewDirCreated) fs.mkdirSync(abs, { recursive: true });

  const gitignore = choices.gitignore ? ensureGitignoreEntry(projectDir, `${choices.reviewDir.replace(/[\\/]+$/, '')}/`) : 'skipped';
  const mcp = choices.mcp ? runMcpInstall(choices.reviewDir, { projectDir, platform, log: () => {} }) : null;
  return { reviewDir: choices.reviewDir, reviewDirCreated, gitignore, mcp };
}

/** Options for {@link runSetup}. */
export interface RunSetupOptions extends SetupOptions {
  /** accept all defaults without prompting (also used on non-TTY terminals) */
  yes?: boolean;
}

/**
 * The `nit setup` wizard. Prompts for each choice with @clack/prompts; with
 * `--yes` (or without a TTY) it applies the defaults straight away: review dir
 * `nit-review`, .gitignore entry, MCP registration.
 */
export async function runSetup({ yes = false, projectDir = process.cwd(), platform, log = line => console.log(line) }: RunSetupOptions = {}): Promise<SetupResult | null> {
  const defaults: SetupChoices = { reviewDir: DEFAULT_REVIEW_DIR, gitignore: true, mcp: true };

  if (yes || !process.stdin.isTTY || !process.stdout.isTTY) {
    if (!yes) log('non-interactive terminal — applying the defaults (same as --yes)');
    const result = applySetup(defaults, { projectDir, platform });
    for (const line of summarize(result, projectDir)) log(line);
    return result;
  }

  p.intro('nit setup — get this project ready for reviews');

  const reviewDir = await p.text({
    message: 'Where should reviews be stored?',
    placeholder: DEFAULT_REVIEW_DIR,
    defaultValue: DEFAULT_REVIEW_DIR,
    validate: value => validateReviewDir(value?.trim() ? value : DEFAULT_REVIEW_DIR),
  });
  if (p.isCancel(reviewDir)) return cancelled();

  const gitignore = await p.confirm({
    message: `Add ${reviewDir}/ to .gitignore? (reviews are working files, usually not committed)`,
    initialValue: true,
  });
  if (p.isCancel(gitignore)) return cancelled();

  const mcp = await p.confirm({
    message: 'Register the nit MCP server in .mcp.json? (lets Claude Code & other agents read this project\'s review)',
    initialValue: true,
  });
  if (p.isCancel(mcp)) return cancelled();

  const result = applySetup({ reviewDir, gitignore, mcp }, { projectDir, platform });
  p.note(summarize(result, projectDir).join('\n'), 'Done');
  p.outro(`Start reviewing:  nit review <url>${result.reviewDir === DEFAULT_REVIEW_DIR ? '' : ` --out ${result.reviewDir}`}`);
  return result;
}

function cancelled(): null {
  p.cancel('setup cancelled — nothing was changed');
  return null;
}

function summarize(result: SetupResult, projectDir: string): string[] {
  const lines = [
    `review directory  ${path.resolve(projectDir, result.reviewDir)}${result.reviewDirCreated ? '  (created)' : '  (already existed)'}`,
  ];
  if (result.gitignore !== 'skipped') {
    const what = result.gitignore === 'created' ? '.gitignore created' : result.gitignore === 'added' ? 'added to .gitignore' : 'already in .gitignore';
    lines.push(`gitignore         ${what}`);
  }
  if (result.mcp) {
    lines.push(`mcp server        ${result.mcp.created ? '.mcp.json created' : '.mcp.json updated'}  (${result.mcp.entry.command} ${result.mcp.entry.args.join(' ')})`);
  }
  return lines;
}

/**
 * First-review guard for `nit review`: when no explicit `--out` was given and
 * the default review directory does not exist yet, confirm (TTY only) that
 * reviews should live in this project — and let the reviewer pick another
 * directory if not. Returns the directory to use.
 */
export async function confirmReviewDir(out: string, { explicit, projectDir = process.cwd() }: { explicit: boolean; projectDir?: string }): Promise<string> {
  if (explicit || fs.existsSync(path.resolve(projectDir, out))) return out;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return out;

  const ok = await p.confirm({
    message: `First review in this project — store it in ${path.resolve(projectDir, out)}?`,
    initialValue: true,
  });
  if (p.isCancel(ok) || ok) return out;

  const custom = await p.text({
    message: 'Where should reviews be stored instead?',
    placeholder: out,
    defaultValue: out,
    validate: value => validateReviewDir(value?.trim() ? value : out),
  });
  return p.isCancel(custom) ? out : custom;
}
