// Atlas key scheme.
//
// The atlas is keyed by string so that shaped runs (a future contextual shaper)
// slot into the exact same cache the per-grapheme path uses. A key identifies a
// rasterizable glyph independent of where it lands on screen.
//
// Default (tinting) mode key:   `${grapheme}\u0001${styleMask}`
//   Monochrome glyphs are rastered as coverage and tinted per-instance by the
//   foreground color, so fg is NOT part of the key. Colored glyphs (emoji) are
//   rastered with their own colors and drawn untinted; they still key by
//   grapheme + styleMask because emoji ignore bold/italic anyway (styleMask 0).
//
// Baked (fg-quant) mode key:    `${grapheme}\u0001${styleMask}\u0001${fgQuant}`
//   For renderers that bake foreground into the glyph (e.g. subpixel AA). The
//   trailing fg bucket is the only difference; docs/architecture.md explains it.

import { CellFlags } from '../types.ts';
import { quantize } from '../color.ts';
import type { Rgb } from '../types.ts';

/** Style bits that change the rastered glyph shape: bold and italic only. */
export const GLYPH_STYLE_MASK = CellFlags.BOLD | CellFlags.ITALIC;

const SEP = '\u0001';

export function styleMask(flags: number): number {
  return flags & GLYPH_STYLE_MASK;
}

/** Default tinting-mode key. */
export function atlasKey(grapheme: string, flags: number): string {
  return grapheme + SEP + (flags & GLYPH_STYLE_MASK);
}

/** Baked fg-quant-mode key. */
export function atlasKeyBaked(grapheme: string, flags: number, fg: Rgb): string {
  return grapheme + SEP + (flags & GLYPH_STYLE_MASK) + SEP + quantize(fg);
}
