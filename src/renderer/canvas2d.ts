// Canvas2D fallback renderer.
//
// Implements the full Renderer interface with a 2D context, for environments
// without WebGL2. Behavior mirrors the known-good ghostty-web canvas2d path
// (MIT), written fresh here: dirty-row redraw, blank-cell skip, wide-char
// spacer handling, and font/fill string caches. This is the correctness
// reference the WebGL2 core must match pixel-decision-for-pixel-decision.
//
// Scrolling shifts the pixels instead of repainting them: the canvas is blitted
// onto itself by the scroll delta and only the rows the scroll uncovered are
// redrawn. That is the 2D counterpart of the WebGL2 slot rotation, and it holds
// for the same reason, that a row's pixels do not depend on which screen row it
// last drew at.

import { CellFlags } from '../types.ts';
import { Emitter } from '../events.ts';
import { toCss } from '../color.ts';
import { drawBoxGlyph, isBoxDrawingGrapheme } from './box-drawing.ts';
import { computeCellMetrics, measureFont } from './metrics.ts';
import { RenderScheduler } from './scheduler.ts';
import { RowShaper } from './runs.ts';
import type {
  CellCoord,
  CursorState,
  LineView,
  Metrics,
  PixelRect,
  Renderer,
  RendererBackend,
  RendererEventMap,
  RendererOptions,
  RenderStats,
  Rgb,
  Theme,
  VtSource,
} from '../types.ts';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const DEFAULT_LINE_HEIGHT = 1.2;
const FONT_CACHE_LIMIT = 8;
const FILL_CACHE_LIMIT = 512;
const ADVANCE_CACHE_LIMIT = 512;

export class Canvas2DRenderer implements Renderer {
  readonly backend: RendererBackend = 'canvas2d';

  private readonly emitter = new Emitter<RendererEventMap>();
  private readonly opts: Required<Omit<RendererOptions, 'shaper' | 'letterSpacing'>> &
    Pick<RendererOptions, 'shaper' | 'letterSpacing'>;

  private canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  private ctx: Ctx2D | null = null;

  private theme: Theme;
  private cols = 0;
  private rows = 0;
  private dpr: number;

  // Device-pixel geometry.
  private cellW = 0;
  private cellH = 0;
  private baseline = 0;
  private deviceFontPx = 0;

  private scheduler: RenderScheduler | null = null;
  private pendingFrame: { source: VtSource; viewportY: number } | null = null;

  // Only constructed when a shaper is configured, so the default path never
  // pays for the per-row grouping pass or its buffers.
  private readonly rowShaper: RowShaper | null;

  private forceFull = true;
  private lastCursorKey = -1;
  // Viewport row drawn at the top of the last frame. Scrolling changes which
  // absolute rows map to which screen rows without dirtying any of them, so a
  // change here drives the pixel shift below.
  private lastViewportY = -1;
  // Absolute row the cursor was painted on last frame, and the state it was
  // painted in. The cursor lives in the same pixels as the text, so when it
  // moves, the row it left has to be repainted or the old block survives there.
  private prevCursorRow = -1;
  private prevCursorKey = -1;
  // Whether the last painted rows contained a blinking cell, and which phase
  // they were painted in. Only meaningful together: a phase flip dirties no row,
  // so it has to force a repaint of its own, and only when something blinks.
  private hasBlink = false;
  private lastBlinkOn = false;

  private readonly fontCache = new Map<number, string>();
  private readonly fillCache = new Map<number, string>();
  private readonly advanceCache = new Map<string, number>();

  constructor(options: RendererOptions) {
    this.opts = {
      fontFamily: options.fontFamily,
      fontSize: options.fontSize,
      lineHeight: options.lineHeight ?? DEFAULT_LINE_HEIGHT,
      dpr: options.dpr ?? globalDpr(),
      theme: options.theme,
      resolveInverse: options.resolveInverse ?? false,
      letterSpacing: options.letterSpacing,
      shaper: options.shaper,
    };
    this.rowShaper = options.shaper ? new RowShaper() : null;
    this.theme = options.theme;
    this.dpr = this.opts.dpr;
  }

  // --- lifecycle ----------------------------------------------------------

  mount(canvas: HTMLCanvasElement | OffscreenCanvas): void {
    this.canvas = canvas;
    const ctx = (canvas as HTMLCanvasElement).getContext('2d', { alpha: false });
    if (!ctx) throw new Error('vtgl: 2d context unavailable');
    this.ctx = ctx as Ctx2D;
    this.measure();
    this.forceFull = true;
  }

