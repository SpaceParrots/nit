// SPDX-License-Identifier: AGPL-3.0-or-later
// Milestone 11 (integration): the panel's filter dropdown sorts, groups by page,
// and collapses/expands groups on click — the current route's group starts open,
// every other group starts collapsed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startFixtureServer } from './helpers/server.js';
import { startTestSession, waitFor, tmpDir } from './helpers/session.js';

function makeFeedback(url) {
  return {
    review: { id: 'panel-fixture', url: `${url}/`, createdAt: '2026-07-20T10:00:00Z', authors: ['Kevin'] },
    annotations: [
      {
        id: 'a1', type: 'change-request', comment: 'Welcome heading tweak', status: 'open', author: 'Kevin',
        viewportScope: 'general', viewport: { mode: 'desktop', w: 1440, h: 900 }, route: '/',
        target: { component: 'fake-hero', ngComponent: null, selector: '#hero-title', xpath: '/html[1]/body[1]/main[1]/fake-hero[1]/h2[1]', tag: 'h2', classes: [], text: 'Welcome to the fixture', rect: { x: 20, y: 80, w: 300, h: 30 } },
        screenshot: null, createdAt: '2026-07-20T10:01:00Z',
      },
      {
        id: 'a2', type: 'comment', comment: 'Button label unclear', status: 'open', author: 'Kevin',
        viewportScope: 'general', viewport: { mode: 'desktop', w: 1440, h: 900 }, route: '/about',
        target: { component: 'fake-about', ngComponent: null, selector: '#cta', xpath: '/html[1]/body[1]/main[1]/fake-about[1]/button[1]', tag: 'button', classes: [], text: 'Click me', rect: { x: 20, y: 80, w: 80, h: 30 } },
        screenshot: null, createdAt: '2026-07-20T10:02:00Z',
      },
    ],
  };
}

test('nit panel — filter dropdown sort, group and collapse', async t => {
  const server = await startFixtureServer();
  const dir = tmpDir('nit-panel-');
  const reviewFile = path.join(dir, 'annotations.json');
  fs.writeFileSync(reviewFile, JSON.stringify(makeFeedback(server.url), null, 2));

  const S = await startTestSession({ mode: 'view', url: undefined, reviewFile });
  t.after(async () => {
    await S.session.close();
    await server.close();
  });

  await t.test('groups by page with the current route expanded and others collapsed', async () => {
    const panel = S.session.panelPage;
    await waitFor(async () => (await panel.locator('.nit-group').count()) >= 2 ? true : null,
      { message: 'two route groups' });
    const first = panel.locator('.nit-group').first();
    assert.equal(await first.getAttribute('data-group'), '/', 'current route first');
    assert.equal(await first.locator('.nit-item').count() > 0, true, 'current route expanded');
    const other = panel.locator('.nit-group[data-group="/about"]');
    assert.equal(await other.locator('.nit-item').count(), 0, 'other routes collapsed');
  });

  await t.test('a group header toggles its items', async () => {
    const panel = S.session.panelPage;
    await panel.locator('.nit-group[data-group="/about"] .nit-group-head').click();
    await waitFor(async () => (await panel.locator('.nit-group[data-group="/about"] .nit-item').count()) === 1
      ? true : null, { message: 'about group expands' });
    // toggling again collapses it back
    await panel.locator('.nit-group[data-group="/about"] .nit-group-head').click();
    await waitFor(async () => (await panel.locator('.nit-group[data-group="/about"] .nit-item').count()) === 0
      ? true : null, { message: 'about group collapses again' });
  });

  await t.test('switching group to none flattens the list', async () => {
    const panel = S.session.panelPage;
    await panel.locator('.nit-filter-btn').click();
    await panel.locator('.nit-group-by[data-group="none"]').click();
    await waitFor(async () => (await panel.locator('.nit-group').count()) === 0 ? true : null,
      { message: 'no group sections' });
    await waitFor(async () => (await panel.locator('.nit-item').count()) === 2 ? true : null,
      { message: 'both items shown flat' });
  });

  await t.test('sort row is present and the active sort is highlighted', async () => {
    const panel = S.session.panelPage;
    const active = panel.locator('.nit-sort.active');
    assert.equal(await active.count(), 1, 'exactly one sort option marked active');
    assert.equal(await active.getAttribute('data-sort'), 'time', 'default sort is time');
  });
});

