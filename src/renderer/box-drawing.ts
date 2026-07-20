// Vector sprites for the box-drawing and block-element ranges, U+2500..U+259F.
//
// These are the only characters a terminal is expected to TILE. A column of
// U+2588 has to read as one unbroken bar and a lower half block sitting under
// an upper half block as a solid band, and a font glyph cannot promise either.
// It is rastered into a cell-sized box at whatever size and position the face
// asks for, so the rounding and antialiasing at its edges leave a hairline of
// background between two stacked cells. Measured on Noto Sans Mono at a 14px
// font and dpr 1, the full block's ink stopped 4 device pixels short of the top
// of its cell and 3 short of the bottom: a 7 pixel gap between two stacked
// blocks, not a hairline.
//
// Every shape here is defined as rectangles over the cell rectangle it is given,
// so two cells that are adjacent on screen are adjacent in the drawing too. The
// splits are the same expression on both sides of a boundary -- a lower half is
// `round(h/2)` from the top and an upper half is `round(h/2)` tall -- which is
// what makes complementary pieces meet exactly rather than nearly.
//
// The approach follows xterm.js, which draws these ranges as vector sprites for
// the same reason (src/browser/renderer/shared/CustomGlyphs.ts, MIT); the shape
// definitions here are written fresh. See THIRD-PARTY.md.

/** A 2D context, or anything that can fill rectangles and stroke paths like one. */
export interface BoxContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void;
  stroke(): void;
}

const FIRST = 0x2500;
const LAST = 0x259f;

/**
 * True when `cp` is drawn as a sprite rather than looked up in the font. Every
 * codepoint in the range is covered, so a caller may treat this as final.
 */
export function isBoxDrawing(cp: number): boolean {
  return cp >= FIRST && cp <= LAST;
}

/** True when `s` is a lone codepoint this module draws. */
export function isBoxDrawingGrapheme(s: string): boolean {
  return s.length === 1 && isBoxDrawing(s.charCodeAt(0));
}

// --- arm table -------------------------------------------------------------
//
// Most of U+2500..U+257F is a junction of four arms reaching from the edges of
// the cell to its centre, so the table below is the whole range in one place:
// four digits per codepoint, in the order up, right, down, left, where 0 is no
// arm, 1 light, 2 heavy and 3 double. The entries that are not junctions
// (dashes, arcs, diagonals) carry '.' and are drawn by the branches after it.

// prettier-ignore
const ARMS = [
  '0101', '0202', '1010', '2020', '....', '....', '....', '....', // 2500
  '....', '....', '....', '....', '0110', '0210', '0120', '0220', // 2508
  '0011', '0012', '0021', '0022', '1100', '1200', '2100', '2200', // 2510
  '1001', '1002', '2001', '2002', '1110', '1210', '2110', '1120', // 2518
  '2120', '2210', '1220', '2220', '1011', '1012', '2011', '1021', // 2520
  '2021', '2012', '1022', '2022', '0111', '0112', '0211', '0212', // 2528
  '0121', '0122', '0221', '0222', '1101', '1102', '1201', '1202', // 2530
  '2101', '2102', '2201', '2202', '1111', '1112', '1211', '1212', // 2538
  '2111', '1121', '2121', '2112', '2211', '1122', '1221', '2212', // 2540
  '1222', '2122', '2221', '2222', '....', '....', '....', '....', // 2548
  '0303', '3030', '0310', '0130', '0330', '0013', '0031', '0033', // 2550
  '1300', '3100', '3300', '1003', '3001', '3003', '1310', '3130', // 2558
  '3330', '1013', '3031', '3033', '0313', '0131', '0333', '1303', // 2560
  '3101', '3303', '1313', '3131', '3333', '....', '....', '....', // 2568
  '....', '....', '....', '....', '0001', '1000', '0100', '0010', // 2570
  '0002', '2000', '0200', '0020', '0201', '1020', '0102', '2010', // 2578
];

const NONE = 0;
const LIGHT = 1;
const HEAVY = 2;
const DOUBLE = 3;

const UP = 0;
const RIGHT = 1;
const DOWN = 2;
const LEFT = 3;

