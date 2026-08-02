// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectDialog } from '../dist/capture/context.js';

/** Minimal fake element: just the members detectDialog is allowed to touch. */
function fakeEl({ tag = 'DIV', attrs = {}, classes = [], parent = null, heading = null, text = '' } = {}) {
  const el = {
    nodeType: 1,
    tagName: tag,
    parentElement: parent,
    textContent: text,
    getAttribute: name => (name in attrs ? attrs[name] : null),
    classList: { contains: c => classes.includes(c) },
    querySelector: sel => (sel === 'h1,h2,h3,h4,h5,h6' ? heading : null),
    ownerDocument: null,
  };
  return el;
}

/**
 * A fake document that answers getComputedStyle from each element's `styles`
 * bag — what the suspected tier's position/overflow checks read. Every element
 * in `all` (plus body/documentElement) is wired to it.
 */
function fakeDoc({ body = null, documentElement = null, all = [] } = {}) {
  const doc = {
    body,
    documentElement,
    getElementById: () => null,
    defaultView: { getComputedStyle: n => n.styles ?? {} },
  };
  for (const n of [...all, body, documentElement]) {
    if (n) n.ownerDocument = doc;
  }
  return doc;
}

test('detectDialog: plain page chain returns null', () => {
  const root = fakeEl({ tag: 'BODY' });
  const el = fakeEl({ tag: 'SPAN', parent: fakeEl({ tag: 'DIV', parent: root }) });
  assert.equal(detectDialog(el), null);
});

test('detectDialog: <dialog> ancestor is found, heading is the label', () => {
  const heading = fakeEl({ tag: 'H2', text: '  Checkout   Settings ' });
  const dlg = fakeEl({ tag: 'DIALOG', heading });
  const el = fakeEl({ tag: 'BUTTON', parent: dlg });
  const found = detectDialog(el);
  assert.equal(found.container, dlg);
  assert.equal(found.label, 'Checkout Settings');
});

test('detectDialog: role=dialog / alertdialog / aria-modal ancestors match', () => {
  for (const attrs of [{ role: 'dialog' }, { role: 'alertdialog' }, { 'aria-modal': 'true' }]) {
    const box = fakeEl({ tag: 'DIV', attrs });
    const el = fakeEl({ tag: 'SPAN', parent: box });
    assert.equal(detectDialog(el).container, box, JSON.stringify(attrs));
  }
});

test('detectDialog: overlay container classes match (cdk-overlay-pane, modal, offcanvas)', () => {
  for (const cls of ['cdk-overlay-pane', 'modal', 'offcanvas']) {
    const box = fakeEl({ tag: 'DIV', classes: [cls] });
    const el = fakeEl({ tag: 'SPAN', parent: box });
    assert.equal(detectDialog(el).container, box, cls);
  }
});

test('detectDialog: the annotated element may itself be the container', () => {
  const dlg = fakeEl({ tag: 'DIALOG' });
  assert.equal(detectDialog(dlg).container, dlg);
});

test('detectDialog: aria-label wins over heading', () => {
  const heading = fakeEl({ tag: 'H2', text: 'Heading' });
  const dlg = fakeEl({ tag: 'DIALOG', attrs: { 'aria-label': ' Cart ' }, heading });
  assert.equal(detectDialog(fakeEl({ parent: dlg })).label, 'Cart');
});

test('detectDialog: aria-labelledby resolves ids via ownerDocument', () => {
  const title = fakeEl({ tag: 'SPAN', text: 'Login' });
  const dlg = fakeEl({ tag: 'DIALOG', attrs: { 'aria-labelledby': 't1  missing' } });
  dlg.ownerDocument = { getElementById: id => (id === 't1' ? title : null) };
  assert.equal(detectDialog(fakeEl({ parent: dlg })).label, 'Login');
});

test('detectDialog: label is capped at 60 chars and null when nothing labels the dialog', () => {
  const long = fakeEl({ tag: 'H2', text: 'x'.repeat(200) });
  const dlg = fakeEl({ tag: 'DIALOG', heading: long });
  assert.equal(detectDialog(fakeEl({ parent: dlg })).label.length, 60);
  const bare = fakeEl({ tag: 'DIALOG' });
  assert.equal(detectDialog(fakeEl({ parent: bare })).label, null);
});

