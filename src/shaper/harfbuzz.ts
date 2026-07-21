// HarfBuzz-WASM contextual shaper.
//
// Where the PF-B shaper (shaper/arabic.ts) selects a precomposed presentation
// form per cell and leans on the browser to draw it, this one runs the real
// HarfBuzz shaping engine over each run: it hands HarfBuzz the run's code points
// and a bundled Arabic face, gets back glyph ids and positions (advances, and
// GPOS x/y offsets for marks), and rasters each glyph straight from its outline.
// Nothing about the result depends on the browser, so Chromium and Firefox draw
// identical pixels, and marks (dots, hamza, madda) land where GPOS puts them,
// which precomposed forms cannot express at all.
//
// Architecture: hybrid. Only runs the shaper claims (the Arabic block, via the
// same `isArabic` test the PF-B shaper uses) go through HarfBuzz. Latin, digits,
// box-drawing, emoji and every other cell stay on the renderer's existing
// code-point + `fillText` path, untouched. That is what keeps ordinary terminal
// content byte-for-byte what it was; the shape-everything design (a primary
// monospace face plus this Arabic face in a fallback chain, so HarfBuzz shapes
// the whole grid and the browser never shapes anything) is the documented next
// step in docs/limits.md and needs the primary face's bytes bundled too.
//
// Each shaped CLUSTER (a base letter plus any marks that share its cluster) is
// composited into one tile carrying its full ink, sized larger than a cell so a
// connecting stroke overhangs freely. The tile is placed at the HarfBuzz pen
// position with no per-cell crop, which is what removes the WebGL2 join seam the
// PF-B path left. A run is fit uniformly across the cells the VT assigned it, so
// the grid stays aligned and joins stay continuous (one scale for the whole run,
// not a per-cell squeeze).
//
// Bidi is out of scope, as with the PF-B shaper: HarfBuzz shapes a run in one
// direction, it does not run the Unicode Bidirectional Algorithm. See
// docs/limits.md.

import { isArabic } from './arabic.ts';
import {
  initHarfBuzz,
  shape as shapeWith,
  Blob,
  Face,
  Font,
  Buffer as HbBuffer,
} from './hb/harfbuzz-wrapper.js';
import { harfBuzzWasm } from './hb/harfbuzz-wasm.ts';
import { notoSansArabic } from './hb/font-noto-arabic.ts';
import type {
  OutlineGlyph,
  RunStyle,
  ShapedGlyph,
  ShapedRun,
  ShaperHook,
  ShaperMetrics,
} from '../types.ts';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** One glyph inside a cluster: its id and pen offset from the cluster origin, device px. */
interface Member {
  gid: number;
  offsetX: number;
  offsetY: number;
}

export interface HarfBuzzShaperOptions {
  /**
   * Font bytes (sfnt: TTF/OTF) for the Arabic face. Defaults to the bundled
   * Noto Sans Arabic. A host may pass its own OFL/embeddable face.
   */
  fontBytes?: Uint8Array;
}

/**
 * Load the wasm engine and the Arabic face and return a ready ShaperHook. Await
 * this once, then pass the result as `RendererOptions.shaper`. It is async
 * because HarfBuzz is a wasm module; resolving the promise means the engine is
 * warm and `shapeRun` will never block.
 */
export async function createHarfBuzzShaper(
  options: HarfBuzzShaperOptions = {},
): Promise<ShaperHook> {
  await initHarfBuzz(harfBuzzWasm);
  const bytes = options.fontBytes ?? notoSansArabic;
  const blob = new Blob(bytes);
  const face = new Face(blob, 0);
  const upem = face.upem || 1000;
  const font = new Font(face);
  return new HarfBuzzShaper(font, upem);
}

class HarfBuzzShaper implements ShaperHook {
  private readonly font: Font;
  private readonly upem: number;
  private readonly buf: HbBuffer;

  // Device-pixel geometry, filled by setMetrics before the first shapeRun.
  private cellW = 0;
  private cellH = 0;
  private baseline = 0;
  private deviceFontPx = 0;

  // SVG path strings by glyph id (font units), and Path2D built from them on the
  // first raster. Path2D is browser-only, so it is created lazily inside draw()
  // and never touched by the node shaping tests, which assert ids and positions.
  private readonly pathStr = new Map<number, string>();
  private readonly path2d = new Map<number, Path2D>();

  constructor(font: Font, upem: number) {
    this.font = font;
    this.upem = upem;
    this.buf = new HbBuffer();
  }

  participates(codepoint: number): boolean {
    return isArabic(codepoint);
  }

  setMetrics(m: ShaperMetrics): void {
    this.cellW = m.cellWidth;
    this.cellH = m.cellHeight;
    this.baseline = m.baseline;
    this.deviceFontPx = m.deviceFontPx;
  }

