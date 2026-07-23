// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure after-shot policy (util/after-shots.ts): which viewport is THE primary
// before/after comparison, which viewports want a shot at all, and how the keyed
// screenshotsAfter map + legacy screenshotAfter mirror resolve per mode. The
// values come out of a shared, hand-editable file, so junk must degrade safely.
import test from 'node:test';
import assert from 'node:assert/strict';
import { primaryAfterMode, wantedAfterModes, afterShotFor } from '../dist/util/after-shots.js';

const desktopVp = { mode: 'desktop', w: 1440, h: 900 };
const mobileVp = { mode: 'mobile', w: 390, h: 844 };

test('primaryAfterMode: scope wins, else the captured viewport, else desktop', () => {
  const cases = [
    // scoped: the scope is primary even when the before-shot viewport differs
    { name: 'desktop scope, mobile capture', ann: { viewportScope: 'desktop', viewport: mobileVp }, want: 'desktop' },
    { name: 'mobile scope, desktop capture', ann: { viewportScope: 'mobile', viewport: desktopVp }, want: 'mobile' },
    // general: the viewport the before-shot was captured at
    { name: 'general, desktop capture', ann: { viewportScope: 'general', viewport: desktopVp }, want: 'desktop' },
    { name: 'general, mobile capture', ann: { viewportScope: 'general', viewport: mobileVp }, want: 'mobile' },
    // untrusted file data degrades to desktop
    { name: 'junk scope + junk viewport mode', ann: { viewportScope: 'tablet', viewport: { mode: 'tablet', w: 1, h: 1 } }, want: 'desktop' },
    { name: 'missing viewport', ann: { viewportScope: 'general', viewport: undefined }, want: 'desktop' },
  ];
  for (const { name, ann, want } of cases) {
    assert.equal(primaryAfterMode(ann), want, name);
  }
});

test('wantedAfterModes: scoped wants one viewport, general wants both (primary first)', () => {
  const cases = [
    { name: 'desktop scope', ann: { viewportScope: 'desktop', viewport: mobileVp }, want: ['desktop'] },
    { name: 'mobile scope', ann: { viewportScope: 'mobile', viewport: desktopVp }, want: ['mobile'] },
    { name: 'general captured on desktop', ann: { viewportScope: 'general', viewport: desktopVp }, want: ['desktop', 'mobile'] },
    { name: 'general captured on mobile', ann: { viewportScope: 'general', viewport: mobileVp }, want: ['mobile', 'desktop'] },
  ];
  for (const { name, ann, want } of cases) {
    assert.deepEqual(wantedAfterModes(ann), want, name);
  }
});

test('afterShotFor: keyed entry wins, legacy mirror answers only for the primary mode', () => {
  const general = { viewportScope: 'general', viewport: desktopVp };
  const cases = [
    { name: 'keyed entry wins over the mirror',
      ann: { ...general, screenshotAfter: 'shots/legacy.png', screenshotsAfter: { desktop: 'shots/a1-after.png' } },
      mode: 'desktop', want: 'shots/a1-after.png' },
    { name: 'non-primary mode reads its own keyed entry',
      ann: { ...general, screenshotAfter: 'shots/a1-after.png', screenshotsAfter: { mobile: 'shots/a1-after-mobile.png' } },
      mode: 'mobile', want: 'shots/a1-after-mobile.png' },
    // an older nit only wrote screenshotAfter — it still answers, but only for the primary
    { name: 'legacy screenshotAfter answers for the primary mode',
      ann: { ...general, screenshotAfter: 'shots/a1-after.png' },
      mode: 'desktop', want: 'shots/a1-after.png' },
    { name: 'legacy screenshotAfter does NOT answer for the other mode',
      ann: { ...general, screenshotAfter: 'shots/a1-after.png' },
      mode: 'mobile', want: undefined },
    // untrusted file data: junk in the keyed map is ignored (and may fall back to the mirror)
    { name: 'non-string keyed junk is ignored, mirror answers',
      ann: { ...general, screenshotAfter: 'shots/a1-after.png', screenshotsAfter: { desktop: 42 } },
      mode: 'desktop', want: 'shots/a1-after.png' },
    { name: 'empty-string keyed junk is ignored',
      ann: { ...general, screenshotsAfter: { mobile: '' } },
      mode: 'mobile', want: undefined },
    { name: 'nothing captured yet',
      ann: { ...general },
      mode: 'desktop', want: undefined },
  ];
  for (const { name, ann, mode, want } of cases) {
    assert.equal(afterShotFor(ann, mode), want, name);
  }
});
