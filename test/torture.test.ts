// Grapheme torture corpus, structural checks.
//
// These do not need a GPU: they assert that the corpus itself is well formed
// (the escapes really encode the clusters they claim) and that the instance
// builder lays clusters out on the grid without splitting or dropping them.
// Pixel-level agreement between the two backends is asserted in the browser
// suite; agreement with a real ghostty-vt is asserted on the host side.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tortureCorpus, buildTortureSource, shapingRequired } from '../src/testing/torture.ts';

test('every corpus entry declares its real scalar count', () => {
  for (const e of tortureCorpus) {
    assert.equal([...e.text].length, e.scalars, `${e.name} scalar count`);
  }
});

test('corpus entry names are unique', () => {
  const names = new Set(tortureCorpus.map((e) => e.name));
  assert.equal(names.size, tortureCorpus.length);
});

test('the corpus covers every hard category', () => {
  const names = tortureCorpus.map((e) => e.name).join(' ');
  for (const needle of [
    'cjk',
    'hangul',
    'fullwidth',
    'emoji-zwj',
    'emoji-flag',
    'emoji-skin-tone',
    'keycap',
    'vs16',
    'vs15',
    'combining',
    'devanagari',
    'arabic',
  ]) {
    assert.ok(names.includes(needle), `corpus is missing a ${needle} case`);
  }
});

test('wide clusters get a width-N head and width-0 spacer tails', () => {
  const s = buildTortureSource();
  tortureCorpus.forEach((entry, row) => {
    if (entry.columns < 2 || entry.layout !== 'wide') return;
    const head = s.getCell(row, 0);
    assert.equal(head.width, entry.columns, `${entry.name} head width`);
    for (let i = 1; i < entry.columns; i++) {
      assert.equal(s.getCell(row, i).width, 0, `${entry.name} spacer tail ${i}`);
    }
  });
});

test('multi-scalar clusters survive as one grapheme string on the head cell', () => {
  const s = buildTortureSource();
  tortureCorpus.forEach((entry, row) => {
    if (entry.scalars < 2) return;
    if (entry.layout === 'split' && entry.columns > 1) return; // split by the VT
    assert.equal(
      s.getGraphemeString(row, 0),
      entry.text,
      `${entry.name} must not be split into separate code points`,
    );
  });
});

test('a ZWJ family is one cluster, not four people', () => {
  const family = tortureCorpus.find((e) => e.name === 'emoji-zwj-family')!;
  const row = tortureCorpus.indexOf(family);
  const s = buildTortureSource();
  assert.equal([...s.getGraphemeString(row, 0)].length, 7);
  assert.equal(s.getCell(row, 0).width, 2, 'the family occupies two columns, not eight');
});

test('combining marks stay on their base cell', () => {
  const s = buildTortureSource();
  for (const name of ['combining-acute', 'combining-stack', 'combining-zalgo']) {
    const entry = tortureCorpus.find((e) => e.name === name)!;
    const row = tortureCorpus.indexOf(entry);
    assert.equal(s.getCell(row, 0).width, 1, `${name} occupies one column`);
    assert.equal(
      s.getGraphemeString(row, 0),
      entry.text,
      `${name} keeps every mark on the base cell`,
    );
  }
});

test('variation selectors change the column count, not just the glyph', () => {
  const vs16 = tortureCorpus.find((e) => e.name === 'vs16-emoji-presentation')!;
  const vs15 = tortureCorpus.find((e) => e.name === 'vs15-text-presentation')!;
  // Same base scalar, opposite presentation, different width.
  assert.equal(vs16.text.codePointAt(0), vs15.text.codePointAt(0));
  assert.equal(vs16.columns, 2);
  assert.equal(vs15.columns, 1);
});

test('the shaping-dependent cases are declared, not silently passing', () => {
  // vtgl has no contextual shaper. These entries are the honest record of what
  // is still wrong, so the set must stay non-empty until a shaper lands.
  assert.ok(shapingRequired.size > 0);
  for (const name of shapingRequired) {
    assert.ok(
      tortureCorpus.some((e) => e.name === name),
      `${name} is marked as needing shaping but is not in the corpus`,
    );
  }
});

test('the atlas keys clusters by string so a shaper can slot in later', async () => {
  const { atlasKey } = await import('../src/atlas/key.ts');
  // Two different clusters that share a first code point must not collide: this
  // is the property that makes string keying (rather than codepoint keying)
  // load bearing, and the reason shaped runs can reuse the same cache.
  const vs16 = tortureCorpus.find((e) => e.name === 'vs16-emoji-presentation')!;
  const vs15 = tortureCorpus.find((e) => e.name === 'vs15-text-presentation')!;
  assert.notEqual(atlasKey(vs16.text, 0), atlasKey(vs15.text, 0));
});
