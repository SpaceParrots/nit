// SPDX-License-Identifier: AGPL-3.0-or-later
// CDP element-clip screenshot (SPEC §2.3): Page.captureScreenshot clipped to the
// element rect in absolute page coordinates, with generous context padding
// (milestone-0 learning: tight crops are useless to the fixing agent).
import fs from 'node:fs';
import type { Page } from 'playwright';
import type { Rect } from '../types.js';

export const SHOT_PADDING = 24;
/**
 * Minimum context a screenshot carries: a tight crop of a small element (a button)
 * is useless to the fixing agent — the clip expands to at least this, centered on
 * the element, so the component's neighbourhood is visible.
 */
export const MIN_SHOT_W = 480;
export const MIN_SHOT_H = 360;

// Hard cap on a capture clip dimension (px) — the rect is page-supplied.
const MAX_CLIP = 20000;

/** The clip actually captured, in absolute page coordinates. */
export interface CaptureClip {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/**
 * Capture a CDP screenshot clipped to an element rect (plus context padding) and
 * write it as a PNG. Uses `Page.captureScreenshot` with `captureBeyondViewport`,
 * so elements outside the current scroll position work too.
 * @param page the page to capture from
 * @param rect element bounds in absolute page coordinates (page-supplied, re-validated here)
 * @param filePath destination PNG path
 * @param options context padding in px around the rect (default {@link SHOT_PADDING})
 * @returns the clip actually captured
 * @throws when the rect is invalid or the CDP call fails
 */
/** Page dimensions the clip is clamped to (scrollWidth/scrollHeight). */
export interface PageBounds {
  w: number;
  h: number;
}

/**
 * Compute the capture clip for an element rect: padding around the element,
 * expanded to at least {@link MIN_SHOT_W}×{@link MIN_SHOT_H} centered on it, and
 * clamped to the page bounds (the window slides inward at edges rather than
 * hanging off; a page smaller than the minimum caps the clip to the page). Pure.
 * @param rect element bounds in absolute page coordinates (page-supplied, re-validated)
 * @param options padding (default {@link SHOT_PADDING}) and page bounds (omit to skip clamping)
 * @throws when the rect is invalid
 */
export function contextClip(
  rect: Rect,
  { padding = SHOT_PADDING, bounds }: { padding?: number; bounds?: PageBounds } = {},
): CaptureClip {
  if (!isFiniteNumber(rect?.x) || !isFiniteNumber(rect.y)
    || !(rect.w >= 0) || !(rect.h >= 0) || rect.w === Infinity || rect.h === Infinity) {
    throw new Error('invalid rect');
  }
  // The rect is page-supplied (and forgeable): clamp to a sane maximum so a
  // hostile or broken page can't request a giant capture.
  const x = clamp(rect.x, 0, MAX_CLIP);
  const y = clamp(rect.y, 0, MAX_CLIP);
  const w = clamp(rect.w, 0, MAX_CLIP);
  const h = clamp(rect.h, 0, MAX_CLIP);

  let width = Math.max(1, Math.round(w + padding * 2), MIN_SHOT_W);
  let height = Math.max(1, Math.round(h + padding * 2), MIN_SHOT_H);
  // Center the window on the element, not on the padded box — for a small
  // element that puts its neighbourhood evenly around it.
  let clipX = Math.round(x + w / 2 - width / 2);
  let clipY = Math.round(y + h / 2 - height / 2);
  if (bounds && isFiniteNumber(bounds.w) && isFiniteNumber(bounds.h)) {
    width = Math.min(width, Math.max(1, Math.round(bounds.w)));
    height = Math.min(height, Math.max(1, Math.round(bounds.h)));
    clipX = clamp(clipX, 0, Math.max(0, Math.round(bounds.w) - width));
    clipY = clamp(clipY, 0, Math.max(0, Math.round(bounds.h) - height));
  } else {
    clipX = Math.max(0, clipX);
    clipY = Math.max(0, clipY);
  }
  return { x: clipX, y: clipY, width, height, scale: 1 };
}

/** Best-effort page bounds for clip clamping; null when the page won't answer. */
async function pageBounds(page: Page): Promise<PageBounds | null> {
  try {
    return await page.evaluate(() => ({
      w: document.documentElement.scrollWidth,
      h: document.documentElement.scrollHeight,
    }));
  } catch {
    return null;
  }
}

/**
 * Capture a CDP screenshot of an element's context clip as a PNG buffer. Uses
 * `Page.captureScreenshot` with `captureBeyondViewport`, so elements outside the
 * current scroll position work too.
 * @param page the page to capture from
 * @param rect element bounds in absolute page coordinates
 * @returns the PNG bytes and the clip actually captured
 * @throws when the rect is invalid or the CDP call fails
 */
export async function captureElementBuffer(
  page: Page,
  rect: Rect,
  options: { padding?: number } = {},
): Promise<{ buffer: Buffer; clip: CaptureClip }> {
  const bounds = await pageBounds(page);
  const clip = contextClip(rect, { ...options, bounds: bounds ?? undefined });
  const cdp = await page.context().newCDPSession(page);
  try {
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip,
      captureBeyondViewport: true,
    });
    return { buffer: Buffer.from(data, 'base64'), clip };
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/**
 * Capture an element's context screenshot and write it as a PNG file.
 * @param page the page to capture from
 * @param rect element bounds in absolute page coordinates (page-supplied, re-validated here)
 * @param filePath destination PNG path
 * @param options context padding in px around the rect (default {@link SHOT_PADDING})
 * @returns the clip actually captured
 * @throws when the rect is invalid or the CDP call fails
 */
export async function captureElementShot(
  page: Page,
  rect: Rect,
  filePath: string,
  options: { padding?: number } = {},
): Promise<CaptureClip> {
  const { buffer, clip } = await captureElementBuffer(page, rect, options);
  fs.writeFileSync(filePath, buffer);
  return clip;
}

/**
 * Read a PNG's pixel dimensions from its IHDR header (no image library needed).
 * @param buffer raw PNG bytes
 * @returns null when the buffer is not a valid PNG
 */
export function pngSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24 || buffer.readUInt32BE(12) !== 0x49484452 /* IHDR */) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}
