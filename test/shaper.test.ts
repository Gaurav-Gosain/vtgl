// Arabic contextual shaper, structural checks.
//
// These assert the joining decisions and the run-local ordering, which is the
// part that is ours. Whether the browser then draws the right glyph for a given
// joining context is a pixel question and is asserted in the browser suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { arabicShaper, isArabic, joiningType } from '../src/shaper/arabic.ts';
import { tortureCorpus } from '../src/testing/torture.ts';
import type { RunStyle } from '../src/types.ts';

const ZWJ = '‍';
const PLAIN: RunStyle = { bold: false, italic: false };

/** Shape a word and return one entry per logical letter, in logical order. */
function shape(word: string): Array<{ cluster: string; col: number; fit: boolean }> {
  const cells = [...word];
  const run = arabicShaper().shapeRun(cells, PLAIN);
  return run.glyphs.map((g) => ({ cluster: g.cluster, col: g.col, fit: g.fitAdvance }));
}

test('joining types match ArabicShaping.txt for the letters that matter', () => {
  // D dual, R right, T transparent, U non-joining, C join-causing.
  assert.equal(joiningType(0x0628), 1, 'beh is dual-joining');
  assert.equal(joiningType(0x0633), 1, 'seen is dual-joining');
  assert.equal(joiningType(0x0644), 1, 'lam is dual-joining');
  assert.equal(joiningType(0x0627), 2, 'alef joins only to the letter before it');
  assert.equal(joiningType(0x0648), 2, 'waw is right-joining');
  assert.equal(joiningType(0x062f), 2, 'dal is right-joining');
  assert.equal(joiningType(0x0621), 0, 'hamza joins on neither side');
  assert.equal(joiningType(0x064e), 3, 'fatha is transparent to joining');
  assert.equal(joiningType(0x0640), 4, 'tatweel causes joining');
  assert.equal(joiningType(0x0041), 0, 'latin A is outside the table');
});

test('the block test accepts Arabic and nothing else', () => {
  assert.ok(isArabic(0x0627));
  assert.ok(isArabic(0x06ff));
  assert.ok(!isArabic(0x0041));
  assert.ok(!isArabic(0x05d0), 'Hebrew is RTL but is not a joining script');
  assert.ok(!isArabic(0x0710), 'Syriac joins but is out of scope');
});

test('a four-letter word gets initial, medial, final and isolated forms', () => {
  // salaam: seen lam alef meem. Alef is right-joining, so it takes a final form
  // from the lam before it but gives the meem after it nothing to join to.
  const g = shape('سلام');
  assert.equal(g[0].cluster, 'س' + ZWJ, 'seen is initial: joins forward only');
  assert.equal(g[1].cluster, ZWJ + 'ل' + ZWJ, 'lam is medial: joins both ways');
  assert.equal(g[2].cluster, ZWJ + 'ا', 'alef is final: joins backward only');
  assert.equal(g[3].cluster, 'م', 'meem is isolated: alef does not join forward');
});

test('the run is laid out right to left', () => {
  const g = shape('سلام');
  assert.deepEqual(
    g.map((x) => x.col),
    [3, 2, 1, 0],
    'the first logical letter takes the rightmost column',
  );
});

test('every column in the run is filled exactly once', () => {
  const g = shape('بسمله');
  const cols = g.map((x) => x.col).sort((a, b) => a - b);
  assert.deepEqual(cols, [0, 1, 2, 3, 4], 'reordering must be a permutation');
});

test('a letter with nothing to join to is left at its natural advance', () => {
  // A lone alef neither joins nor is fitted, so it rasters exactly as it does
  // with no shaper at all. This is what keeps the arabic-isolated corpus row
  // byte-identical before and after.
  const g = shape('ا');
  assert.equal(g[0].cluster, 'ا');
  assert.equal(g[0].fit, false);
  assert.equal(g[0].col, 0);

  // Whereas a letter that does join is fitted, because its stroke has to meet
  // its neighbour's on the cell boundary.
  const w = shape('لا');
  assert.ok(w.every((x) => x.fit), 'both letters of lam-alef join and are fitted');
});

test('combining marks are transparent to the joining decision', () => {
  // beh + fatha + teh: the mark must not stop the two letters joining through it.
  const g = shape('بَت');
  assert.equal(g[0].cluster, 'ب' + ZWJ, 'beh still joins forward across the mark');
  assert.equal(g[2].cluster, ZWJ + 'ت', 'teh still joins backward across the mark');
});

test('an Arabic-Indic number inside a run keeps its digits in reading order', () => {
  // Reversing the run must not reverse a number inside it. Three digits between
  // two letters: the digit span moves as a block and its own order survives.
  const digits = '١٢٣'; // 1 2 3
  const g = shape('ب' + digits + 'ت');
  const cols = g.map((x) => x.col);
  assert.deepEqual(cols[0], 4, 'the leading letter takes the rightmost column');
  assert.deepEqual(cols.slice(1, 4), [1, 2, 3], 'digits keep ascending columns');
  assert.deepEqual(cols[4], 0, 'the trailing letter takes the leftmost column');
});

test('tatweel joins on both sides without taking a form of its own', () => {
  const g = shape('بـت');
  assert.equal(g[1].cluster, ZWJ + 'ـ' + ZWJ);
});

test('the shaper only claims code points it has a table for', () => {
  const s = arabicShaper();
  assert.ok(s.participates(0x0633));
  assert.ok(!s.participates('a'.codePointAt(0)!));
  assert.ok(!s.participates(0x4e16), 'Han is none of the shaper business');
});

test('atlas keys distinguish every form a letter can take', () => {
  // Four contextual forms of the same letter must not share a cache slot, and
  // none of them may collide with the plain grapheme the default path keys on.
  const g = shape('لللل');
  const run = arabicShaper().shapeRun([...'لللل'], PLAIN);
  const keys = new Set(run.glyphs.map((x) => x.atlasKey));
  assert.equal(g.length, 4);
  assert.ok(keys.size >= 3, 'initial, medial and final lam are distinct keys');
  for (const k of keys) {
    assert.ok(k.startsWith('ar'), 'shaped keys stay in their own namespace');
  }
});

test('bold and italic runs do not share keys with regular ones', () => {
  const cells = [...'لا'];
  const plain = arabicShaper().shapeRun(cells, PLAIN);
  const bold = arabicShaper().shapeRun(cells, { bold: true, italic: false });
  assert.notEqual(plain.glyphs[0].atlasKey, bold.glyphs[0].atlasKey);
});

test('the corpus words the shaper is meant to fix really are split into cells', () => {
  // If the VT stopped splitting Arabic per cell, the shaper would be solving a
  // problem that no longer exists, so this pins the assumption it rests on.
  for (const name of ['arabic-word', 'arabic-lam-alef']) {
    const e = tortureCorpus.find((x) => x.name === name)!;
    assert.equal(e.layout, 'split');
    assert.equal(e.columns, e.scalars);
  }
});
