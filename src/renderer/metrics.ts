// Shared cell-metric computation. Both the Canvas2D fallback and the WebGL2
// core derive their device-pixel geometry from this one function so the two
// backends agree cell-for-cell; the Playwright pixel-parity test depends on it.

export interface CellMetrics {
  /** Font size in device pixels (CSS fontSize * dpr). */
  deviceFontPx: number;
  /** Cell width in device pixels. */
  cellW: number;
  /** Cell height in device pixels. */
  cellH: number;
  /** Baseline offset from the top of the cell, device pixels. */
  baseline: number;
}

/**
 * Compute cell geometry from the font inputs and a measured horizontal advance.
 * `advance` is the device-pixel width of a representative monospace glyph (the
 * caller measures it with a 2D context, or passes a fallback). `letterSpacing`
 * is in CSS pixels and is scaled by dpr here.
 */
export function computeCellMetrics(
  fontSize: number,
  dpr: number,
  lineHeight: number,
  advance: number,
  letterSpacing: number,
): CellMetrics {
  const deviceFontPx = fontSize * dpr;
  const cellW = Math.max(1, Math.round(advance + letterSpacing * dpr));
  const cellH = Math.max(1, Math.round(deviceFontPx * lineHeight));
  // Center the text box in the cell and sit the baseline near 80% down.
  const baseline = Math.round(
    deviceFontPx + (cellH - deviceFontPx) / 2 - deviceFontPx * 0.18,
  );
  return { deviceFontPx, cellW, cellH, baseline };
}
