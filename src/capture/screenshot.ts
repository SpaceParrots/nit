// SPDX-License-Identifier: AGPL-3.0-or-later
// CDP element-clip screenshot (SPEC §2.3): Page.captureScreenshot clipped to the
// element rect in absolute page coordinates, with generous context padding
// (milestone-0 learning: tight crops are useless to the fixing agent).
import fs from 'node:fs';
import type { Page } from 'playwright';
import type { Rect } from '../types.js';

export const SHOT_PADDING = 24;

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
export async function captureElementShot(
  page: Page,
  rect: Rect,
  filePath: string,
  { padding = SHOT_PADDING }: { padding?: number } = {},
): Promise<CaptureClip> {
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
  const clip: CaptureClip = {
    x: Math.max(0, Math.round(x - padding)),
    y: Math.max(0, Math.round(y - padding)),
    width: Math.max(1, Math.round(w + padding * 2)),
    height: Math.max(1, Math.round(h + padding * 2)),
    scale: 1,
  };
  const cdp = await page.context().newCDPSession(page);
  try {
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip,
      captureBeyondViewport: true,
    });
    fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
    return clip;
  } finally {
    await cdp.detach().catch(() => {});
  }
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
