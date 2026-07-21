// WebGL2 glyph-atlas renderer. Implements the same Renderer interface as the
// Canvas2D fallback (renderer/canvas2d.ts is the pixel-decision reference), but
// draws the whole grid in a handful of instanced draw calls instead of one
// fillText per cell. See docs/architecture.md.
//
// Per frame: recompute the CPU instance shadow for dirty rows only, upload the
// changed byte ranges with bufferSubData, then issue the full-grid draws
// (background, glyphs, decorations) plus the cursor. Draw count is independent
// of cell count. Steady-state per-frame allocation is near zero: the instance
// buffers, run scratch, and cursor scratch are all preallocated and reused.
//
// Scrolling does not rebuild. The instance streams are addressed by slot, and
// slot s draws at screen row (s - slotBase) mod rows, so moving the viewport by
// n rows is a rotation of slotBase plus a rebuild of the n rows that entered the
// viewport. Nothing in the instance data encodes a screen position, which is the
// invariant that makes the rotation sound; see instances.ts and gl/shaders.ts.

import { CellFlags } from '../types.ts';
import { Emitter } from '../events.ts';
import { computeCellMetrics, measureFont } from './metrics.ts';
import { RenderScheduler } from './scheduler.ts';
import { InstanceBuffers, GLYPH_UNITS, DECO_UNITS, DECO_PER_CELL } from './instances.ts';
import { RowShaper } from './runs.ts';
import { styleMask } from '../atlas/key.ts';
import { GlyphAtlas } from '../atlas/glyph-atlas.ts';
import type { RasterFont } from '../atlas/glyph-atlas.ts';
import type { AtlasRect } from './instances.ts';
import { linkProgram, uniformLocations } from '../gl/program.ts';
import {
  bgVert,
  bgFrag,
  glyphVert,
  glyphFrag,
  glyphAtVert,
  decoVert,
  solidVert,
  solidFrag,
} from '../gl/shaders.ts';
import type {
  CellCoord,
  CursorShape,
  Metrics,
  PixelRect,
  Renderer,
  RendererBackend,
  RendererEventMap,
  RendererOptions,
  RenderStats,
  ShaperHook,
  Theme,
  VtSource,
} from '../types.ts';

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const DEFAULT_LINE_HEIGHT = 1.2;
const MAX_BUILD_ATTEMPTS = 3;

interface ProgramInfo {
  prog: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
}

export class WebGL2Renderer implements Renderer {
  readonly backend: RendererBackend = 'webgl2';

  private readonly emitter = new Emitter<RendererEventMap>();
  private readonly opts: {
    fontFamily: string;
    fontSize: number;
    lineHeight: number;
    letterSpacing: number;
    dpr: number;
    resolveInverse: boolean;
    shaper?: ShaperHook;
  };

  // Only constructed when a shaper is configured, so the default path never
  // pays for the per-row grouping pass or its buffers.
  private readonly rowShaper: RowShaper | null;

  private theme: Theme;
  private cols = 0;
  private rows = 0;
  private dpr: number;

  private canvas: AnyCanvas | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private lost = false;

  // Device-pixel geometry.
  private cellW = 0;
  private cellH = 0;
  private baseline = 0;
  private deviceFontPx = 0;

  private scheduler: RenderScheduler | null = null;
  private pendingFrame: { source: VtSource; viewportY: number } | null = null;

  private forceFull = true;
  private lastCursorKey = -1;
  // Viewport row drawn at the top of the last frame. Scrolling changes which
  // absolute rows map to which screen rows without dirtying any of them, so a
  // change here is what drives the slot rotation below.
  private lastViewportY = -1;
  // Slot holding screen row 0. Slot s draws at screen row (s - slotBase) mod
  // rows; a scroll of n rows advances this by n and rebuilds only the rows that
  // entered the viewport. Reset to 0 on any full frame.
  private slotBase = 0;
  // Signed scroll applied to slotBase this frame, 0 when the viewport is still.
  // Positive means the viewport moved down, so the rows that entered are at the
  // bottom of the screen.
  private scrolled = 0;

  // Scratch raster surface for the atlas.
  private scratch: AnyCanvas | null = null;
  private scratchCtx: Ctx2D | null = null;
  private readonly fontCache = new Map<number, string>();