  shapeRun(cells: readonly string[], _style: RunStyle): ShapedRun {
    const n = cells.length;
    if (n === 0 || this.cellW === 0) return { glyphs: [] };

    // Shape the whole run at once. HarfBuzz returns glyphs in visual order
    // (left to right) for a right-to-left run, each carrying the input offset of
    // its cluster, so a mark and its base share a cluster value.
    const text = cells.join('');
    const buf = this.buf;
    buf.reset();
    buf.addText(text);
    buf.guessSegmentProperties();
    shapeWith(this.font, buf);
    const infos = buf.getGlyphInfosAndPositions();
    if (infos.length === 0) return { glyphs: [] };

    const fontScale = this.deviceFontPx / this.upem;

    // Uniform horizontal fit: scale the whole run so its advance fills the n
    // cells the VT assigned it. One scale for the run keeps every join
    // continuous (all glyphs move together) while holding the row aligned to the
    // grid; the glyph height stays at the natural font scale.
    let natural = 0;
    for (const g of infos) natural += g.xAdvance;
    natural *= fontScale;
    const runW = n * this.cellW;
    const fit = natural > 0 ? runW / natural : 1;
    const hScale = fontScale * fit;
    const vScale = fontScale;

    // Walk the glyphs left to right, grouping consecutive same-cluster glyphs
    // (base + its marks) into one composited tile.
    interface Group {
      members: Member[];
      originX: number;
      advance: number;
    }
    const groups: Group[] = [];
    let cur: Group | null = null;
    let curCluster = -1;
    let penX = 0;
    for (const g of infos) {
      if (cur === null || g.cluster !== curCluster) {
        cur = { members: [], originX: penX, advance: 0 };
        groups.push(cur);
        curCluster = g.cluster;
      }
      const gx = penX + g.xOffset * hScale;
      const gy = -g.yOffset * vScale;
      cur.members.push({ gid: g.codepoint, offsetX: gx - cur.originX, offsetY: gy });
      cur.advance += g.xAdvance * hScale;
      penX += g.xAdvance * hScale;
    }

    // Tile geometry. Generous fixed margins carry the full ink of the tallest
    // marks and the leftward overhang of a joining stroke with no crop; tighter
    // tiles are a size optimization deferred to later (docs/limits.md).
    const marginX = this.cellW;
    const marginTop = Math.round(this.cellH * 0.5);
    const marginBottom = Math.round(this.cellH * 0.6);
    const tileH = this.baseline + marginTop + marginBottom;
    const penYTile = this.baseline + marginTop;

    const glyphs: ShapedGlyph[] = [];
    const count = Math.min(groups.length, n);
    for (let gi = 0; gi < count; gi++) {
      const grp = groups[gi];
      const tileW = Math.ceil(grp.advance) + 2 * marginX;
      const members = grp.members;
      const outline: OutlineGlyph = {
        tileW,
        tileH,
        penX: marginX,
        penY: penYTile,
        draw: (ctx, px, py) => this.drawCluster(ctx, members, px, py, hScale, vScale),
      };
      glyphs.push({
        atlasKey: keyFor(members, hScale, vScale),
        cluster: cells[gi] ?? 'ar',
        col: gi,
        xOffset: grp.originX - gi * this.cellW,
        yOffset: 0,
        // rtl/fitAdvance belong to the fillText path and are ignored for an
        // outline glyph, which carries its own placement and scale.
        rtl: false,
        fitAdvance: false,
        outline,
      });
    }
    // Blank the run's remaining cells so a covered letter (behind a wider tile,
    // or a cluster that consumed more than one code unit) is not drawn again
    // underneath. Matches how the PF-B shaper blanks a ligature's second cell.
    for (let col = count; col < n; col++) {
      glyphs.push({
        atlasKey: 'hbblank',
        cluster: '',
        col,
        xOffset: 0,
        yOffset: 0,
        rtl: false,
        fitAdvance: false,
      });
    }
    return { glyphs };
  }

  private drawCluster(
    ctx: Ctx2D,
    members: readonly Member[],
    penX: number,
    penY: number,
    hScale: number,
    vScale: number,
  ): void {
    for (const m of members) {
      const path = this.pathFor(m.gid);
      if (path === null) continue;
      ctx.save();
      ctx.translate(penX + m.offsetX, penY + m.offsetY);
      // Font units are y-up; flip to the context's y-down. x carries the run's
      // horizontal fit, y stays at the natural font scale.
      ctx.scale(hScale, -vScale);
      ctx.fill(path);
      ctx.restore();
    }
  }

  private pathFor(gid: number): Path2D | null {
    let p = this.path2d.get(gid);
    if (p !== undefined) return p;
    if (typeof Path2D === 'undefined') return null;
    let s = this.pathStr.get(gid);
    if (s === undefined) {
      s = this.font.glyphToPath(gid);
      this.pathStr.set(gid, s);
    }
    p = new Path2D(s);
    this.path2d.set(gid, p);
    return p;
  }
}

/**
 * Atlas key for a composited cluster tile. It must vary with everything that
 * changes the pixels: the face is fixed (one bundled Arabic face), so the ids,
 * their rounded offsets, and the horizontal/vertical scale buckets are what
 * identify the tile. Two runs of different length shape the same letter at a
 * different fit, and those are legitimately different pictures.
 */
function keyFor(members: readonly Member[], hScale: number, vScale: number): string {
  let k = 'hb\u0001';
  for (const m of members) {
    k += m.gid + ',' + Math.round(m.offsetX) + ',' + Math.round(m.offsetY) + ';';
  }
  k += '' + Math.round(hScale * 1000) + 'x' + Math.round(vScale * 1000);
  return k;
}

