// SPDX-License-Identifier: AGPL-3.0-or-later
// nit mcp-install: writes the project-scoped .mcp.json — created when missing,
// merged when present, OS-specific command shape, never clobbers invalid files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runMcpInstall, buildMcpServerEntry } from '../dist/cli/mcp-install.js';
import { tmpDir } from './helpers/tmp.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli', 'index.js');

const readConfig = dir => JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'));
const noLog = () => {};

test('mcp-install: builds the OS-specific server entry', () => {
  assert.deepEqual(buildMcpServerEntry('nit-review', 'linux'), {
    command: 'nit',
    args: ['mcp', 'nit-review'],
  });
  assert.deepEqual(buildMcpServerEntry('nit-review', 'darwin'), {
    command: 'nit',
    args: ['mcp', 'nit-review'],
  });
  // Windows: MCP clients spawn without a shell; the nit bin is a .cmd shim there.
  assert.deepEqual(buildMcpServerEntry('nit-review', 'win32'), {
    command: 'cmd',
    args: ['/c', 'nit', 'mcp', 'nit-review'],
  });
});

test('mcp-install: creates .mcp.json when the project has none', () => {
  const dir = tmpDir('nit-mcpi-');
  const res = runMcpInstall('nit-review', { projectDir: dir, platform: 'linux', log: noLog });
  assert.equal(res.created, true);
  assert.equal(res.replaced, false);
  assert.deepEqual(readConfig(dir), {
    mcpServers: { nit: { command: 'nit', args: ['mcp', 'nit-review'] } },
  });
});

test('mcp-install: merges into an existing .mcp.json, preserving other servers and keys', () => {
  const dir = tmpDir('nit-mcpi-');
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({
    mcpServers: { other: { command: 'other-tool', args: ['serve'] } },
    customTopLevel: { keep: true },
  }));
  const res = runMcpInstall('reviews/site', { projectDir: dir, platform: 'linux', log: noLog });
  assert.equal(res.created, false);
  assert.equal(res.replaced, false);
  assert.deepEqual(readConfig(dir), {
    mcpServers: {
      other: { command: 'other-tool', args: ['serve'] },
      nit: { command: 'nit', args: ['mcp', 'reviews/site'] },
    },
    customTopLevel: { keep: true },
  });
});

test('mcp-install: re-running replaces the existing nit entry (idempotent)', () => {
  const dir = tmpDir('nit-mcpi-');
  runMcpInstall('old-dir', { projectDir: dir, platform: 'linux', log: noLog });
  const res = runMcpInstall('new-dir', { projectDir: dir, platform: 'win32', log: noLog });
  assert.equal(res.replaced, true);
  const config = readConfig(dir);
  assert.deepEqual(Object.keys(config.mcpServers), ['nit']);
  assert.deepEqual(config.mcpServers.nit, { command: 'cmd', args: ['/c', 'nit', 'mcp', 'new-dir'] });
});

test('mcp-install: a custom --name lands under that key', () => {
  const dir = tmpDir('nit-mcpi-');
  runMcpInstall('nit-review', { projectDir: dir, platform: 'linux', name: 'nit-staging', log: noLog });
  assert.ok(readConfig(dir).mcpServers['nit-staging']);
});

test('mcp-install: an invalid .mcp.json is reported and left untouched', () => {
  const dir = tmpDir('nit-mcpi-');
  const file = path.join(dir, '.mcp.json');
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => runMcpInstall('nit-review', { projectDir: dir, platform: 'linux', log: noLog }),
    /not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json', 'file is untouched');

  fs.writeFileSync(file, '["an array, not an object"]');
  assert.throws(() => runMcpInstall('nit-review', { projectDir: dir, platform: 'linux', log: noLog }),
    /not a JSON object/);
});

test('mcp-install: CLI command writes the file for the current OS and prints what it did', () => {
  const dir = tmpDir('nit-mcpi-');
  const res = spawnSync(process.execPath, [CLI, 'mcp-install'], { cwd: dir, encoding: 'utf8', timeout: 30000 });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes('.mcp.json'));
  assert.ok(res.stdout.includes('nit review'), 'hints at creating the review first');
  const expected = process.platform === 'win32'
    ? { command: 'cmd', args: ['/c', 'nit', 'mcp', 'nit-review'] }
    : { command: 'nit', args: ['mcp', 'nit-review'] };
  assert.deepEqual(readConfig(dir).mcpServers.nit, expected);
});
