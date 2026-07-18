// Golden scenarios shared by unit tests and benchmarks. Each builds a FakeSource
// in a known state; scenarios that exercise damage expose a `step` to mutate the
// grid frame-to-frame (the benchmark harness clears dirty between steps).

import { CellFlags } from '../types.ts';
import type { Rgb } from '../types.ts';
import { FakeSource } from './fake-source.ts';

export interface Scenario {
  name: string;
  description: string;
  cols: number;
  rows: number;
  build(): FakeSource;
  /** Optional per-frame mutation for churn benchmarks. Returns nothing. */
  step?(source: FakeSource, frame: number): void;
  /**
   * Optional per-frame viewport top. Scenarios that scroll rather than mutate
   * express their motion here; the default is the top of the active screen.
   * Returned rows are absolute (0 = oldest scrollback line).
   */
  viewportY?(source: FakeSource, frame: number): number;
  /**
   * How much of the grid this scenario dirties on its own each frame, as the
   * study measured it. Benchmarks in "natural" mode trust step()/viewportY()
   * to produce that damage; benchmarks in "full" mode override it by dirtying
   * every row, which is the worst case rather than the workload.
   */
  damage: 'static' | 'full-screen' | 'partial' | 'scroll-only';
}

const COLS = 120;
const ROWS = 40;

const FG = 0xd0d0d0;
const BG = 0x101010;

