// A scriptable VtSource for unit tests and benchmarks. Not a VT: it holds an
// absolute grid (scrollback + active) with explicit dirty tracking so tests can
// drive damage precisely. Deliberately simple; correctness over speed, though
// getLine is allocation-free (one LineView is bound per row up front).

import { CellFlags } from '../types.ts';
import type { Cell, CursorState, LineView, Rgb, VtSource } from '../types.ts';

interface Store {
  codepoint: Int32Array;
  width: Int8Array;
  fg: Int32Array;
  bg: Int32Array;
  flags: Int32Array;
  // Grapheme strings are sparse; most cells are single-codepoint. Only cells
  // whose grapheme differs from String.fromCodePoint(codepoint) get an entry.
  grapheme: (string | undefined)[];
}

export interface FakeSourceOptions {
  cols: number;
  rows: number;
  /** Extra rows above the active screen. Default 0. */
  scrollbackRows?: number;
  fg?: Rgb;
  bg?: Rgb;
}

export class FakeSource implements VtSource {
  readonly cols: number;
  readonly rows: number;
  readonly scrollbackRows: number;

  private readonly total: number;
  private readonly store: Store;
  private readonly dirty: Uint8Array;
  private readonly lineViews: LineView[];
  private readonly defaultFg: Rgb;
  private readonly defaultBg: Rgb;
  private readonly modes = new Map<number, boolean>();

  private cursor: CursorState;

  constructor(opts: FakeSourceOptions) {
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.scrollbackRows = opts.scrollbackRows ?? 0;
    this.total = this.rows + this.scrollbackRows;
    this.defaultFg = opts.fg ?? 0xffffff;
    this.defaultBg = opts.bg ?? 0x000000;

    const n = this.total * this.cols;
    this.store = {
      codepoint: new Int32Array(n),
      width: new Int8Array(n),
      fg: new Int32Array(n),
      bg: new Int32Array(n),
      flags: new Int32Array(n),
      grapheme: new Array(n),
    };
    this.store.fg.fill(this.defaultFg);
    this.store.bg.fill(this.defaultBg);
    this.store.width.fill(1);

    this.dirty = new Uint8Array(this.total);
    this.dirty.fill(1); // fresh source: everything dirty for the first frame

    this.cursor = {
      x: 0,
      y: this.scrollbackRows,
      visible: true,
      shape: 'block',
      blink: false,
    };

    this.lineViews = new Array(this.total);
    for (let row = 0; row < this.total; row++) {
      this.lineViews[row] = this.makeLineView(row);
    }
  }

  // --- VtSource -----------------------------------------------------------

  getLine(row: number): LineView {
    return this.lineViews[row];
  }

  getCell(row: number, col: number): Cell {
    const i = this.idx(row, col);
    const s = this.store;
    const cp = s.codepoint[i];
    return {
      codepoint: cp,
      grapheme: s.grapheme[i] ?? (cp === 0 ? '' : String.fromCodePoint(cp)),
      width: s.width[i],
      fg: s.fg[i],
      bg: s.bg[i],
      flags: s.flags[i],
    };
  }

  getGraphemeString(row: number, col: number): string {
    const i = this.idx(row, col);
    const cp = this.store.codepoint[i];
    return this.store.grapheme[i] ?? (cp === 0 ? '' : String.fromCodePoint(cp));
  }

  getCursor(): CursorState {
    return this.cursor;
  }

  isRowDirty(row: number): boolean {
    return this.dirty[row] === 1;
  }

  getMode(mode: number): boolean {
    return this.modes.get(mode) ?? false;
  }

  // --- scripting API ------------------------------------------------------

  /** Clear all dirty flags. Call this after a frame, as a real driver would. */
  clearDirty(): void {
    this.dirty.fill(0);
  }

  markDirty(row: number): void {
    this.dirty[row] = 1;
  }

  setMode(mode: number, on: boolean): void {
    this.modes.set(mode, on);
  }

  setCursor(partial: Partial<CursorState>): void {
    this.cursor = { ...this.cursor, ...partial };
  }

