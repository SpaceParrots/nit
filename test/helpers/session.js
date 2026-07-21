// SPDX-License-Identifier: AGPL-3.0-or-later
// In-process nit session for browser tests (headless, tmp profile + output dirs).
import { startSession } from '../../dist/browser/session.js';
import { tmpDir } from './tmp.js';

export { tmpDir, readAnnotations, waitFor } from './tmp.js';

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
  return { session, out, logs, events };
}
