// Color helpers. Colors flow through the renderer as packed 0xRRGGBB integers.

import type { Rgb } from './types.ts';

export function r(c: Rgb): number {
  return (c >> 16) & 0xff;
}
export function g(c: Rgb): number {
  return (c >> 8) & 0xff;
}
export function b(c: Rgb): number {
  return c & 0xff;
}

export function rgb(rr: number, gg: number, bb: number): Rgb {
  return ((rr & 0xff) << 16) | ((gg & 0xff) << 8) | (bb & 0xff);
}

/** CSS `#rrggbb` string. Cached by callers that need it repeatedly. */
export function toCss(c: Rgb): string {
  return '#' + (c & 0xffffff).toString(16).padStart(6, '0');
}

/**
 * Quantize a 24-bit color to a coarser key for atlas bucketing when color must
 * be baked into the glyph (subpixel AA, colored fallback). Default renderer
 * tints monochrome glyphs and does NOT use this; it exists for the fg-quant
 * atlas mode documented in DESIGN.md. Buckets each channel to 5 bits (RGB555).
 */
export function quantize(c: Rgb): number {
  return ((r(c) >> 3) << 10) | ((g(c) >> 3) << 5) | (b(c) >> 3);
}
