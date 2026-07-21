// Core public contract for vtgl.
//
// The renderer consumes a VtSource strictly read-only. It never imports a VT,
// never touches clipboard, protocol, or fonts beyond the options handed to its
// constructor. Everything the renderer needs to draw a frame is reachable
// through the interfaces in this file.

/**
 * Per-cell style bitfield. Values match the ghostty-vt cell flag layout so the
 * reference adapter can pass the wasm flags through unchanged, but nothing in
 * the renderer depends on the source being ghostty-vt.
 */
export const CellFlags = {
  NONE: 0,
  BOLD: 1,
  ITALIC: 2,
  UNDERLINE: 4,
  STRIKETHROUGH: 8,
  INVERSE: 16,
  INVISIBLE: 32,
  BLINK: 64,
  FAINT: 128,
} as const;
export type CellFlags = (typeof CellFlags)[keyof typeof CellFlags];

/**
 * A packed 24-bit color, 0xRRGGBB. The source is expected to have already
 * resolved palette indices and default colors into concrete RGB triples; the
 * renderer does no palette lookup of its own. INVERSE is likewise expected to
 * be pre-resolved by the source OR applied by the renderer (see RendererOptions
 * `resolveInverse`).
 */
export type Rgb = number;

/**
 * A materialized cell. This struct shape is used by convenience and hit-testing
 * APIs (cellAtPixel). The per-frame hot path does NOT allocate one of these per
 * cell; it reads columns through LineView numeric accessors instead.
 */
export interface Cell {
  /** Primary Unicode scalar value. 0 (empty) or 32 (space) mark a blank cell. */
  codepoint: number;
  /** Full grapheme cluster to shape/raster, e.g. an emoji ZWJ sequence. */
  grapheme: string;
  /** Display columns: 1 = normal, 2 = wide (CJK/emoji), 0 = spacer tail of a wide cell. */
  width: number;
  /** Foreground color, packed 0xRRGGBB. */
  fg: Rgb;
  /** Background color, packed 0xRRGGBB. */
  bg: Rgb;
  /** Bitfield of CellFlags. */
  flags: number;
}

/**
 * Allocation-free row accessor. getLine returns one of these; the renderer's
 * inner loop reads numeric fields with zero garbage. grapheme() is the only
 * accessor that may allocate and is called only for non-blank, non-spacer cells
 * (and its result is immediately interned as an atlas key string).
 */
export interface LineView {
  /** Number of columns in this line, equal to source.cols. */
  readonly length: number;
  codepoint(col: number): number;
  /** The grapheme cluster string for the cell. May allocate; call sparingly. */
  grapheme(col: number): string;
  width(col: number): number;
  fg(col: number): Rgb;
  bg(col: number): Rgb;
  flags(col: number): number;
}

export type CursorShape = 'block' | 'bar' | 'underline';

export interface CursorState {
  /** Column, 0-based, in the active screen. */
  x: number;
  /** Row, 0-based, in absolute buffer coordinates (scrollbackRows + active row). */
  y: number;
  /**
   * Whether to draw the cursor at all. A host that wants a blinking cursor owns
   * the clock and toggles this, because the renderer has none: see the blinking
   * cursor example in the README.
   */
  visible: boolean;
  shape: CursorShape;
}

/**
 * Read-only VT state the renderer draws from.
 *
 * Row coordinates are ABSOLUTE across the whole buffer:
 *   row in [0, scrollbackRows)                 -> scrollback, oldest first
 *   row in [scrollbackRows, scrollbackRows+rows) -> the active screen
 * render(source, viewportY) draws the `rows` lines starting at absolute
 * `viewportY`. The renderer never mutates the source; dirty state is owned and
 * cleared by whoever drives the source, out of band from render().
 */
export interface VtSource {
  /** Visible viewport height in rows. */
  readonly rows: number;
  /** Width in columns. */
  readonly cols: number;
  /** Number of scrollback rows available above the active screen. */
  readonly scrollbackRows: number;

  /** Column-addressable view of one absolute row. */
  getLine(row: number): LineView;
  /** Materialize a single cell (convenience / hit testing). */
  getCell(row: number, col: number): Cell;
  /** Grapheme cluster string at an absolute cell. */
  getGraphemeString(row: number, col: number): string;

