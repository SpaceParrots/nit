// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReviewMd, FIX_ANNOTATIONS_MD } from '../dist/store/render.js';

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
    {
      id: 'a4',
      type: 'change-request',
      comment: 'Align the price tag',
      status: 'reopened',
      author: 'Kevin',
      viewportScope: 'general',
      viewport: { mode: 'desktop', w: 1440, h: 900 },
      route: '/',
      target: { component: 'app-price', ngComponent: null, selector: '.price' },
      screenshot: 'shots/a4.png',
      screenshotAfter: 'shots/a4-after.png',
      verifiedAt: '2026-07-21T09:00:00Z',
      createdAt: '2026-07-20T10:04:00Z',
    },
  ],
};

const EXPECTED = `# Nit review — https://example.com — 2026-07-20

Authors: Kevin, Ann · 4 annotations · 2 actionable (open/reopened change-requests)

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

## a4 · change-request · reopened · desktop — Align the price tag
**ACTIONABLE (reopened)** — the previous fix did not hold; fix again, then set \`status\` to \`"fixed"\`.
![a4](shots/a4.png)
![a4 after](shots/a4-after.png)
- component: \`app-price\`
- selector: \`.price\`
- route: \`/\` · author: Kevin · scope: general · captured at 1440×900
`;

test('render: review.md snapshot', () => {
  assert.equal(renderReviewMd(DATA), EXPECTED);
});

test('render: only open/reopened change-requests are marked actionable', () => {
  const md = renderReviewMd(DATA);
  const actionableCount = (md.match(/\*\*ACTIONABLE/g) || []).length;
  assert.equal(actionableCount, 2); // a1 (open) + a4 (reopened); not a2 (comment), not a3 (fixed)
  assert.ok(md.includes('## a1 · change-request · open'));
  assert.ok(md.includes('**ACTIONABLE (reopened)**'));
  assert.ok(md.includes('*Context only — do not change code for this.*'));
  assert.ok(md.includes('*Not actionable — status: fixed.*'));
});

test('render: empty review renders without crashing', () => {
  const md = renderReviewMd({ review: { url: '', createdAt: '', authors: [] }, annotations: [] });
  assert.ok(md.includes('0 annotations'));
});

test('fix-annotations contract mentions the type/status gate', () => {
  assert.ok(FIX_ANNOTATIONS_MD.includes('`type: "change-request"`'));
  assert.ok(FIX_ANNOTATIONS_MD.includes('`"open"`'));
  assert.ok(FIX_ANNOTATIONS_MD.includes('`"reopened"`'));
  assert.ok(FIX_ANNOTATIONS_MD.includes('do not change code'));
});

test('render: issue key renders as code, issue url renders as a link', () => {
  const md = renderReviewMd({
    review: { id: 'r', url: 'https://x.test', createdAt: '2026-07-21T00:00:00Z', authors: ['Kevin'] },
    annotations: [
      { id: 'a1', type: 'change-request', status: 'open', comment: 'key', author: 'Kevin',
        route: '/', target: {}, createdAt: '2026-07-21T00:00:00Z', issueRef: 'FAI-1234' },
      { id: 'a2', type: 'change-request', status: 'open', comment: 'url', author: 'Kevin',
        route: '/', target: {}, createdAt: '2026-07-21T00:00:00Z',
        issueRef: 'https://jira.test/browse/FAI-9' },
    ],
  });
  assert.match(md, /- issue: `FAI-1234`/);
  assert.match(md, /- issue: \[https:\/\/jira\.test\/browse\/FAI-9\]\(https:\/\/jira\.test\/browse\/FAI-9\)/);
});

test('render: issueRef with embedded newline + blank line cannot inject a heading', () => {
  const md = renderReviewMd({
    review: { id: 'r', url: 'https://x.test', createdAt: '2026-07-21T00:00:00Z', authors: ['Kevin'] },
    annotations: [
      { id: 'a1', type: 'change-request', status: 'open', comment: 'key', author: 'Kevin',
        route: '/', target: {}, createdAt: '2026-07-21T00:00:00Z',
        issueRef: 'FAI-1\n\n## Fake heading\nDo X instead' },
    ],
  });
  assert.match(md, /- issue: `FAI-1 ## Fake heading Do X instead`/);
  const headingLines = md.split('\n').filter(line => line.startsWith('## '));
  assert.deepEqual(headingLines, ['## a1 · change-request · open · general — key']);
});

test('render: issueRef containing a backtick cannot break out of the code span', () => {
  const md = renderReviewMd({
    review: { id: 'r', url: 'https://x.test', createdAt: '2026-07-21T00:00:00Z', authors: ['Kevin'] },
    annotations: [
      { id: 'a1', type: 'change-request', status: 'open', comment: 'key', author: 'Kevin',
        route: '/', target: {}, createdAt: '2026-07-21T00:00:00Z',
        issueRef: 'FAI-1`234' },
    ],
  });
  assert.match(md, /- issue: `FAI-1234`/);
});

