// SPDX-License-Identifier: AGPL-3.0-or-later
// Which viewports a fixed annotation's after-shots must cover, and which single
// shot is THE before/after comparison. Pure and shared across both runtimes —
// the Node capture (browser/verify.ts, bridge.ts) and the panel's verify card
// must agree on this, or the tour switches viewports for shots the capture
// side then refuses to take.
import type { Annotation, ViewportMode } from '../types.js';

/**
 * The viewport whose after-shot is the primary before/after comparison: the
 * scope viewport for a scoped annotation, else the viewport the before-shot
 * was captured at. The annotation comes out of a shared, hand-editable file,
 * so an unrecognizable viewport falls back to desktop.
 */
export function primaryAfterMode(ann: Pick<Annotation, 'viewportScope' | 'viewport'>): ViewportMode {
  if (ann.viewportScope === 'desktop' || ann.viewportScope === 'mobile') return ann.viewportScope;
  return ann.viewport?.mode === 'mobile' ? 'mobile' : 'desktop';
}

/**
 * Every viewport an after-shot is wanted in, primary first. A scoped
 * annotation only ever wants its own viewport; a general one wants both —
 * its fix must hold on desktop and mobile alike, and the verify card shows
 * the two side by side.
 */
export function wantedAfterModes(ann: Pick<Annotation, 'viewportScope' | 'viewport'>): ViewportMode[] {
  const primary = primaryAfterMode(ann);
  if (ann.viewportScope === 'desktop' || ann.viewportScope === 'mobile') return [primary];
  return [primary, primary === 'desktop' ? 'mobile' : 'desktop'];
}

/**
 * The stored after-shot for a viewport, or `undefined` while it has not been
 * captured. Reads the keyed map first and falls back to the legacy
 * `screenshotAfter` for the primary mode, so reviews verified by an older nit
 * still show their shot. Values come from an untrusted file — only non-empty
 * strings count.
 */
export function afterShotFor(
  ann: Pick<Annotation, 'viewportScope' | 'viewport' | 'screenshotAfter' | 'screenshotsAfter'>,
  mode: ViewportMode,
): string | undefined {
  const keyed = ann.screenshotsAfter?.[mode];
  if (typeof keyed === 'string' && keyed) return keyed;
  if (mode === primaryAfterMode(ann) && typeof ann.screenshotAfter === 'string' && ann.screenshotAfter) {
    return ann.screenshotAfter;
  }
  return undefined;
}