/** Plain ASCII paragraph text, static. */
export const asciiScenario: Scenario = {
  name: 'ascii',
  damage: 'static',
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
  damage: 'static',
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
  damage: 'static',
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
  damage: 'partial',
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
  damage: 'full-screen',
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

// --- study workloads -------------------------------------------------------
//
// The four workloads the performance study used to characterise the incumbent
// 2D bundle. Unlike the scenarios above, these are shaped to produce their own
// damage each frame, so they can be benchmarked in "natural" mode where the
// damage pattern is the point rather than an override.

const DUMP_PALETTE: Rgb[] = [
  0xe06c75, 0x98c379, 0xe5c07b, 0x61afef, 0xc678dd, 0x56b6c2, 0xabb2bf, 0x5c6370,
];

/**
 * Large colored dump: the `cat a colorized build log` case. Every frame scrolls
 * one line in, so every row's content changes and the whole screen is dirty.
 * Text is heavily SGR-colored to check that per-cell color churn does not cost
 * atlas work (fg is tinted per instance, not baked into the key).
 */
export const dumpScenario: Scenario = {
  name: 'dump',
  damage: 'full-screen',
  description: 'Large colored dump: 24-bit SGR log text scrolling a line a frame.',
  cols: COLS,
  rows: ROWS,
  build() {
    const s = new FakeSource({ cols: COLS, rows: ROWS, fg: FG, bg: BG });
    fillDump(s, 0);
    return s;
  },
  step(s, frame) {
    fillDump(s, frame);
  },
};

const DUMP_WORDS = [
  'compiling', 'module', 'linking', 'warning:', 'unused', 'variable', 'in',
  'src/main.rs', 'finished', 'release', 'target(s)', 'in', '4.21s', 'ok',
  'test', 'result:', 'passed', 'ignored', 'measured', 'filtered', 'out',
];

function fillDump(s: FakeSource, frame: number): void {
  for (let r = 0; r < ROWS; r++) {
    const row = s.activeTop + r;
    // Line identity shifts by one each frame: this is a scrolling dump, so the
    // content at screen row r on frame n is what was at row r+1 on frame n-1.
    const line = frame + r;
    let col = 0;
    col = s.writeText(row, col, '[' + String(line).padStart(6, '0') + '] ', {
      fg: 0x5c6370,
    });
    let w = line * 3;
    while (col < COLS - 12) {
      const word = DUMP_WORDS[w % DUMP_WORDS.length];
      const fg = DUMP_PALETTE[(w + line) % DUMP_PALETTE.length];
      col = s.writeText(row, col, word + ' ', { fg });
      w++;
    }
    for (let c = col; c < COLS; c++) s.setCell(row, c, 32, {});
  }
}

/**
 * Alt-screen animation: a full-screen TUI whose chrome is static and whose
 * inner panel animates. Only the animated rows dirty each frame, which is the
 * case damage tracking exists for. The static chrome still has to be drawn by
 * the GPU every frame, so this separates "cells drawn" from "rows uploaded".
 */
export const altScreenScenario: Scenario = {
  name: 'altscreen',
  damage: 'partial',
  description: 'Alt-screen TUI: static chrome with an animated 8-row inner panel.',
  cols: COLS,
  rows: ROWS,
  build() {
    const s = new FakeSource({ cols: COLS, rows: ROWS, fg: FG, bg: BG });
    s.setMode(1049, true); // alt screen active
    s.clearRegion(s.activeTop, s.activeTop + ROWS);
    drawChrome(s);
    drawPanel(s, 0);
    s.clearDirty();
    return s;
  },
  step(s, frame) {
    drawPanel(s, frame);
  },
};

const SCROLLBACK = 2000;

const PANEL_TOP = 8;
const PANEL_ROWS = 8;

function drawChrome(s: FakeSource): void {
  const top = s.activeTop;
  s.writeText(top, 0, '┌' + '─'.repeat(COLS - 2) + '┐', { fg: 0x5c6370 });
  s.writeText(top + 1, 0, '│ dashboard', { flags: CellFlags.BOLD });
  for (let r = 2; r < ROWS - 2; r++) {
    s.setCell(top + r, 0, '│'.codePointAt(0)!, { fg: 0x5c6370 });
    s.setCell(top + r, COLS - 1, '│'.codePointAt(0)!, { fg: 0x5c6370 });
  }
  s.writeText(top + ROWS - 2, 0, '└' + '─'.repeat(COLS - 2) + '┘', { fg: 0x5c6370 });
  s.writeText(top + ROWS - 1, 0, ' q quit   r reload   tab next pane ', {
    fg: 0x282c34,
    bg: 0x61afef,
  });
}

function drawPanel(s: FakeSource, frame: number): void {
  const top = s.activeTop + PANEL_TOP;
  const spinner = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
  for (let r = 0; r < PANEL_ROWS; r++) {
    const row = top + r;
    // Clear the panel interior, leaving the border columns alone.
    for (let c = 2; c < COLS - 2; c++) s.setCell(row, c, 32, {});
    const pct = (frame * 3 + r * 11) % 101;
    const barWidth = Math.round((pct / 100) * (COLS - 40));
    let col = 4;
    col = s.writeText(row, col, spinner[(frame + r) % spinner.length] + ' ');
    col = s.writeText(row, col, ('worker-' + r).padEnd(12), { flags: CellFlags.BOLD });
    col = s.writeText(row, col, '█'.repeat(barWidth), { fg: 0x98c379 });
    col = s.writeText(row, col, '░'.repeat(COLS - 40 - barWidth), { fg: 0x3e4451 });
    s.writeText(row, col + 1, String(pct).padStart(3) + '%', { fg: 0xe5c07b });
  }
}

/**
 * Scroll storm: a deep scrollback dragged past the viewport a few lines a
 * frame, with no cell ever mutating. Nothing is dirty, so this measures the
 * pure scroll path. vtgl currently repaints in full on any viewport change,
 * which this workload is meant to expose rather than hide.
 */
export const scrollStormScenario: Scenario = {
  name: 'scrollstorm',
  damage: 'scroll-only',
  description: 'Scroll storm: 2000 rows of scrollback dragged 3 lines a frame.',
  cols: COLS,
  rows: ROWS,
  build() {
    const s = new FakeSource({
      cols: COLS,
      rows: ROWS,
      scrollbackRows: SCROLLBACK,
      fg: FG,
      bg: BG,
    });
    for (let row = 0; row < SCROLLBACK + ROWS; row++) {
      let col = 0;
      col = s.writeText(row, col, String(row).padStart(5, ' ') + '  ', { fg: 0x5c6370 });
      const word = DUMP_WORDS[row % DUMP_WORDS.length];
      while (col < COLS - 12) {
        col = s.writeText(row, col, word + ' ', {
          fg: DUMP_PALETTE[row % DUMP_PALETTE.length],
        });
      }
    }
    s.setCursor({ visible: false });
    s.clearDirty();
    return s;
  },
  viewportY(_s, frame) {
    // Walk down the scrollback three lines a frame and wrap, so the workload is
    // stable over any frame count.
    return (frame * 3) % SCROLLBACK;
  },
};

/**
 * Blank-heavy TUI screen: an editor sitting idle, mostly empty cells, with one
 * status line repainting each frame (a clock ticking). This is the cheap case,
 * and the one where the 2D path's blank-cell skip is competitive.
 */
export const tuiScenario: Scenario = {
  name: 'tui',
  damage: 'partial',
  description: 'Blank-heavy editor screen; one status line repaints per frame.',
  cols: COLS,
  rows: ROWS,
  build() {
    const s = new FakeSource({ cols: COLS, rows: ROWS, fg: FG, bg: BG });
    s.clearRegion(s.activeTop, s.activeTop + ROWS);
    const top = s.activeTop;
    const code = [
      'package main',
      '',
      'import "fmt"',
      '',
      'func main() {',
      '\tfmt.Println("hello")',
      '}',
    ];
    for (let r = 0; r < code.length; r++) {
      s.writeText(top + r, 0, String(r + 1).padStart(4) + ' ', { fg: 0x5c6370 });
      s.writeText(top + r, 5, code[r].replace('\t', '    '));
    }
    for (let r = code.length; r < ROWS - 2; r++) {
      s.writeText(top + r, 0, '   ~', { fg: 0x3e4451 });
    }
    drawStatus(s, 0);
    s.setCursor({ x: 5, y: top + 5 });
    s.clearDirty();
    return s;
  },
  step(s, frame) {
    drawStatus(s, frame);
  },
};

function drawStatus(s: FakeSource, frame: number): void {
  const row = s.activeTop + ROWS - 1;
  for (let c = 0; c < COLS; c++) s.setCell(row, c, 32, { bg: 0x3e4451 });
  const secs = frame % 60;
  const text =
    ' NORMAL  main.go  go  ln 6, col 5  ' + String(secs).padStart(2, '0') + 's elapsed ';
  s.writeText(row, 0, text, { fg: 0xd0d0d0, bg: 0x3e4451, flags: CellFlags.BOLD });
}

export const scenarios: Scenario[] = [
  asciiScenario,
  cjkScenario,
  emojiScenario,
  blankScenario,
  churnScenario,
];

/** The four workloads the performance study characterised the 2D bundle on. */
export const workloads: Scenario[] = [
  dumpScenario,
  altScreenScenario,
  scrollStormScenario,
  tuiScenario,
];

export const allScenarios: Scenario[] = [...scenarios, ...workloads];

export function scenarioByName(name: string): Scenario | undefined {
  return allScenarios.find((s) => s.name === name);
}