  // GL resources.
  private atlas: GlyphAtlas | null = null;
  private readonly buffers = new InstanceBuffers();
  private bgProg: ProgramInfo | null = null;
  private glyphProg: ProgramInfo | null = null;
  private glyphAtProg: ProgramInfo | null = null;
  private decoProg: ProgramInfo | null = null;
  private solidProg: ProgramInfo | null = null;
  private bgBuf: WebGLBuffer | null = null;
  private glyphBuf: WebGLBuffer | null = null;
  private decoBuf: WebGLBuffer | null = null;
  private cursorRectBuf: WebGLBuffer | null = null;
  private cursorGlyphBuf: WebGLBuffer | null = null;
  private bgVao: WebGLVertexArrayObject | null = null;
  private glyphVao: WebGLVertexArrayObject | null = null;
  private decoVao: WebGLVertexArrayObject | null = null;
  private cursorRectVao: WebGLVertexArrayObject | null = null;
  private cursorGlyphVao: WebGLVertexArrayObject | null = null;

  // Scratch for dirty-run coalescing and cursor instances (preallocated).
  private dirtyFlags = new Uint8Array(0);
  private readonly cursorRectF32 = new Float32Array(5);
  private readonly cursorRectU32 = new Uint32Array(this.cursorRectF32.buffer);
  private readonly cursorGlyphF32 = new Float32Array(GLYPH_UNITS);
  private readonly cursorGlyphU32 = new Uint32Array(this.cursorGlyphF32.buffer);

  // Cursor draw state resolved during the build phase.
  private curVisible = false;
  private curVr = 0;
  private curX = 0;
  private curShape: CursorShape = 'block';
  private curGlyphRect: AtlasRect | null = null;
  // Glyph offset within the cursor cell for the overpainted glyph. Non-zero only
  // when the covered glyph is an outline (HarfBuzz) tile that overhangs its cell.
  private curGlyphOffX = 0;
  private curGlyphOffY = 0;

  // The same cursor state as it stood at the end of the last frame that
  // actually drew. A cursor that moves, changes shape, hides, or comes to sit
  // over a different glyph changes the picture without dirtying any row, so an
  // otherwise-clean frame has to compare against this before it skips.
  private hasDrawn = false;
  private drawnCurVisible = false;
  private drawnCurVr = -1;
  private drawnCurX = -1;
  private drawnCurShape: CursorShape = 'block';
  private drawnCurGlyph = -1;

  private readonly onLost = (e: Event): void => {
    e.preventDefault();
    this.lost = true;
  };
  private readonly onRestored = (): void => {
    this.lost = false;
    this.createGLResources();
    this.forceFull = true;
  };

  constructor(options: RendererOptions) {
    this.opts = {
      fontFamily: options.fontFamily,
      fontSize: options.fontSize,
      lineHeight: options.lineHeight ?? DEFAULT_LINE_HEIGHT,
      letterSpacing: options.letterSpacing ?? 0,
      dpr: options.dpr ?? globalDpr(),
      resolveInverse: options.resolveInverse ?? false,
      shaper: options.shaper,
    };
    this.rowShaper = options.shaper ? new RowShaper() : null;
    this.theme = options.theme;
    this.dpr = this.opts.dpr;
  }

  // --- lifecycle ----------------------------------------------------------

  mount(canvas: AnyCanvas): void {
    this.canvas = canvas;
    const gl = (canvas as HTMLCanvasElement).getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('vtgl: webgl2 context unavailable');
    this.gl = gl;

    const el = canvas as HTMLCanvasElement;
    if (typeof el.addEventListener === 'function') {
      el.addEventListener('webglcontextlost', this.onLost as EventListener, false);
      el.addEventListener('webglcontextrestored', this.onRestored as EventListener, false);
    }

    this.scratch = makeScratchCanvas();
    this.scratchCtx = get2d(this.scratch);
    this.measure();
    this.createGLResources();
    this.forceFull = true;
  }

  resize(cols: number, rows: number, dpr: number): void {
    this.cols = cols;
    this.rows = rows;
    this.dpr = dpr;
    this.measure();
    this.buffers.resize(cols, rows);
    this.buffers.configure(this.cellW, this.cellH, this.baseline, this.dpr, this.opts.resolveInverse);
    if (this.dirtyFlags.length !== rows) this.dirtyFlags = new Uint8Array(rows);
    this.applyBackingStore();
    // Cell geometry drove the atlas slot sizes; rebuild it fresh.
    this.rebuildAtlas();
    this.sizeInstanceGpuBuffers();
    this.forceFull = true;
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.forceFull = true;
  }

