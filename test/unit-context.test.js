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
