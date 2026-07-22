// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Click-history limits and the bridge-side sanitizer. Shared between the overlay
 * (which bounds the trail as it records) and Node (which must re-validate the
 * save payload — page JS can forge `__nitSave` calls, so the trail arriving over
 * the bridge is untrusted input).
 */
import type { ClickStep } from '../types.js';

/** Maximum clicks kept in a trail — and stored on an annotation. */
export const MAX_HISTORY = 10;

// Field caps: selectors can legitimately be long (nth-of-type chains); everything
// else matches the caps used elsewhere (text 80 like Target.text).
const CAPS: Readonly<Record<keyof ClickStep, number>> = {
  selector: 300,
  tag: 60,
  component: 60,
  text: 80,
  at: 40,
};

/**
 * Validate an untrusted `history` value from a save payload. Keeps at most
 * {@link MAX_HISTORY} entries; an entry survives only if all five fields are
 * strings. Fields are whitespace-collapsed (so a crafted value cannot smuggle
 * block-level markdown into review.md) and length-capped. Returns undefined when
 * nothing survives, so absent and empty look identical on disk.
 */
export function sanitizeHistory(v: unknown): ClickStep[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: ClickStep[] = [];
  for (const entry of v) {
    if (out.length >= MAX_HISTORY) break;
    const step = sanitizeStep(entry);
    if (step) out.push(step);
  }
  return out.length ? out : undefined;
}

function sanitizeStep(v: unknown): ClickStep | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<keyof ClickStep, unknown>;
  const fields = {} as Record<keyof ClickStep, string>;
  for (const key of Object.keys(CAPS) as (keyof ClickStep)[]) {
    const raw = o[key];
    if (typeof raw !== 'string') return null;
    fields[key] = raw.replace(/\s+/g, ' ').trim().slice(0, CAPS[key]);
  }
  return fields;
}