  invalidate(): void {
    this.forceFull = true;
  }

  dispose(): void {
    this.scheduler?.dispose();
    this.scheduler = null;
    this.pendingFrame = null;
    const el = this.canvas as HTMLCanvasElement | null;
    if (el && typeof el.removeEventListener === 'function') {
      el.removeEventListener('webglcontextlost', this.onLost as EventListener, false);
      el.removeEventListener('webglcontextrestored', this.onRestored as EventListener, false);
    }
    this.destroyGLResources();
    this.emitter.clear();
    this.fontCache.clear();
    this.gl = null;
    this.canvas = null;
    this.scratch = null;
    this.scratchCtx = null;
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
      if (!f || !this.gl) return;
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
    const gl = this.gl;
    if (!gl) throw new Error('vtgl: render before mount');
    if (this.lost) return;

    if (this.cols !== source.cols || this.rows !== source.rows) {
      this.resize(source.cols, source.rows, this.dpr);
    }

    const t0 = now();
    const atlas = this.atlas!;
    atlas.beginFrame();

    // Clear the flag before building: buildFrame may legitimately re-arm it to
    // request another full frame (for example after an atlas flush).
    let wasFull = this.forceFull;
    this.forceFull = false;
    this.scrolled = 0;
    const delta = this.lastViewportY < 0 ? 0 : viewportY - this.lastViewportY;
    this.lastViewportY = viewportY;
    if (!wasFull && delta !== 0) {
      // Past a viewport's worth of movement nothing on screen survives, so the
      // rotation would rebuild every row anyway and a full frame is cheaper.
      if (delta <= -this.rows || delta >= this.rows) {
        wasFull = true;
      } else {
        this.scrolled = delta;
        this.slotBase = mod(this.slotBase + delta, this.rows);
      }
    }
    if (wasFull) this.slotBase = 0;

    const { full, dirtyRows, glyphs } = this.buildFrame(source, viewportY, wasFull);

    // A frame that changes nothing the GPU can see does not need its draws
    // reissued. The instance buffers already hold the whole grid and the
    // compositor still holds the last swap, so the screen keeps showing exactly
    // what the skipped draws would have produced, and the next frame that does
    // draw reproduces it from the same buffers. Three things move without any
    // row going dirty and each vetoes the skip: a scroll (it rotates slotBase),
    // a blinking cell (the glyph shader animates it against u_time), and the
    // cursor. An atlas upload does too, since it repoints texels the standing
    // instances already reference.
    const redundant =
      !full &&
      this.hasDrawn &&
      dirtyRows === 0 &&
      this.scrolled === 0 &&
      atlas.uploads === 0 &&
      this.buffers.blinkCount === 0 &&
      this.cursorMatchesDrawn();

    let drawCalls = 0;
    if (!redundant) {
      this.uploadInstances(full);
      drawCalls = this.draw();
      this.snapshotCursor();
      this.hasDrawn = true;
    }

    const stats: RenderStats = {
      dirtyRows,
      glyphs,
      drawCalls,
      atlasUploads: atlas.uploads,
      full,
      skipped: redundant,
      cpuMs: now() - t0,
    };
    this.emitter.emit('render', stats);
  }

