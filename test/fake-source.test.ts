import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FakeSource, graphemeWidth } from '../src/testing/fake-source.ts';
import { CellFlags } from '../src/types.ts';

test('fresh source marks every row dirty for the first frame', () => {
  const s = new FakeSource({ cols: 10, rows: 4, scrollbackRows: 2 });
  for (let r = 0; r < 6; r++) assert.equal(s.isRowDirty(r), true);
});

test('clearDirty resets and setCell re-dirties only that row', () => {
  const s = new FakeSource({ cols: 10, rows: 4 });
  s.clearDirty();
  for (let r = 0; r < 4; r++) assert.equal(s.isRowDirty(r), false);
  s.setCell(2, 3, 65);
  assert.equal(s.isRowDirty(2), true);
  assert.equal(s.isRowDirty(1), false);
});

test('writeText lays down ASCII with width 1', () => {
  const s = new FakeSource({ cols: 20, rows: 2 });
  const next = s.writeText(0, 0, 'hi');
  assert.equal(next, 2);
  assert.equal(s.getCell(0, 0).codepoint, 'h'.codePointAt(0));
  assert.equal(s.getCell(0, 0).width, 1);
  assert.equal(s.getCell(0, 1).codepoint, 'i'.codePointAt(0));
});

test('writeText places a wide CJK head and a width-0 spacer tail', () => {
  const s = new FakeSource({ cols: 20, rows: 2 });
  const next = s.writeText(0, 0, '世');
  assert.equal(next, 2, 'wide char advances two columns');
  const head = s.getCell(0, 0);
  assert.equal(head.width, 2);
  assert.equal(head.codepoint, '世'.codePointAt(0));
  const tail = s.getCell(0, 1);
  assert.equal(tail.width, 0, 'spacer tail has width 0');
});

test('writeText keeps ZWJ emoji as one grapheme cluster', () => {
  const s = new FakeSource({ cols: 20, rows: 2 });
  s.writeText(0, 0, '👩‍💻');
  const head = s.getCell(0, 0);
  assert.equal(head.grapheme, '👩‍💻');
  assert.equal(head.width, 2);
  assert.equal(s.getCell(0, 1).width, 0);
});

test('setCell carries flags and colors', () => {
  const s = new FakeSource({ cols: 10, rows: 2 });
  s.setCell(0, 0, 65, { fg: 0x112233, bg: 0x445566, flags: CellFlags.BOLD | CellFlags.UNDERLINE });
  const c = s.getCell(0, 0);
  assert.equal(c.fg, 0x112233);
  assert.equal(c.bg, 0x445566);
  assert.equal(c.flags & CellFlags.BOLD, CellFlags.BOLD);
  assert.equal(c.flags & CellFlags.UNDERLINE, CellFlags.UNDERLINE);
});

test('LineView numeric accessors match getCell', () => {
  const s = new FakeSource({ cols: 10, rows: 2 });
  s.setCell(1, 4, 90, { fg: 0xaabbcc });
  const line = s.getLine(1);
  assert.equal(line.codepoint(4), 90);
  assert.equal(line.fg(4), 0xaabbcc);
  assert.equal(line.width(4), 1);
});

test('graphemeWidth classifies CJK and emoji as wide, ASCII as narrow', () => {
  assert.equal(graphemeWidth('a'), 1);
  assert.equal(graphemeWidth('世'), 2);
  assert.equal(graphemeWidth('😀'), 2);
});

test('scrollbackRows and activeTop line up', () => {
  const s = new FakeSource({ cols: 5, rows: 3, scrollbackRows: 7 });
  assert.equal(s.scrollbackRows, 7);
  assert.equal(s.activeTop, 7);
});
