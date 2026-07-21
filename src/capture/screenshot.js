// CDP element-clip screenshot (SPEC §2.3): Page.captureScreenshot clipped to the
// element rect in absolute page coordinates, with generous context padding
// (milestone-0 learning: tight crops are useless to the fixing agent).
import fs from 'node:fs';

export const SHOT_PADDING = 24;

/**
 * @param {import('playwright').Page} page
 * @param {{x: number, y: number, w: number, h: number}} rect absolute page coords
 * @param {string} filePath destination PNG
 * @returns {Promise<{x: number, y: number, width: number, height: number}>} the clip used
 */
export async function captureElementShot(page, rect, filePath, { padding = SHOT_PADDING } = {}) {
  if (!rect || !(rect.w >= 0) || !(rect.h >= 0)) throw new Error('invalid rect');
  const clip = {
    x: Math.max(0, Math.round(rect.x - padding)),
    y: Math.max(0, Math.round(rect.y - padding)),
    width: Math.max(1, Math.round(rect.w + padding * 2)),
    height: Math.max(1, Math.round(rect.h + padding * 2)),
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

/** Minimal PNG header parse (for tests / sanity checks). */
export function pngSize(buffer) {
  if (buffer.length < 24 || buffer.readUInt32BE(12) !== 0x49484452 /* IHDR */) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}
