// vtgl: a standalone glyph-atlas terminal renderer. VT state in, pixels and
// input events out. This barrel exposes the public contract and both renderer
// backends: the WebGL2 glyph-atlas core and the Canvas2D fallback, which
// implement the identical Renderer interface.

export * from './types.ts';
export { Canvas2DRenderer } from './renderer/canvas2d.ts';
export { WebGL2Renderer } from './renderer/webgl2.ts';
export { atlasKey, atlasKeyBaked, styleMask, GLYPH_STYLE_MASK } from './atlas/key.ts';
export { rgb, toCss, quantize } from './color.ts';
export { Emitter } from './events.ts';
export { RenderScheduler } from './renderer/scheduler.ts';
export type { RenderSchedulerOptions } from './renderer/scheduler.ts';
export { computeCellMetrics, measureFont } from './renderer/metrics.ts';
export type { CellMetrics, FontMeasurement, MeasureContext } from './renderer/metrics.ts';
export { ShelfAllocator } from './atlas/shelf.ts';
export { AtlasPacker } from './atlas/packer.ts';
export type { AtlasEntry, PackerStats } from './atlas/packer.ts';
export { GlyphAtlas } from './atlas/glyph-atlas.ts';
export type { RasterFont } from './atlas/glyph-atlas.ts';
export { InstanceBuffers, StyleBit } from './renderer/instances.ts';
export type { AtlasRect, GlyphProvider, RasterHint } from './renderer/instances.ts';
export { RowShaper } from './renderer/runs.ts';
export { arabicShaper, isArabic, joiningType } from './shaper/arabic.ts';
export { createHarfBuzzShaper } from './shaper/harfbuzz.ts';
export type { HarfBuzzShaperOptions } from './shaper/harfbuzz.ts';

import { Canvas2DRenderer } from './renderer/canvas2d.ts';
import { WebGL2Renderer } from './renderer/webgl2.ts';
import type { Renderer, RendererOptions } from './types.ts';

/**
 * True if the environment can create a WebGL2 context. Probed on a throwaway
 * canvas so the answer is known before a renderer is constructed.
 */
export function supportsWebGL2(): boolean {
  try {
    const doc = (globalThis as { document?: { createElement(t: string): HTMLCanvasElement } })
      .document;
    if (!doc?.createElement) return false;
    const probe = doc.createElement('canvas');
    const gl = probe.getContext('webgl2');
    return gl !== null && gl !== undefined;
  } catch {
    return false;
  }
}

/**
 * Construct the best available renderer for the current environment: the WebGL2
 * glyph-atlas core where WebGL2 exists, else the Canvas2D fallback. The return
 * type is the shared Renderer interface either way, so callers never branch.
 */
export function createRenderer(options: RendererOptions): Renderer {
  if (supportsWebGL2()) {
    try {
      return new WebGL2Renderer(options);
    } catch {
      // Fall through to the 2D path if WebGL2 construction fails.
    }
  }
  return new Canvas2DRenderer(options);
}