test('detectDialog: a [popover] ancestor is a confident match', () => {
  const pop = fakeEl({ tag: 'DIV', attrs: { popover: '' } });
  const found = detectDialog(fakeEl({ tag: 'SPAN', parent: pop }));
  assert.equal(found.container, pop);
  assert.equal(found.confidence, 'confident');
});

test('detectDialog: every semantic/framework match reports confidence "confident"', () => {
  for (const el of [
    fakeEl({ tag: 'DIALOG' }),
    fakeEl({ tag: 'DIV', attrs: { role: 'dialog' } }),
    fakeEl({ tag: 'DIV', attrs: { 'aria-modal': 'true' } }),
    fakeEl({ tag: 'DIV', classes: ['cdk-overlay-pane'] }),
  ]) {
    assert.equal(detectDialog(el).confidence, 'confident', el.tagName);
  }
});

test('detectDialog: a modal-ish class name alone is only "suspected"', () => {
  for (const cls of ['app-modal', 'checkout_drawer', 'ui dialog wrap', 'bottom-sheet', 'popup', 'lightbox', 'flyout']) {
    const box = fakeEl({ tag: 'DIV', attrs: { class: cls } });
    const found = detectDialog(fakeEl({ tag: 'SPAN', parent: box }));
    assert.equal(found?.container, box, cls);
    assert.equal(found.confidence, 'suspected', cls);
  }
});

test('detectDialog: modal-ish word matching respects word boundaries', () => {
  for (const cls of ['modality', 'nomodal', 'unpopular', 'dialogue']) {
    const box = fakeEl({ tag: 'DIV', attrs: { class: cls } });
    assert.equal(detectDialog(fakeEl({ tag: 'SPAN', parent: box })), null, cls);
  }
});

test('detectDialog: a confident ancestor beats a nearer suspected one', () => {
  const dlg = fakeEl({ tag: 'DIV', attrs: { role: 'dialog', 'aria-label': 'Cart' } });
  const body = fakeEl({ tag: 'DIV', attrs: { class: 'modal-body' }, parent: dlg });
  const found = detectDialog(fakeEl({ tag: 'SPAN', parent: body }));
  assert.equal(found.container, dlg, 'reports the real dialog, not its inner .modal-body');
  assert.equal(found.confidence, 'confident');
  assert.equal(found.label, 'Cart');
});

test('detectDialog: a fixed-position ancestor only counts while the page is scroll-locked', () => {
  const build = bodyStyles => {
    const body = fakeEl({ tag: 'BODY' });
    body.styles = bodyStyles;
    const box = fakeEl({ tag: 'DIV', parent: body });
    box.styles = { position: 'fixed' };
    const el = fakeEl({ tag: 'SPAN', parent: box });
    fakeDoc({ body, documentElement: fakeEl({ tag: 'HTML' }), all: [box, el] });
    return { box, el };
  };
  // A sticky header on an ordinary, scrollable page is not a dialog.
  assert.equal(detectDialog(build({ overflow: 'visible' }).el), null);
  // The same box while a modal holds the screen is worth asking about.
  const locked = build({ overflow: 'hidden' });
  assert.equal(detectDialog(locked.el).container, locked.box);
  assert.equal(detectDialog(locked.el).confidence, 'suspected');
});

test('detectDialog: a scroll-lock class on body counts as the lock', () => {
  const body = fakeEl({ tag: 'BODY', attrs: { class: 'app modal-open' } });
  const box = fakeEl({ tag: 'DIV', parent: body });
  box.styles = { position: 'fixed' };
  const el = fakeEl({ tag: 'SPAN', parent: box });
  fakeDoc({ body, all: [box, el] });
  assert.equal(detectDialog(el).container, box);
});

test('detectDialog: body and html are never claimed as the container', () => {
  const body = fakeEl({ tag: 'BODY', attrs: { class: 'modal-open' } });
  body.styles = { position: 'fixed', overflow: 'hidden' };
  const el = fakeEl({ tag: 'SPAN', parent: body });
  fakeDoc({ body, all: [el] });
  assert.equal(detectDialog(el), null, 'a scroll-locked body is not itself the dialog');
});

test('detectDialog: elements that cannot be measured degrade to null, never throw', () => {
  const box = fakeEl({ tag: 'DIV' });
  box.ownerDocument = { defaultView: { getComputedStyle: () => { throw new Error('detached'); } } };
  assert.equal(detectDialog(fakeEl({ tag: 'SPAN', parent: box })), null);
});
