// Browser-side capture harness.
//
// Bundled into scripts/capture/harness.js by capture.mjs and loaded by
// index.html, so the README images are produced by the real WebGL2 renderer in
// a real GPU context rather than by a mockup. Node builds the cell grids and
// hands them over as plain JSON; everything below this line is vtgl doing the
// drawing.
//
// Capture-only. Not part of the shipped package and not used by the tests.

import { WebGL2Renderer } from '../../src/renderer/webgl2.ts';
import { FakeSource } from '../../src/testing/fake-source.ts';
import type { RenderStats, Theme } from '../../src/types.ts';

interface CellSpec {
  /** Row, column. */
  r: number;
  c: number;
  /** The grapheme cluster occupying this cell. */
  t: string;
  fg?: number;
  bg?: number;
  /** CellFlags bitfield. */
  fl?: number;
}

interface GridSpec {
  cols: number;
  rows: number;
  fontSize: number;
  dpr: number;
  fontFamily: string;
  theme: Theme;
  cells: CellSpec[];
}

interface GridResult {
  png: string;
  width: number;
  height: number;
  stats: RenderStats;
  cellWidth: number;
  cellHeight: number;
}

interface AtlasResult {
  png: string;
  /** Page dimensions in texels, and the used sub-rectangle that was cropped to. */
  pageSize: number;
  usedWidth: number;
  usedHeight: number;
  entries: number;
  pages: number;
}

/**
 * The live renderer from the last renderGrid call. Kept alive so the atlas it
 * filled can be read back afterwards: the whole point of the atlas image is
 * that it is the texture that drew the frame above it, not a fresh one.
 */
let live: { renderer: WebGL2Renderer; canvas: HTMLCanvasElement } | null = null;

/** Copy any canvas (2D or WebGL) into a 2D scratch and encode it as a PNG. */
function encode(canvas: HTMLCanvasElement): string {
  const scratch = document.createElement('canvas');
  scratch.width = canvas.width;
  scratch.height = canvas.height;
  const ctx = scratch.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(canvas, 0, 0);
  return scratch.toDataURL('image/png');
}

function renderGrid(spec: GridSpec): GridResult {
  if (live) {
    live.renderer.dispose();
    live.canvas.remove();
  }

  const source = new FakeSource({
    cols: spec.cols,
    rows: spec.rows,
    fg: spec.theme.foreground,
    bg: spec.theme.background,
  });
  source.setCursor({ visible: false });
  source.clearRegion(0, spec.rows);

  for (const cell of spec.cells) {
    source.writeText(cell.r, cell.c, cell.t, {
      fg: cell.fg ?? spec.theme.foreground,
      bg: cell.bg ?? spec.theme.background,
      flags: cell.fl ?? 0,
    });
  }

  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 8;
  document.body.appendChild(canvas);

  const renderer = new WebGL2Renderer({
    fontFamily: spec.fontFamily,
    fontSize: spec.fontSize,
    dpr: spec.dpr,
    theme: spec.theme,
  });
  renderer.mount(canvas);
  renderer.resize(spec.cols, spec.rows, spec.dpr);

  let stats: RenderStats | undefined;
  renderer.on('render', (s) => (stats = s));
  renderer.render(source, 0);

  // Read back before anything can composite the drawing buffer away.
  const png = encode(canvas);
  const m = renderer.getMetrics();
  live = { renderer, canvas };

  return {
    png,
    width: canvas.width,
    height: canvas.height,
    stats: stats!,
    cellWidth: m.cellWidth,
    cellHeight: m.cellHeight,
  };
}

/**
 * Read one page of the live renderer's glyph atlas straight off the GPU.
 *
 * This reaches past `private` into the renderer's atlas and GL context on
 * purpose: the alternative is re-rasterizing the glyphs into a separate canvas,
 * which would produce a picture of an atlas rather than a picture of THE atlas.
 * The layer is attached to a framebuffer and read with readPixels, so what
 * lands in the PNG is the texture memory the frame above sampled from.
 *
 * Slots hold straight (non-premultiplied) alpha, white for grayscale glyphs and
 * real colour for emoji, so the readback is composited over the page background
 * to be visible at all. The crop is measured from the data: the used region is
 * the bounding box of every texel with any coverage.
 */
function atlasPage(page: number, background: number, scale: number, rule: number): AtlasResult {
  if (!live) throw new Error('capture: no live renderer');
  const inner = live.renderer as unknown as {
    gl: WebGL2RenderingContext;
    atlas: {
      texture: WebGLTexture;
      pageSize: number;
      stats(): { entries: number; pages: number };
      packer: { map: Map<string, { page: number; x: number; y: number; w: number; h: number }> };
    };
  };
  const gl = inner.gl;
  const atlas = inner.atlas;
  const size = atlas.pageSize;

  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, atlas.texture, 0, page);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error('capture: atlas framebuffer incomplete: 0x' + status.toString(16));
  }
  const texels = new Uint8Array(size * size * 4);
  gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, texels);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb);

  // Bounding box of anything with coverage.
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (texels[(y * size + x) * 4 + 3] > 0) {
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  const usedWidth = Math.min(size, maxX + 2);
  const usedHeight = Math.min(size, maxY + 2);

  const src = document.createElement('canvas');
  src.width = usedWidth;
  src.height = usedHeight;
  const srcCtx = src.getContext('2d')!;
  const img = srcCtx.createImageData(usedWidth, usedHeight);
  const br = (background >> 16) & 0xff;
  const bg_ = (background >> 8) & 0xff;
  const bb = background & 0xff;

  for (let y = 0; y < usedHeight; y++) {
    for (let x = 0; x < usedWidth; x++) {
      const s = (y * size + x) * 4;
      const d = (y * usedWidth + x) * 4;
      const a = texels[s + 3] / 255;
      img.data[d] = Math.round(texels[s] * a + br * (1 - a));
      img.data[d + 1] = Math.round(texels[s + 1] * a + bg_ * (1 - a));
      img.data[d + 2] = Math.round(texels[s + 2] * a + bb * (1 - a));
      img.data[d + 3] = 255;
    }
  }
  srcCtx.putImageData(img, 0, 0);

  // Blow the strip up with nearest-neighbour so no texel is invented, then
  // stroke the slot rectangles the packer actually allocated. The outlines are
  // read from the packer's own map, not inferred from the pixels, so what is
  // drawn is the real shelf packing: rows of equal-height slots filled left to
  // right, a double-width box wherever a wide cluster was assigned two columns.
  const out = document.createElement('canvas');
  out.width = usedWidth * scale;
  out.height = usedHeight * scale;
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, out.width, out.height);

  ctx.strokeStyle = '#' + rule.toString(16).padStart(6, '0');
  ctx.lineWidth = 1;
  for (const e of atlas.packer.map.values()) {
    if (e.page !== page) continue;
    ctx.strokeRect(e.x * scale + 0.5, e.y * scale + 0.5, e.w * scale - 1, e.h * scale - 1);
  }

  const s = atlas.stats();
  return {
    png: out.toDataURL('image/png'),
    pageSize: size,
    usedWidth,
    usedHeight,
    entries: s.entries,
    pages: s.pages,
  };
}

(window as unknown as { capture: unknown }).capture = { renderGrid, atlasPage };
