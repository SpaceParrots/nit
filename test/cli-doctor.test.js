// SPDX-License-Identifier: AGPL-3.0-or-later
// nit doctor: environment checks + Chromium install offer (Playwright-style).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runDoctor } from '../dist/cli/doctor.js';
import { ensureBase } from '../dist/store/workspace.js';
import { tmpDir } from './helpers/tmp.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli', 'index.js');

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

test('doctor: reports the review layout it finds', async () => {
  const cwd = tmpDir('nit-doctor-ws-');
  ensureBase(path.join(cwd, 'nit-review'), 'https://staging.example.com', 'staging');
  ensureBase(path.join(cwd, 'nit-review'), 'http://localhost:4200');
  const lines = [];
  await runDoctor({ yes: false, cwd, log: l => lines.push(l) });
  const text = lines.join('\n');
  assert.match(text, /2 base URLs/);
  assert.match(text, /staging/);
});

test('doctor: a single-url review and an empty project both read clearly', async () => {
  const flatCwd = tmpDir('nit-doctor-flat-');
  const reviewDir = path.join(flatCwd, 'nit-review');
  fs.mkdirSync(reviewDir, { recursive: true });
  fs.writeFileSync(path.join(reviewDir, 'annotations.json'), JSON.stringify({
    review: { id: 'flat', url: 'https://fainin.dev/', createdAt: '2026-07-20T10:00:00Z', authors: [] },
    annotations: [],
  }));
  const flat = [];
  await runDoctor({ yes: false, cwd: flatCwd, log: l => flat.push(l) });
  assert.match(flat.join('\n'), /one review \(https:\/\/fainin\.dev\/\)/);

  const empty = [];
  await runDoctor({ yes: false, cwd: tmpDir('nit-doctor-none-'), log: l => empty.push(l) });
  assert.match(empty.join('\n'), /no review folder yet/);
});

test('doctor: --yes is offered for non-interactive use', () => {
  const help = run(['doctor', '--help']);
  assert.equal(help.code, 0);
  assert.ok(help.out.includes('--yes'));
  assert.ok(help.out.includes('Chromium'));
});