  /** Cursor position and appearance, in absolute coordinates. */
  getCursor(): CursorState;

  /**
   * True if the absolute row has changed since the driver last cleared its
   * dirty state. Read-only for the renderer. A source with no damage tracking
   * may return true always (correct, just slower).
   */
  isRowDirty(row: number): boolean;
}

// ---------------------------------------------------------------------------
// Renderer output surface
// ---------------------------------------------------------------------------

export interface Theme {
  /** Default foreground, 0xRRGGBB. */
  foreground: Rgb;
  /** Default background, 0xRRGGBB. */
  background: Rgb;
  /** Cursor block/bar color. */
  cursor: Rgb;
  /** Text color under a block cursor; defaults to `background` if omitted. */
  cursorText?: Rgb;
}

export interface RendererOptions {
  /** CSS font stack. The renderer measures and rasters with this only. */
  fontFamily: string;
  /** Font size in CSS pixels. */
  fontSize: number;
  /** Line height multiplier applied to the font's natural height. Default 1.2. */
  lineHeight?: number;
  /** Extra horizontal advance in CSS px added to the measured cell width. */
  letterSpacing?: number;
  /** Device pixel ratio for the backing store. Default: devicePixelRatio or 1. */
  dpr?: number;
  /** Initial colors. */
  theme: Theme;
  /**
   * If true, the renderer swaps fg/bg for cells carrying CellFlags.INVERSE.
   * If the source already pre-resolves inverse, leave this false.
   */
  resolveInverse?: boolean;
  /**
   * Optional run shaper hook (see ShaperHook). Both backends honour it. Absent,
   * every cell is its own single-grapheme run and the renderer behaves exactly
   * as it did before shaping existed, which is why this is opt-in: `arabicShaper`
   * reorders cells within a run, and that is a trade a host must choose.
   */
  shaper?: ShaperHook;
}

export interface Metrics {
  cols: number;
  rows: number;
  /** Cell size in device pixels (what the atlas and geometry use). */
  cellWidth: number;
  cellHeight: number;
  /** Cell size in CSS pixels (what hit testing maps against). */
  cssCellWidth: number;
  cssCellHeight: number;
  /** Text baseline offset from the top of the cell, device pixels. */
  baseline: number;
  dpr: number;
  /** Backing store size in device pixels. */
  canvasWidth: number;
  canvasHeight: number;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
}

/**
 * A grid coordinate. The row's frame of reference depends on the producer:
 * cellAtPixel/pixelForCell use a VIEWPORT row in [0, rows), while the
 * cursorMove event reports an ABSOLUTE buffer row taken from CursorState.y.
 * Add viewportY to a hit-test row to get an absolute one.
 */
export interface CellCoord {
  col: number;
  row: number;
}

/** Pixel rectangle in CSS pixels, top-left origin. */
export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Stats emitted with each `render` event. */
export interface RenderStats {
  /** Rows redrawn/uploaded this frame. */
  dirtyRows: number;
  /** Glyph instances drawn (WebGL) or fillText calls issued (Canvas2D). */
  glyphs: number;
  /** Draw calls issued (1 for Canvas2D). */
  drawCalls: number;
  /** Atlas misses that triggered a raster+upload this frame (0 for Canvas2D). */
  atlasUploads: number;
  /** Whether this frame was a full redraw (mount/resize/theme). */
  full: boolean;
  /** CPU time spent in render(), milliseconds. */
  cpuMs: number;
}

export interface RendererEventMap {
  render: RenderStats;
  cursorMove: CellCoord;
}

export type RendererBackend = 'webgl2' | 'canvas2d';

/**
 * The renderer output API. Both the WebGL2 core and the Canvas2D fallback
 * implement exactly this. Construction takes RendererOptions; the two backends
 * differ only in how render() turns VT state into pixels.
 */
export interface Renderer {
  readonly backend: RendererBackend;

  /** Attach to a canvas. Must be called before render/resize. */
  mount(canvas: HTMLCanvasElement | OffscreenCanvas): void;

