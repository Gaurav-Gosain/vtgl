// Seam tests for the box-drawing and block-element ranges.
//
// These characters are the only ones a terminal is expected to TILE: a column
// of U+2588 has to read as one unbroken bar, a row of U+2500 as one unbroken
// rule, and a lower half block sitting under an upper half block as a solid
// band across the cell boundary. A font glyph cannot promise that. It is
// rastered into a cell-sized box at whatever size and position the face asks
// for, and the rounding and antialiasing at its edges leave a hairline of
// background between two stacked cells.
//
// Every case here fills a grid with one repeating pattern, reads back which
// pixels carry the full foreground colour, and asserts that a rectangle the
// pattern is supposed to fill solid really is solid. The rectangles are chosen
// to straddle cell boundaries, so a failure is reported as a seam width in
// device pixels at a named boundary rather than as a pixel-diff percentage.

import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const HARNESS_URL = pathToFileURL(resolve('test-browser/index.html')).href;

interface SeamProfile {
  cellW: number;
  cellH: number;
  width: number;
  height: number;
  mask: string[];
}

/** A rectangle that a pattern must fill solid, in cells; ends are exclusive. */
interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface TilingCase {
  name: string;
  /** One string per cell row, each repeated across the row's columns. */
  grid: string[];
  cols: number;
  rows: number;
  /** Rectangles the pattern fills solid, in cell units. */
  solid(cols: number, rows: number): Rect[];
}

// Geometry to sweep. The dprs include a fractional one, and the font sizes are
// picked so the measured cell lands on a different pixel count each time.
const DPRS = [1, 1.25, 1.5, 2];
const FONT_SIZES = [11, 14, 17];

const TILING: TilingCase[] = [
  {
    // The case the bug was reported on: a solid region of full blocks.
    name: 'full block U+2588',
    grid: ['█'],
    cols: 6,
    rows: 6,
    solid: (cols, rows) => [{ x0: 0, y0: 0, x1: cols, y1: rows }],
  },
  {
    // Lower half over upper half: a solid band centred on every odd row
    // boundary, which isolates the horizontal boundary from everything else.
    name: 'half blocks U+2584 over U+2580',
    grid: ['▄', '▀'],
    cols: 6,
    rows: 6,
    solid: (cols, rows) => bands(rows, (k) => ({ x0: 0, y0: k - 0.5, x1: cols, y1: k + 0.5 })),
  },
  {
    // Right half beside left half: the same isolation for the vertical
    // boundary.
    name: 'half blocks U+2590 beside U+258C',
    grid: ['▐▌'],
    cols: 6,
    rows: 6,
    solid: (cols, rows) => bands(cols, (k) => ({ x0: k - 0.5, y0: 0, x1: k + 0.5, y1: rows })),
  },
  {
    // Lower one eighth under upper one eighth. The thinnest tiling pair the
    // block range has, and the one where a raster rounding error is most
    // likely to erase the join outright.
    name: 'eighth blocks U+2581 under U+2594',
    grid: ['▁', '▔'],
    cols: 6,
    rows: 6,
    solid: (cols, rows) => bands(rows, (k) => ({ x0: 0, y0: k - 0.1, x1: cols, y1: k + 0.1 })),
  },
  {
    // Lower seven eighths, every row. Nothing tiles vertically here (the top
    // eighth is empty by definition), so what this asserts is edge contact:
    // the filled part reaches the left and right edges of its own cell, which
    // is what makes a run of them one unbroken bar across the vertical
    // boundaries.
    name: 'seven eighths U+2587 across the vertical boundaries',
    grid: ['▇'],
    cols: 6,
    rows: 4,
    solid: (cols, rows) =>
      Array.from({ length: rows }, (_, r) => ({ x0: 0, y0: r + 0.16, x1: cols, y1: r + 1 })),
  },
  {
    // The same for the left seven eighths across the horizontal boundaries.
    name: 'left seven eighths U+2589 across the horizontal boundaries',
    grid: ['▉'],
    cols: 4,
    rows: 6,
    solid: (cols, rows) =>
      Array.from({ length: cols }, (_, c) => ({ x0: c, y0: 0, x1: c + 0.84, y1: rows })),
  },
  {
    // Four quadrants meeting at a cell corner. This is the only pattern that
    // puts a corner rather than an edge under test, and it fails if either
    // axis is off.
    name: 'quadrants meeting at a corner',
    grid: ['▗▖', '▝▘'],
    cols: 6,
    rows: 6,
    solid: (cols, rows) => {
      const out: Rect[] = [];
      for (let ky = 1; ky < rows; ky += 2) {
        for (let kx = 1; kx < cols; kx += 2) {
          out.push({ x0: kx - 0.5, y0: ky - 0.5, x1: kx + 0.5, y1: ky + 0.5 });
        }
      }
      return out;
    },
  },
];

