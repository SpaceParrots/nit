// Filesystem + polling helpers shared by unit and browser tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Create a unique temp directory for a test.
 * @param {string} prefix directory name prefix
 * @returns {string} absolute path
 */
export function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Read and parse the annotations.json of a review directory.
 * @param {string} dir
 * @returns {import('../../src/types.js').ReviewData}
 */
export function readAnnotations(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'annotations.json'), 'utf8'));
}

/**
 * Poll until `fn` returns a truthy value (which is then returned) or the timeout
 * elapses (which throws, naming `message`).
 * @template T
 * @param {() => T | Promise<T>} fn
 * @param {{timeout?: number, interval?: number, message?: string}} [opts]
 * @returns {Promise<T>}
 */
export async function waitFor(fn, { timeout = 10000, interval = 100, message = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${message}`);
    await new Promise(r => setTimeout(r, interval));
  }
}
