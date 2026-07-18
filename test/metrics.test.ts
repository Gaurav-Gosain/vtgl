// Cell geometry is derived from the font's measured vertical extents, not
// from the nominal font size. The regression these tests guard: deriving the
// baseline from a guessed fraction of the font size (the old
// `deviceFontPx * 0.18` descender) puts the baseline a pixel or more off the
// face's real one and packs rows tighter than the face asks for, which shows
// up as vertically cramped text.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeCellMetrics, measureFont } from '../src/renderer/metrics.ts';
import type { MeasureContext } from '../src/renderer/metrics.ts';

/** A context reporting the metrics a real face declares. */
function ctxWith(opts: {
  advance?: number;
  fontAscent?: number;
  fontDescent?: number;
  inkAscent?: number;
  inkDescent?: number;
}): MeasureContext {
  return {
    font: '',
    measureText(text: string) {
      return {
        width: (opts.advance ?? 0.6) * text.length,
        fontBoundingBoxAscent: opts.fontAscent,
        fontBoundingBoxDescent: opts.fontDescent,
        actualBoundingBoxAscent: opts.inkAscent,
        actualBoundingBoxDescent: opts.inkDescent,
      };
    },
  };
}

test('cell height is the face line box, not the nominal font size', () => {
  // JetBrainsMono Nerd Font Mono at 14px reports ascent 14, descent 4, so the
  // natural line box is 18px. The nominal-size derivation produced 15px, which
  // is the cramped-rows bug: 3px of every row missing.
  const m = measureFont(ctxWith({ advance: 8.4, fontAscent: 14, fontDescent: 4 }), 'mono', 14);
  assert.equal(m.ascent, 14);
  assert.equal(m.descent, 4);

  const g = computeCellMetrics(14, 1, 1, m, 0);
  assert.equal(g.cellH, 18, 'cell height must be ascent + descent');
  assert.equal(g.baseline, 14, 'baseline must sit where the face puts it');
});

test('the baseline tracks the face, not a fixed fraction of the size', () => {
  const shallow = measureFont(ctxWith({ fontAscent: 10, fontDescent: 8 }), 'mono', 14);
  const deep = measureFont(ctxWith({ fontAscent: 14, fontDescent: 4 }), 'mono', 14);

  const a = computeCellMetrics(14, 1, 1, shallow, 0);
  const b = computeCellMetrics(14, 1, 1, deep, 0);

  // Same nominal size and same total line box, but different baselines: a
  // size-derived guess cannot express this and would return one value for both.
  assert.equal(a.cellH, b.cellH);
  assert.equal(a.baseline, 10);
  assert.equal(b.baseline, 14);
  assert.notEqual(a.baseline, b.baseline);
});

test('extra leading is split evenly above and below the text box', () => {
  const m = measureFont(ctxWith({ fontAscent: 14, fontDescent: 4 }), 'mono', 14);
  const tight = computeCellMetrics(14, 1, 1, m, 0);
  const loose = computeCellMetrics(14, 1, 1.5, m, 0);

  assert.equal(tight.cellH, 18);
  assert.equal(loose.cellH, 27);
  // 9px of leading, half of it above: baseline moves down by 4.5 -> 5 (rounded).
  assert.equal(loose.baseline, tight.baseline + Math.round((loose.cellH - tight.cellH) / 2));
});

test('geometry scales with dpr so a HiDPI display is not cramped', () => {
  const at1 = measureFont(ctxWith({ advance: 8.4, fontAscent: 14, fontDescent: 4 }), 'mono', 14);
  const at2 = measureFont(ctxWith({ advance: 16.8, fontAscent: 29, fontDescent: 8 }), 'mono', 28);

  const g1 = computeCellMetrics(14, 1, 1, at1, 0);
  const g2 = computeCellMetrics(14, 2, 1, at2, 0);

  assert.equal(g1.cellH, 18);
  assert.equal(g2.cellH, 37, 'dpr=2 must use the metrics measured at 28px');
  assert.equal(g2.baseline, 29);
  // The old nominal derivation returned round(28 * (15/14)) = 30 here, seven
  // device pixels short of the face's real line box.
  assert.notEqual(g2.cellH, 30);
});

test('the ink box of a tall-and-deep sample stands in when no font box exists', () => {
  // Some engines report only actualBoundingBox*. Measuring 'M' alone would
  // report a zero descent, since M has no descender.
  const m = measureFont(ctxWith({ inkAscent: 10, inkDescent: 3 }), 'mono', 14);
  assert.equal(m.ascent, 10);
  assert.equal(m.descent, 3);
  assert.equal(computeCellMetrics(14, 1, 1, m, 0).cellH, 13);
});

test('a context that measures nothing still yields sane geometry', () => {
  const m = measureFont(null, 'mono', 14);
  const g = computeCellMetrics(14, 1, 1, m, 0);
  assert.ok(g.cellH > 0 && g.cellW > 0);
  assert.ok(g.baseline > 0 && g.baseline <= g.cellH);
});

test('the baseline always lands inside the cell', () => {
  for (const lineHeight of [0.5, 0.8, 1, 1.2, 2]) {
    for (const [asc, desc] of [[14, 4], [10, 10], [20, 1], [1, 20]]) {
      const m = measureFont(ctxWith({ fontAscent: asc, fontDescent: desc }), 'mono', 14);
      const g = computeCellMetrics(14, 1, lineHeight, m, 0);
      assert.ok(
        g.baseline >= 0 && g.baseline <= g.cellH,
        `baseline ${g.baseline} outside cell ${g.cellH} (lh=${lineHeight}, ${asc}/${desc})`,
      );
    }
  }
});

test('letter spacing widens the cell and is scaled by dpr', () => {
  const m = measureFont(ctxWith({ advance: 8, fontAscent: 14, fontDescent: 4 }), 'mono', 14);
  assert.equal(computeCellMetrics(14, 1, 1, m, 0).cellW, 8);
  assert.equal(computeCellMetrics(14, 1, 1, m, 2).cellW, 10);
  assert.equal(computeCellMetrics(14, 2, 1, m, 2).cellW, 12);
});
