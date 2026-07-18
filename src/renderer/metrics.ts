// Shared cell-metric computation. Both the Canvas2D fallback and the WebGL2
// core derive their device-pixel geometry from this one function so the two
// backends agree cell-for-cell; the Playwright pixel-parity test depends on it.
//
// Cell height and baseline come from the font's own vertical metrics
// (fontBoundingBoxAscent/Descent) rather than from the nominal font size. The
// nominal size says nothing about where a given face puts its baseline or how
// much descender room it needs, so deriving the baseline from it -- as this
// module used to, via a guessed 0.18 * fontSize descender -- lands a pixel or
// more off on real faces and packs the rows tighter than the face asks for.
// The measurement approach follows xterm.js's TextMetricsMeasureStrategy
// (src/browser/services/CharSizeService.ts, MIT); see THIRD-PARTY.md.

/** A 2D context, or anything that can measure text like one. */
export interface MeasureContext {
  font: string;
  measureText(text: string): {
    width: number;
    fontBoundingBoxAscent?: number;
    fontBoundingBoxDescent?: number;
    actualBoundingBoxAscent?: number;
    actualBoundingBoxDescent?: number;
  };
}

export interface FontMeasurement {
  /** Horizontal advance of a representative glyph, device pixels. */
  advance: number;
  /** Distance from the baseline to the top of the font's line box. */
  ascent: number;
  /** Distance from the baseline to the bottom of the font's line box. */
  descent: number;
}

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

/** The glyph whose advance defines the cell width. */
const ADVANCE_SAMPLE = 'M';

/**
 * A string covering the tall and deep extremes of a face, so that engines
 * which only report `actualBoundingBox*` still yield a usable line box.
 */
const EXTENT_SAMPLE = 'Mg|_j';

/**
 * Measure a font's advance and vertical extents at `deviceFontPx`.
 *
 * Prefers `fontBoundingBox*`, which reports the face's declared line box and
 * is therefore stable no matter which characters happen to be on screen.
 * Falls back to the ink box of a tall-and-deep sample, and finally to
 * proportions of the nominal size, so a context that reports neither still
 * produces sane geometry.
 */
export function measureFont(
  ctx: MeasureContext | null | undefined,
  fontFamily: string,
  deviceFontPx: number,
): FontMeasurement {
  const fallback: FontMeasurement = {
    advance: deviceFontPx * 0.6,
    ascent: deviceFontPx * 0.8,
    descent: deviceFontPx * 0.2,
  };
  if (!ctx) return fallback;

  ctx.font = `${deviceFontPx}px ${fontFamily}`;
  const adv = ctx.measureText(ADVANCE_SAMPLE);
  const advance = adv.width > 0 ? adv.width : fallback.advance;

  // Prefer the face's declared line box.
  let ascent = adv.fontBoundingBoxAscent ?? 0;
  let descent = adv.fontBoundingBoxDescent ?? 0;

  if (!(ascent > 0) || !(descent > 0)) {
    // No font box; fall back to the ink box of a sample that reaches both
    // extremes. Measured on the sample, not on 'M', which has no descender.
    const ext = ctx.measureText(EXTENT_SAMPLE);
    const a = ext.actualBoundingBoxAscent ?? 0;
    const d = ext.actualBoundingBoxDescent ?? 0;
    if (a > 0) ascent = a;
    if (d > 0) descent = d;
  }

  if (!(ascent > 0)) ascent = fallback.ascent;
  if (!(descent > 0)) descent = fallback.descent;
  return { advance, ascent, descent };
}

/**
 * Compute cell geometry from the font inputs and a font measurement.
 *
 * `lineHeight` scales the face's natural line box: 1 means "exactly what the
 * font asks for", 1.2 adds 20% leading. Extra leading is split evenly above
 * and below the text box so glyphs stay optically centred. `letterSpacing` is
 * in CSS pixels and is scaled by dpr here.
 */
export function computeCellMetrics(
  fontSize: number,
  dpr: number,
  lineHeight: number,
  measurement: FontMeasurement,
  letterSpacing: number,
): CellMetrics {
  const deviceFontPx = fontSize * dpr;
  const cellW = Math.max(1, Math.round(measurement.advance + letterSpacing * dpr));

  // The face's own line box, then the caller's leading on top of it.
  const charH = measurement.ascent + measurement.descent;
  const cellH = Math.max(1, Math.round(charH * lineHeight));

  // Sit the baseline where the face puts it, with any extra leading split
  // evenly above and below.
  const baseline = Math.max(
    0,
    Math.min(cellH, Math.round(measurement.ascent + (cellH - charH) / 2)),
  );

  return { deviceFontPx, cellW, cellH, baseline };
}