  resize(cols: number, rows: number, dpr: number): void {
    this.cols = cols;
    this.rows = rows;
    this.dpr = dpr;
    this.measure();
    this.applyBackingStore();
    this.forceFull = true;
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.fillCache.clear();
    this.forceFull = true;
  }

  dispose(): void {
    this.scheduler?.dispose();
    this.scheduler = null;
    this.pendingFrame = null;
    this.emitter.clear();
    this.fontCache.clear();
    this.fillCache.clear();
    this.advanceCache.clear();
    this.ctx = null;
    this.canvas = null;
  }

  // --- scheduling ---------------------------------------------------------

  /**
   * Ask for a render on the next animation frame, coalescing repeat requests
   * within one frame into a single render. Prefer this over render() on any
   * path driven by inbound data or input; render() stays available for
   * callers that already own a frame loop.
   */
  requestRender(source: VtSource, viewportY: number): void {
    this.pendingFrame = { source, viewportY };
    this.scheduler ??= new RenderScheduler(() => {
      const f = this.pendingFrame;
      if (!f || !this.ctx) return;
      this.pendingFrame = null;
      this.render(f.source, f.viewportY);
    });
    this.scheduler.schedule();
  }

  /** Render any frame booked by requestRender right now. */
  flushRender(): void {
    this.scheduler?.flush();
  }

  // --- render -------------------------------------------------------------

  render(source: VtSource, viewportY: number): void {
    const ctx = this.ctx;
    if (!ctx) throw new Error('vtgl: render before mount');

    // Adopt grid size from the source on first frame / mismatch.
    if (this.cols !== source.cols || this.rows !== source.rows) {
      this.resize(source.cols, source.rows, this.dpr);
    }

    const t0 = now();
    let full = this.forceFull;
    let scrolled = 0;
    const delta = this.lastViewportY < 0 ? 0 : viewportY - this.lastViewportY;
    this.lastViewportY = viewportY;
    if (!full && delta !== 0) {
      // Past a viewport's worth of movement no pixel on screen survives, so the
      // shift would uncover every row anyway and a full repaint is cheaper.
      if (delta <= -this.rows || delta >= this.rows) full = true;
      else scrolled = delta;
    }

    // A blinking cell changes with the clock rather than with the source, and
    // the flip marks nothing dirty, so repaint everything on the frame it lands.
    const blinkOn = blinkPhase();
    if (!full && this.hasBlink && blinkOn !== this.lastBlinkOn) full = true;
    this.lastBlinkOn = blinkOn;
    if (full) this.hasBlink = false;

    let dirtyRows = 0;
    let glyphs = 0;

    ctx.textBaseline = 'alphabetic';

    if (full) {
      ctx.fillStyle = this.fill(this.theme.background);
      ctx.fillRect(0, 0, this.cols * this.cellW, this.rows * this.cellH);
    } else if (scrolled !== 0) {
      // Self-blit. The 2D spec snapshots the source bitmap, so an overlapping
      // copy is well defined, and at an integer offset with no scaling it is an
      // exact move of the pixels rather than a resample.
      ctx.drawImage(this.canvas as HTMLCanvasElement, 0, -scrolled * this.cellH);
    }

    // Rows the shift uncovered. They are repainted whether or not the source
    // calls them dirty: their pixels came from the row that just left the far
    // edge of the viewport.
    const exposedFrom = scrolled > 0 ? this.rows - scrolled : 0;
    const exposedTo = scrolled < 0 ? -scrolled : scrolled > 0 ? this.rows : 0;

    // The blit moves the old cursor along with the row it sits on, which is
    // right, but a cursor that also moved leaves a copy behind. Repaint the row
    // it was on; nothing else will, because cursor movement is not damage.
    const cursorKey = cursorStateKey(source.getCursor());
    const staleCursorRow = cursorKey === this.prevCursorKey ? -1 : this.prevCursorRow;

    for (let vr = 0; vr < this.rows; vr++) {
      const absRow = viewportY + vr;
      const exposed = vr >= exposedFrom && vr < exposedTo;
      if (!full && !exposed && absRow !== staleCursorRow && !source.isRowDirty(absRow)) {
        continue;
      }
      dirtyRows++;
      glyphs += this.drawRow(ctx, source.getLine(absRow), vr, full, blinkOn);
    }

    glyphs += this.drawCursor(ctx, source, viewportY);
    this.prevCursorKey = cursorKey;

    this.forceFull = false;

    const stats: RenderStats = {
      dirtyRows,
      glyphs,
      drawCalls: 1,
      atlasUploads: 0,
      full,
      cpuMs: now() - t0,
    };
    this.emitter.emit('render', stats);
  }