  /**
   * Recompute the CPU instance shadow for the rows that need it: everything on a
   * full frame, otherwise the rows the source reports dirty plus the rows a
   * scroll just exposed. If a glyph miss flushes the atlas mid-build (generation
   * change), every earlier rect is stale, so restart once as a full rebuild into
   * the fresh atlas. Bounded by MAX_BUILD_ATTEMPTS.
   */
  private buildFrame(
    source: VtSource,
    viewportY: number,
    initialFull: boolean,
  ): { full: boolean; dirtyRows: number; glyphs: number } {
    const atlas = this.atlas!;
    let full = initialFull;
    let glyphs = 0;
    let dirtyRows = 0;

    for (let attempt = 0; attempt < MAX_BUILD_ATTEMPTS; attempt++) {
      const gen = atlas.generation;
      glyphs = 0;
      dirtyRows = 0;
      if (full) {
        this.slotBase = 0;
        this.buffers.clearAll(this.theme);
      }
      // Rows uncovered by this frame's scroll. They are rebuilt whether or not
      // the source calls them dirty: their slot still holds the row that just
      // left the far edge of the viewport.
      const scrolled = full ? 0 : this.scrolled;
      const exposedFrom = scrolled > 0 ? this.rows - scrolled : 0;
      const exposedTo = scrolled < 0 ? -scrolled : scrolled > 0 ? this.rows : 0;

      this.dirtyFlags.fill(0);
      for (let vr = 0; vr < this.rows; vr++) {
        const absRow = viewportY + vr;
        const exposed = vr >= exposedFrom && vr < exposedTo;
        if (!full && !exposed && !source.isRowDirty(absRow)) continue;
        const slot = this.slotFor(vr);
        this.dirtyFlags[slot] = 1;
        dirtyRows++;
        // An exposed slot holds an unrelated row, so a leading spacer cell would
        // inherit its background. Rebuilt dirty rows keep the old occupant's
        // colors in that one degenerate case, as they always have.
        if (exposed) this.buffers.clearSlotBg(slot, this.theme.background);
        glyphs += this.buffers.buildRow(
          source,
          absRow,
          slot,
          atlas,
          this.planRow(source, absRow),
        ).glyphs;
      }

      this.resolveCursor(source, viewportY);

      if (atlas.generation === gen) break;
      // Atlas flushed mid-build; redo everything as a full frame.
      full = true;
      // If this was the last attempt some rects may still be stale, so ask for
      // another full frame next time rather than leaving the screen wrong.
      if (attempt === MAX_BUILD_ATTEMPTS - 1) this.forceFull = true;
    }

    return { full, dirtyRows, glyphs };
  }

  /** Slot currently holding screen row `vr`. */
  private slotFor(vr: number): number {
    const s = vr + this.slotBase;
    return s >= this.rows ? s - this.rows : s;
  }

  /**
   * Shape one row, or return undefined when there is no shaper or the row has
   * nothing the shaper wants. Returning undefined rather than an empty plan lets
   * the instance builder skip its per-column shaped-cell test entirely.
   *
   * The plan is per row and holds no screen position, so it is indifferent to
   * which slot the row is being built into.
   */
  private planRow(source: VtSource, absRow: number): RowShaper | undefined {
    const rs = this.rowShaper;
    if (!rs) return undefined;
    return rs.plan(source.getLine(absRow), this.cols, this.opts.shaper!) ? rs : undefined;
  }

  private resolveCursor(source: VtSource, viewportY: number): void {
    this.curGlyphRect = null;
    const cur = source.getCursor();
    const vr = cur.y - viewportY;
    this.curVisible =
      cur.visible && vr >= 0 && vr < this.rows && cur.x >= 0 && cur.x < this.cols;
    if (!this.curVisible) return;
    this.curVr = vr;
    this.curX = cur.x;
    this.curShape = cur.shape;

    const key = (cur.y << 20) | (cur.x << 4) | cursorShapeBit(cur.shape);
    if (key !== this.lastCursorKey) {
      this.lastCursorKey = key;
      this.emitter.emit('cursorMove', { col: cur.x, row: cur.y });
    }

    if (cur.shape !== 'block') return;
    const line = source.getLine(cur.y);
    const cp = line.codepoint(cur.x);
    if (cp === 0 || cp === 32) return;
    // The cursor overpaints whatever is drawn in its column, which under a
    // reordering shaper is not the character the cursor's own cell holds. Shape
    // the row again here: buildFrame's plan is for the row it was building, and
    // the cursor row may not have been dirty at all.
    const plan = this.planRow(source, cur.y);
    const shapedHere = plan !== undefined && plan.has(cur.x);
    const g = shapedHere ? plan.cluster(cur.x) : line.grapheme(cur.x);
    if (g.length === 0) return;
    const w = line.width(cur.x) === 2 ? 2 : 1;
    const hint = shapedHere ? plan.hintFor(cur.x) : undefined;
    this.curGlyphRect = this.atlas!.ensure(g, styleMask(line.flags(cur.x)), w, hint);
    // An outline glyph's tile is offset from the cell so its overhang lands
    // right; carry that into the cursor overpaint so the covered letter matches.
    const outline = hint?.outline;
    if (outline !== undefined && shapedHere) {
      this.curGlyphOffX = plan!.xOffset(cur.x) - outline.penX;
      this.curGlyphOffY = this.baseline + plan!.yOffset(cur.x) - outline.penY;
    } else {
      this.curGlyphOffX = 0;
      this.curGlyphOffY = 0;
    }
  }

