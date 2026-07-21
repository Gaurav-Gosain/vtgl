// HarfBuzz shaper correctness.
//
// Two layers are asserted here, both in node against the real wasm engine and
// the bundled Noto Sans Arabic face. First the engine itself: the glyph ids,
// advances and GPOS offsets HarfBuzz returns for known words, which is the
// ground truth the PF-B path cannot produce (marks, in particular, are placed
// by GPOS and have no precomposed form). Second the ShaperHook wrapper: that a
// claimed Arabic run comes back as outline glyphs laid across its cells, that a
// non-Arabic code point is not claimed, and that the run stays a permutation of
// its columns. Pixels are asserted in the browser suite; this pins the numbers.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  initHarfBuzz,
  shape,
  Blob,
  Face,
  Font,
  Buffer as HbBuffer,
} from '../src/shaper/hb/harfbuzz-wrapper.js';
import { harfBuzzWasm } from '../src/shaper/hb/harfbuzz-wasm.ts';
import { notoSansArabic } from '../src/shaper/hb/font-noto-arabic.ts';
import { createHarfBuzzShaper } from '../src/shaper/harfbuzz.ts';
import { isArabic } from '../src/shaper/arabic.ts';
import type { ShaperMetrics } from '../src/types.ts';

const PLAIN = { bold: false, italic: false };

// A 14px cell at dpr 1 in round numbers, enough for the shaper to lay glyphs.
const METRICS: ShaperMetrics = {
  cellWidth: 8,
  cellHeight: 17,
  baseline: 13,
  deviceFontPx: 14,
  dpr: 1,
};

/** Raw engine shaping, returning ids/positions in font units. */
function engineShape(font: Font, text: string): Array<{
  gid: number;
  cluster: number;
  xAdvance: number;
  xOffset: number;
  yOffset: number;
}> {
  const buf = new HbBuffer();
  buf.addText(text);
  buf.guessSegmentProperties();
  shape(font, buf);
  return buf.getGlyphInfosAndPositions().map((g) => ({
    gid: g.codepoint,
    cluster: g.cluster,
    xAdvance: g.xAdvance,
    xOffset: g.xOffset,
    yOffset: g.yOffset,
  }));
}

test('the engine shapes salaam into four contextual glyphs in visual order', async () => {
  await initHarfBuzz(harfBuzzWasm);
  const font = new Font(new Face(new Blob(notoSansArabic), 0));
  const g = engineShape(font, 'سلام');
  assert.equal(g.length, 4, 'seen, lam, alef, meem');
  // HarfBuzz emits visual left-to-right for an RTL run, so the clusters descend
  // from the last logical letter to the first: meem(3), alef(2), lam(1), seen(0).
  assert.deepEqual(g.map((x) => x.cluster), [3, 2, 1, 0]);
  // Distinct contextual glyph ids, not four copies of an isolated form.
  assert.equal(new Set(g.map((x) => x.gid)).size, 4);
  for (const x of g) assert.ok(x.xAdvance > 0, 'every base advances the pen');
});

test('lam-alef shapes to the two connecting glyphs, not two isolated letters', async () => {
  await initHarfBuzz(harfBuzzWasm);
  const font = new Font(new Face(new Blob(notoSansArabic), 0));
  const g = engineShape(font, 'لا');
  assert.equal(g.length, 2, 'lam and alef, each a joining form');
  // The alef here is the joining alef (final), distinct from the isolated alef
  // the unshaped path would draw.
  const isolatedAlef = engineShape(font, 'ا');
  assert.notEqual(g[0].gid, isolatedAlef[0].gid, 'the joined form differs from isolated');
});

test('alef-madda places its mark by GPOS, which precomposed forms cannot do', async () => {
  await initHarfBuzz(harfBuzzWasm);
  const font = new Font(new Face(new Blob(notoSansArabic), 0));
  const g = engineShape(font, 'لآ');
  // Three glyphs: the madda mark, the alef and the lam. The mark carries a
  // non-zero GPOS y offset and zero advance, which is exactly the placement the
  // Presentation-Forms path has no way to express.
  const mark = g.find((x) => x.xAdvance === 0 && x.yOffset !== 0);
  assert.ok(mark, 'a zero-advance, y-offset mark is present');
});

