// Canvas2D fallback renderer.
//
// Implements the full Renderer interface with a 2D context, for environments
// without WebGL2. Behavior mirrors the known-good ghostty-web canvas2d path
// (MIT), written fresh here: dirty-row redraw, blank-cell skip, wide-char
// spacer handling, and font/fill string caches. This is the correctness
// reference the WebGL2 core must match pixel-decision-for-pixel-decision.

import { CellFlags } from '../types.ts';
import { Emitter } from '../events.ts';
import { toCss } from '../color.ts';
import { computeCellMetrics } from './metrics.ts';
import type {
  CellCoord,
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

  private forceFull = true;
  private lastCursorKey = -1;
  // Viewport row drawn at the top of the last frame. Scrolling changes which
  // absolute rows map to which screen rows without dirtying any of them, so a
  // change here has to force a full repaint or the screen keeps stale content.
  private lastViewportY = -1;

  private readonly fontCache = new Map<number, string>();
  private readonly fillCache = new Map<number, string>();

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
    this.emitter.clear();
    this.fontCache.clear();
    this.fillCache.clear();
    this.ctx = null;
    this.canvas = null;
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
    const full = this.forceFull || viewportY !== this.lastViewportY;
    this.lastViewportY = viewportY;
    let dirtyRows = 0;
    let glyphs = 0;

    ctx.textBaseline = 'alphabetic';

    if (full) {
      ctx.fillStyle = this.fill(this.theme.background);
      ctx.fillRect(0, 0, this.cols * this.cellW, this.rows * this.cellH);
    }

    for (let vr = 0; vr < this.rows; vr++) {
      const absRow = viewportY + vr;
      if (!full && !source.isRowDirty(absRow)) continue;
      dirtyRows++;
      glyphs += this.drawRow(ctx, source.getLine(absRow), vr, full);
    }

    glyphs += this.drawCursor(ctx, source, viewportY);

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

  private drawRow(ctx: Ctx2D, line: LineView, vr: number, full: boolean): number {
    const y = vr * this.cellH;
    const defaultBg = this.theme.background;

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

      const grapheme = line.grapheme(col);
      if (grapheme.length === 0) continue;

      ctx.font = this.font(flags);
      const alpha = flags & CellFlags.FAINT ? 0.5 : 1;
      if (alpha !== 1) ctx.globalAlpha = alpha;
      ctx.fillStyle = this.fill(fg);
      ctx.fillText(grapheme, x, y + this.baseline);
      if (alpha !== 1) ctx.globalAlpha = 1;
      glyphs++;

      if (flags & (CellFlags.UNDERLINE | CellFlags.STRIKETHROUGH)) {
        this.drawDecorations(ctx, flags, x, y, span, fg);
      }
    }
    return glyphs;
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
    if (!cur.visible) return 0;
    const vr = cur.y - viewportY;
    if (vr < 0 || vr >= this.rows || cur.x < 0 || cur.x >= this.cols) return 0;

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
        const g = line.grapheme(cur.x);
        if (g.length > 0 && line.codepoint(cur.x) !== 32) {
          ctx.font = this.font(line.flags(cur.x));
          ctx.fillStyle = this.fill(this.theme.cursorText ?? this.theme.background);
          ctx.fillText(g, x, y + this.baseline);
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
    const ctx = this.ctx;
    let advance = this.deviceFontPx * 0.6; // monospace fallback
    if (ctx) {
      ctx.font = `${this.deviceFontPx}px ${this.opts.fontFamily}`;
      const m = ctx.measureText('M');
      if (m.width > 0) advance = m.width;
    }
    // Shared with the WebGL2 core so both backends land on identical geometry.
    const g = computeCellMetrics(
      this.opts.fontSize,
      this.dpr,
      this.opts.lineHeight,
      advance,
      this.opts.letterSpacing ?? 0,
    );
    this.cellW = g.cellW;
    this.cellH = g.cellH;
    this.baseline = g.baseline;
    this.fontCache.clear();
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

function globalDpr(): number {
  const w = globalThis as { devicePixelRatio?: number };
  return w.devicePixelRatio && w.devicePixelRatio > 0 ? w.devicePixelRatio : 1;
}

function now(): number {
  const p = (globalThis as { performance?: { now(): number } }).performance;
  return p ? p.now() : Date.now();
}