/** Dash counts, indexed by codepoint. Vertical entries are marked separately. */
const DASHES: Record<number, { count: number; weight: number; vertical: boolean }> = {
  0x2504: { count: 3, weight: LIGHT, vertical: false },
  0x2505: { count: 3, weight: HEAVY, vertical: false },
  0x2506: { count: 3, weight: LIGHT, vertical: true },
  0x2507: { count: 3, weight: HEAVY, vertical: true },
  0x2508: { count: 4, weight: LIGHT, vertical: false },
  0x2509: { count: 4, weight: HEAVY, vertical: false },
  0x250a: { count: 4, weight: LIGHT, vertical: true },
  0x250b: { count: 4, weight: HEAVY, vertical: true },
  0x254c: { count: 2, weight: LIGHT, vertical: false },
  0x254d: { count: 2, weight: HEAVY, vertical: false },
  0x254e: { count: 2, weight: LIGHT, vertical: true },
  0x254f: { count: 2, weight: HEAVY, vertical: true },
};

/**
 * Stroke width of a light line, in device pixels. Derived from the cell height
 * rather than from the nominal font size so it tracks whatever geometry the
 * measured face produced, and so both backends land on the same number.
 */
function lightWidth(h: number): number {
  return Math.max(1, Math.round(h / 16));
}

function weightWidth(weight: number, h: number): number {
  const light = lightWidth(h);
  if (weight === NONE) return 0;
  if (weight === HEAVY) return Math.max(light + 1, light * 2);
  if (weight === DOUBLE) return light * 3;
  return light;
}

/** Offset of a band of `t` px centred in `size` px starting at `p`. */
function centred(p: number, size: number, t: number): number {
  return p + Math.round((size - t) / 2);
}

/**
 * Draw the sprite for `cp` over the rectangle (x, y, w, h), in device pixels.
 * The caller has already set the fill colour and any global alpha. Returns
 * false when the codepoint is outside the range, in which case the caller must
 * fall back to the font.
 */
export function drawBoxGlyph(
  ctx: BoxContext,
  cp: number,
  x: number,
  y: number,
  w: number,
  h: number,
): boolean {
  if (!isBoxDrawing(cp)) return false;
  if (cp >= 0x2580) {
    drawBlock(ctx, cp, x, y, w, h);
    return true;
  }

  const dash = DASHES[cp];
  if (dash) {
    drawDashed(ctx, dash.count, dash.weight, dash.vertical, x, y, w, h);
    return true;
  }
  if (cp >= 0x256d && cp <= 0x2570) {
    drawArc(ctx, cp, x, y, w, h);
    return true;
  }
  if (cp >= 0x2571 && cp <= 0x2573) {
    drawDiagonal(ctx, cp, x, y, w, h);
    return true;
  }

  const entry = ARMS[cp - FIRST];
  const arms = [
    entry.charCodeAt(UP) - 48,
    entry.charCodeAt(RIGHT) - 48,
    entry.charCodeAt(DOWN) - 48,
    entry.charCodeAt(LEFT) - 48,
  ];
  if (arms[UP] === DOUBLE || arms[RIGHT] === DOUBLE || arms[DOWN] === DOUBLE || arms[LEFT] === DOUBLE) {
    drawDoubleJunction(ctx, arms, x, y, w, h);
  } else {
    drawJunction(ctx, arms, x, y, w, h);
  }
  return true;
}

// --- light and heavy junctions ---------------------------------------------

/**
 * A junction of light and heavy arms. Each arm runs from its own cell edge to
 * the far side of the perpendicular band, so opposite arms overlap in the
 * middle and a junction has no hole in it. An arm keeps its own thickness,
 * which is what lets a cell mix a heavy stem with light branches.
 */
