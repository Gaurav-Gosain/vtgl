// Box-drawing and block-element sprites.
//
// The sprites are pure geometry over a cell rectangle, so the tiling claim can
// be checked here without a GPU or a browser: draw the characters into a
// coverage grid through a recording context and ask whether the pixels a
// pattern is meant to fill are filled. The browser suite then re-checks the
// same properties on real framebuffers from both backends, which is what
// catches a difference between the geometry and what a backend does with it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  drawBoxGlyph,
  isBoxDrawing,
  isBoxDrawingGrapheme,
} from '../src/renderer/box-drawing.ts';
import type { BoxContext } from '../src/renderer/box-drawing.ts';

/** A context that records coverage into a grid instead of drawing anything. */
class Grid implements BoxContext {
  fillStyle: string = '#fff';
  strokeStyle: string = '#fff';
  lineWidth = 1;
  readonly cells: Uint8Array;
  readonly width: number;
  readonly height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.cells = new Uint8Array(width * height);
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    for (let yy = Math.round(y); yy < Math.round(y + h); yy++) {
      if (yy < 0 || yy >= this.height) continue;
      for (let xx = Math.round(x); xx < Math.round(x + w); xx++) {
        if (xx < 0 || xx >= this.width) continue;
        this.cells[yy * this.width + xx] = 1;
      }
    }
  }

  // Stroked paths (arcs and diagonals) are not modelled: a coverage grid cannot
  // rasterize a curve, and the browser suite checks those on real pixels.
  beginPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  arcTo(): void {}
  stroke(): void {}

  covered(x: number, y: number): boolean {
    return this.cells[y * this.width + x] === 1;
  }

  /** Covered pixels in a rectangle. */
  count(x0: number, y0: number, x1: number, y1: number): number {
    let n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (this.covered(x, y)) n++;
    return n;
  }
}

/**
 * `n` eighths of `extent`, the same expression the sprites split on. The tests
 * have to round the way the drawing does, or they assert a boundary that was
 * never claimed rather than a seam.
 */
function eighths(extent: number, n: number): number {
  return Math.round((extent * n) / 8);
}

/** Cell geometries to check every claim against, including odd extents. */
const GEOMETRIES: Array<[number, number]> = [
  [7, 15],
  [8, 17],
  [9, 23],
  [10, 28],
  [13, 34],
  [17, 46],
  [20, 55],
];

/** Draw one character per cell of a cols x rows grid and hand back the coverage. */
function tile(chars: string[], cols: number, rows: number, w: number, h: number): Grid {
  const g = new Grid(cols * w, rows * h);
  for (let r = 0; r < rows; r++) {
    const line = [...chars[r % chars.length]];
    for (let c = 0; c < cols; c++) {
      const cp = line[c % line.length].codePointAt(0)!;
      assert.ok(drawBoxGlyph(g, cp, c * w, r * h, w, h), 'no sprite for U+' + cp.toString(16));
    }
  }
  return g;
}

test('the whole box-drawing and block range is claimed by the sprite path', () => {
  for (let cp = 0x2500; cp <= 0x259f; cp++) {
    assert.ok(isBoxDrawing(cp), 'U+' + cp.toString(16) + ' is not claimed');
    const g = new Grid(20, 55);
    assert.ok(drawBoxGlyph(g, cp, 0, 0, 20, 55), 'U+' + cp.toString(16) + ' drew nothing');
  }
  assert.equal(isBoxDrawing(0x24ff), false);
  assert.equal(isBoxDrawing(0x25a0), false);
});

test('only a lone box codepoint takes the sprite path', () => {
  assert.equal(isBoxDrawingGrapheme('█'), true);
  // A base with a combining mark is not the block character any more, and
  // sending it through the sprite path would silently drop the mark.
  assert.equal(isBoxDrawingGrapheme('█́'), false);
  assert.equal(isBoxDrawingGrapheme('a'), false);
  assert.equal(isBoxDrawingGrapheme(''), false);
});

test('stacked full blocks leave no gap anywhere', () => {
  for (const [w, h] of GEOMETRIES) {
    const g = tile(['█'], 4, 4, w, h);
    assert.equal(
      g.count(0, 0, g.width, g.height),
      g.width * g.height,
      `U+2588 left a gap at ${w}x${h}`,
    );
  }
});

test('complementary halves meet exactly on the cell boundary', () => {
  for (const [w, h] of GEOMETRIES) {
    // Lower half over upper half: a solid band across every odd row boundary.
    const v = tile(['▄', '▀'], 4, 4, w, h);
    for (let k = 1; k < 4; k += 2) {
      const y0 = (k - 1) * h + eighths(h, 4);
      const y1 = k * h + eighths(h, 4);
      assert.equal(
        v.count(0, y0, v.width, y1),
        v.width * (y1 - y0),
        `halves left a seam at row boundary ${k}, ${w}x${h}`,
      );
    }
    // Right half beside left half, for the other axis.
    const hz = tile(['▐▌'], 4, 4, w, h);
    for (let k = 1; k < 4; k += 2) {
      const x0 = (k - 1) * w + eighths(w, 4);
      const x1 = k * w + eighths(w, 4);
      assert.equal(
        hz.count(x0, 0, x1, hz.height),
        hz.height * (x1 - x0),
        `halves left a seam at column boundary ${k}, ${w}x${h}`,
      );
    }
  }
});

