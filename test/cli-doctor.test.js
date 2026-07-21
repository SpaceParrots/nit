// nit doctor: environment checks + Chromium install offer (Playwright-style).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'index.js');

function run(args, env = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, ...env },
  });
  return { code: res.status, out: res.stdout + res.stderr };
}

test('doctor: healthy environment reports ok and exits 0', () => {
  const { code, out } = run(['doctor']);
  assert.equal(code, 0, out);
  assert.ok(out.includes(`[ok] Node ${process.versions.node}`));
  assert.ok(out.includes('[ok] playwright'));
  assert.ok(out.includes('[ok] esbuild'));
  assert.ok(out.includes('[ok] commander'));
  assert.ok(out.includes('[ok] Chromium installed'));
  assert.ok(out.includes('All good'));
});

test('doctor: missing Chromium is detected and the install command is suggested', () => {
  // Point Playwright at an empty browsers dir; non-TTY stdin means the install
  // offer is declined automatically, so nothing is downloaded.
  const emptyBrowsers = tmpDir('nit-doctor-browsers-');
  const { code, out } = run(['doctor'], { PLAYWRIGHT_BROWSERS_PATH: emptyBrowsers });
  assert.equal(code, 1, out);
  assert.ok(out.includes('[!!] Chromium browser not installed'));
  assert.ok(out.includes('npx playwright install chromium'));
  assert.ok(out.includes('Fix the issues above'));
});

test('doctor: --yes is offered for non-interactive setup and setup alias works', () => {
  const help = run(['doctor', '--help']);
  assert.equal(help.code, 0);
  assert.ok(help.out.includes('--yes'));
  assert.ok(help.out.includes('Chromium'));

  const alias = run(['setup', '--help']);
  assert.equal(alias.code, 0);
  assert.ok(alias.out.includes('Chromium'));
});
