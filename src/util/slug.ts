// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared slug helper for author-derived identifiers (merge ids, export names).

/**
 * Lowercase a string and collapse everything non-alphanumeric to single dashes
 * (`Ann Müller` → `ann-m-ller`); falls back to `'unknown'` for empty input.
 */
export function slugify(s: string): string {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}