  private drawRow(
    ctx: Ctx2D,
    line: LineView,
    vr: number,
    full: boolean,
    blinkOn: boolean,
  ): number {
    const y = vr * this.cellH;
    const defaultBg = this.theme.background;
    const shaped = this.planRow(line);

    // On an incremental redraw the row was not cleared by the full-clear above,
    // so repaint its background band before drawing cells.
    if (!full) {
      ctx.fillStyle = this.fill(defaultBg);
      ctx.fillRect(0, y, this.cols * this.cellW, this.cellH);
    }

    let glyphs = 0;
    const cols = this.cols;
    for (let col = 0; col < cols; col++) {
      const width = line.width(col);
      if (width === 0) continue; // spacer tail of a preceding wide cell

      const cp = line.codepoint(col);
      let fg = line.fg(col);
      let bg = line.bg(col);
      const flags = line.flags(col);

      if (this.opts.resolveInverse && flags & CellFlags.INVERSE) {
        const t = fg;
        fg = bg;
        bg = t;
      }

      const blank = cp === 0 || cp === 32;

      // Blank-cell fast skip: nothing to paint when the cell is empty and its
      // background matches the default (already covered by the band fill).
      if (blank && bg === defaultBg) continue;

      const x = col * this.cellW;
      const span = width === 2 ? this.cellW * 2 : this.cellW;

      if (bg !== defaultBg) {
        ctx.fillStyle = this.fill(bg);
        ctx.fillRect(x, y, span, this.cellH);
      }

      if (blank || flags & CellFlags.INVISIBLE) continue;

      // Blink hides the glyph for half of each phase, matching the alpha gate in
      // the WebGL2 glyph shader. Decorations keep drawing there, so they do here.
      let blinking = false;
      if (flags & CellFlags.BLINK) {
        this.hasBlink = true;
        blinking = true;
      }

      // A shaped column draws the shaper's cluster, which under a reordering
      // shaper came from another cell of the same run. Runs are uniform in
      // style, so the colours and flags read above still apply.
      const isShaped = shaped !== undefined && shaped.has(col);
      const grapheme = isShaped ? shaped.cluster(col) : line.grapheme(col);
      if (grapheme.length === 0) continue;

      if (!blinking || blinkOn) {
        ctx.font = this.font(flags);
        const alpha = flags & CellFlags.FAINT ? 0.5 : 1;
        if (alpha !== 1) ctx.globalAlpha = alpha;
        ctx.fillStyle = this.fill(fg);
        this.fillGlyph(ctx, grapheme, x, y, span, shaped, isShaped ? col : -1);
        if (alpha !== 1) ctx.globalAlpha = 1;
        glyphs++;
      }

      if (flags & (CellFlags.UNDERLINE | CellFlags.STRIKETHROUGH)) {
        this.drawDecorations(ctx, flags, x, y, span, fg);
      }
    }
    return glyphs;
  }

  /**
   * Shape one row, or undefined when there is no shaper or the row holds
   * nothing the shaper wants.
   */
  private planRow(line: LineView): RowShaper | undefined {
    const rs = this.rowShaper;
    if (!rs) return undefined;
    return rs.plan(line, this.cols, this.opts.shaper!) ? rs : undefined;
  }

