import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReviewMd, FIX_ANNOTATIONS_MD } from '../src/store/render.js';

const DATA = {
  review: {
    id: '2026-07-20-example.com',
    url: 'https://example.com',
    createdAt: '2026-07-20T10:00:00Z',
    authors: ['Kevin', 'Ann'],
  },
  annotations: [
    {
      id: 'a1',
      type: 'change-request',
      comment: 'Badge should be yellow',
      status: 'open',
      author: 'Kevin',
      viewportScope: 'general',
      viewport: { mode: 'desktop', w: 1440, h: 900 },
      route: '/products',
      target: {
        component: 'app-product-tile',
        ngComponent: 'ProductTileComponent',
        selector: 'app-product-tile:nth-of-type(3) > .badge',
      },
      screenshot: 'shots/a1.png',
      createdAt: '2026-07-20T10:01:00Z',
    },
    {
      id: 'a2',
      type: 'comment',
      comment: 'Nice hover animation',
      status: 'open',
      author: 'Ann',
      viewportScope: 'mobile',
      viewport: { mode: 'mobile', w: 390, h: 844 },
      route: '/',
      target: { component: 'app-header', ngComponent: null, selector: '#logo' },
      screenshot: null,
      createdAt: '2026-07-20T10:02:00Z',
    },
    {
      id: 'a3',
      type: 'change-request',
      comment: 'Fix the footer link',
      status: 'fixed',
      author: 'Kevin',
      viewportScope: 'general',
      viewport: { mode: 'desktop', w: 1440, h: 900 },
      route: '/',
      target: { component: 'app-footer', ngComponent: null, selector: 'footer a.imprint' },
      screenshot: null,
      createdAt: '2026-07-20T10:03:00Z',
    },
  ],
};

const EXPECTED = `# Nit review — https://example.com — 2026-07-20

Authors: Kevin, Ann · 3 annotations · 1 actionable (open change-requests)

## a1 · change-request · open · desktop — Badge should be yellow
**ACTIONABLE** — make this change, then set \`status\` to \`"fixed"\` in annotations.json.
![a1](shots/a1.png)
- component: \`app-product-tile\` (ProductTileComponent)
- selector: \`app-product-tile:nth-of-type(3) > .badge\`
- route: \`/products\` · author: Kevin · scope: general · captured at 1440×900

## a2 · comment · open · mobile — Nice hover animation
*Context only — do not change code for this.*
- component: \`app-header\`
- selector: \`#logo\`
- route: \`/\` · author: Ann · scope: mobile · captured at 390×844

## a3 · change-request · fixed · desktop — Fix the footer link
*Not actionable — status: fixed.*
- component: \`app-footer\`
- selector: \`footer a.imprint\`
- route: \`/\` · author: Kevin · scope: general · captured at 1440×900
`;

test('render: review.md snapshot', () => {
  assert.equal(renderReviewMd(DATA), EXPECTED);
});

test('render: only open change-requests are marked actionable', () => {
  const md = renderReviewMd(DATA);
  const actionableCount = (md.match(/\*\*ACTIONABLE\*\*/g) || []).length;
  assert.equal(actionableCount, 1);
  assert.ok(md.includes('## a1 · change-request · open'));
  assert.ok(md.includes('*Context only — do not change code for this.*'));
  assert.ok(md.includes('*Not actionable — status: fixed.*'));
});

test('render: empty review renders without crashing', () => {
  const md = renderReviewMd({ review: { url: '', createdAt: '', authors: [] }, annotations: [] });
  assert.ok(md.includes('0 annotations'));
});

test('fix-annotations contract mentions the type/status gate', () => {
  assert.ok(FIX_ANNOTATIONS_MD.includes('`status: "open"`'));
  assert.ok(FIX_ANNOTATIONS_MD.includes('`type: "change-request"`'));
  assert.ok(FIX_ANNOTATIONS_MD.includes('do not\nchange code'));
});