  /**
   * Draw the frame. `viewportY` is the absolute row drawn at the top of the
   * viewport (0 = top of scrollback ... scrollbackRows = active screen top).
   */
  render(source: VtSource, viewportY: number): void;

  /**
   * Ask for a render on the next animation frame, coalescing repeat requests
   * within one frame into a single render. Prefer this over render() on any
   * path driven by inbound data or input; render() stays available for callers
   * that already own a frame loop.
   */
  requestRender(source: VtSource, viewportY: number): void;

  /** Render any frame booked by requestRender right now. */
  flushRender(): void;

  /** Reconfigure grid size and device pixel ratio. Forces a full redraw. */
  resize(cols: number, rows: number, dpr: number): void;

  /** Replace colors. Forces a full redraw. */
  setTheme(theme: Theme): void;

  getMetrics(): Metrics;

  /**
   * Map a CSS-pixel point (relative to the canvas) to a grid cell, or null when
   * the point is outside the grid. The returned row is VIEWPORT-relative,
   * [0, rows); add viewportY for an absolute buffer row.
   */
  cellAtPixel(px: number, py: number): CellCoord | null;

  /** Map a viewport-relative grid cell to its CSS-pixel rectangle. */
  pixelForCell(col: number, row: number): PixelRect;

  // Event emitter surface.
  on<K extends keyof RendererEventMap>(
    event: K,
    handler: (payload: RendererEventMap[K]) => void,
  ): () => void;
  off<K extends keyof RendererEventMap>(
    event: K,
    handler: (payload: RendererEventMap[K]) => void,
  ): void;

