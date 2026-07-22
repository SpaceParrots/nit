// SPDX-License-Identifier: AGPL-3.0-or-later
// Compress a reproduction trail for the MCP payload. History is the single
// biggest token cost in a get_annotation response, and most of it is noise:
// the reviewer clicking the element they are about to annotate, several
// consecutive clicks on the same element (hover/retry), and captions that
// repeat verbatim between adjacent steps.
import type { Annotation, ClickStep } from '../types.js';

/**
 * A compressed reproduction step. Identical to {@link ClickStep} except
 * `text` is *omitted*, not emptied, when it repeats the previous kept step's
 * text (step 5 below) — the field is genuinely absent from the record, so a
 * plain `ClickStep[]` (where `text` is required) cannot express it.
 */
export type CompressedStep = Omit<ClickStep, 'text'> & { text?: string };

/**
 * Reduce a raw click trail to what is worth showing an agent:
 * 1. drop malformed entries (same shape guard as `render.ts`'s `historyMd`),
 * 2. drop the reviewer's own click on the annotated element (a self-click is
 *    the bug, not a repro step),
 * 3. collapse consecutive steps sharing one selector into the first of the run,
 * 4. keep only the last 5 remaining steps,
 * 5. drop a kept step's `text` when it repeats the immediately preceding kept
 *    step's `text`.
 *
 * Never mutates the input; every returned step is a fresh copy.
 * @param history raw trail as stored on the annotation (oldest first)
 * @param targetSelector the annotation's own `target.selector`, to drop self-clicks
 * @returns the compressed trail, oldest first
 */
export function compressHistory(
  history: Annotation['history'],
  targetSelector: string | undefined,
): CompressedStep[] {
  if (!Array.isArray(history)) return [];

  const valid = history.filter((s): s is ClickStep => Boolean(
    s && typeof s === 'object'
    && typeof s.selector === 'string' && typeof s.text === 'string'
    && typeof s.component === 'string' && typeof s.tag === 'string' && typeof s.at === 'string',
  ));

  const reproduction = valid.filter(s => s.selector !== targetSelector);

  const collapsed: ClickStep[] = [];
  for (const step of reproduction) {
    const prev = collapsed[collapsed.length - 1];
    if (prev?.selector === step.selector) continue;
    collapsed.push(step);
  }

  const capped = collapsed.slice(-5);
  return capped.map((step, i): CompressedStep => {
    if (i > 0 && step.text === capped[i - 1].text) {
      return { selector: step.selector, tag: step.tag, component: step.component, at: step.at };
    }
    return { ...step };
  });
}
