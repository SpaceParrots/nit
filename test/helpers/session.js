// SPDX-License-Identifier: AGPL-3.0-or-later
// In-process nit session for browser tests (headless, tmp profile + output dirs).
import { startSession } from '../../dist/browser/session.js';
import { tmpDir } from './tmp.js';

export { tmpDir, readAnnotations, waitFor } from './tmp.js';

/**
 * @param {object} [overrides] passed through to `startSession`
 * @returns {Promise<{session: object, out: string, dir: string, logs: string[], events: unknown[]}>}
 *   `out` is the workspace root passed as `--out`; `dir` is where this
 *   session's files actually land — `session.store.dir`, which for review
 *   mode is `out/<slug>` (the base folder `ensureBase` created), not `out`
 *   itself. Exposed here once so callers ask the session rather than
 *   re-deriving the slug/layout rule in every test.
 */
export async function startTestSession(overrides = {}) {
  const out = overrides.out || tmpDir('nit-out-');
  const logs = [];
  const events = [];
  const session = await startSession({
    mode: 'review',
    headless: true,
    debug: true,
    author: 'Tester',
    out,
    profileDir: tmpDir('nit-profile-'),
    log: line => logs.push(line),
    onEvent: evt => events.push(evt),
    ...overrides,
  });
  return { session, out, dir: session.store.dir, logs, events };
}