  /**
   * Scalar signature of the glyph the block cursor is currently overpainting.
   * Compared rather than the rect itself because the atlas is free to hand back
   * a fresh object for the same glyph; what matters is where in the atlas the
   * texels sit and how they are read, not the identity of the wrapper.
   */
  private cursorGlyphSig(): number {
    const r = this.curGlyphRect;
    if (!r) return -1;
    let h = 2166136261;
    h = Math.imul(h ^ r.x, 16777619);
    h = Math.imul(h ^ r.y, 16777619);
    h = Math.imul(h ^ r.w, 16777619);
    h = Math.imul(h ^ r.h, 16777619);
    h = Math.imul(h ^ r.page, 16777619);
    h = Math.imul(h ^ (r.colored ? 1 : 0), 16777619);
    return h >>> 0;
  }

  /** True when the cursor would draw exactly as it drew on the last real frame. */
  private cursorMatchesDrawn(): boolean {
    if (this.curVisible !== this.drawnCurVisible) return false;
    if (!this.curVisible) return true;
    return (
      this.curVr === this.drawnCurVr &&
      this.curX === this.drawnCurX &&
      this.curShape === this.drawnCurShape &&
      this.cursorGlyphSig() === this.drawnCurGlyph
    );
  }

  private snapshotCursor(): void {
    this.drawnCurVisible = this.curVisible;
    this.drawnCurVr = this.curVr;
    this.drawnCurX = this.curX;
    this.drawnCurShape = this.curShape;
    this.drawnCurGlyph = this.cursorGlyphSig();
  }

  // --- GPU upload ---------------------------------------------------------