function makeGotoFeedback(url) {
  return {
    review: { id: 'goto-fixture', url: `${url}/`, createdAt: '2026-07-20T10:00:00Z', authors: ['Kevin'] },
    annotations: [
      {
        id: 'a1', type: 'change-request', comment: 'Welcome heading tweak', status: 'open', author: 'Kevin',
        viewportScope: 'general', viewport: { mode: 'desktop', w: 1440, h: 900 }, route: '/',
        target: { component: 'fake-hero', ngComponent: null, selector: '#hero-title', xpath: '/html[1]/body[1]/main[1]/fake-hero[1]/h2[1]', tag: 'h2', classes: [], text: 'Welcome to the fixture', rect: { x: 20, y: 80, w: 300, h: 30 } },
        screenshot: null, createdAt: '2026-07-20T10:01:00Z',
      },
      {
        id: 'a3', type: 'comment', comment: 'CTA needs a tracker', status: 'open', author: 'Kevin',
        viewportScope: 'general', viewport: { mode: 'desktop', w: 1440, h: 900 }, route: '/about',
        target: { component: 'fake-about', ngComponent: null, selector: '#cta', xpath: '/html[1]/body[1]/main[1]/fake-about[1]/button[1]', tag: 'button', classes: [], text: 'Click me', rect: { x: 20, y: 80, w: 80, h: 30 } },
        screenshot: null, createdAt: '2026-07-20T10:02:00Z',
      },
    ],
  };
}

test('nit panel — expanded item: timestamps, issue ref, go to page', async t => {
  const server = await startFixtureServer();
  const dir = tmpDir('nit-goto-');
  const reviewFile = path.join(dir, 'annotations.json');
  fs.writeFileSync(reviewFile, JSON.stringify(makeGotoFeedback(server.url), null, 2));

  const S = await startTestSession({ mode: 'view', url: undefined, reviewFile });
  t.after(async () => {
    await S.session.close();
    await server.close();
  });

  await t.test('expanded item shows the created stamp; the issue input survives a poll tick and Escape reverts without committing', async () => {
    const panel = S.session.panelPage;
    await panel.locator('.nit-item[data-id="a1"]').click();
    await waitFor(async () => (await panel.locator('.nit-item[data-id="a1"] .meta').count()) === 1 ? true : null,
      { message: 'item expands' });
    // "created" and its value are now separate grid cells of a .meta-row
    // rather than words on one text line, so innerText joins them with a
    // line break instead of a space.
    const metaText = await panel.locator('.nit-item[data-id="a1"] .meta').innerText();
    assert.match(metaText, /created\s+2026-07-20 \d{2}:\d{2}/i, 'created stamp rendered');

    const input = panel.locator('.nit-item[data-id="a1"] .nit-issue');
    await input.click();
    await input.fill('WIP-1');
    // outlast the 600ms poll tick — the tick() focus-guard must not steal the caret or revert the text
    await new Promise(resolve => setTimeout(resolve, 900));
    assert.equal(await input.inputValue(), 'WIP-1', 'typed value survives a poll tick');
    assert.equal(await input.evaluate(el => el === document.activeElement), true, 'input keeps focus across a poll tick');

    await input.press('Escape');
    assert.equal(await input.inputValue(), '', 'Escape reverts the input to the stored value');
    const afterEscape = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
    assert.equal(afterEscape.annotations.find(a => a.id === 'a1').issueRef, undefined, 'Escape does not commit');
  });

  await t.test('setting an issue ref persists to annotations.json with exactly one commit', async () => {
    const panel = S.session.panelPage;
    const input = panel.locator('.nit-item[data-id="a1"] .nit-issue');
    await input.fill('FAI-1234');
    await input.press('Enter'); // Enter triggers blur, and blur commits — must not double-fire
    await waitFor(() => {
      const data = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
      const a1 = data.annotations.find(a => a.id === 'a1');
      return a1.issueRef === 'FAI-1234' && a1.updatedAt ? true : null;
    }, { message: 'issue ref written with a stamp' });
    const commits = S.logs.filter(l => l.includes('issue FAI-1234')).length;
    assert.equal(commits, 1, 'a single Enter press commits exactly once');

    await panel.locator('.nit-item[data-id="a1"]').click(); // collapse
    await waitFor(async () => (await panel.locator('.nit-item[data-id="a1"] .nit-issue-chip').count()) === 1
      ? true : null, { message: 'issue chip shown on the collapsed row' });
    assert.equal(await panel.locator('.nit-item[data-id="a1"] .nit-issue-chip').innerText(), 'FAI-1234');
  });

  await t.test('Go to page is disabled for an annotation on the current route', async () => {
    const panel = S.session.panelPage;
    await panel.locator('.nit-item[data-id="a1"]').click(); // expand a1 again (route "/", the current route)
    assert.equal(await panel.locator('.nit-item[data-id="a1"] .nit-goto').isDisabled(), true);
    await panel.locator('.nit-item[data-id="a1"]').click(); // collapse
  });

  await t.test('Go to page navigates the site page, focuses the pin, and then disables itself once current', async () => {
    const panel = S.session.panelPage;
    const page = S.session.page;
    await panel.locator('.nit-group[data-group="/about"] .nit-group-head').click();
    await panel.locator('.nit-item[data-id="a3"]').click();
    const goto = panel.locator('.nit-item[data-id="a3"] .nit-goto');
    assert.equal(await goto.isDisabled(), false, 'go-to enabled for an annotation on another route');

    await goto.click();
    await waitFor(async () => {
      // mid-navigation, evaluate() can transiently throw as the execution context tears down
      try { return (await page.evaluate(() => location.pathname)) === '/about' ? true : null; }
      catch { return null; }
    }, { message: 'site page navigated to /about' });
    await waitFor(async () => (await page.locator('.nit-pin').count()) === 1 ? true : null,
      { message: 'pin re-anchored on the new route' });

    // Navigating flipped which group is "current", which flips that group's
    // *default* expanded state — and since we explicitly toggled it open earlier,
    // the toggle now inverts against the new default and closes it. Re-click the
    // header once to drop the stale toggle and land back on the (now correct)
    // default of open. This is a real interaction of the grouping feature, not a
    // test artifact, so it is asserted directly rather than papered over.
    await panel.locator('.nit-group[data-group="/about"] .nit-group-head').click();

    // once the panel's polled state reflects the new route, a3 (now on the current
    // page) disables its own go-to button — read directly instead of the fragile
    // collapse/expand-to-reread dance, since a route change already forces a repaint.
    await waitFor(async () => (await panel.locator('.nit-item[data-id="a3"] .nit-goto').isDisabled())
      ? true : null, { message: 'go-to disables once its route is the current one' });
  });
});