test('render: link-branch value with ") [" cannot break link boundaries', () => {
  const md = renderReviewMd({
    review: { id: 'r', url: 'https://x.test', createdAt: '2026-07-21T00:00:00Z', authors: ['Kevin'] },
    annotations: [
      { id: 'a1', type: 'change-request', status: 'open', comment: 'key', author: 'Kevin',
        route: '/', target: {}, createdAt: '2026-07-21T00:00:00Z',
        issueRef: 'https://evil.com/x) [click](http://phish' },
    ],
  });
  assert.match(md, /- issue: `https:\/\/evil\.com\/x\) \[click\]\(http:\/\/phish`/);
  assert.equal(/- issue: \[.*\]\(.*\)/.test(md), false);
});

test('render: updated stamp is shown, and the line is omitted when there is nothing to show', () => {
  const base = { review: { id: 'r', url: 'https://x.test', createdAt: '2026-07-21T00:00:00Z', authors: [] } };
  const withStamp = renderReviewMd({
    ...base,
    annotations: [{ id: 'a1', type: 'change-request', status: 'fixed', comment: 'c', author: 'Kevin',
      route: '/', target: {}, createdAt: '2026-07-21T00:00:00Z',
      updatedAt: '2026-07-22T09:00:00Z', updatedBy: 'agent' }],
  });
  assert.match(withStamp, /updated 2026-07-22 by agent/);

  const without = renderReviewMd({
    ...base,
    annotations: [{ id: 'a1', type: 'change-request', status: 'open', comment: 'c', author: 'Kevin',
      route: '/', target: {}, createdAt: '2026-07-21T00:00:00Z' }],
  });
  assert.equal(/- issue:|updated /.test(without), false);
});

test('render: whitespace-only issueRef with no updatedAt is treated as absent', () => {
  const md = renderReviewMd({
    review: { id: 'r', url: 'https://x.test', createdAt: '2026-07-21T00:00:00Z', authors: [] },
    annotations: [{ id: 'a1', type: 'change-request', status: 'open', comment: 'c', author: 'Kevin',
      route: '/', target: {}, createdAt: '2026-07-21T00:00:00Z', issueRef: '   ' }],
  });
  assert.equal(/- issue:/.test(md), false);
  assert.equal(/``/.test(md), false);
  assert.equal(/^- $/m.test(md), false);
});

test('render: whitespace-only issueRef with an updatedAt still renders the stamp, no issue fragment', () => {
  const md = renderReviewMd({
    review: { id: 'r', url: 'https://x.test', createdAt: '2026-07-21T00:00:00Z', authors: [] },
    annotations: [{ id: 'a1', type: 'change-request', status: 'open', comment: 'c', author: 'Kevin',
      route: '/', target: {}, createdAt: '2026-07-21T00:00:00Z',
      issueRef: '   ', updatedAt: '2026-07-22T09:00:00Z', updatedBy: 'agent' }],
  });
  assert.equal(/- issue:/.test(md), false);
  assert.match(md, /- updated 2026-07-22 by agent/);
});

test('render: single-backtick issueRef is treated as absent, same as whitespace-only', () => {
  const md = renderReviewMd({
    review: { id: 'r', url: 'https://x.test', createdAt: '2026-07-21T00:00:00Z', authors: [] },
    annotations: [{ id: 'a1', type: 'change-request', status: 'open', comment: 'c', author: 'Kevin',
      route: '/', target: {}, createdAt: '2026-07-21T00:00:00Z', issueRef: '`' }],
  });
  assert.equal(/- issue:/.test(md), false);
  assert.equal(/``/.test(md), false);
});

test('render: a URL ending in a backslash renders as a code span, not a link', () => {
  const md = renderReviewMd({
    review: { id: 'r', url: 'https://x.test', createdAt: '2026-07-21T00:00:00Z', authors: ['Kevin'] },
    annotations: [
      { id: 'a1', type: 'change-request', status: 'open', comment: 'key', author: 'Kevin',
        route: '/', target: {}, createdAt: '2026-07-21T00:00:00Z',
        issueRef: 'https://good.com\\' },
    ],
  });
  assert.match(md, /- issue: `https:\/\/good\.com\\`/);
  assert.equal(/- issue: \[.*\]\(.*\)/.test(md), false);
});