function drawJunction(
  ctx: BoxContext,
  arms: number[],
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const t = [
    weightWidth(arms[UP], h),
    weightWidth(arms[RIGHT], h),
    weightWidth(arms[DOWN], h),
    weightWidth(arms[LEFT], h),
  ];
  const vt = Math.max(t[UP], t[DOWN]);
  const ht = Math.max(t[RIGHT], t[LEFT]);
  const vx0 = centred(x, w, vt);
  const vx1 = vx0 + vt;
  const hy0 = centred(y, h, ht);
  const hy1 = hy0 + ht;

  if (t[UP] > 0) ctx.fillRect(centred(x, w, t[UP]), y, t[UP], hy1 - y);
  if (t[DOWN] > 0) ctx.fillRect(centred(x, w, t[DOWN]), hy0, t[DOWN], y + h - hy0);
  if (t[LEFT] > 0) ctx.fillRect(x, centred(y, h, t[LEFT]), vx1 - x, t[LEFT]);
  if (t[RIGHT] > 0) {
    ctx.fillRect(vx0, centred(y, h, t[RIGHT]), x + w - vx0, t[RIGHT]);
  }
}

// --- double junctions ------------------------------------------------------

/**
 * A junction where at least one axis is a double line. A double axis is two
 * light strokes with a light gap, and where the two axes meet, which stroke
 * stops where is what distinguishes a corner from a tee from a crossing. The
 * rules, applied per stroke by `axisSpans`:
 *
 *   crossing  nothing stops, and the square between the four strokes is left
 *             open, which is the shape of U+256C.
 *   tee       the strokes of the through axis pass the near line of the other
 *             pair and stop under its far line, and the near line is broken
 *             across them so the junction opens the way the missing arm went.
 *   corner    the outer stroke of each pair turns into the outer stroke of the
 *             other, and the inner into the inner.
 */
function drawDoubleJunction(
  ctx: BoxContext,
  arms: number[],
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const lw = lightWidth(h);
  const vDouble = arms[UP] === DOUBLE || arms[DOWN] === DOUBLE;
  const hDouble = arms[RIGHT] === DOUBLE || arms[LEFT] === DOUBLE;
  const vt = vDouble ? lw * 3 : lw;
  const ht = hDouble ? lw * 3 : lw;
  const vx0 = centred(x, w, vt);
  const vx1 = vx0 + vt;
  const hy0 = centred(y, h, ht);
  const hy1 = hy0 + ht;

  // Vertical strokes: the low stroke is the left one, and it is the one the
  // left arm opens onto.
  for (const s of axisSpans(
    arms[UP], arms[DOWN], arms[LEFT], arms[RIGHT],
    y, y + h, hy0, hy1, lw, vDouble, hDouble,
  )) {
    const sx = s.low ? vx0 : vx1 - lw;
    ctx.fillRect(vDouble ? sx : vx0, s.start, vDouble ? lw : vt, s.end - s.start);
  }

  // Horizontal strokes: the low stroke is the top one, and the up arm opens
  // onto it.
  for (const s of axisSpans(
    arms[LEFT], arms[RIGHT], arms[UP], arms[DOWN],
    x, x + w, vx0, vx1, lw, hDouble, vDouble,
  )) {
    const sy = s.low ? hy0 : hy1 - lw;
    ctx.fillRect(s.start, hDouble ? sy : hy0, s.end - s.start, hDouble ? lw : ht);
  }
}

interface Span {
  /** True for the stroke at the low edge of the band (left, or top). */
  low: boolean;
  start: number;
  end: number;
}

/**
 * Where the strokes of one axis start and end along that axis.
 *
 * `aLow`/`aHigh` are this axis's own arms (up and down, or left and right),
 * `pLow`/`pHigh` the perpendicular ones taken in the same order, so that the
 * low stroke of this band and the low perpendicular arm are on the same side.
 * `cellLow`/`cellHigh` bound the cell along this axis and `p0`/`p1` the
 * perpendicular band, which is what the strokes terminate against.
 */