// Regression coverage for the finding: `tick()` skipped every poll while ANY
// <input> held focus (or while the menu was open). The filter menu's own scope
// checkbox is an <input>, and closing the menu never blurred it — so opening the
// menu and touching the checkbox froze the panel permanently: no new annotation,
// count, mode or grouping change would ever appear again.
test('nit panel — the filter menu never strands the poll loop', async t => {
  const server = await startFixtureServer();
  const dir = tmpDir('nit-menu-');
  const reviewFile = path.join(dir, 'annotations.json');
  fs.writeFileSync(reviewFile, JSON.stringify(makeFeedback(server.url), null, 2));

  const S = await startTestSession({ mode: 'view', url: undefined, reviewFile });
  t.after(async () => {
    await S.session.close();
    await server.close();
  });

  /** Append an annotation to the live store — the panel must repaint its count. */
  function addAnnotation(id) {
    S.session.store.upsert({
      id, type: 'change-request', comment: `added ${id}`, status: 'open', author: 'Kevin',
      viewportScope: 'general', viewport: { mode: 'desktop', w: 1440, h: 900 }, route: '/',
      target: { component: 'fake-hero', ngComponent: null, selector: '#hero-title', xpath: '/html[1]', tag: 'h2', classes: [], text: '', rect: { x: 20, y: 80, w: 300, h: 30 } },
      screenshot: null, createdAt: '2026-07-20T10:05:00Z',
    });
  }

  await t.test('focusing the scope checkbox and closing with Escape leaves the panel live', async () => {
    const panel = S.session.panelPage;
    await waitFor(async () => (await panel.locator('#count').innerText()).startsWith('2 ') ? true : null,
      { message: 'panel shows the two fixture annotations' });

    await panel.locator('.nit-filter-btn').click();
    await waitFor(async () => await panel.locator('.nit-filter').isVisible() ? true : null,
      { message: 'filter menu open' });
    await panel.locator('.nit-filter').focus();
    assert.equal(await panel.evaluate(() => document.activeElement?.classList.contains('nit-filter')), true,
      'the scope checkbox holds focus');

    await panel.keyboard.press('Escape');
    await waitFor(async () => await panel.locator('.nit-filter').isVisible() ? null : true,
      { message: 'filter menu closed' });
    assert.equal(await panel.evaluate(() => document.activeElement?.classList.contains('nit-filter')), false,
      'closing the menu blurred the checkbox');

    addAnnotation('a9');
    await waitFor(async () => (await panel.locator('#count').innerText()).startsWith('3 ') ? true : null,
      { message: 'panel picks up state changed after the menu interaction' });
  });

  await t.test('the menu closes when the panel window loses focus', async () => {
    const panel = S.session.panelPage;
    await panel.locator('.nit-filter-btn').click();
    await waitFor(async () => await panel.locator('.nit-filter').isVisible() ? true : null,
      { message: 'filter menu open again' });

    // The outside-click closer only listens on the panel's own document; leaving
    // the window is the seam that used to strand `menuOpen` at true.
    await panel.evaluate(() => window.dispatchEvent(new Event('blur')));
    await waitFor(async () => await panel.locator('.nit-filter').isVisible() ? null : true,
      { message: 'filter menu closed on window blur' });

    addAnnotation('a10');
    await waitFor(async () => (await panel.locator('#count').innerText()).startsWith('4 ') ? true : null,
      { message: 'panel still polls after the window lost focus with the menu open' });
  });
});

