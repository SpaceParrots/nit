// SPDX-License-Identifier: AGPL-3.0-or-later
// Milestone 7 (unit layer): re-anchoring table — selector → xpath → text heuristic → null.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startFixtureServer } from './helpers/server.js';
import { bundleModule } from './helpers/bundle.js';

test('anchor resolution table', async t => {
  const server = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await server.close();
  });
  const page = await browser.newPage();
  await page.goto(server.url + '/');
  await page.addScriptTag({ content: await bundleModule('anchor/anchor.js', 'NitAnchor') });

  const results = await page.evaluate(() => {
    const A = window.NitAnchor;
    const q = s => document.querySelector(s);
    const hero = q('#hero-title');
    const HERO_XPATH = '/html[1]/body[1]/main[1]/fake-hero[1]/h2[1]';
    return {
      bySelector: A.anchorTarget({ selector: '#hero-title' }) === hero,
      byXpathWhenSelectorStale: A.anchorTarget({ selector: '#does-not-exist', xpath: HERO_XPATH }) === hero,
      byInvalidSelectorSyntax: A.anchorTarget({ selector: '#[broken', xpath: HERO_XPATH }) === hero,
      byTextWhenBothStale: A.anchorTarget({
        selector: '#nope', xpath: '/html[1]/body[1]/div[99]',
        component: 'fake-product-tile', tag: 'span', text: 'deep text',
      }) === q('.deep-target'),
      byTextPrefix: A.anchorTarget({
        component: 'fake-hero', tag: 'p', text: 'A tiny SPA used by',
      }) === q('.lead'),
      byClassesWhenNoText: A.anchorTarget({
        component: 'fake-product-tile', tag: 'div', text: '', classes: ['badge', 'badge--muted'],
      }) === q('fake-product-tile .badge'),
      allLayersFail: A.anchorTarget({
        selector: '#nope', xpath: '/html[1]/body[1]/div[99]',
        component: 'no-such-component', tag: 'div', text: 'TEXT THAT EXISTS NOWHERE ON THIS PAGE',
      }),
      nullTarget: A.anchorTarget(null),
      emptyTarget: A.anchorTarget({}),
    };
  });

  assert.equal(results.bySelector, true, 'layer 1: selector');
  assert.equal(results.byXpathWhenSelectorStale, true, 'layer 2: xpath');
  assert.equal(results.byInvalidSelectorSyntax, true, 'invalid selector syntax degrades to xpath');
  assert.equal(results.byTextWhenBothStale, true, 'layer 3: text scoped to component');
  assert.equal(results.byTextPrefix, true, 'capped text matches by prefix');
  assert.equal(results.byClassesWhenNoText, true, 'textless targets match by classes');
  assert.equal(results.allLayersFail, null, 'all layers failing returns null, no crash');
  assert.equal(results.nullTarget, null);
  assert.equal(results.emptyTarget, null);
});
