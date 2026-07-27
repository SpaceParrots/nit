// SPDX-License-Identifier: AGPL-3.0-or-later
// The docs are part of the published package; these assert they describe the
// CLI that actually ships, so a new command cannot land undocumented.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('docs: the README command table lists every command the CLI exposes', () => {
  const readme = read('README.md');
  for (const cmd of ['nit list', 'nit clear']) {
    assert.ok(readme.includes(cmd), `README documents ${cmd}`);
  }
  assert.match(readme, /bases\.json/, 'README shows the workspace layout');
});

test('docs: the command reference has a section per new command', () => {
  const commands = read('docs/wiki/commands.md');
  assert.match(commands, /^## nit list/m);
  assert.match(commands, /^## nit clear/m);
  for (const flag of ['--base', '--all', '--verified', '--dry-run', '--json', '--actionable']) {
    assert.ok(commands.includes(flag), `commands.md documents ${flag}`);
  }
  assert.ok(commands.includes('-v, --version'), 'commands.md documents -v');
});

test('docs: mcp.md explains bases, qualified ids and the clear tool', () => {
  const mcp = read('docs/wiki/mcp.md');
  assert.match(mcp, /nit_clear_verified/);
  assert.match(mcp, /staging:a1|<base>:<id>/, 'qualified id format is shown');
  assert.match(mcp, /nit:\/\/base\//, 'base-scoped resource uris are documented');
});

test('docs: annotations.md states the schema is unchanged and shows bases.json', () => {
  const annotations = read('docs/wiki/annotations.md');
  assert.match(annotations, /bases\.json/);
});

test('docs: the source map covers every module in src/', () => {
  const srcReadme = read('src/README.md');
  const modules = [];
  for (const dir of ['cli', 'store', 'mcp', 'util', 'overlay']) {
    for (const name of fs.readdirSync(path.join(ROOT, 'src', dir))) {
      if (name.endsWith('.ts')) modules.push(`${dir}/${name}`);
    }
  }
  const missing = modules.filter(m => !srcReadme.includes(path.basename(m)));
  assert.deepEqual(missing, [], `src/README.md is missing: ${missing.join(', ')}`);
});