/** Bands of half a cell either side of every odd boundary up to `n`. */
function bands(n: number, make: (k: number) => Rect): Rect[] {
  const out: Rect[] = [];
  for (let k = 1; k < n; k += 2) out.push(make(k));
  return out;
}

interface Gap {
  /** 'row' when a horizontal boundary is broken, 'col' for a vertical one. */
  axis: 'row' | 'col';
  /** The cell boundary the gap sits on, or -1 when it is not on a boundary. */
  boundary: number;
  /** Consecutive incomplete pixel rows or columns, device px. */
  width: number;
}

/**
 * Every run of pixel rows and columns inside `rect` that is not fully covered.
 * A seam is such a run sitting on a cell boundary, so the boundary index is
 * recorded with each run and the caller can report the width in device pixels.
 */
function gapsIn(p: SeamProfile, rect: Rect): Gap[] {
  const x0 = Math.round(rect.x0 * p.cellW);
  const x1 = Math.min(p.width, Math.round(rect.x1 * p.cellW));
  const y0 = Math.round(rect.y0 * p.cellH);
  const y1 = Math.min(p.height, Math.round(rect.y1 * p.cellH));

  const rowFull: boolean[] = [];
  for (let y = y0; y < y1; y++) {
    const row = p.mask[y];
    let full = true;
    for (let x = x0; x < x1 && full; x++) if (row[x] !== '1') full = false;
    rowFull.push(full);
  }
  const colFull: boolean[] = [];
  for (let x = x0; x < x1; x++) {
    let full = true;
    for (let y = y0; y < y1 && full; y++) if (p.mask[y][x] !== '1') full = false;
    colFull.push(full);
  }

  const out: Gap[] = [];
  collect(rowFull, y0, p.cellH, 'row', out);
  collect(colFull, x0, p.cellW, 'col', out);
  return out;
}

/** Turn a full/not-full profile into runs, tagged with the boundary they touch. */
function collect(
  full: boolean[],
  origin: number,
  cell: number,
  axis: 'row' | 'col',
  out: Gap[],
): void {
  let run = 0;
  for (let i = 0; i <= full.length; i++) {
    if (i < full.length && !full[i]) {
      run++;
      continue;
    }
    if (run === 0) continue;
    const start = origin + i - run;
    const end = origin + i;
    // The boundary a run touches: the only cell edge inside or adjacent to it.
    let boundary = -1;
    for (let k = Math.floor(start / cell); k <= Math.ceil(end / cell); k++) {
      const edge = Math.round(k * cell);
      if (edge >= start - 1 && edge <= end + 1) boundary = k;
    }
    out.push({ axis, boundary, width: run });
    run = 0;
  }
}

/** The worst seam found across one geometry, as a single number. */
function worstSeam(p: SeamProfile, rects: Rect[]): number {
  let worst = 0;
  for (const r of rects) {
    for (const g of gapsIn(p, r)) if (g.width > worst) worst = g.width;
  }
  return worst;
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
  await page.goto(HARNESS_URL);
  await page.waitForFunction(() => (window as any).harness !== undefined);
});

for (const backend of ['webgl2', 'canvas2d'] as const) {
  test(`box and block characters tile with no seam on ${backend}`, async ({ page }) => {
    test.setTimeout(300_000);
    const report: string[] = [];
    let failures = 0;

    for (const c of TILING) {
      for (const dpr of DPRS) {
        for (const fontSize of FONT_SIZES) {
          const p: SeamProfile = await page.evaluate(
            ([b, grid, cols, rows, d, fs]) =>
              (window as any).harness.seamProbe(b, grid, cols, rows, d, fs),
            [backend, c.grid, c.cols, c.rows, dpr, fontSize] as const,
          );
          const rects = c.solid(c.cols, c.rows);
          const seam = worstSeam(p, rects);
          if (seam > 0) {
            failures++;
            const g = gapsIn(p, rects[0]).find((x) => x.width === seam) ?? gapsIn(p, rects[0])[0];
            report.push(
              `${c.name} dpr ${dpr} font ${fontSize} cell ${p.cellW}x${p.cellH}: ` +
                `${seam}px seam` +
                (g ? ` (${g.axis} boundary ${g.boundary})` : ''),
            );
          }
        }
      }
    }

    expect(failures, 'seams found:\n' + report.join('\n')).toBe(0);
  });
}

