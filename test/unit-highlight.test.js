// SPDX-License-Identifier: AGPL-3.0-or-later
// Selector tokenizer unit table: every token kind, quoted attrs, lossless fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenizeSelector } from '../dist/panel/highlight.js';

const join = toks => toks.map(t => t.text).join('');
const kinds = toks => toks.map(t => t.kind);

test('tokenizeSelector table', async t => {
  await t.test('empty string → no tokens', () => {
    assert.deepEqual(tokenizeSelector(''), []);
  });

  await t.test('plain id', () => {
    assert.deepEqual(tokenizeSelector('#hero-title'), [{ kind: 'id', text: '#hero-title' }]);
  });

  await t.test('tag + class + descendant', () => {
    const toks = tokenizeSelector('nav a.active');
    assert.deepEqual(toks, [
      { kind: 'tag', text: 'nav' },
      { kind: 'combinator', text: ' ' },
      { kind: 'tag', text: 'a' },
      { kind: 'class', text: '.active' },
    ]);
  });

  await t.test('attr with quoted value', () => {
    const toks = tokenizeSelector('li[data-id="42"]');
    assert.deepEqual(toks, [
      { kind: 'tag', text: 'li' },
      { kind: 'attr', text: '[data-id="42"]' },
    ]);
  });

  await t.test('quoted value containing ] and escaped quote stays one attr token', () => {
    const sel = 'div[data-id="a]b\\"c"] span';
    const toks = tokenizeSelector(sel);
    assert.equal(join(toks), sel);
    assert.equal(toks[1].kind, 'attr');
    assert.equal(toks[1].text, '[data-id="a]b\\"c"]');
  });

  await t.test('pseudo with argument and child combinator', () => {
    const toks = tokenizeSelector('section:nth-of-type(2) > p');
    assert.deepEqual(kinds(toks), ['tag', 'pseudo', 'combinator', 'tag']);
    assert.equal(toks[1].text, ':nth-of-type(2)');
    assert.equal(toks[2].text, ' > ');
  });

  await t.test('escaped characters inside id/class stay in one token', () => {
    const sel = '#a\\.b .c\\:d';
    const toks = tokenizeSelector(sel);
    assert.equal(join(toks), sel);
    assert.deepEqual(kinds(toks), ['id', 'combinator', 'class']);
  });

  await t.test('unclosed attr bracket is lossless', () => {
    const sel = 'a[data-id="broken';
    assert.equal(join(tokenizeSelector(sel)), sel);
  });

  await t.test('unknown characters fall back to text tokens, lossless', () => {
    const sel = 'a {{weird}} b';
    const toks = tokenizeSelector(sel);
    assert.equal(join(toks), sel);
    assert.ok(toks.some(tok => tok.kind === 'text'));
  });

  await t.test('kitchen sink round-trips', () => {
    const sel = '#hdr nav[data-id="m\\"x"] > ul.menu li:nth-of-type(3) a.active';
    assert.equal(join(tokenizeSelector(sel)), sel);
  });
});
