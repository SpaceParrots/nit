// Filesystem + polling helpers shared by unit and browser tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function readAnnotations(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'annotations.json'), 'utf8'));
}

export async function waitFor(fn, { timeout = 10000, interval = 100, message = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${message}`);
    await new Promise(r => setTimeout(r, interval));
  }
}
