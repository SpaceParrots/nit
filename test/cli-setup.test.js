// SPDX-License-Identifier: AGPL-3.0-or-later
// nit setup: idempotent project onboarding — review dir, .gitignore entry, .mcp.json.
// The interactive wizard is a thin layer over applySetup(), which is tested here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applySetup, ensureGitignoreEntry, validateReviewDir } from '../dist/cli/setup.js';
import { readUserConfig, writeUserConfig } from '../dist/util/user-config.js';
import { tmpDir } from './helpers/tmp.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli', 'index.js');
const DEFAULTS = { reviewDir: 'nit-review', gitignore: true, mcp: true, author: null };

test('setup: applySetup creates review dir, .gitignore and .mcp.json', () => {
  const dir = tmpDir('nit-setup-');
  const res = applySetup(DEFAULTS, { projectDir: dir, platform: 'linux' });

  assert.equal(res.reviewDirCreated, true);
  assert.ok(fs.statSync(path.join(dir, 'nit-review')).isDirectory());
  assert.equal(res.gitignore, 'created');
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'nit-review/\n');
  assert.ok(res.mcp.created);
  const mcp = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'));
  assert.deepEqual(mcp.mcpServers.nit, { command: 'nit', args: ['mcp', 'nit-review'] });
});

test('setup: applySetup is idempotent on a second run', () => {
  const dir = tmpDir('nit-setup-');
  applySetup(DEFAULTS, { projectDir: dir, platform: 'linux' });
  const res = applySetup(DEFAULTS, { projectDir: dir, platform: 'linux' });

  assert.equal(res.reviewDirCreated, false);
  assert.equal(res.gitignore, 'present');
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'nit-review/\n', 'no duplicate entry');
  assert.equal(res.mcp.replaced, true);
});

test('setup: choices can opt out of gitignore and mcp', () => {
  const dir = tmpDir('nit-setup-');
  const res = applySetup({ reviewDir: 'reviews', gitignore: false, mcp: false }, { projectDir: dir, platform: 'linux' });

  assert.ok(fs.statSync(path.join(dir, 'reviews')).isDirectory());
  assert.equal(res.gitignore, 'skipped');
  assert.equal(res.mcp, null);
  assert.equal(fs.existsSync(path.join(dir, '.gitignore')), false);
  assert.equal(fs.existsSync(path.join(dir, '.mcp.json')), false);
});

test('setup: ensureGitignoreEntry appends to an existing file and detects both spellings', () => {
  const dir = tmpDir('nit-setup-');
  const file = path.join(dir, '.gitignore');

  fs.writeFileSync(file, 'node_modules/\ndist'); // no trailing newline on purpose
  assert.equal(ensureGitignoreEntry(dir, 'nit-review/'), 'added');
  assert.equal(fs.readFileSync(file, 'utf8'), 'node_modules/\ndist\nnit-review/\n');

  assert.equal(ensureGitignoreEntry(dir, 'nit-review/'), 'present');
  fs.writeFileSync(file, 'nit-review\n'); // listed without the trailing slash
  assert.equal(ensureGitignoreEntry(dir, 'nit-review/'), 'present');
});

test('setup: validateReviewDir rejects escaping and absolute paths', () => {
  assert.equal(validateReviewDir('nit-review'), undefined);
  assert.equal(validateReviewDir('reviews/site'), undefined);
  assert.ok(validateReviewDir(''));
  assert.ok(validateReviewDir('  '));
  assert.ok(validateReviewDir('../outside'));
  assert.ok(validateReviewDir('a/../../b'));
  assert.ok(validateReviewDir(path.resolve('abs')));
  assert.throws(() => applySetup({ reviewDir: '../x', gitignore: false, mcp: false }, { projectDir: tmpDir('nit-setup-') }),
    /invalid review directory/);
});

test('setup: CLI --yes applies the defaults non-interactively', () => {
  const dir = tmpDir('nit-setup-');
  // Point os.homedir() (and so the user config dir) at the tmp dir — the
  // subprocess must never touch the real ~/.config/nit.
  const env = { ...process.env, HOME: dir, USERPROFILE: dir };
  const res = spawnSync(process.execPath, [CLI, 'setup', '--yes'], { cwd: dir, encoding: 'utf8', timeout: 30000, env });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(fs.existsSync(path.join(dir, 'nit-review')));
  assert.ok(fs.existsSync(path.join(dir, '.gitignore')));
  assert.ok(fs.existsSync(path.join(dir, '.mcp.json')));
  assert.ok(res.stdout.includes('review directory'));
  assert.ok(fs.existsSync(path.join(dir, '.config', 'nit', 'config.json')), 'user config written under the isolated home');
});

test('user-config: readUserConfig on a missing dir returns {}', () => {
  const dir = tmpDir('nit-userconfig-');
  assert.deepEqual(readUserConfig(path.join(dir, 'does-not-exist')), {});
});

test('user-config: writeUserConfig then readUserConfig round-trips and merges', () => {
  const dir = tmpDir('nit-userconfig-');
  writeUserConfig({ author: 'Ann' }, dir);
  assert.deepEqual(readUserConfig(dir), { author: 'Ann' });

  writeUserConfig({}, dir);
  assert.deepEqual(readUserConfig(dir), { author: 'Ann' }, 'an empty patch keeps the existing author');
});

test('user-config: a corrupt config.json yields {} without throwing', () => {
  const dir = tmpDir('nit-userconfig-');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), '{nope', 'utf8');
  assert.deepEqual(readUserConfig(dir), {});
});

test('setup: applySetup stores the author in the user config, null stores nothing', () => {
  const projectDir = tmpDir('nit-setup-');
  const configDir = tmpDir('nit-userconfig-');
  const res = applySetup({ ...DEFAULTS, author: 'Ann' }, { projectDir, configDir, platform: 'linux' });

  assert.equal(res.author, 'Ann');
  assert.deepEqual(readUserConfig(configDir), { author: 'Ann' });

  const projectDir2 = tmpDir('nit-setup-');
  const configDir2 = tmpDir('nit-userconfig-');
  const res2 = applySetup({ ...DEFAULTS, author: null }, { projectDir: projectDir2, configDir: configDir2, platform: 'linux' });

  assert.equal(res2.author, null);
  assert.deepEqual(readUserConfig(configDir2), {});
});