function axisSpans(
  aLow: number,
  aHigh: number,
  pLow: number,
  pHigh: number,
  cellLow: number,
  cellHigh: number,
  p0: number,
  p1: number,
  lw: number,
  isDouble: boolean,
  pIsDouble: boolean,
): Span[] {
  if (aLow === NONE && aHigh === NONE) return [];
  const through = aLow !== NONE && aHigh !== NONE;
  const perpBoth = pLow !== NONE && pHigh !== NONE;

  // Where a stroke stops when its own arm on that side is missing. `low` says
  // which of the pair is being placed, `toLow` which way the stroke is running.
  const stop = (low: boolean, toLow: boolean): number => {
    // A single perpendicular line is spanned, not stopped at: the stroke runs
    // right through it and the two merge.
    if (!pIsDouble) return toLow ? p0 : p1;
    if (!isDouble) {
      // A single stroke abuts a double pair at a tee and caps it at a corner.
      if (perpBoth) return toLow ? p1 : p0;
      return toLow ? p0 : p1;
    }
    // Tee: pass the near line of the pair and stop under the far one.
    if (perpBoth) return toLow ? p0 + lw : p1 - lw;
    // Corner. The outer stroke is the one away from the arm that is present,
    // and it turns into the other pair's outer line; the inner into the inner.
    const outer = pHigh !== NONE ? low : !low;
    if (outer) return toLow ? p0 : p1;
    return toLow ? p1 - lw : p0 + lw;
  };

  const spans: Span[] = [];
  for (const low of isDouble ? [true, false] : [true]) {
    const start = aLow !== NONE ? cellLow : stop(low, true);
    const end = aHigh !== NONE ? cellHigh : stop(low, false);
    // A through stroke is broken where the perpendicular arm opens onto it, and
    // only when both axes are double: a single line crossing a double pair is
    // not interrupted by it, and neither is a single pair crossed by a double.
    const broken =
      through &&
      isDouble &&
      pIsDouble &&
      (low ? pLow !== NONE && pHigh === NONE : pHigh !== NONE && pLow === NONE);
    if (!broken) {
      spans.push({ low, start, end });
      continue;
    }
    spans.push({ low, start, end: p0 + lw });
    spans.push({ low, start: p1 - lw, end });
  }
  return spans;
}

// --- dashes, arcs, diagonals -----------------------------------------------

/**
 * `count` dashes evenly spaced along the cell. The gaps are inset from the cell
 * edges rather than centred on them, so a run of dashed cells keeps an even
 * rhythm across the boundaries instead of doubling up a gap at every join.
 */
function drawDashed(
  ctx: BoxContext,
  count: number,
  weight: number,
  vertical: boolean,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const t = weightWidth(weight, h);
  const len = vertical ? h : w;
  const gap = Math.max(1, Math.round(len / (count * 4)));
  const step = (len + gap) / count;
  const dash = step - gap;
  for (let i = 0; i < count; i++) {
    const a = Math.round(i * step);
    const b = Math.min(len, Math.round(i * step + dash));
    if (b <= a) continue;
    if (vertical) ctx.fillRect(centred(x, w, t), y + a, t, b - a);
    else ctx.fillRect(x + a, centred(y, h, t), b - a, t);
  }
}

/**
 * One of the four light arcs. Stroked rather than filled, because a quarter
 * circle is the one shape in the range that rectangles cannot express, and the
 * path is anchored on the same centre line the straight arms use so an arc and
 * a line meet on the cell boundary.
 */
function drawArc(
  ctx: BoxContext,
  cp: number,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const lw = lightWidth(h);
  const cx = centred(x, w, lw) + lw / 2;
  const cy = centred(y, h, lw) + lw / 2;
  const r = Math.min(w, h) / 2;
  // Which cell edges the arc reaches: down-and-right joins the right edge to
  // the bottom edge, and so on round.
  const toRight = cp === 0x256d || cp === 0x2570;
  const toDown = cp === 0x256d || cp === 0x256e;
  const ex = toRight ? x + w : x;
  const ey = toDown ? y + h : y;

  ctx.strokeStyle = ctx.fillStyle;
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.moveTo(ex, cy);
  ctx.arcTo(cx, cy, cx, ey, r);
  ctx.lineTo(cx, ey);
  ctx.stroke();
}

/** The two diagonals and their cross. */
function drawDiagonal(
  ctx: BoxContext,
  cp: number,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const lw = lightWidth(h);
  ctx.strokeStyle = ctx.fillStyle;
  ctx.lineWidth = lw;
  ctx.beginPath();
  if (cp !== 0x2571) {
    ctx.moveTo(x, y);
    ctx.lineTo(x + w, y + h);
  }
  if (cp !== 0x2572) {
    ctx.moveTo(x, y + h);
    ctx.lineTo(x + w, y);
  }
  ctx.stroke();
}