  /** Release GPU/context resources. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Shaping-later hook
// ---------------------------------------------------------------------------

/** Style attributes that influence glyph selection/shaping. */
export interface RunStyle {
  bold: boolean;
  italic: boolean;
}

/**
 * Device-pixel geometry a shaper needs to position and size glyphs. The
 * renderer computes these from the font metrics and hands them to the shaper
 * through `ShaperHook.setMetrics` after every measure/resize; a shaper that
 * works in code points (the PF-B `arabicShaper`) ignores them, while one that
 * lays glyphs at real coordinates (the HarfBuzz shaper) needs them to convert
 * font units to pixels and to fit a run across the cells the VT assigned it.
 */
export interface ShaperMetrics {
  /** Cell width in device pixels. */
  cellWidth: number;
  /** Cell height in device pixels. */
  cellHeight: number;
  /** Baseline offset from the top of the cell, device pixels. */
  baseline: number;
  /** Font size in device pixels (CSS fontSize * dpr). */
  deviceFontPx: number;
  /** Device pixel ratio. */
  dpr: number;
}

/**
 * A glyph rastered from a font outline rather than through `fillText`.
 *
 * The HarfBuzz shaper produces these: each shaped cluster (a base letter plus
 * any GPOS-positioned marks, composited) is drawn from its glyph outlines into
 * a tile that carries the cluster's full ink, sized larger than a cell so a
 * connecting stroke may overhang the cell it started in. That overhang is what
 * removes the WebGL2 join seam the per-cell `fillText` raster left: nothing is
 * cropped to a cell boundary. The `fillText` path (default and PF-B) never sets
 * this, so it is unaffected.
 */
export interface OutlineGlyph {
  /**
   * Fill the cluster's glyph(s) into `ctx` with the cluster pen origin at
   * (penX, penY) in device pixels, using the context's current fill style. Both
   * backends call this: the WebGL2 atlas draws into a tile at the tile-local pen
   * origin, and the Canvas2D backend draws straight to the screen pen.
   */
  draw(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, penX: number, penY: number): void;
  /** Tile width in device pixels (the WebGL2 atlas slot width). */
  tileW: number;
  /** Tile height in device pixels (the WebGL2 atlas slot height). */
  tileH: number;
  /** Pen origin x within the tile, device pixels from the tile's left edge. */
  penX: number;
  /** Pen origin y (the baseline) within the tile, device pixels from the top. */
  penY: number;
}

/** One positioned glyph produced by a shaper. */
export interface ShapedGlyph {
  /**
   * Atlas key for this glyph. Because the atlas keys by string, a shaper can
   * mint stable per-glyph keys and they slot into the same atlas the default
   * per-grapheme path uses. The key must vary with everything that changes the
   * rastered pixels, `cluster`, `rtl` and `fitAdvance` included: two glyphs that
   * look different and share a key would collide in the cache. An outline glyph
   * keys by (face, glyph ids, offsets, scale) instead of the grapheme.
   */
  atlasKey: string;
  /** The substring to raster for this glyph (contextual form for Arabic, etc). */
  cluster: string;
  /**
   * Column this glyph is drawn in, relative to the start of the run. A shaper
   * that reorders (see `arabicShaper`) returns a column other than the source
   * cell's own index, which is how run-local right-to-left ordering is expressed.
   */
  col: number;
  /**
   * Horizontal offset in device px from the column's left edge. On the
   * `fillText` path this is where the cluster is drawn inside its cell; on the
   * outline path it is where the cluster's pen origin lands relative to the
   * column, which may sit outside the cell so a run can be positioned at
   * HarfBuzz coordinates.
   */
  xOffset: number;
  /**
   * Vertical offset in device px from the text baseline, positive downward.
   * Only the outline path uses it; the `fillText` path leaves it 0.
   */
  yOffset?: number;
  /**
   * When present, the glyph is rastered from a font outline (HarfBuzz) rather
   * than through `fillText`, and positioned at (xOffset, yOffset) with the tile
   * carrying full ink and no per-cell crop.
   */
  outline?: OutlineGlyph;
  /**
   * Raster the cluster in a right-to-left context. Chromium's canvas only
   * applies a following joining context (a trailing ZWJ) when the context is
   * RTL; under the default LTR direction it is dropped and every Arabic letter
   * comes back isolated or final. Measured, not assumed: see docs/limits.md.
   */
  rtl: boolean;
  /**
   * Scale the cluster horizontally so its advance equals the slot width. A
   * shaped Arabic letter's natural advance has nothing to do with the monospace
   * cell the VT assigned it, so without this the joining strokes land wherever
   * the font puts them and do not meet across the cell boundary.
   */
  fitAdvance: boolean;
  /**
   * Columns this glyph spans, starting at `col`. Default 1. A shaper that
   * collapses two cells into one glyph (a lam-alef ligature) returns 2 here and
   * emits an empty cluster for the covered column, so the ligature is fitted and
   * rastered across both cells the VT assigned it rather than crammed into one.
   */
  cols?: number;
}

/** Result of shaping one contiguous same-style run of cells. */
export interface ShapedRun {
  glyphs: ShapedGlyph[];
}

/**
 * Optional contextual shaper, honoured by both backends.
 *
 * The renderer groups contiguous cells of identical style into runs, asks the
 * shaper to shape them, and rasters the returned glyphs under
 * `ShapedGlyph.atlasKey`. Absent a shaper, each cell is a length-1 run whose
 * atlas key is its grapheme string and nothing about rendering changes.
 *
 * shapeRun takes the run's cells rather than one concatenated string. The
 * original seam passed a string, which cannot be split back into cells: a cell's
 * grapheme may carry combining marks, so `text.length` and the run's column
 * count are unrelated and the shaper has no way to answer in the columns the
 * renderer must draw in. Cells in, columns out.
 */
export interface ShaperHook {
  /**
   * Whether this code point belongs in a shaped run at all. Called once per cell
   * on every dirty row, so it must be cheap; it exists so the renderer can skip
   * the whole run-grouping pass on rows the shaper has no interest in without
   * knowing which scripts the shaper handles.
   */
  participates(codepoint: number): boolean;
  /** Shape one contiguous same-style run. `cells[i]` is the grapheme at column i. */
  shapeRun(cells: readonly string[], style: RunStyle): ShapedRun;
  /**
   * Receive the renderer's device-pixel geometry. Called by both backends after
   * every measure and resize, before any `shapeRun`. Optional: a code-point
   * shaper does not need it. An outline shaper stores it and lays glyphs at
   * these coordinates.
   */
  setMetrics?(metrics: ShaperMetrics): void;
}
