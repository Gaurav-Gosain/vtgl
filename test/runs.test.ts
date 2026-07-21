// Run grouping: turning a row of cells into the runs a shaper is given.
//
// The grouping rules carry real consequences, because the Arabic shaper
// reorders within a run: a run that swallowed cells of a different colour would
// move colours between columns, and a run that spanned a wide cell would place
// a glyph on a spacer tail. Both are asserted here rather than left to the
// pixels to reveal.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RowShaper } from '../src/renderer/runs.ts';
import { arabicShaper } from '../src/shaper/arabic.ts';
import { FakeSource } from '../src/testing/fake-source.ts';
import type { RunStyle, ShapedRun, ShaperHook } from '../src/types.ts';

const COLS = 16;

function row(write: (s: FakeSource) => void): FakeSource {
  const s = new FakeSource({ cols: COLS, rows: 1, fg: 0xd0d0d0, bg: 0x101010 });
  s.clearRegion(0, 1);
  write(s);
  return s;
}

/** Records the runs it is handed, so grouping can be asserted directly. */
function recordingShaper(): ShaperHook & { runs: string[][] } {
  const inner = arabicShaper();
  const runs: string[][] = [];
  return {
    runs,
    participates: inner.participates,
    shapeRun(cells: readonly string[], style: RunStyle): ShapedRun {
      runs.push([...cells]);
      return inner.shapeRun(cells, style);
    },
  };
}

test('a row with no Arabic is never shaped and plans nothing', () => {
  const s = row((x) => x.writeText(0, 0, 'hello world'));
  const shaper = recordingShaper();
  const rs = new RowShaper();
  assert.equal(rs.plan(s.getLine(0), COLS, shaper), false);
  assert.deepEqual(shaper.runs, [], 'the shaper was never called');
  for (let c = 0; c < COLS; c++) assert.equal(rs.has(c), false);
});

test('a contiguous Arabic word becomes exactly one run', () => {
  const s = row((x) => x.writeText(0, 2, 'سلام'));
  const shaper = recordingShaper();
  const rs = new RowShaper();
  assert.equal(rs.plan(s.getLine(0), COLS, shaper), true);
  assert.deepEqual(shaper.runs, [[...'سلام']]);
  // The run occupies exactly the four cells it was written into.
  for (let c = 0; c < COLS; c++) {
    assert.equal(rs.has(c), c >= 2 && c < 6, 'column ' + c);
  }
});

test('a space between two Arabic words splits them into separate runs', () => {
  // This is the documented limit of the reordering: each word is internally
  // right-to-left, but the words themselves are not reordered against each
  // other, because they are never in the same run.
  const s = row((x) => x.writeText(0, 0, 'سلام دنيا'));
  const shaper = recordingShaper();
  new RowShaper().plan(s.getLine(0), COLS, shaper);
  assert.equal(shaper.runs.length, 2);
  assert.deepEqual(shaper.runs[0], [...'سلام']);
  assert.deepEqual(shaper.runs[1], [...'دنيا']);
});

test('latin on either side does not join the run', () => {
  const s = row((x) => {
    x.writeText(0, 0, 'a');
    x.writeText(0, 1, 'لا');
    x.writeText(0, 3, 'b');
  });
  const shaper = recordingShaper();
  const rs = new RowShaper();
  rs.plan(s.getLine(0), COLS, shaper);
  assert.deepEqual(shaper.runs, [[...'لا']]);
  assert.equal(rs.has(0), false, 'the latin cell is untouched');
  assert.equal(rs.has(3), false);
});

test('a colour change breaks the run', () => {
  // Reordering moves characters between columns. If a run spanned two colours,
  // the reversal would carry a character into a cell painted the other colour,
  // so the run must stop at the boundary.
  const s = row((x) => {
    x.writeText(0, 0, 'سل', { fg: 0xff0000 });
    x.writeText(0, 2, 'ام', { fg: 0x00ff00 });
  });
  const shaper = recordingShaper();
  new RowShaper().plan(s.getLine(0), COLS, shaper);
  assert.deepEqual(shaper.runs, [[...'سل'], [...'ام']]);
});

test('a bold span is shaped separately from a regular one', () => {
  const s = row((x) => {
    x.writeText(0, 0, 'سل', { flags: 1 });
    x.writeText(0, 2, 'ام');
  });
  const shaper = recordingShaper();
  new RowShaper().plan(s.getLine(0), COLS, shaper);
  assert.equal(shaper.runs.length, 2);
});

test('the plan is cleared between rows', () => {
  const arabic = row((x) => x.writeText(0, 0, 'سلام'));
  const latin = row((x) => x.writeText(0, 0, 'hello'));
  const rs = new RowShaper();
  const shaper = arabicShaper();
  assert.equal(rs.plan(arabic.getLine(0), COLS, shaper), true);
  assert.equal(rs.has(0), true);
  // A row with nothing to shape must not inherit the previous row's columns.
  assert.equal(rs.plan(latin.getLine(0), COLS, shaper), false);
  for (let c = 0; c < COLS; c++) assert.equal(rs.has(c), false, 'column ' + c);
});

test('a shaper that places a glyph outside its run is ignored, not obeyed', () => {
  // A shaper is host-supplied code. Writing outside the run would corrupt a
  // cell the run does not own, so the column is dropped.
  const rogue: ShaperHook = {
    participates: arabicShaper().participates,
    shapeRun(cells) {
      return {
        glyphs: cells.map((c, i) => ({
          atlasKey: 'x' + i,
          cluster: c,
          col: i === 0 ? 99 : -5,
          xOffset: 0,
          rtl: false,
          fitAdvance: false,
        })),
      };
    },
  };
  const s = row((x) => x.writeText(0, 4, 'لا'));
  const rs = new RowShaper();
  assert.equal(rs.plan(s.getLine(0), COLS, rogue), false);
  for (let c = 0; c < COLS; c++) assert.equal(rs.has(c), false, 'column ' + c);
});

test('the planned columns carry the shaper raster hints', () => {
  const s = row((x) => x.writeText(0, 0, 'لا'));
  const rs = new RowShaper();
  rs.plan(s.getLine(0), COLS, arabicShaper());
  // lam-alef is a mandatory ligature: one fitted glyph spanning the two cells,
  // placed in the left-hand column, with the right-hand column blanked so the
  // lam is not drawn again underneath it.
  assert.equal(rs.cluster(0), String.fromCodePoint(0xfefb), 'the isolated lam-alef ligature');
  assert.equal(rs.fitAdvance(0), true, 'the ligature is fitted');
  assert.equal(rs.glyphCols(0), 2, 'and spans both cells');
  assert.equal(rs.cluster(1), '', 'the covered cell carries a blank cluster');
  assert.equal(rs.glyphCols(1), 1, 'a blank spans one cell');
  assert.notEqual(rs.key(0), rs.key(1), 'the ligature and the blank are cached separately');
});