  /** Absolute row of the first active line (top of active screen). */
  get activeTop(): number {
    return this.scrollbackRows;
  }

  /** Set one cell. Marks its row dirty. */
  setCell(
    row: number,
    col: number,
    cp: number,
    opts: { fg?: Rgb; bg?: Rgb; flags?: number; width?: number; grapheme?: string } = {},
  ): void {
    const i = this.idx(row, col);
    const s = this.store;
    s.codepoint[i] = cp;
    s.width[i] = opts.width ?? 1;
    s.fg[i] = opts.fg ?? this.defaultFg;
    s.bg[i] = opts.bg ?? this.defaultBg;
    s.flags[i] = opts.flags ?? CellFlags.NONE;
    s.grapheme[i] = opts.grapheme;
    this.dirty[row] = 1;
  }

  /**
   * Write a string starting at (row, col). Handles wide graphemes: a cell whose
   * grapheme measures 2 columns writes a width-2 head and a width-0 spacer tail.
   * Returns the next free column.
   */
  writeText(
    row: number,
    col: number,
    text: string,
    opts: { fg?: Rgb; bg?: Rgb; flags?: number } = {},
  ): number {
    let c = col;
    for (const seg of graphemeSegments(text)) {
      if (c >= this.cols) break;
      const w = graphemeWidth(seg);
      const cp = seg.codePointAt(0) ?? 0;
      const multi = [...seg].length > 1;
      this.setCell(row, c, cp, {
        ...opts,
        width: w === 0 ? 1 : w,
        grapheme: multi ? seg : undefined,
      });
      if (w === 2 && c + 1 < this.cols) {
        // spacer tail
        this.setCell(row, c + 1, 0, { ...opts, width: 0 });
        c += 2;
      } else {
        c += 1;
      }
    }
    return c;
  }

  /** Fill a rectangular region with blanks (space, default colors). */
  clearRegion(row0: number, row1: number): void {
    for (let row = row0; row < row1; row++) {
      for (let col = 0; col < this.cols; col++) {
        this.setCell(row, col, 32, {});
      }
    }
  }

  // --- internals ----------------------------------------------------------

  private idx(row: number, col: number): number {
    return row * this.cols + col;
  }

  private makeLineView(row: number): LineView {
    const base = row * this.cols;
    const s = this.store;
    return {
      length: this.cols,
      codepoint: (col) => s.codepoint[base + col],
      grapheme: (col) => {
        const i = base + col;
        const cp = s.codepoint[i];
        return s.grapheme[i] ?? (cp === 0 ? '' : String.fromCodePoint(cp));
      },
      width: (col) => s.width[base + col],
      fg: (col) => s.fg[base + col],
      bg: (col) => s.bg[base + col],
      flags: (col) => s.flags[base + col],
    };
  }
}

// --- tiny grapheme helpers (test-grade, not a full UAX #29 implementation) --

/**
 * Split into grapheme-ish segments using Intl.Segmenter when available (Node 24
 * has it), else fall back to code points. Good enough to script CJK and ZWJ
 * emoji scenarios for tests.
 */
export function graphemeSegments(text: string): string[] {
  const Seg = (globalThis as { Intl?: { Segmenter?: typeof Intl.Segmenter } }).Intl?.Segmenter;
  if (Seg) {
    const seg = new Seg(undefined, { granularity: 'grapheme' });
    const out: string[] = [];
    for (const s of seg.segment(text)) out.push(s.segment);
    return out;
  }
  return [...text];
}

/** East-Asian-width-ish column count: 2 for CJK/emoji, 1 otherwise. */
export function graphemeWidth(seg: string): number {
  const cp = seg.codePointAt(0) ?? 0;
  // Multi-scalar clusters with a ZWJ or emoji presentation are wide.
  if ([...seg].length > 1) {
    if (seg.includes('‍') || /\p{Emoji_Presentation}/u.test(seg)) return 2;
  }
  if (isWideCodePoint(cp)) return 2;
  return 1;
}

function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || // CJK .. Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji blocks
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B+
  );
}
