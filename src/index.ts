// vtgl: a standalone glyph-atlas terminal renderer. VT state in, pixels and
// input events out. This barrel exposes the public contract and the shipping
// renderer(s). The WebGL2 core is added in the Core phase; today the Canvas2D
// fallback is the working implementation of the Renderer interface.

export * from './types.ts';
export { Canvas2DRenderer } from './renderer/canvas2d.ts';
export { atlasKey, atlasKeyBaked, styleMask, GLYPH_STYLE_MASK } from './atlas/key.ts';
export { rgb, toCss, quantize } from './color.ts';
export { Emitter } from './events.ts';

import { Canvas2DRenderer } from './renderer/canvas2d.ts';
import type { Renderer, RendererOptions } from './types.ts';

/**
 * Construct the best available renderer for the current environment. Today this
 * returns the Canvas2D fallback; once the WebGL2 core lands it will probe for a
 * WebGL2 context and fall back to Canvas2D automatically. The return type is the
 * shared Renderer interface either way.
 */
export function createRenderer(options: RendererOptions): Renderer {
  return new Canvas2DRenderer(options);
}
