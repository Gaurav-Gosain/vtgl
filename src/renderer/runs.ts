// Per-row shaping plan, shared by both backends.
//
// A shaper works on runs, but the renderers work on cells, so something has to
// group one into the other. This does it once per row and answers per column,
// which keeps the shaping decision out of both inner loops: each backend asks
// `has(col)` and, if the answer is yes, draws `cluster(col)` under `key(col)`
// instead of the cell's own grapheme.
//
// Two properties matter and are worth stating plainly:
//
//   1. Absent a shaper, plan() is never called and nothing here runs. The
//      default render path is byte-for-byte what it was before shaping existed.
//   2. A run is contiguous cells that are all width 1, all accepted by
//      `shaper.participates`, and all identical in fg, bg and flags. Grouping on
//      colour matters because a shaper may reorder within the run: reversing
//      cells that did not share a colour would move colours between columns.
//
// Storage is preallocated per row width and reused, so a steady-state frame
// allocates only what the shaper itself allocates for the runs it is handed.

import { CellFlags } from '../types.ts';
import type { RasterHint } from './instances.ts';
import type { LineView, OutlineGlyph, ShaperHook } from '../types.ts';

/** Bit flags packed into the per-column hint byte. */
const HINT_RTL = 1;
const HINT_FIT = 2;

export class RowShaper {
  private cols = 0;
  private active = new Uint8Array(0);
  private hints = new Uint8Array(0);
  /** Column span of the glyph at each column, 1 unless a ligature spans more. */
  private span = new Uint8Array(0);
  private xoff = new Float32Array(0);
  /** Sub-baseline y offset in device px, outline (HarfBuzz) glyphs only. */
  private yoff = new Float32Array(0);
  private clusters: string[] = [];
  private keys: string[] = [];
  /** Per-column outline glyph, present only where the shaper rastered from a face. */
  private outlines: (OutlineGlyph | undefined)[] = [];
  /** Scratch for the run's cell graphemes, handed to the shaper. */
  private cells: string[] = [];
  /** Reused raster hint, see hintFor. */
  private readonly hint: RasterHint = { key: '', rtl: false, fitAdvance: false, outline: undefined };
  private planned = false;

  resize(cols: number): void {
    if (cols === this.cols) return;
    this.cols = cols;
    this.active = new Uint8Array(cols);
    this.hints = new Uint8Array(cols);
    this.span = new Uint8Array(cols);
    this.xoff = new Float32Array(cols);
    this.yoff = new Float32Array(cols);
    this.clusters = new Array<string>(cols).fill('');
    this.keys = new Array<string>(cols).fill('');
    this.outlines = new Array<OutlineGlyph | undefined>(cols).fill(undefined);
  }

  /**
   * Group `line` into runs and shape them. Returns true if any column ended up
   * with a shaped glyph; a false return means every `has(col)` is false and the
   * caller can take its normal path unchanged.
   */
  plan(line: LineView, cols: number, shaper: ShaperHook): boolean {
    this.resize(cols);
    if (this.planned) this.active.fill(0);
    this.planned = false;

    let col = 0;
    while (col < cols) {
      // Code point first. It rejects on a range compare and it rejects nearly
      // every cell of a typical screen, which keeps the width() call off the
      // path a row with no Arabic on it actually takes. The accessors are called
      // on `line` rather than hoisted into locals because LineView is a host
      // interface and nothing in the contract says its methods ignore `this`.
      if (!shaper.participates(line.codepoint(col)) || line.width(col) !== 1) {
        col++;
        continue;
      }
      const fg = line.fg(col);
      const bg = line.bg(col);
      const flags = line.flags(col);
      let end = col + 1;
      while (
        end < cols &&
        shaper.participates(line.codepoint(end)) &&
        line.width(end) === 1 &&
        line.fg(end) === fg &&
        line.bg(end) === bg &&
        line.flags(end) === flags
      ) {
        end++;
      }

      const n = end - col;
      this.cells.length = n;
      for (let k = 0; k < n; k++) this.cells[k] = line.grapheme(col + k);

      const run = shaper.shapeRun(this.cells, {
        bold: (flags & CellFlags.BOLD) !== 0,
        italic: (flags & CellFlags.ITALIC) !== 0,
      });

      for (const g of run.glyphs) {
        // A shaper is host-supplied code. Placing a glyph outside the run it was
        // given would corrupt a cell the run does not own, so drop it rather
        // than trust the column.
        if (g.col < 0 || g.col >= n) continue;
        const c = col + g.col;
        // A glyph that spans more columns than the run has left would raster and
        // paint into a cell the run does not own, so clamp it to the run.
        const cols = g.cols === undefined ? 1 : g.cols;
        this.active[c] = 1;
        this.clusters[c] = g.cluster;
        this.keys[c] = g.atlasKey;
        this.hints[c] = (g.rtl ? HINT_RTL : 0) | (g.fitAdvance ? HINT_FIT : 0);
        this.span[c] = cols < 1 ? 1 : c + cols > n ? n - g.col : cols;
        this.xoff[c] = g.xOffset;
        this.yoff[c] = g.yOffset ?? 0;
        this.outlines[c] = g.outline;
        this.planned = true;
      }
      col = end;
    }
    return this.planned;
  }

  /**
   * Raster hint for a shaped column. Returns a shared scratch object refilled on
   * every call, so the caller must consume it before asking for another; the
   * atlas does, synchronously, and that is what keeps a shaped frame from
   * allocating one hint per glyph.
   */
  hintFor(col: number): RasterHint {
    const h = this.hint;
    h.key = this.keys[col];
    h.rtl = (this.hints[col] & HINT_RTL) !== 0;
    h.fitAdvance = (this.hints[col] & HINT_FIT) !== 0;
    h.outline = this.outlines[col];
    return h;
  }

  has(col: number): boolean {
    return this.active[col] === 1;
  }
  /** Columns the glyph at this column spans, at least 1. */
  glyphCols(col: number): number {
    const s = this.span[col];
    return s < 1 ? 1 : s;
  }
  cluster(col: number): string {
    return this.clusters[col];
  }
  key(col: number): string {
    return this.keys[col];
  }
  rtl(col: number): boolean {
    return (this.hints[col] & HINT_RTL) !== 0;
  }
  fitAdvance(col: number): boolean {
    return (this.hints[col] & HINT_FIT) !== 0;
  }
  xOffset(col: number): number {
    return this.xoff[col];
  }
  /** Sub-baseline y offset in device px for an outline glyph, else 0. */
  yOffset(col: number): number {
    return this.yoff[col];
  }
  /** The outline glyph at this column, or undefined on the fillText path. */
  outline(col: number): OutlineGlyph | undefined {
    return this.outlines[col];
  }
}
