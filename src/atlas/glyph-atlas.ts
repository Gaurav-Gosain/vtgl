// GL-backed glyph atlas. Owns a TEXTURE_2D_ARRAY (one layer per packer page),
// rasterizes graphemes to a scratch 2D canvas on a miss, and uploads the slot
// with texSubImage3D. Implements GlyphProvider so the instance builder can stay
// GL-free. LRU/eviction bookkeeping lives in AtlasPacker; this class does the
// raster and upload and reports per-frame upload counts.
//
// Monochrome glyphs are rastered white-on-transparent and stored as coverage in
// the alpha channel; the shader tints them by the per-instance foreground.
// Colored glyphs (emoji) are detected by pixel inspection and stored as-is with
// a `colored` flag so the shader samples them untinted.

import { AtlasPacker } from './packer.ts';
import { atlasKey } from './key.ts';
import type { AtlasRect, GlyphProvider, RasterHint } from '../renderer/instances.ts';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Font/geometry the atlas needs to raster a glyph into a cell-sized slot. */
export interface RasterFont {
  cellW: number;
  cellH: number;
  baseline: number;
  /** Scratch 2D context, sized at least (2*cellW) x cellH. */
  ctx: Ctx2D;
  /** CSS font string (device px) for a bold/italic style mask. */
  fontFor(styleMask: number): string;
}

export class GlyphAtlas implements GlyphProvider {
  readonly pageSize: number;
  readonly maxPages: number;

  private gl: WebGL2RenderingContext;
  private packer: AtlasPacker;
  private font: RasterFont;
  private tex: WebGLTexture | null = null;
  private uploadsThisFrame = 0;

  constructor(
    gl: WebGL2RenderingContext,
    font: RasterFont,
    pageSize = 1024,
    maxPages = 4,
  ) {
    this.gl = gl;
    this.font = font;
    this.pageSize = pageSize;
    this.maxPages = maxPages;
    this.packer = new AtlasPacker(pageSize, maxPages);
    this.createTexture();
  }

  get texture(): WebGLTexture {
    if (!this.tex) throw new Error('vtgl: atlas texture missing');
    return this.tex;
  }

  get generation(): number {
    return this.packer.currentGeneration;
  }

  get uploads(): number {
    return this.uploadsThisFrame;
  }

  beginFrame(): void {
    this.packer.beginFrame();
    this.uploadsThisFrame = 0;
  }

  stats(): { entries: number; pages: number; evictions: number; flushes: number } {
    const s = this.packer.stats();
    return { entries: s.entries, pages: s.pages, evictions: s.evictions, flushes: s.flushes };
  }

  ensure(
    grapheme: string,
    styleMask: number,
    widthCols: number,
    hint?: RasterHint,
  ): AtlasRect | null {
    const slotW = Math.max(1, widthCols) * this.font.cellW;
    const slotH = this.font.cellH;
    // A shaped glyph carries its own key: the same grapheme rastered with a
    // joining context or a fitted advance is a different picture, and the
    // shaper's key is what keeps the two from sharing a slot.
    const key = hint ? hint.key : atlasKey(grapheme, styleMask);
    const res = this.packer.alloc(key, slotW, slotH, false);
    if (res === null) return null;
    if (res.isNew) {
      res.entry.colored = this.raster(grapheme, styleMask, slotW, slotH, res.entry.page, res.entry.x, res.entry.y, hint);
    }
    const e = res.entry;
    return { x: e.x, y: e.y, w: e.w, h: e.h, colored: e.colored, page: e.page };
  }

  /** Rebuild the texture after context loss and drop all cached slots. */
  onContextRestored(gl: WebGL2RenderingContext): void {
    this.gl = gl;
    this.tex = null;
    this.createTexture();
    this.packer.flush();
  }

  destroy(): void {
    if (this.tex) this.gl.deleteTexture(this.tex);
    this.tex = null;
  }

  // --- internals ----------------------------------------------------------

  private createTexture(): void {
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error('vtgl: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, this.pageSize, this.pageSize, this.maxPages);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.tex = tex;
  }

  private raster(
    grapheme: string,
    styleMask: number,
    slotW: number,
    slotH: number,
    page: number,
    x: number,
    y: number,
    hint?: RasterHint,
  ): boolean {
    const ctx = this.font.ctx;
    ctx.clearRect(0, 0, slotW, slotH);
    ctx.font = this.font.fontFor(styleMask);
    ctx.textBaseline = 'alphabetic';
    // Both are set on every raster rather than once at setup: the context is
    // shared across glyphs, so a shaped glyph that flipped direction must not
    // leak that into the next unshaped one. textAlign has to be explicit
    // alongside it, because the default 'start' means the right edge under rtl.
    ctx.textAlign = 'left';
    ctx.direction = hint?.rtl ? 'rtl' : 'ltr';
    ctx.fillStyle = '#ffffff';
    if (hint?.fitAdvance) {
      const advance = ctx.measureText(grapheme).width;
      ctx.save();
      // Squeeze or stretch the glyph so its advance is exactly the slot. This is
      // what puts a joining stroke on the cell boundary where its neighbour's
      // stroke also ends, and it is also why a shaped glyph cannot overflow its
      // slot the way an unshaped wide one can.
      if (advance > 0) ctx.scale(slotW / advance, 1);
      ctx.fillText(grapheme, 0, this.font.baseline);
      ctx.restore();
    } else {
      ctx.fillText(grapheme, 0, this.font.baseline);
    }

    const img = ctx.getImageData(0, 0, slotW, slotH);
    const colored = detectColored(img.data);

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texSubImage3D(
      gl.TEXTURE_2D_ARRAY,
      0,
      x,
      y,
      page,
      slotW,
      slotH,
      1,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      img.data,
    );
    this.uploadsThisFrame++;
    return colored;
  }
}

/**
 * A glyph is "colored" if enough opaque-ish pixels carry real chroma. White
 * text (grayscale AA) has equal channels, so it never trips this; emoji do.
 */
function detectColored(data: Uint8ClampedArray): boolean {
  let colorful = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 24) continue;
    const rr = data[i];
    const gg = data[i + 1];
    const bb = data[i + 2];
    const max = Math.max(rr, gg, bb);
    const min = Math.min(rr, gg, bb);
    if (max - min > 24) {
      colorful++;
      if (colorful > 4) return true;
    }
  }
  return false;
}