test('box drawing lines stay continuous across cells', async ({ page }) => {
  // A stacked vertical rule must leave no pixel row without ink and a repeated
  // horizontal rule no pixel column, which is the line-drawing equivalent of
  // the solid-region tests above.
  const cases = [
    { name: 'light vertical U+2502', ch: '│', axis: 'row' as const },
    { name: 'light horizontal U+2500', ch: '─', axis: 'col' as const },
    { name: 'double vertical U+2551', ch: '║', axis: 'row' as const },
    { name: 'double horizontal U+2550', ch: '═', axis: 'col' as const },
    { name: 'heavy vertical U+2503', ch: '┃', axis: 'row' as const },
    { name: 'heavy horizontal U+2501', ch: '━', axis: 'col' as const },
  ];
  const broken: string[] = [];
  for (const c of cases) {
    for (const dpr of DPRS) {
      const p: SeamProfile = await page.evaluate(
        ([b, grid, cols, rows, d, fs]) =>
          (window as any).harness.seamProbe(b, grid, cols, rows, d, fs),
        [ 'webgl2', [c.ch], 6, 6, dpr, 14 ] as const,
      );
      let empty = 0;
      if (c.axis === 'row') {
        for (let y = 0; y < p.height; y++) if (!p.mask[y].includes('1')) empty++;
      } else {
        for (let x = 0; x < p.width; x++) {
          let any = false;
          for (let y = 0; y < p.height && !any; y++) if (p.mask[y][x] === '1') any = true;
          if (!any) empty++;
        }
      }
      if (empty > 0) {
        broken.push(`${c.name} dpr ${dpr}: ${empty} empty ${c.axis}s of the rule`);
      }
    }
  }
  expect(broken.length, 'broken rules:\n' + broken.join('\n')).toBe(0);
});

test('the arcs close the corners they are drawn for', async ({ page }) => {
  // A rounded box is four arcs, and the only thing that makes it a box rather
  // than four unrelated curves is that each arc reaches the middle of the cell
  // edge it turns towards. Two by two of them is a closed loop, so the check is
  // that ink crosses both interior boundaries.
  const p: SeamProfile = await page.evaluate(
    ([b, grid, cols, rows, d, fs]) =>
      (window as any).harness.seamProbe(b, grid, cols, rows, d, fs),
    ['webgl2', ['╭╮', '╰╯'], 2, 2, 2, 17] as const,
  );
  const cx = Math.round(p.cellW);
  const cy = Math.round(p.cellH);
  // The vertical boundary is crossed by the two horizontal runs of the arcs,
  // and the horizontal boundary by the two vertical runs.
  let acrossVertical = 0;
  for (let y = 0; y < p.height; y++) {
    if (p.mask[y][cx - 1] === '1' && p.mask[y][cx] === '1') acrossVertical++;
  }
  let acrossHorizontal = 0;
  for (let x = 0; x < p.width; x++) {
    if (p.mask[cy - 1][x] === '1' && p.mask[cy][x] === '1') acrossHorizontal++;
  }
  expect(acrossVertical, 'no arc ink crosses the vertical boundary').toBeGreaterThan(0);
  expect(acrossHorizontal, 'no arc ink crosses the horizontal boundary').toBeGreaterThan(0);
});

test('the shades cover close to their nominal fraction', async ({ page }) => {
  // The shades do not tile into a solid region, so the seam question does not
  // arise for them. What can be asserted is that each one covers about the
  // fraction of its cell that its name claims, which a font glyph does not
  // promise either.
  const cases = [
    { name: 'light shade U+2591', ch: '░', nominal: 0.25 },
    { name: 'medium shade U+2592', ch: '▒', nominal: 0.5 },
    { name: 'dark shade U+2593', ch: '▓', nominal: 0.75 },
  ];
  const off: string[] = [];
  for (const c of cases) {
    for (const dpr of DPRS) {
      const p: SeamProfile = await page.evaluate(
        ([b, grid, cols, rows, d, fs]) =>
          (window as any).harness.seamProbe(b, grid, cols, rows, d, fs),
        ['webgl2', [c.ch], 6, 6, dpr, 14] as const,
      );
      let covered = 0;
      for (const row of p.mask) for (const ch of row) if (ch === '1') covered++;
      const fraction = covered / (p.width * p.height);
      if (Math.abs(fraction - c.nominal) > 0.14) {
        off.push(
          `${c.name} dpr ${dpr}: covered ${(fraction * 100).toFixed(1)}% ` +
            `against a nominal ${(c.nominal * 100).toFixed(0)}%`,
        );
      }
    }
  }
  expect(off.length, 'shades off nominal:\n' + off.join('\n')).toBe(0);
});