function makeGotoQueryFeedback(url) {
  return {
    review: { id: 'goto-query-fixture', url: `${url}/about?id=9`, createdAt: '2026-07-20T10:00:00Z', authors: ['Kevin'] },
    annotations: [
      {
        id: 'a5', type: 'comment', comment: 'CTA needs the id=5 variant', status: 'open', author: 'Kevin',
        viewportScope: 'general', viewport: { mode: 'desktop', w: 1440, h: 900 }, route: '/about?id=5',
        target: { component: 'fake-about', ngComponent: null, selector: '#cta', xpath: '/html[1]/body[1]/main[1]/fake-about[1]/button[1]', tag: 'button', classes: [], text: 'Click me', rect: { x: 20, y: 80, w: 80, h: 30 } },
        screenshot: null, createdAt: '2026-07-20T10:03:00Z',
      },
    ],
  };
}

// Regression coverage for the finding: the disabled check used to compare
// pathnames only (routePath), discarding the query string, while __nitGoTo
// decides "already on this page" using pathname AND search. That disagreement
// disabled the button for an annotation on a different query of the *same*
// path, even though clicking it would have correctly navigated.
test('nit panel — go to page is enabled across different queries of the same path', async t => {
  const server = await startFixtureServer();
  const dir = tmpDir('nit-goto-query-');
  const reviewFile = path.join(dir, 'annotations.json');
  fs.writeFileSync(reviewFile, JSON.stringify(makeGotoQueryFeedback(server.url), null, 2));

  // Site starts on /about?id=9; the annotation lives on /about?id=5 — same
  // path, different query.
  const S = await startTestSession({ mode: 'view', url: undefined, reviewFile });
  t.after(async () => {
    await S.session.close();
    await server.close();
  });

  await t.test('go-to is enabled for a different query on the current path, and navigates to the exact route', async () => {
    const panel = S.session.panelPage;
    const page = S.session.page;

    await waitFor(async () => {
      try { return (await page.evaluate(() => location.pathname + location.search)) === '/about?id=9' ? true : null; }
      catch { return null; }
    }, { message: 'site page starts on /about?id=9' });

    await panel.locator('.nit-item[data-id="a5"]').click();
    const goto = panel.locator('.nit-item[data-id="a5"] .nit-goto');
    await waitFor(async () => (await goto.count()) === 1 ? true : null, { message: 'a5 expands' });
    assert.equal(await goto.isDisabled(), false,
      'go-to enabled: same path but a different query is NOT "the current page"');

    await goto.click();
    await waitFor(async () => {
      try { return (await page.evaluate(() => location.pathname + location.search)) === '/about?id=5' ? true : null; }
      catch { return null; }
    }, { message: 'site page navigated to the annotation\'s exact query (/about?id=5)' });

    // Once the panel's polled state reflects the new query, the button disables
    // itself again — proving the disabled check and the navigation agree both
    // ways, not just that the click happened to work.
    await waitFor(async () => (await panel.locator('.nit-item[data-id="a5"] .nit-goto').isDisabled())
      ? true : null, { message: 'go-to disables once its exact route is current' });
  });
});