test('the eighths partition the cell with no overlap and no gap', () => {
  for (const [w, h] of GEOMETRIES) {
    for (let n = 1; n <= 8; n++) {
      // Lower n eighths plus upper (8-n) eighths is the whole cell, and the
      // only upper piece the range has is the one eighth, so this is checked
      // as "the lower piece starts exactly where the upper one would end".
      const lower = new Grid(w, h);
      drawBoxGlyph(lower, 0x2580 + n, 0, 0, w, h);
      const expected = h - Math.round((h * (8 - n)) / 8);
      assert.equal(
        lower.count(0, 0, w, h),
        w * expected,
        `U+${(0x2580 + n).toString(16)} covered the wrong area at ${w}x${h}`,
      );
      // Full width on every covered row, so a run of them is one unbroken bar.
      for (let y = h - expected; y < h; y++) {
        assert.equal(lower.count(0, y, w, y + 1), w, 'eighth row not full width');
      }
    }
  }
});

test('lower one eighth and upper one eighth tile across the boundary', () => {
  for (const [w, h] of GEOMETRIES) {
    const g = tile(['▁', '▔'], 4, 4, w, h);
    for (let k = 1; k < 4; k += 2) {
      const y0 = (k - 1) * h + eighths(h, 7);
      const y1 = k * h + eighths(h, 1);
      assert.equal(
        g.count(0, y0, g.width, y1),
        g.width * (y1 - y0),
        `eighths left a seam at row boundary ${k}, ${w}x${h}`,
      );
    }
  }
});

test('four quadrants fill the cell they meet in', () => {
  for (const [w, h] of GEOMETRIES) {
    const g = tile(['▗▖', '▝▘'], 4, 4, w, h);
    const x0 = eighths(w, 4);
    const x1 = w + eighths(w, 4);
    const y0 = eighths(h, 4);
    const y1 = h + eighths(h, 4);
    assert.equal(
      g.count(x0, y0, x1, y1),
      (x1 - x0) * (y1 - y0),
      `quadrants left a hole at the corner, ${w}x${h}`,
    );
  }
});

test('the quadrant splits agree with the half splits', () => {
  // A left half and the two left quadrants have to cover the same pixels, or a
  // screen mixing the two families shows a step where they meet.
  for (const [w, h] of GEOMETRIES) {
    const half = new Grid(w, h);
    drawBoxGlyph(half, 0x258c, 0, 0, w, h);
    const quads = new Grid(w, h);
    drawBoxGlyph(quads, 0x2598, 0, 0, w, h); // upper left
    drawBoxGlyph(quads, 0x2596, 0, 0, w, h); // lower left
    assert.deepEqual(Array.from(quads.cells), Array.from(half.cells), `at ${w}x${h}`);
  }
});

test('stacked rules stay unbroken', () => {
  for (const [w, h] of GEOMETRIES) {
    for (const ch of ['│', '┃', '║']) {
      const g = tile([ch], 3, 4, w, h);
      for (let y = 0; y < g.height; y++) {
        assert.ok(g.count(0, y, g.width, y + 1) > 0, `${ch} broke at row ${y}, ${w}x${h}`);
      }
    }
    for (const ch of ['─', '━', '═']) {
      const g = tile([ch], 4, 3, w, h);
      for (let x = 0; x < g.width; x++) {
        assert.ok(g.count(x, 0, x + 1, g.height) > 0, `${ch} broke at column ${x}, ${w}x${h}`);
      }
    }
  }
});

test('a light cross joins all four of its arms', () => {
  for (const [w, h] of GEOMETRIES) {
    const g = new Grid(w, h);
    drawBoxGlyph(g, 0x253c, 0, 0, w, h);
    // Ink on every edge, and a connected path through the middle: sampled as
    // "every row of the vertical arm and every column of the horizontal one".
    for (let y = 0; y < h; y++) {
      assert.ok(g.count(0, y, w, y + 1) > 0, `U+253C has no ink on row ${y}, ${w}x${h}`);
    }
    for (let x = 0; x < w; x++) {
      assert.ok(g.count(x, 0, x + 1, h) > 0, `U+253C has no ink in column ${x}, ${w}x${h}`);
    }
  }
});

test('the shades cover a quarter, a half and three quarters', () => {
  for (const [w, h] of GEOMETRIES) {
    for (const [cp, nominal] of [
      [0x2591, 0.25],
      [0x2592, 0.5],
      [0x2593, 0.75],
    ] as const) {
      const g = new Grid(w, h);
      drawBoxGlyph(g, cp, 0, 0, w, h);
      const fraction = g.count(0, 0, w, h) / (w * h);
      assert.ok(
        Math.abs(fraction - nominal) < 0.06,
        `U+${cp.toString(16)} covered ${fraction.toFixed(3)} at ${w}x${h}`,
      );
    }
  }
});

test('a double crossing leaves its middle open', () => {
  // U+256C is the one junction whose correctness is visible as an absence: the
  // square between the four lines has to stay clear or it reads as a blot.
  for (const [w, h] of GEOMETRIES) {
    const g = new Grid(w, h);
    drawBoxGlyph(g, 0x256c, 0, 0, w, h);
    assert.ok(
      !g.covered(Math.floor(w / 2), Math.floor(h / 2)),
      `U+256C filled its middle at ${w}x${h}`,
    );
    // All four edges still carry both lines of their pair.
    assert.ok(g.count(0, 0, 1, h) > 0, 'no ink on the left edge');
    assert.ok(g.count(w - 1, 0, w, h) > 0, 'no ink on the right edge');
    assert.ok(g.count(0, 0, w, 1) > 0, 'no ink on the top edge');
    assert.ok(g.count(0, h - 1, w, h) > 0, 'no ink on the bottom edge');
  }
});