  /**
   * Draw one cluster over the cell whose top-left corner is (x, y). The
   * unshaped path is a plain fillText, unchanged. The shaped path has to
   * reproduce the decisions GlyphAtlas.raster makes, because the two backends
   * are held to drawing the same picture: same RTL context, same advance fitted
   * to the cell, same left-aligned origin.
   */
  private fillGlyph(
    ctx: Ctx2D,
    cluster: string,
    x: number,
    y: number,
    span: number,
    shaped: RowShaper | undefined,
    col: number,
  ): void {
    // Box and block characters are drawn from the cell rectangle rather than
    // looked up in the face, so that adjacent cells abut. The WebGL2 path does
    // the same thing into the atlas slot; see renderer/box-drawing.ts.
    if (col < 0 && isBoxDrawingGrapheme(cluster)) {
      if (drawBoxGlyph(ctx, cluster.charCodeAt(0), x, y, span, this.cellH)) return;
    }
    const baselineY = y + this.baseline;
    if (col < 0 || shaped === undefined) {
      ctx.fillText(cluster, x, baselineY);
      return;
    }
    // Set on every shaped glyph and reset after, so a shaped cell cannot leak
    // its direction into the next unshaped one on the same row.
    ctx.textAlign = 'left';
    ctx.direction = shaped.rtl(col) ? 'rtl' : 'ltr';
    const dx = x + shaped.xOffset(col);
    if (shaped.fitAdvance(col)) {
      const advance = this.advanceOf(ctx, cluster);
      ctx.save();
      ctx.translate(dx, baselineY);
      if (advance > 0) ctx.scale(this.cellW / advance, 1);
      ctx.fillText(cluster, 0, 0);
      ctx.restore();
    } else {
      ctx.fillText(cluster, dx, baselineY);
    }
    ctx.direction = 'ltr';
  }

  private drawDecorations(
    ctx: Ctx2D,
    flags: number,
    x: number,
    y: number,
    span: number,
    fg: Rgb,
  ): void {
    ctx.fillStyle = this.fill(fg);
    const thickness = Math.max(1, Math.round(this.dpr));
    if (flags & CellFlags.UNDERLINE) {
      const uy = y + Math.min(this.cellH - thickness, this.baseline + thickness);
      ctx.fillRect(x, uy, span, thickness);
    }
    if (flags & CellFlags.STRIKETHROUGH) {
      const sy = y + Math.round(this.cellH * 0.5);
      ctx.fillRect(x, sy, span, thickness);
    }
  }

  private drawCursor(ctx: Ctx2D, source: VtSource, viewportY: number): number {
    const cur = source.getCursor();
    this.prevCursorRow = -1;
    if (!cur.visible) return 0;
    const vr = cur.y - viewportY;
    if (vr < 0 || vr >= this.rows || cur.x < 0 || cur.x >= this.cols) return 0;
    this.prevCursorRow = cur.y;

    const key = (cur.y << 20) | (cur.x << 4) | cursorShapeBit(cur.shape);
    if (key !== this.lastCursorKey) {
      this.lastCursorKey = key;
      this.emitter.emit('cursorMove', { col: cur.x, row: cur.y });
    }

    const x = cur.x * this.cellW;
    const y = vr * this.cellH;
    ctx.fillStyle = this.fill(this.theme.cursor);
    const thickness = Math.max(1, Math.round(this.dpr * 2));
    switch (cur.shape) {
      case 'bar':
        ctx.fillRect(x, y, thickness, this.cellH);
        break;
      case 'underline':
        ctx.fillRect(x, y + this.cellH - thickness, this.cellW, thickness);
        break;
      case 'block':
      default: {
        ctx.fillRect(x, y, this.cellW, this.cellH);
        const line = source.getLine(cur.y);
        // Overpaint whatever is drawn in this column, which under a reordering
        // shaper is not the character the cursor's own cell holds.
        const plan = this.planRow(line);
        const shapedHere = plan !== undefined && plan.has(cur.x);
        const g = shapedHere ? plan.cluster(cur.x) : line.grapheme(cur.x);
        if (g.length > 0 && line.codepoint(cur.x) !== 32) {
          ctx.font = this.font(line.flags(cur.x));
          ctx.fillStyle = this.fill(this.theme.cursorText ?? this.theme.background);
          this.fillGlyph(ctx, g, x, y, this.cellW, plan, shapedHere ? cur.x : -1);
        }
        break;
      }
    }
    return 0;
  }

  // --- metrics / hit testing ---------------------------------------------

  getMetrics(): Metrics {
    return {
      cols: this.cols,
      rows: this.rows,
      cellWidth: this.cellW,
      cellHeight: this.cellH,
      cssCellWidth: this.cellW / this.dpr,
      cssCellHeight: this.cellH / this.dpr,
      baseline: this.baseline,
      dpr: this.dpr,
      canvasWidth: this.cols * this.cellW,
      canvasHeight: this.rows * this.cellH,
      fontFamily: this.opts.fontFamily,
      fontSize: this.opts.fontSize,
      lineHeight: this.opts.lineHeight,
    };
  }

  cellAtPixel(px: number, py: number): CellCoord | null {
    const cssW = this.cellW / this.dpr;
    const cssH = this.cellH / this.dpr;
    if (px < 0 || py < 0) return null;
    const col = Math.floor(px / cssW);
    const row = Math.floor(py / cssH);
    if (col >= this.cols || row >= this.rows) return null;
    return { col, row };
  }

