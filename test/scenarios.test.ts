import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scenarios, scenarioByName } from '../src/testing/scenarios.ts';

test('every scenario builds a source at its declared size', () => {
  for (const sc of scenarios) {
    const s = sc.build();
    assert.equal(s.cols, sc.cols, `${sc.name} cols`);
    assert.equal(s.rows, sc.rows, `${sc.name} rows`);
  }
});

test('cjk scenario produces width-2 heads with width-0 tails', () => {
  const s = scenarioByName('cjk')!.build();
  let foundWide = false;
  const row = s.activeTop;
  for (let c = 0; c < s.cols - 1; c++) {
    if (s.getCell(row, c).width === 2) {
      assert.equal(s.getCell(row, c + 1).width, 0);
      foundWide = true;
    }
  }
  assert.ok(foundWide, 'expected at least one wide cell');
});

test('emoji scenario keeps multi-scalar ZWJ clusters intact', () => {
  const s = scenarioByName('emoji')!.build();
  let foundZwj = false;
  const row = s.activeTop;
  for (let c = 0; c < s.cols; c++) {
    const g = s.getCell(row, c).grapheme;
    if (g.includes('‍')) foundZwj = true;
  }
  assert.ok(foundZwj, 'expected a ZWJ cluster somewhere on the first row');
});

test('blank scenario leaves most cells empty', () => {
  const s = scenarioByName('blank')!.build();
  let blanks = 0;
  const total = s.rows * s.cols;
  for (let r = 0; r < s.rows; r++) {
    for (let c = 0; c < s.cols; c++) {
      const cp = s.getCell(s.activeTop + r, c).codepoint;
      if (cp === 0 || cp === 32) blanks++;
    }
  }
  assert.ok(blanks > total * 0.8, 'blank scenario should be mostly empty');
});

test('churn step rewrites content and re-dirties the whole viewport', () => {
  const sc = scenarioByName('churn')!;
  const s = sc.build();
  s.clearDirty();
  sc.step!(s, 5);
  for (let r = 0; r < s.rows; r++) {
    assert.equal(s.isRowDirty(s.activeTop + r), true, `row ${r} dirty after churn`);
  }
});