test('beh x4 shapes four bases each with its GPOS-placed dot', async () => {
  await initHarfBuzz(harfBuzzWasm);
  const font = new Font(new Face(new Blob(notoSansArabic), 0));
  const g = engineShape(font, 'بببب');
  const bases = g.filter((x) => x.xAdvance > 0);
  const marks = g.filter((x) => x.xAdvance === 0);
  assert.equal(bases.length, 4, 'four beh forms');
  assert.equal(marks.length, 4, 'four dots, one per beh, placed by GPOS xOffset');
  for (const m of marks) assert.ok(m.xOffset !== 0 || m.yOffset !== 0, 'the dot is offset');
});

test('the ShaperHook lays a claimed run as outline glyphs across its cells', async () => {
  const shaper = await createHarfBuzzShaper();
  shaper.setMetrics!(METRICS);
  const cells = [...'سلام'];
  const run = shaper.shapeRun(cells, PLAIN);
  assert.equal(run.glyphs.length, cells.length, 'one glyph slot per cell');
  const cols = run.glyphs.map((x) => x.col).sort((a, b) => a - b);
  assert.deepEqual(cols, [0, 1, 2, 3], 'every column is filled exactly once');
  // Salaam is four distinct clusters (no lam-alef here), so all four are outline
  // glyphs, none blanked.
  const outlined = run.glyphs.filter((x) => x.outline !== undefined);
  assert.equal(outlined.length, 4, 'all four cells carry an outline glyph');
  for (const g of outlined) {
    assert.ok(g.outline!.tileW > METRICS.cellWidth, 'the tile is wider than a cell (full ink, overhangs)');
    assert.ok(g.outline!.tileH > METRICS.cellHeight, 'the tile is taller than a cell');
    assert.equal(typeof g.outline!.draw, 'function');
  }
});

test('a lam-alef run fills its two cells with outline glyphs', async () => {
  const shaper = await createHarfBuzzShaper();
  shaper.setMetrics!(METRICS);
  const run = shaper.shapeRun([...'لا'], PLAIN);
  assert.equal(run.glyphs.length, 2);
  assert.deepEqual(run.glyphs.map((x) => x.col).sort(), [0, 1]);
  // Two connecting glyphs, so both cells carry an outline (no blank here).
  assert.equal(run.glyphs.filter((x) => x.outline !== undefined).length, 2);
});

test('the run is fit across its cells, so the last glyph does not overrun the grid', async () => {
  const shaper = await createHarfBuzzShaper();
  shaper.setMetrics!(METRICS);
  const cells = [...'بببب'];
  const run = shaper.shapeRun(cells, PLAIN);
  // The pen origin of a glyph is col*cellW + xOffset; with the run fit to the
  // grid, the rightmost glyph's pen origin stays within the run's width.
  const runW = cells.length * METRICS.cellWidth;
  for (const g of run.glyphs) {
    const penX = g.col * METRICS.cellWidth + g.xOffset;
    assert.ok(penX >= -METRICS.cellWidth && penX <= runW, `pen ${penX} inside the run`);
  }
});

test('the shaper claims the Arabic block and nothing else (Latin never regresses)', async () => {
  const shaper = await createHarfBuzzShaper();
  assert.ok(shaper.participates(0x0628), 'beh is claimed');
  assert.ok(shaper.participates(0x0644), 'lam is claimed');
  assert.ok(!shaper.participates('A'.codePointAt(0)!), 'Latin A is left to the default path');
  assert.ok(!shaper.participates('7'.codePointAt(0)!), 'a digit is left to the default path');
  assert.ok(!shaper.participates(0x2500), 'a box-drawing char is left to the default path');
  // The claim test matches the PF-B shaper, so the run grouping is identical.
  assert.equal(shaper.participates(0x0633), isArabic(0x0633));
});
