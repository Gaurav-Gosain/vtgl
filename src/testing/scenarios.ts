// Golden scenarios shared by unit tests and benchmarks. Each builds a FakeSource
// in a known state; scenarios that exercise damage expose a `step` to mutate the
// grid frame-to-frame (the benchmark harness clears dirty between steps).

import { CellFlags } from '../types.ts';
import { FakeSource } from './fake-source.ts';

export interface Scenario {
  name: string;
  description: string;
  cols: number;
  rows: number;
  build(): FakeSource;
  /** Optional per-frame mutation for churn benchmarks. Returns nothing. */
  step?(source: FakeSource, frame: number): void;
}

const COLS = 120;
const ROWS = 40;

const FG = 0xd0d0d0;
const BG = 0x101010;

/** Plain ASCII paragraph text, static. */
export const asciiScenario: Scenario = {
  name: 'ascii',
  description: 'Dense ASCII text, 120x40, static after first paint.',
  cols: COLS,
  rows: ROWS,
  build() {
    const s = new FakeSource({ cols: COLS, rows: ROWS, fg: FG, bg: BG });
    const line =
      'The quick brown fox jumps over the lazy dog. 0123456789 !@#$%^&*() ' +
      'lorem ipsum dolor sit amet consectetur adipiscing elit sed do';
    for (let r = 0; r < ROWS; r++) {
      s.writeText(s.activeTop + r, 0, line.slice(0, COLS));
    }
    return s;
  },
};

/** Mixed CJK (wide) and ASCII, exercising width-2 heads and width-0 tails. */
export const cjkScenario: Scenario = {
  name: 'cjk',
  description: 'Wide CJK interleaved with ASCII; spacer-tail handling.',
  cols: COLS,
  rows: ROWS,
  build() {
    const s = new FakeSource({ cols: COLS, rows: ROWS, fg: FG, bg: BG });
    const jp = 'こんにちは世界';
    for (let r = 0; r < ROWS; r++) {
      let col = 0;
      col = s.writeText(s.activeTop + r, col, 'row ' + r + ': ');
      while (col < COLS - 16) {
        col = s.writeText(s.activeTop + r, col, jp);
        col = s.writeText(s.activeTop + r, col, ' ok ');
      }
    }
    return s;
  },
};

/** Emoji including ZWJ sequences (family, profession) that must key by cluster. */
export const emojiScenario: Scenario = {
  name: 'emoji',
  description: 'Emoji and ZWJ clusters (family, professions), wide cells.',
  cols: COLS,
  rows: ROWS,
  build() {
    const s = new FakeSource({ cols: COLS, rows: ROWS, fg: FG, bg: BG });
    const emojis = [
      '👨‍👩‍👧‍👦', // family ZWJ
      '👩‍💻', // technologist ZWJ
      '🧑‍🚀', // astronaut ZWJ
      '🏳️‍🌈', // rainbow flag ZWJ
      '😀',
      '🎉',
      '🔥',
    ];
    for (let r = 0; r < ROWS; r++) {
      let col = 0;
      while (col < COLS - 4) {
        col = s.writeText(s.activeTop + r, col, emojis[(r + col) % emojis.length]);
        col = s.writeText(s.activeTop + r, col, ' ');
      }
    }
    return s;
  },
};

/** Mostly blank screen with a little text: exercises the blank-cell fast skip. */
export const blankScenario: Scenario = {
  name: 'blank',
  description: 'Blank-heavy screen; only a status line and cursor row painted.',
  cols: COLS,
  rows: ROWS,
  build() {
    const s = new FakeSource({ cols: COLS, rows: ROWS, fg: FG, bg: BG });
    s.clearRegion(s.activeTop, s.activeTop + ROWS);
    s.writeText(s.activeTop, 0, ' STATUS  ready  |  branch main  |  0 errors', {
      flags: CellFlags.BOLD,
    });
    s.writeText(s.activeTop + ROWS - 1, 0, '$ ');
    s.setCursor({ x: 2, y: s.activeTop + ROWS - 1 });
    s.clearDirty();
    s.markDirty(s.activeTop + ROWS - 1);
    return s;
  },
};

/**
 * Full-screen churn: every frame rewrites every cell with shifting content and
 * marks the whole viewport dirty. This is the 60fps stress target (a 120x40
 * full redraw must stay well under 16ms).
 */
export const churnScenario: Scenario = {
  name: 'churn',
  description: 'Full-screen churn: all cells rewritten each frame, all dirty.',
  cols: COLS,
  rows: ROWS,
  build() {
    const s = new FakeSource({ cols: COLS, rows: ROWS, fg: FG, bg: BG });
    fillChurn(s, 0);
    return s;
  },
  step(s, frame) {
    fillChurn(s, frame);
  },
};

const RAMP = '@#S%?*+;:,. abcdefghijklmnopqrstuvwxyz0123456789';

function fillChurn(s: FakeSource, frame: number): void {
  for (let r = 0; r < ROWS; r++) {
    const row = s.activeTop + r;
    for (let c = 0; c < COLS; c++) {
      const ch = RAMP[(r * 7 + c * 3 + frame) % RAMP.length];
      const fg = 0x00_00_00 | (((r * 6 + frame) & 0xff) << 16) | ((c * 2) & 0xff);
      s.setCell(row, c, ch.codePointAt(0) ?? 32, { fg });
    }
  }
}

export const scenarios: Scenario[] = [
  asciiScenario,
  cjkScenario,
  emojiScenario,
  blankScenario,
  churnScenario,
];

export function scenarioByName(name: string): Scenario | undefined {
  return scenarios.find((s) => s.name === name);
}
