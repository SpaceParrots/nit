// SPDX-License-Identifier: AGPL-3.0-or-later
// nit doctor — check everything nit needs (Node, dependencies, Chromium) and offer
// to install the Chromium browser the same way "npx playwright install chromium" does.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { BrowserType } from 'playwright';

const require = createRequire(import.meta.url);
const PKG_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

type LogSink = (line: string) => void;

/** Options for {@link runDoctor}. */
export interface DoctorOptions {
  /** install Chromium without asking (non-interactive setup) */
  yes?: boolean;
  /** log sink */
  log?: LogSink;
}

/**
 * Run the environment checks: Node version, npm dependencies, and the Playwright
 * Chromium browser. When Chromium is missing, offers to install it (or installs
 * straight away with `yes`); without a TTY the offer is skipped and the manual
 * command is printed instead.
 * @returns true when the environment is ready to run nit
 */
export async function runDoctor({ yes = false, log = console.log }: DoctorOptions = {}): Promise<boolean> {
  let ok = true;
  log('nit doctor\n');

  // 1. Node version (20.12 is the floor: node:util styleText via @clack/prompts)
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
  if (nodeMajor > 20 || (nodeMajor === 20 && nodeMinor >= 12)) {
    pass(log, `Node ${process.versions.node}`);
  } else {
    fail(log, `Node ${process.versions.node}`, 'nit needs Node >= 20.12 — https://nodejs.org');
    ok = false;
  }

  // 2. npm dependencies
  for (const dep of ['playwright', 'esbuild', 'commander', '@clack/prompts', 'fflate']) {
    const version = readPkgVersion(dep);
    if (version) {
      pass(log, `${dep} ${version}`);
    } else {
      fail(log, dep, 'dependency missing — run: npm install');
      ok = false;
    }
  }

  // 3. Chromium browser (the one Playwright downloads)
  let chromium: BrowserType | null = null;
  try {
    ({ chromium } = await import('playwright'));
  } catch { /* playwright missing — already reported above */ }
  if (chromium) {
    const exe = safeExecutablePath(chromium);
    if (exe && fs.existsSync(exe)) {
      pass(log, `Chromium installed (${exe})`);
    } else {
      fail(log, 'Chromium browser not installed', exe ? `expected at ${exe}` : 'no known install location');
      const install = yes || await confirm('\nDownload and install Chromium now (~1 min, one-time)? (Y/n) ');
      if (install) {
        const code = installChromium(log);
        const nowExe = safeExecutablePath(chromium);
        if (code === 0 && nowExe && fs.existsSync(nowExe)) {
          pass(log, `Chromium installed (${nowExe})`);
        } else {
          fail(log, 'Chromium install failed', 'run manually: npx playwright install chromium');
          ok = false;
        }
      } else {
        log('  -> install later with: npx playwright install chromium  (or: nit doctor --yes)');
        ok = false;
      }
    }
  } else {
    ok = false;
  }

  log(ok
    ? '\nAll good — nit is ready. Try: nit review https://example.com'
    : '\nFix the issues above, then re-run: nit doctor');
  return ok;
}

function pass(log: LogSink, label: string): void {
  log(`  [ok] ${label}`);
}

function fail(log: LogSink, label: string, hint?: string): void {
  log(`  [!!] ${label}${hint ? ` — ${hint}` : ''}`);
}

function readPkgVersion(dep: string): string | null {
  // Direct path first: require.resolve('<dep>/package.json') is blocked by some
  // packages' export maps (commander), and nit's own node_modules is the usual home.
  const candidates = [path.join(PKG_ROOT, 'node_modules', dep, 'package.json')];
  try { candidates.push(require.resolve(`${dep}/package.json`)); } catch { /* exports-restricted */ }
  for (const p of candidates) {
    try {
      return (JSON.parse(fs.readFileSync(p, 'utf8')) as { version?: string }).version ?? null;
    } catch { /* next */ }
  }
  return null;
}

function safeExecutablePath(chromium: BrowserType): string | null {
  try { return chromium.executablePath(); } catch { return null; }
}

function installChromium(log: LogSink): number {
  log('\nInstalling Chromium via Playwright…');
  const cli = playwrightCliPath();
  const res = cli
    ? spawnSync(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' })
    : spawnSync('npx', ['playwright', 'install', 'chromium'], { stdio: 'inherit', shell: process.platform === 'win32' });
  return res.status ?? 1;
}

function playwrightCliPath(): string | null {
  try {
    const cli = path.join(path.dirname(require.resolve('playwright')), 'cli.js');
    return fs.existsSync(cli) ? cli : null;
  } catch {
    return null;
  }
}

function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(!/^n/i.test(answer.trim()));
    });
  });
}
