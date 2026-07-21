// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared error narrowing for `catch (err: unknown)` sites.

/**
 * Extract a human-readable message from an unknown thrown value.
 * @param err the caught value
 * @returns the `Error` message, or the value stringified
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