  private uploadInstances(full: boolean): void {
    const gl = this.gl!;
    const b = this.buffers;

    if (full) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bgBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, b.bgBytes);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.glyphBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, b.glyphBytes);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.decoBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, b.decoBytes);
      return;
    }

    // Coalesce contiguous dirty slots into runs and upload each run once. The
    // flags are indexed by slot, not screen row, because that is how the buffers
    // are laid out; a scroll leaves every clean slot where it already sits on
    // the GPU. Byte offsets are computed inline rather than through the *Range
    // helpers so the steady-state upload path allocates nothing at all.
    const perRowBg = this.cols * 4;
    const perRowGlyph = this.cols * GLYPH_UNITS * 4;
    const perRowDeco = this.cols * DECO_PER_CELL * DECO_UNITS * 4;
    let slot = 0;
    while (slot < this.rows) {
      if (this.dirtyFlags[slot] === 0) {
        slot++;
        continue;
      }
      let end = slot;
      while (end + 1 < this.rows && this.dirtyFlags[end + 1] === 1) end++;
      const span = end - slot + 1;

      this.uploadRun(gl, this.bgBuf, b.bgBytes, slot * perRowBg, span * perRowBg);
      this.uploadRun(gl, this.glyphBuf, b.glyphBytes, slot * perRowGlyph, span * perRowGlyph);
      this.uploadRun(gl, this.decoBuf, b.decoBytes, slot * perRowDeco, span * perRowDeco);
      slot = end + 1;
    }
  }

  private uploadRun(
    gl: WebGL2RenderingContext,
    buf: WebGLBuffer | null,
    bytes: Uint8Array,
    startByte: number,
    lengthBytes: number,
  ): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferSubData(gl.ARRAY_BUFFER, startByte, bytes, startByte, lengthBytes);
  }

  // --- draws --------------------------------------------------------------

  private draw(): number {
    const gl = this.gl!;
    const w = this.cols * this.cellW;
    const h = this.rows * this.cellH;
    gl.viewport(0, 0, w, h);

    gl.disable(gl.BLEND);
    gl.clearColor(
      ((this.theme.background >> 16) & 0xff) / 255,
      ((this.theme.background >> 8) & 0xff) / 255,
      (this.theme.background & 0xff) / 255,
      1,
    );
    gl.clear(gl.COLOR_BUFFER_BIT);

    const cellCount = this.buffers.cellCount;
    const atlasSize = this.atlas!.pageSize;
    const time = now() / 500;
    let calls = 0;

    // Background pass (opaque, blend off).
    {
      const p = this.bgProg!;
      gl.useProgram(p.prog);
      gl.uniform2f(p.u.u_resolution, w, h);
      gl.uniform2f(p.u.u_cellSize, this.cellW, this.cellH);
      gl.uniform1i(p.u.u_cols, this.cols);
      gl.uniform1i(p.u.u_slotBase, this.slotBase);
      gl.uniform1i(p.u.u_rows, this.rows);
      gl.bindVertexArray(this.bgVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, cellCount);
      calls++;
    }

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // Glyph pass.
    {
      const p = this.glyphProg!;
      gl.useProgram(p.prog);
      gl.uniform2f(p.u.u_resolution, w, h);
      gl.uniform2f(p.u.u_cellSize, this.cellW, this.cellH);
      gl.uniform2f(p.u.u_atlasSize, atlasSize, atlasSize);
      gl.uniform1i(p.u.u_cols, this.cols);
      gl.uniform1i(p.u.u_slotBase, this.slotBase);
      gl.uniform1i(p.u.u_rows, this.rows);
      gl.uniform1f(p.u.u_time, time);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlas!.texture);
      gl.uniform1i(p.u.u_atlas, 0);
      gl.bindVertexArray(this.glyphVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, cellCount);
      calls++;
    }

    // Decoration pass (underline + strikethrough as solid quads).
    {
      const p = this.decoProg!;
      gl.useProgram(p.prog);
      gl.uniform2f(p.u.u_resolution, w, h);
      gl.uniform2f(p.u.u_cellSize, this.cellW, this.cellH);
      gl.uniform1i(p.u.u_cols, this.cols);
      gl.uniform1i(p.u.u_perCell, DECO_PER_CELL);
      gl.uniform1i(p.u.u_slotBase, this.slotBase);
      gl.uniform1i(p.u.u_rows, this.rows);
      gl.bindVertexArray(this.decoVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.buffers.decoCount);
      calls++;
    }

    calls += this.drawCursor();
    gl.bindVertexArray(null);
    return calls;
  }

  private drawCursor(): number {
    if (!this.curVisible) return 0;
    const gl = this.gl!;
    const shape = this.curShape;
    const x = this.curX * this.cellW;
    const y = this.curVr * this.cellH;
    const thickness = Math.max(1, Math.round(this.dpr * 2));
    let calls = 0;

    // Cursor rect.
    let rx = x;
    let ry = y;
    let rw = this.cellW;
    let rh = this.cellH;
    if (shape === 'bar') {
      rw = thickness;
    } else if (shape === 'underline') {
      ry = y + this.cellH - thickness;
      rh = thickness;
    }
    this.cursorRectF32[0] = rx;
    this.cursorRectF32[1] = ry;
    this.cursorRectF32[2] = rw;
    this.cursorRectF32[3] = rh;
    this.cursorRectU32[4] = this.theme.cursor & 0xffffff;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cursorRectBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.cursorRectF32);
    {
      const p = this.solidProg!;
      gl.useProgram(p.prog);
      gl.uniform2f(p.u.u_resolution, this.cols * this.cellW, this.rows * this.cellH);
      gl.bindVertexArray(this.cursorRectVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1);
      calls++;
    }

    // Block cursor: overpaint the covered glyph in the cursor-text color.
    if (shape === 'block' && this.curGlyphRect) {
      const rect = this.curGlyphRect;
      const f = this.cursorGlyphF32;
      const u = this.cursorGlyphU32;
      f[0] = rect.x;
      f[1] = rect.y;
      f[2] = rect.w;
      f[3] = rect.h;
      f[4] = this.curGlyphOffX;
      f[5] = this.curGlyphOffY;
      u[6] = (this.theme.cursorText ?? this.theme.background) & 0xffffff;
      let style = (rect.page & 0xff) << 8;
      if (rect.colored) style |= 1;
      u[7] = style;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.cursorGlyphBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, f);
      const p = this.glyphAtProg!;
      gl.useProgram(p.prog);
      gl.uniform2f(p.u.u_resolution, this.cols * this.cellW, this.rows * this.cellH);
      gl.uniform2f(p.u.u_atlasSize, this.atlas!.pageSize, this.atlas!.pageSize);
      gl.uniform2f(p.u.u_origin, x, y);
      gl.uniform1f(p.u.u_time, now() / 500);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlas!.texture);
      gl.uniform1i(p.u.u_atlas, 0);
      gl.bindVertexArray(this.cursorGlyphVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1);
      calls++;
    }
    return calls;
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

  // --- GL resource management ---------------------------------------------

  private createGLResources(): void {
    const gl = this.gl;
    if (!gl) return;
    this.bgProg = makeProgram(gl, bgVert, bgFrag, [
      'u_resolution',
      'u_cellSize',
      'u_cols',
      'u_slotBase',
      'u_rows',
    ]);
    this.glyphProg = makeProgram(gl, glyphVert, glyphFrag, [
      'u_resolution',
      'u_cellSize',
      'u_atlasSize',
      'u_cols',
      'u_slotBase',
      'u_rows',
      'u_atlas',
      'u_time',
    ]);
    this.glyphAtProg = makeProgram(gl, glyphAtVert, glyphFrag, [
      'u_resolution',
      'u_atlasSize',
      'u_origin',
      'u_atlas',
      'u_time',
    ]);
    this.decoProg = makeProgram(gl, decoVert, solidFrag, [
      'u_resolution',
      'u_cellSize',
      'u_cols',
      'u_perCell',
      'u_slotBase',
      'u_rows',
    ]);
    this.solidProg = makeProgram(gl, solidVert, solidFrag, ['u_resolution']);

    this.bgBuf = gl.createBuffer();
    this.glyphBuf = gl.createBuffer();
    this.decoBuf = gl.createBuffer();
    this.cursorRectBuf = gl.createBuffer();
    this.cursorGlyphBuf = gl.createBuffer();

    this.bgVao = gl.createVertexArray();
    this.glyphVao = gl.createVertexArray();
    this.decoVao = gl.createVertexArray();
    this.cursorRectVao = gl.createVertexArray();
    this.cursorGlyphVao = gl.createVertexArray();

    this.setupBgVao();
    this.setupGlyphVao(this.glyphVao, this.glyphBuf);
    this.setupSolidVao(this.decoVao, this.decoBuf);
    this.setupSolidVao(this.cursorRectVao, this.cursorRectBuf);
    this.setupGlyphVao(this.cursorGlyphVao, this.cursorGlyphBuf);

    // Fixed-size cursor buffers.
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cursorRectBuf);
    gl.bufferData(gl.ARRAY_BUFFER, DECO_UNITS * 4, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cursorGlyphBuf);
    gl.bufferData(gl.ARRAY_BUFFER, GLYPH_UNITS * 4, gl.DYNAMIC_DRAW);

    if (this.cols > 0 && this.rows > 0) {
      this.rebuildAtlas();
      this.sizeInstanceGpuBuffers();
    }
  }

  private destroyGLResources(): void {
    const gl = this.gl;
    if (!gl) return;
    for (const p of [
      this.bgProg,
      this.glyphProg,
      this.glyphAtProg,
      this.decoProg,
      this.solidProg,
    ]) {
      if (p) gl.deleteProgram(p.prog);
    }
    for (const b of [this.bgBuf, this.glyphBuf, this.decoBuf, this.cursorRectBuf, this.cursorGlyphBuf]) {
      if (b) gl.deleteBuffer(b);
    }
    for (const v of [this.bgVao, this.glyphVao, this.decoVao, this.cursorRectVao, this.cursorGlyphVao]) {
      if (v) gl.deleteVertexArray(v);
    }
    if (this.atlas) this.atlas.destroy();
    this.atlas = null;
    this.bgProg = this.glyphProg = this.glyphAtProg = null;
    this.decoProg = this.solidProg = null;
  }

  private sizeInstanceGpuBuffers(): void {
    const gl = this.gl;
    if (!gl || !this.bgBuf) return; // resize() before mount(); sized at mount
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bgBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.buffers.bg.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.glyphBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.buffers.glyphBuf.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.decoBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.buffers.decoBuf.byteLength, gl.DYNAMIC_DRAW);
  }

  private rebuildAtlas(): void {
    const gl = this.gl;
    if (!gl || !this.scratchCtx) return;
    if (this.atlas) this.atlas.destroy();
    // Grow the scratch surface to hold the widest slot. With a shaper configured
    // that is an outline tile, which carries a cluster's full ink and overhangs
    // its cell (see shaper/harfbuzz.ts: up to ~cluster advance + 2 cells wide and
    // ~2 cells tall); without one it is at most a wide (2-cell) glyph.
    const sc = this.scratch as HTMLCanvasElement;
    sc.width = this.opts.shaper ? this.cellW * 6 : this.cellW * 2;
    sc.height = this.opts.shaper ? this.cellH * 3 : this.cellH;
    const font: RasterFont = {
      cellW: this.cellW,
      cellH: this.cellH,
      baseline: this.baseline,
      ctx: this.scratchCtx,
      fontFor: (mask) => this.fontFor(mask),
    };
    this.atlas = new GlyphAtlas(gl, font);
  }

  private setupBgVao(): void {
    const gl = this.gl!;
    gl.bindVertexArray(this.bgVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bgBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribIPointer(0, 1, gl.UNSIGNED_INT, 4, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.bindVertexArray(null);
  }

  private setupGlyphVao(vao: WebGLVertexArrayObject | null, buf: WebGLBuffer | null): void {
    const gl = this.gl!;
    const stride = GLYPH_UNITS * 4; // 32
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_INT, stride, 24);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribIPointer(3, 1, gl.UNSIGNED_INT, stride, 28);
    gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(null);
  }

  private setupSolidVao(vao: WebGLVertexArrayObject | null, buf: WebGLBuffer | null): void {
    const gl = this.gl!;
    const stride = DECO_UNITS * 4; // 20
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribIPointer(1, 1, gl.UNSIGNED_INT, stride, 16);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);
  }

  // --- internals ----------------------------------------------------------

  private measure(): void {
    this.deviceFontPx = this.opts.fontSize * this.dpr;
    const measurement = measureFont(
      this.scratchCtx,
      this.opts.fontFamily,
      this.deviceFontPx,
    );
    const g = computeCellMetrics(
      this.opts.fontSize,
      this.dpr,
      this.opts.lineHeight,
      measurement,
      this.opts.letterSpacing,
    );
    this.cellW = g.cellW;
    this.cellH = g.cellH;
    this.baseline = g.baseline;
    // Hand the shaper the device-pixel geometry it needs to lay glyphs (see the
    // Canvas2D backend for the same call). A code-point shaper ignores it.
    this.opts.shaper?.setMetrics?.({
      cellWidth: g.cellW,
      cellHeight: g.cellH,
      baseline: g.baseline,
      deviceFontPx: this.deviceFontPx,
      dpr: this.dpr,
    });
    this.fontCache.clear();
  }

  private applyBackingStore(): void {
    const canvas = this.canvas;
    if (!canvas) return;
    canvas.width = this.cols * this.cellW;
    canvas.height = this.rows * this.cellH;
  }

  private fontFor(mask: number): string {
    let s = this.fontCache.get(mask);
    if (s) return s;
    const bold = mask & CellFlags.BOLD ? 'bold ' : '';
    const italic = mask & CellFlags.ITALIC ? 'italic ' : '';
    s = `${italic}${bold}${this.deviceFontPx}px ${this.opts.fontFamily}`;
    this.fontCache.set(mask, s);
    return s;
  }
}