  pixelForCell(col: number, row: number): PixelRect {
    const cssW = this.cellW / this.dpr;
    const cssH = this.cellH / this.dpr;
    return { x: col * cssW, y: row * cssH, width: cssW, height: cssH };
  }

  // --- events -------------------------------------------------------------

  on<K extends keyof RendererEventMap>(
    event: K,
    handler: (payload: RendererEventMap[K]) => void,
  ): () => void {
    return this.emitter.on(event, handler);
  }

  off<K extends keyof RendererEventMap>(
    event: K,
    handler: (payload: RendererEventMap[K]) => void,
  ): void {
    this.emitter.off(event, handler);
  }

  // --- internals ----------------------------------------------------------

  private measure(): void {
    this.deviceFontPx = this.opts.fontSize * this.dpr;
    // Shared with the WebGL2 core so both backends land on identical geometry.
    const measurement = measureFont(
      this.ctx,
      this.opts.fontFamily,
      this.deviceFontPx,
    );
    const g = computeCellMetrics(
      this.opts.fontSize,
      this.dpr,
      this.opts.lineHeight,
      measurement,
      this.opts.letterSpacing ?? 0,
    );
    this.cellW = g.cellW;
    this.cellH = g.cellH;
    this.baseline = g.baseline;
    this.fontCache.clear();
    // Advances are in device pixels, so a metrics change invalidates them.
    this.advanceCache.clear();
  }

  private applyBackingStore(): void {
    const canvas = this.canvas;
    if (!canvas) return;
    canvas.width = this.cols * this.cellW;
    canvas.height = this.rows * this.cellH;
  }

  private font(flags: number): string {
    const mask = flags & (CellFlags.BOLD | CellFlags.ITALIC);
    let s = this.fontCache.get(mask);
    if (s) return s;
    const bold = mask & CellFlags.BOLD ? 'bold ' : '';
    const italic = mask & CellFlags.ITALIC ? 'italic ' : '';
    s = `${italic}${bold}${this.deviceFontPx}px ${this.opts.fontFamily}`;
    if (this.fontCache.size >= FONT_CACHE_LIMIT) this.fontCache.clear();
    this.fontCache.set(mask, s);
    return s;
  }

  /**
   * Advance of a shaped cluster in the current font and direction.
   *
   * This backend has no glyph cache, so without memoising, fitting would cost a
   * measureText on every shaped cell on every frame; the WebGL path measures
   * once and keeps the result in the atlas. Keyed by the font string as well as
   * the cluster because the same letters measure differently bold.
   */
  private advanceOf(ctx: Ctx2D, cluster: string): number {
    const key = ctx.font + '\u0001' + cluster;
    const hit = this.advanceCache.get(key);
    if (hit !== undefined) return hit;
    const w = ctx.measureText(cluster).width;
    if (this.advanceCache.size >= ADVANCE_CACHE_LIMIT) this.advanceCache.clear();
    this.advanceCache.set(key, w);
    return w;
  }

  private fill(color: Rgb): string {
    let s = this.fillCache.get(color);
    if (s) return s;
    s = toCss(color);
    if (this.fillCache.size >= FILL_CACHE_LIMIT) this.fillCache.clear();
    this.fillCache.set(color, s);
    return s;
  }
}

function cursorShapeBit(shape: string): number {
  return shape === 'bar' ? 1 : shape === 'underline' ? 2 : 0;
}

/** Everything about the cursor that changes which pixels it occupies. */
function cursorStateKey(cur: CursorState): number {
  if (!cur.visible) return -1;
  return (cur.y << 20) | (cur.x << 4) | cursorShapeBit(cur.shape);
}

/**
 * Visible half of the blink phase, matching `step(0.5, fract(u_time))` in the
 * glyph fragment shader with `u_time = performance.now() / 500`. vtgl owns no
 * clock: the phase only advances on screen while something requests frames.
 */
function blinkPhase(): boolean {
  const t = now() / 500;
  return t - Math.floor(t) >= 0.5;
}

function globalDpr(): number {
  const w = globalThis as { devicePixelRatio?: number };
  return w.devicePixelRatio && w.devicePixelRatio > 0 ? w.devicePixelRatio : 1;
}

function now(): number {
  const p = (globalThis as { performance?: { now(): number } }).performance;
  return p ? p.now() : Date.now();
}