// --- blocks, U+2580..U+259F ------------------------------------------------

/**
 * The block elements. Every split is `round(extent * n / 8)` measured from the
 * same edge on both sides of a boundary, so a lower half and the upper half
 * under it name the same pixel and the two abut with nothing between them.
 */
function drawBlock(
  ctx: BoxContext,
  cp: number,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  // Eighths growing up from the bottom, U+2581..U+2588.
  if (cp >= 0x2581 && cp <= 0x2588) {
    const top = y + eighths(h, 8 - (cp - 0x2580));
    ctx.fillRect(x, top, w, y + h - top);
    return;
  }
  // Eighths growing right from the left edge, U+2589..U+258F, then U+2588 again
  // as the eight-eighths case above.
  if (cp >= 0x2589 && cp <= 0x258f) {
    ctx.fillRect(x, y, eighths(w, 0x2590 - cp), h);
    return;
  }
  switch (cp) {
    case 0x2580: // upper half
      ctx.fillRect(x, y, w, eighths(h, 4));
      return;
    case 0x2590: // right half
      ctx.fillRect(x + eighths(w, 4), y, w - eighths(w, 4), h);
      return;
    case 0x2591: // light shade
      shade(ctx, x, y, w, h, 1);
      return;
    case 0x2592: // medium shade
      shade(ctx, x, y, w, h, 2);
      return;
    case 0x2593: // dark shade
      shade(ctx, x, y, w, h, 3);
      return;
    case 0x2594: // upper one eighth
      ctx.fillRect(x, y, w, eighths(h, 1));
      return;
    case 0x2595: // right one eighth
      ctx.fillRect(x + eighths(w, 7), y, w - eighths(w, 7), h);
      return;
    default:
      break;
  }
  // Quadrants, U+2596..U+259F. The low four bits of the table entry are the
  // four quadrants in the order upper-left, upper-right, lower-left,
  // lower-right.
  const q = QUADRANTS[cp - 0x2596];
  const mx = eighths(w, 4);
  const my = eighths(h, 4);
  if (q & 8) ctx.fillRect(x, y, mx, my);
  if (q & 4) ctx.fillRect(x + mx, y, w - mx, my);
  if (q & 2) ctx.fillRect(x, y + my, mx, h - my);
  if (q & 1) ctx.fillRect(x + mx, y + my, w - mx, h - my);
}

// U+2596..U+259F, as upper-left, upper-right, lower-left, lower-right bits.
const QUADRANTS = [
  0b0010, // 2596 lower left
  0b0001, // 2597 lower right
  0b1000, // 2598 upper left
  0b1011, // 2599 upper left and lower left and lower right
  0b1001, // 259A upper left and lower right
  0b1110, // 259B upper left and upper right and lower left
  0b1101, // 259C upper left and upper right and lower right
  0b0100, // 259D upper right
  0b0110, // 259E upper right and lower left
  0b0111, // 259F upper right and lower left and lower right
];

/** `n` eighths of `extent`, rounded the same way from either side. */
function eighths(extent: number, n: number): number {
  return Math.round((extent * n) / 8);
}

/**
 * The three shades, as an ordered dither on a two by two lattice: a quarter of
 * the pixels for light, half for medium, three quarters for dark. Dithered
 * rather than drawn at a fractional alpha because a terminal stacks these
 * against solid blocks, and a flat 25% grey next to a dithered one from some
 * other renderer is the more visible mismatch of the two.
 *
 * The lattice is anchored on the cell origin, which is what keeps the two
 * backends drawing the same pixels.
 */
function shade(
  ctx: BoxContext,
  x: number,
  y: number,
  w: number,
  h: number,
  level: number,
): void {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const on =
        level === 1
          ? (dx & 1) === 0 && (dy & 1) === 0
          : level === 2
            ? ((dx ^ dy) & 1) === 0
            : !((dx & 1) === 1 && (dy & 1) === 1);
      if (on) ctx.fillRect(x + dx, y + dy, 1, 1);
    }
  }
}
