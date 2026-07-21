// CPU-side instance buffers for the WebGL2 pipeline. Pure and GL-free so the
// instance-generation logic is unit-testable under node against the fake
// VtSource without a GPU. The WebGL2 renderer owns one of these, uploads the
// dirty byte ranges to GPU buffers, and issues the instanced draws.
//
// Three per-cell instance streams, all sized cols*rows and reused frame to
// frame (zero steady-state allocation):
//   background: 1 uint32 per cell (packed 0xRRGGBB), cell derived from InstanceID
//   glyph:      8 x 32-bit per cell  (atlas rect, glyph offset, fg, style)
//   decoration: 2 instances per cell (underline, strikethrough), 5 x 32-bit each
// Blank/spacer cells and undecorated cells emit zero-area quads, so a single
// full-grid instanced draw covers every cell with no per-cell branching on GPU.
//
// The streams are addressed by SLOT, a row index in [0, rows) that the renderer
// maps to a screen row through a rotating base (see the row ring in
// gl/shaders.ts). Nothing written here may encode a screen position: that is the
// invariant that lets a scroll rotate the base instead of rebuilding rows, so
// decoration quads carry a y relative to their own row rather than an absolute
// device-pixel y.

import { CellFlags } from '../types.ts';
import { styleMask } from '../atlas/key.ts';
import type { RowShaper } from './runs.ts';
import type { OutlineGlyph, Theme, VtSource } from '../types.ts';

/** A packed slot in the atlas, as returned by a GlyphProvider. */
export interface AtlasRect {
  x: number;
  y: number;
  w: number;
  h: number;
  colored: boolean;
  page: number;
}

/**
 * How to raster a shaped glyph, supplied by a ShaperHook. Absent (the default
 * path), the atlas keys by grapheme and rasters exactly as it always has.
 */
export interface RasterHint {
  /** Atlas key minted by the shaper, used in place of the grapheme-derived one. */
  key: string;
  /** Raster in a right-to-left context, which is what makes a trailing ZWJ count. */
  rtl: boolean;
  /** Scale horizontally so the cluster's advance equals the slot width. */
  fitAdvance: boolean;
  /**
   * When present the glyph is rastered from a font outline (HarfBuzz) into a
   * full-ink tile rather than through fillText, and `rtl`/`fitAdvance` are
   * ignored. The atlas slot is the tile, not the cell.
   */
  outline?: OutlineGlyph;
}

/**
 * Minimal glyph-supply surface the builder needs. The GL atlas implements this
 * (raster+upload on miss); tests pass a fake that hands back deterministic
 * rects. Returns null if the glyph could not be placed.
 */
export interface GlyphProvider {
  ensure(
    grapheme: string,
    styleMask: number,
    widthCols: number,
    hint?: RasterHint,
  ): AtlasRect | null;
}

export const StyleBit = {
  COLORED: 1,
  FAINT: 2,
  BLINK: 4,
} as const;

const GLYPH_UNITS = 8; // 32-bit units per glyph instance
const DECO_UNITS = 5; // 32-bit units per decoration instance
const DECO_PER_CELL = 2; // underline + strikethrough

export interface RowBuildResult {
  /** Non-degenerate glyph instances written for this row. */
  glyphs: number;
}

export class InstanceBuffers {
  cols = 0;
  rows = 0;
  private cap = 0;

  // Background: one packed color per cell.
  bg = new Uint32Array(0);

  // Glyph stream, dual-view over one ArrayBuffer.
  glyphBuf = new ArrayBuffer(0);
  glyphF32 = new Float32Array(0);
  glyphU32 = new Uint32Array(0);

  // Decoration stream, dual-view over one ArrayBuffer.
  decoBuf = new ArrayBuffer(0);
  decoF32 = new Float32Array(0);
  decoU32 = new Uint32Array(0);

  // Persistent byte views for partial uploads. Held here so the per-frame
  // upload path never allocates a view object.
  bgBytes = new Uint8Array(0);
  glyphBytes = new Uint8Array(0);
  decoBytes = new Uint8Array(0);

