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
  // muharram: meem hah reh meem. Reh is right-joining, so it takes a final form
  // from the hah before it but gives the meem after it nothing to join to. Each
  // letter is remapped to its Presentation Forms-B code point.
  const g = shape('محرم');
  const cp = String.fromCodePoint;
  assert.equal(g[0].cluster, cp(0xfee3), 'meem is initial: joins forward only');
  assert.equal(g[1].cluster, cp(0xfea4), 'hah is medial: joins both ways');
  assert.equal(g[2].cluster, cp(0xfeae), 'reh is final: joins backward only');
  assert.equal(g[3].cluster, 'م', 'meem is isolated: reh does not join forward, code point kept');
});

test('the run is laid out right to left', () => {
  const g = shape('محرم');
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

  // Whereas lam-alef joins into a mandatory ligature that is fitted across the
  // two cells: one glyph carrying the ligature and a blank covering the second
  // cell so the lam is not drawn again underneath it.
  const w = shape('لا');
  const cp = String.fromCodePoint;
  assert.equal(w[0].cluster, cp(0xfefb), 'lam-alef is the isolated ligature');
  assert.equal(w[0].fit, true, 'the ligature is fitted across its cells');
  assert.equal(w[1].cluster, '', 'the covered cell is blanked');
});

test('combining marks are transparent to the joining decision', () => {
  // beh + fatha + teh: the mark must not stop the two letters joining through it.
  const g = shape('بَت');
  const cp = String.fromCodePoint;
  assert.equal(g[0].cluster, cp(0xfe91), 'beh takes its initial form across the mark');
  assert.equal(g[2].cluster, cp(0xfe96), 'teh takes its final form across the mark');
});

test('lam plus each alef variant collapses into its mandatory ligature', () => {
  const cp = String.fromCodePoint;
  // Isolated ligature: the lam has no preceding letter to join to.
  const cases: [string, number][] = [
    ['لا', 0xfefb], // lam + alef
    ['لآ', 0xfef5], // lam + alef madda
    ['لأ', 0xfef7], // lam + alef hamza above
    ['لإ', 0xfef9], // lam + alef hamza below
  ];
  for (const [word, form] of cases) {
    const g = shape(word);
    assert.equal(g.length, 2, `${word}: one ligature glyph and one blank`);
    assert.equal(g[0].cluster, cp(form), `${word}: isolated ligature form`);
    assert.equal(g[1].cluster, '', `${word}: covered cell blanked`);
  }
});

test('a lam-alef takes the final ligature when the lam joins a letter before it', () => {
  const cp = String.fromCodePoint;
  // salaam: seen lam alef meem. The lam joins backward to the seen, so the
  // lam-alef is the final ligature FEFC, not the isolated FEFB. It spans two
  // columns and the covered column is blanked.
  const run = arabicShaper().shapeRun([...'سلام'], PLAIN);
  const lig = run.glyphs.find((x) => x.cluster === cp(0xfefc));
  assert.ok(lig, 'the final lam-alef ligature is emitted');
  assert.equal(lig!.cols, 2, 'the ligature spans the two cells');
  assert.equal(run.glyphs.find((x) => x.cluster === '')?.cluster, '', 'the second cell is blanked');
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