test('nit panel — editing a comment', async t => {
  const server = await startFixtureServer();
  const dir = tmpDir('nit-edit-');
  const reviewFile = path.join(dir, 'annotations.json');
  fs.writeFileSync(reviewFile, JSON.stringify(makeGotoFeedback(server.url), null, 2));

  const S = await startTestSession({ mode: 'view', url: undefined, reviewFile });
  t.after(async () => {
    await S.session.close();
    await server.close();
  });
  const panel = S.session.panelPage;
  const editor = () => panel.locator('.nit-item[data-id="a1"] .nit-comment-edit');

  await waitFor(async () => (await panel.locator('.nit-item[data-id="a1"]').count()) === 1 ? true : null,
    { message: 'item listed' });
  await panel.locator('.nit-item[data-id="a1"]').click();
  await waitFor(async () => (await editor().count()) === 1 ? true : null, { message: 'editor visible' });

  await t.test('blur commits the new text and stamps the edit', async () => {
    await editor().fill('Heading copy needs the brand voice');
    await panel.locator('body').click(); // blur → commit
    await waitFor(() => {
      const d = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
      const a = d.annotations.find(x => x.id === 'a1');
      return a.comment === 'Heading copy needs the brand voice' && a.updatedAt ? a : null;
    }, { message: 'comment persisted with a stamp' });
    const logs = S.logs.filter(l => l.includes('comment edited'));
    assert.equal(logs.length, 1, 'exactly one edit write');
  });

  await t.test('Escape reverts without a write', async () => {
    await panel.locator('.nit-item[data-id="a1"]').click(); // collapse
    await panel.locator('.nit-item[data-id="a1"]').click(); // re-expand fresh
    await waitFor(async () => (await editor().count()) === 1 ? true : null, { message: 'editor back' });
    await editor().fill('discarded draft');
    await editor().press('Escape');
    await panel.waitForTimeout(300);
    const d = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
    assert.equal(d.annotations.find(x => x.id === 'a1').comment, 'Heading copy needs the brand voice');
    assert.equal(await editor().inputValue(), 'Heading copy needs the brand voice', 'textarea restored');
  });

  await t.test('an emptied textarea reverts instead of committing', async () => {
    await editor().fill('');
    await panel.locator('body').click(); // blur
    await panel.waitForTimeout(300);
    const d = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
    assert.equal(d.annotations.find(x => x.id === 'a1').comment, 'Heading copy needs the brand voice');
    assert.equal(S.logs.filter(l => l.includes('comment edited')).length, 1, 'no second write');
  });

  await t.test('expanded item shows a syntax-highlighted selector', async () => {
    const panel = S.session.panelPage;
    // a1 is still expanded from the previous subtests — collapse, then re-expand
    // fresh, same as the "Escape reverts" subtest above, so a single click always
    // lands on the expanded state regardless of what ran before it.
    await panel.locator('.nit-item[data-id="a1"]').click();
    await panel.locator('.nit-item[data-id="a1"]').click();
    await waitFor(async () => (await panel.locator('.sel-code').count()) === 1 ? true : null,
      { message: 'selector code line appears' });
    const idSpan = panel.locator('.sel-code .sel-id');
    assert.equal(await idSpan.count(), 1, 'one id token');
    assert.equal(await idSpan.textContent(), '#hero-title');
    assert.equal(await panel.locator('.sel-code').textContent(), '#hero-title', 'lossless');
  });

  await t.test('expanded item labels fields with badges and icon rows', async () => {
    const panel = S.session.panelPage;
    await waitFor(async () => (await panel.locator('.meta-badges').count()) === 1 ? true : null,
      { message: 'badge row appears' });
    const status = panel.locator('.badge-status');
    assert.equal(await status.count(), 1, 'one status badge');
    assert.equal(await status.getAttribute('data-status'), 'open');
    assert.ok((await status.getAttribute('class')).includes('badge-status--open'), 'known status gets modifier');
    const scope = panel.locator('.badge-scope');
    assert.equal(await scope.count(), 1, 'one scope badge');
    assert.equal((await scope.textContent()).trim(), 'general');
    assert.equal(await scope.locator('svg').count(), 1, 'scope badge has an icon');
    // This test earlier committed an edit to a1's comment (the "blur commits
    // the new text and stamps the edit" subtest), which stamps updatedAt — so
    // the updated row is present here, unlike a never-edited annotation.
    const labels = await panel.locator('.meta-row .meta-label').allTextContents();
    assert.deepEqual(labels, ['created', 'updated', 'component', 'selector', 'id'], 'labeled rows in order');
    assert.equal(await panel.locator('.meta-row .meta-value .sel-code').count(), 1, 'selector row keeps highlighting');
    assert.equal(await panel.locator('.meta-row .meta-value').last().textContent(), 'a1', 'id row shows the id');
    assert.equal(await panel.locator('.meta-row .meta-ico svg').count(), 5, 'every row has an icon');
  });
});
