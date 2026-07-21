// Milestone 3: target resolution unit table (≥8 cases) in a real DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startFixtureServer } from './helpers/server.js';
import { bundleModule } from './helpers/bundle.js';

test('target resolution table', async t => {
  const server = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await server.close();
  });
  const page = await browser.newPage();
  await page.goto(server.url + '/');
  await page.addScriptTag({ content: await bundleModule('capture/target.js', 'NitTarget') });

  const results = await page.evaluate(() => {
    const R = window.NitTarget;
    const q = s => document.querySelector(s);
    const badge1 = q('fake-product-tile .badge');
    const badge2 = document.querySelectorAll('fake-product-tile')[1].querySelector('.badge');
    const deep = q('.deep-target');

    const verify = (target, el) => ({
      ...target,
      selectorResolves: (() => {
        try { return document.querySelector(target.selector) === el; } catch { return false; }
      })(),
      xpathResolves: (() => {
        try { return document.evaluate(target.xpath, document, null, 9, null).singleNodeValue === el; } catch { return false; }
      })(),
    });

    const cases = {};
    // 1: element with id → id selector
    cases.heroById = verify(R.resolveTarget(q('#hero-title')), q('#hero-title'));
    // 2: custom-element ancestor with nth-of-type disambiguation
    cases.badge1 = verify(R.resolveTarget(badge1), badge1);
    // 3: deeply nested element
    cases.deep = verify(R.resolveTarget(deep), deep);
    // 4: window.ng absent → null, never throws
    cases.ngAbsent = R.resolveTarget(badge1).ngComponent;
    // 5: window.ng present → Angular class name from nearest component
    window.ng = {
      getComponent(el) {
        return el.tagName === 'FAKE-PRODUCT-TILE' ? { constructor: { name: 'ProductTileComponent' } } : null;
      },
    };
    cases.ngPresent = R.resolveTarget(badge1).ngComponent;
    // 6: window.ng.getComponent throwing → null, never throws
    window.ng = { getComponent() { throw new Error('boom'); } };
    cases.ngThrows = R.resolveTarget(badge1).ngComponent;
    delete window.ng;
    // 7: no custom-element ancestor → component falls back to own tag
    cases.noCustomAncestor = R.resolveTarget(q('#hdr h1')).component;
    // 8: Angular runtime junk classes are filtered out
    cases.junkClasses = R.resolveTarget(badge2).classes;
    cases.badge2 = verify(R.resolveTarget(badge2), badge2);
    // 9: text normalized and capped at 80 chars
    cases.longText = R.resolveTarget(q('#long-text')).text;
    // 10: ancestor id anchors the selector (nav link inside #hdr)
    const navLink = document.querySelector('#hdr nav a');
    cases.navLink = verify(R.resolveTarget(navLink), navLink);
    // 11: landmark tags (article/section/…) anchor and appear in the path
    const postNote = q('article .post-note');
    cases.postNote = verify(R.resolveTarget(postNote), postNote);
    // 12: rect is absolute page coords even when scrolled
    window.scrollTo(0, 1200);
    const fine = q('.fine-print');
    const r = fine.getBoundingClientRect();
    cases.rect = {
      got: R.resolveTarget(fine).rect,
      expected: {
        x: Math.round(r.x + scrollX), y: Math.round(r.y + scrollY),
        w: Math.round(r.width), h: Math.round(r.height),
      },
    };
    window.scrollTo(0, 0);
    return cases;
  });

  assert.equal(results.heroById.selector, '#hero-title');
  assert.equal(results.heroById.component, 'fake-hero');
  assert.equal(results.heroById.tag, 'h2');
  assert.ok(results.heroById.selectorResolves && results.heroById.xpathResolves);

  assert.equal(results.badge1.component, 'fake-product-tile');
  assert.match(results.badge1.selector, /fake-product-tile/);
  assert.ok(results.badge1.selectorResolves, `badge1 selector unique: ${results.badge1.selector}`);
  assert.ok(results.badge1.xpathResolves);
  assert.equal(results.badge1.text, 'New');

  assert.equal(results.deep.component, 'fake-product-tile');
  assert.ok(results.deep.selectorResolves, `deep selector unique: ${results.deep.selector}`);
  assert.ok(results.deep.xpathResolves);

  assert.equal(results.ngAbsent, null);
  assert.equal(results.ngPresent, 'ProductTileComponent');
  assert.equal(results.ngThrows, null);

  assert.equal(results.noCustomAncestor, 'h1');

  assert.deepEqual(results.junkClasses, ['badge']);
  assert.ok(results.badge2.selectorResolves, `badge2 selector unique: ${results.badge2.selector}`);

  assert.ok(results.longText.length <= 80, `capped: ${results.longText.length}`);
  assert.ok(!results.longText.includes('\n'));

  assert.match(results.navLink.selector, /^#hdr/, `id-anchored: ${results.navLink.selector}`);
  assert.ok(results.navLink.selectorResolves && results.navLink.xpathResolves);

  assert.match(results.postNote.selector, /article/, `landmark in path: ${results.postNote.selector}`);
  assert.ok(results.postNote.selectorResolves && results.postNote.xpathResolves);

  assert.deepEqual(results.rect.got, results.rect.expected);
});