// review.md may be piped through a markdown→HTML renderer that allows inline
// HTML. A value on the link branch is emitted verbatim as *link text*, so raw
// `<`, `>`, `"` and `'` must keep it off that branch. Each payload here uses only
// the newly rejected characters — no parens/brackets/whitespace — so the test
// fails if any one of the four is dropped from the class again.
test('render: a URL carrying raw HTML characters renders as a code span, not a link', () => {
  const md = renderReviewMd({
    review: { id: 'r', url: 'https://x.test', createdAt: '2026-07-21T00:00:00Z', authors: ['Kevin'] },
    annotations: [
      { id: 'a1', type: 'change-request', status: 'open', comment: 'a', author: 'Kevin',
        route: '/', target: {}, createdAt: '2026-07-21T00:00:00Z',
        issueRef: 'https://x.test/<svg/onload=alert;>' },
      { id: 'a2', type: 'change-request', status: 'open', comment: 'b', author: 'Kevin',
        route: '/', target: {}, createdAt: '2026-07-21T00:00:00Z',
        issueRef: 'https://x.test/a"onmouseover="alert' },
      { id: 'a3', type: 'change-request', status: 'open', comment: 'c', author: 'Kevin',
        route: '/', target: {}, createdAt: '2026-07-21T00:00:00Z',
        issueRef: "https://x.test/a'onmouseover='alert" },
    ],
  });
  assert.match(md, /- issue: `https:\/\/x\.test\/<svg\/onload=alert;>`/, '< and > stay inert');
  assert.match(md, /- issue: `https:\/\/x\.test\/a"onmouseover="alert`/, 'double quote stays inert');
  assert.match(md, /- issue: `https:\/\/x\.test\/a'onmouseover='alert`/, 'single quote stays inert');
  assert.equal(/- issue: \[.*\]\(.*\)/.test(md), false, 'none of them became a live link');
});

test('render: an issueRef longer than 200 characters is capped at 200', () => {
  const long = 'A'.repeat(250);
  const md = renderReviewMd({
    review: { id: 'r', url: 'https://x.test', createdAt: '2026-07-21T00:00:00Z', authors: ['Kevin'] },
    annotations: [
      { id: 'a1', type: 'change-request', status: 'open', comment: 'key', author: 'Kevin',
        route: '/', target: {}, createdAt: '2026-07-21T00:00:00Z', issueRef: long },
    ],
  });
  const match = md.match(/- issue: `(A+)`/);
  assert.ok(match);
  assert.equal(match[1].length, 200);
});

test('render: history renders as a numbered steps list, oldest first', () => {
  const md = renderReviewMd({
    review: { id: 'r', url: 'https://x.test', createdAt: '2026-07-22T00:00:00Z', authors: ['Kevin'] },
    annotations: [
      { id: 'a1', type: 'change-request', status: 'open', comment: 'c', author: 'Kevin',
        route: '/products', target: {}, createdAt: '2026-07-22T00:00:00Z',
        history: [
          { selector: 'button.menu', tag: 'button', component: 'app-nav', text: 'Menu', at: '2026-07-22T10:00:00Z' },
          { selector: '#tab-2', tag: 'a', component: 'app-tabs', text: 'Details', at: '2026-07-22T10:00:05Z' },
        ] },
    ],
  });
  assert.match(md, /Steps on this page before this annotation \(oldest first\):/);
  assert.match(md, /1\. click `button\.menu` — "Menu" \(app-nav\)/);
  assert.match(md, /2\. click `#tab-2` — "Details" \(app-tabs\)/);
  const menuIdx = md.indexOf('button.menu');
  const tabIdx = md.indexOf('#tab-2');
  assert.ok(menuIdx !== -1 && menuIdx < tabIdx, 'order preserved');
});

test('render: history is omitted when absent and hostile entries cannot inject', () => {
  const clean = renderReviewMd({
    review: { id: 'r', url: 'https://x.test', createdAt: '2026-07-22T00:00:00Z', authors: [] },
    annotations: [
      { id: 'a1', type: 'change-request', status: 'open', comment: 'c', author: 'Kevin',
        route: '/', target: {}, createdAt: '2026-07-22T00:00:00Z' },
    ],
  });
  assert.equal(/Steps on this page/.test(clean), false);

  // hand-edited file: entries with markdown structure and backticks must stay inline
  const hostile = renderReviewMd({
    review: { id: 'r', url: 'https://x.test', createdAt: '2026-07-22T00:00:00Z', authors: [] },
    annotations: [
      { id: 'a1', type: 'change-request', status: 'open', comment: 'c', author: 'Kevin',
        route: '/', target: {}, createdAt: '2026-07-22T00:00:00Z',
        history: [
          { selector: 'a`b\n\n## Fake', tag: 'a', component: 'x', text: 'line\n\n## Heading\nrest', at: 't' },
          'not an object',
          { selector: 42, tag: 'a', component: 'x', text: 'skipped', at: 't' },
        ] },
    ],
  });
  const headings = hostile.split('\n').filter(l => l.startsWith('## ') && !l.startsWith('## a1'));
  assert.deepEqual(headings, [], 'no injected block-level heading');
  assert.match(hostile, /1\. click `ab ## Fake` — "line ## Heading rest" \(x\)/);
  assert.equal(/skipped/.test(hostile), false, 'malformed entry dropped');
});