  // Device-pixel geometry, set via configure().
  private cellW = 0;
  private cellH = 0;
  private baseline = 0;
  private dpr = 1;
  private resolveInverse = false;

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    const cap = cols * rows;
    if (cap !== this.cap) {
      this.cap = cap;
      this.bg = new Uint32Array(cap);
      this.glyphBuf = new ArrayBuffer(cap * GLYPH_UNITS * 4);
      this.glyphF32 = new Float32Array(this.glyphBuf);
      this.glyphU32 = new Uint32Array(this.glyphBuf);
      this.decoBuf = new ArrayBuffer(cap * DECO_PER_CELL * DECO_UNITS * 4);
      this.decoF32 = new Float32Array(this.decoBuf);
      this.decoU32 = new Uint32Array(this.decoBuf);
      this.bgBytes = new Uint8Array(this.bg.buffer);
      this.glyphBytes = new Uint8Array(this.glyphBuf);
      this.decoBytes = new Uint8Array(this.decoBuf);
    }
  }

  configure(
    cellW: number,
    cellH: number,
    baseline: number,
    dpr: number,
    resolveInverse: boolean,
  ): void {
    this.cellW = cellW;
    this.cellH = cellH;
    this.baseline = baseline;
    this.dpr = dpr;
    this.resolveInverse = resolveInverse;
  }

  /** Byte offset/length of one slot's slice in the background buffer. */
  bgRange(slot: number): { offset: number; length: number } {
    return { offset: slot * this.cols * 4, length: this.cols * 4 };
  }

  glyphRange(slot: number): { offset: number; length: number } {
    return { offset: slot * this.cols * GLYPH_UNITS * 4, length: this.cols * GLYPH_UNITS * 4 };
  }

  decoRange(slot: number): { offset: number; length: number } {
    const perRow = this.cols * DECO_PER_CELL * DECO_UNITS * 4;
    return { offset: slot * perRow, length: perRow };
  }

  /** Total instance counts for the draw calls. */
  get cellCount(): number {
    return this.cols * this.rows;
  }
  get decoCount(): number {
    return this.cols * this.rows * DECO_PER_CELL;
  }

  /**
   * Fill the background slice of one slot with a flat color. Used before
   * rebuilding a slot whose previous occupant is unrelated to the incoming row:
   * a row that opens on a width-0 spacer would otherwise inherit the old
   * occupant's background in that cell, since only a wide head writes one.
   */
  clearSlotBg(slot: number, color: number): void {
    const start = slot * this.cols;
    this.bg.fill(color & 0xffffff, start, start + this.cols);
  }

  /**
   * Recompute one slot (0..rows-1) reading absolute source row `absRow`. Fills
   * the slot's slice of all three streams. Blank/spacer cells and undecorated
   * cells become zero-area quads. Nothing written depends on which screen row
   * the slot currently draws at.
   */
  buildRow(
    source: VtSource,
    absRow: number,
    slot: number,
    provider: GlyphProvider,
    shaped?: RowShaper,
  ): RowBuildResult {
    const line = source.getLine(absRow);
    const cols = this.cols;
    let glyphs = 0;

    for (let col = 0; col < cols; col++) {
      const cellIdx = slot * cols + col;
      const gBase = cellIdx * GLYPH_UNITS;
      const dBase = cellIdx * DECO_PER_CELL * DECO_UNITS;

      const width = line.width(col);

      // Default to a blank, transparent-glyph, undecorated cell; overwrite below.
      this.zeroGlyph(gBase);
      this.zeroDeco(dBase);

      if (width === 0) {
        // Spacer tail of a preceding wide glyph. Its background was written by
        // the wide head; leave it as the head set it (do not clobber to default).
        continue;
      }

      const cp = line.codepoint(col);
      let fg = line.fg(col);
      let bg = line.bg(col);
      const flags = line.flags(col);

      if (this.resolveInverse && flags & CellFlags.INVERSE) {
        const t = fg;
        fg = bg;
        bg = t;
      }

      const spanCols = width === 2 ? 2 : 1;
      // Background for this cell (and the spacer tail for a wide head).
      this.bg[cellIdx] = bg & 0xffffff;
      if (spanCols === 2 && col + 1 < cols) {
        this.bg[cellIdx + 1] = bg & 0xffffff;
      }

      const blank = cp === 0 || cp === 32;
      if (blank || flags & CellFlags.INVISIBLE) continue;

      // A shaped column draws the shaper's cluster under the shaper's key. The
      // cell it came from may be elsewhere in the run, but a run is uniform in
      // style, so the colours and flags read above still apply here.
      const isShaped = shaped !== undefined && shaped.has(col);
      const grapheme = isShaped ? shaped.cluster(col) : line.grapheme(col);
      if (grapheme.length === 0) continue;

      // A shaped ligature spans the cells the VT gave its two letters, so its
      // slot and quad are that wide; an unshaped glyph spans its own cell width.
      const glyphCols = isShaped ? shaped.glyphCols(col) : spanCols;
      const rect = provider.ensure(
        grapheme,
        styleMask(flags),
        glyphCols,
        isShaped ? shaped.hintFor(col) : undefined,
      );
      if (rect === null) continue; // could not place; drawn as blank this frame

      const x = col * this.cellW;
      // Atlas rect (texels == device px), no per-cell offset in the default path.
      this.glyphF32[gBase + 0] = rect.x;
      this.glyphF32[gBase + 1] = rect.y;
      this.glyphF32[gBase + 2] = rect.w;
      this.glyphF32[gBase + 3] = rect.h;
      // An outline glyph places its tile so the cluster's pen origin lands at
      // (col*cellW + xOffset, baseline + yOffset); the quad is the tile, which
      // may overhang the cell. The fillText path keeps its cell-local offset.
      const outline = isShaped ? shaped!.outline(col) : undefined;
      if (outline !== undefined) {
        this.glyphF32[gBase + 4] = shaped!.xOffset(col) - outline.penX;
        this.glyphF32[gBase + 5] = this.baseline + shaped!.yOffset(col) - outline.penY;
      } else {
        this.glyphF32[gBase + 4] = isShaped ? shaped!.xOffset(col) : 0; // glyphOff.x
        this.glyphF32[gBase + 5] = 0; // glyphOff.y
      }
      this.glyphU32[gBase + 6] = fg & 0xffffff;
      let style = (rect.page & 0xff) << 8;
      if (rect.colored) style |= StyleBit.COLORED;
      if (flags & CellFlags.FAINT) style |= StyleBit.FAINT;
      if (flags & CellFlags.BLINK) style |= StyleBit.BLINK;
      this.glyphU32[gBase + 7] = style;
      glyphs++;

      // Decorations as solid quads spanning the glyph's columns. y is relative
      // to the row top; the shader adds the row offset (see the row ring).
      if (flags & (CellFlags.UNDERLINE | CellFlags.STRIKETHROUGH)) {
        const span = spanCols * this.cellW;
        const thickness = Math.max(1, Math.round(this.dpr));
        if (flags & CellFlags.UNDERLINE) {
          const uy = Math.min(this.cellH - thickness, this.baseline + thickness);
          this.writeDeco(dBase, x, uy, span, thickness, fg);
        }
        if (flags & CellFlags.STRIKETHROUGH) {
          const sy = Math.round(this.cellH * 0.5);
          this.writeDeco(dBase + DECO_UNITS, x, sy, span, thickness, fg);
        }
      }
    }

    return { glyphs };
  }

  /** Zero every cell's streams (used on a full clear before rebuilding). */
  clearAll(theme: Theme): void {
    this.bg.fill(theme.background & 0xffffff);
    this.glyphF32.fill(0);
    this.glyphU32.fill(0);
    this.decoF32.fill(0);
    this.decoU32.fill(0);
  }

  private zeroGlyph(base: number): void {
    // Zero atlas w/h => degenerate quad. Leave fg/style irrelevant.
    this.glyphF32[base + 2] = 0;
    this.glyphF32[base + 3] = 0;
  }

  private zeroDeco(base: number): void {
    this.decoF32[base + 2] = 0;
    this.decoF32[base + 3] = 0;
    this.decoF32[base + DECO_UNITS + 2] = 0;
    this.decoF32[base + DECO_UNITS + 3] = 0;
  }

  private writeDeco(
    base: number,
    x: number,
    yy: number,
    w: number,
    h: number,
    color: number,
  ): void {
    this.decoF32[base + 0] = x;
    this.decoF32[base + 1] = yy;
    this.decoF32[base + 2] = w;
    this.decoF32[base + 3] = h;
    this.decoU32[base + 4] = color & 0xffffff;
  }
}

export { GLYPH_UNITS, DECO_UNITS, DECO_PER_CELL };