// --- helpers --------------------------------------------------------------

function makeProgram(
  gl: WebGL2RenderingContext,
  vs: string,
  fs: string,
  uniforms: readonly string[],
): ProgramInfo {
  const prog = linkProgram(gl, vs, fs);
  return { prog, u: uniformLocations(gl, prog, uniforms) };
}

function makeScratchCanvas(): AnyCanvas {
  const doc = (globalThis as { document?: { createElement(t: string): HTMLCanvasElement } }).document;
  if (doc?.createElement) return doc.createElement('canvas');
  const OC = (globalThis as { OffscreenCanvas?: typeof OffscreenCanvas }).OffscreenCanvas;
  if (OC) return new OC(8, 8);
  throw new Error('vtgl: no canvas available for glyph rasterization');
}

function get2d(canvas: AnyCanvas): Ctx2D {
  const ctx = (canvas as HTMLCanvasElement).getContext('2d', {
    willReadFrequently: true,
  }) as Ctx2D | null;
  if (!ctx) throw new Error('vtgl: 2d context unavailable for rasterization');
  return ctx;
}

function cursorShapeBit(shape: string): number {
  return shape === 'bar' ? 1 : shape === 'underline' ? 2 : 0;
}

/** Euclidean modulo: the scroll delta may be negative. */
function mod(a: number, n: number): number {
  const m = a % n;
  return m < 0 ? m + n : m;
}

function globalDpr(): number {
  const w = globalThis as { devicePixelRatio?: number };
  return w.devicePixelRatio && w.devicePixelRatio > 0 ? w.devicePixelRatio : 1;
}

function now(): number {
  const p = (globalThis as { performance?: { now(): number } }).performance;
  return p ? p.now() : Date.now();
}
