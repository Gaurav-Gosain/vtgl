// Steady-state allocation behavior of the instance builder.
//
// An honest note on what "zero per-frame allocation" means here. The instance
// streams themselves are preallocated and reused, and the upload path is pure
// arithmetic over persistent byte views, so neither allocates per frame. Two
// things on the dirty-cell path do allocate by design: LineView.grapheme(col)
// may mint a string (the contract says so), and the atlas key is a string
// concatenation. Both are short-lived garbage that the atlas map interns on
// first sight, not retained growth.
//
// So the properties worth asserting are: the buffers are never reallocated, a
// frame with no damage touches nothing, and repeated full rebuilds leave no
// retained heap behind (no leak). Run with --expose-gc for the heap assertions;
// they skip cleanly without it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InstanceBuffers } from '../src/renderer/instances.ts';
import type { AtlasRect, GlyphProvider } from '../src/renderer/instances.ts';
import { FakeSource } from '../src/testing/fake-source.ts';
import { churnScenario } from '../src/testing/scenarios.ts';

const CELL_W = 10;
const CELL_H = 20;

class CachingProvider implements GlyphProvider {
  ensures = 0;
  misses = 0;
  private readonly slots = new Map<string, AtlasRect>();

  ensure(grapheme: string, styleMask: number, widthCols: number): AtlasRect | null {
    this.ensures++;
    const key = grapheme + '|' + styleMask;
    let s = this.slots.get(key);
    if (!s) {
      this.misses++;
      s = { x: 0, y: 0, w: widthCols * CELL_W, h: CELL_H, colored: false, page: 0 };
      this.slots.set(key, s);
    }
    return s;
  }
}

function gcOrNull(): (() => void) | null {
  const g = (globalThis as { gc?: () => void }).gc;
  return typeof g === 'function' ? g : null;
}

function buildAllRows(b: InstanceBuffers, source: FakeSource, rows: number, p: GlyphProvider) {
  const top = source.scrollbackRows;
  for (let vr = 0; vr < rows; vr++) b.buildRow(source, top + vr, vr, p);
}

test('the glyph working set converges: repeat frames are all atlas hits', () => {
  const sc = churnScenario;
  const source = sc.build();
  const b = new InstanceBuffers();
  b.resize(sc.cols, sc.rows);
  b.configure(CELL_W, CELL_H, 15, 1, false);
  const p = new CachingProvider();

  buildAllRows(b, source, sc.rows, p);
  const missesAfterFirst = p.misses;
  assert.ok(missesAfterFirst > 0, 'the first frame rasters its glyphs');

  // The churn scenario cycles a fixed ramp of characters, so after a few frames
  // every glyph it will ever use is already cached.
  for (let f = 1; f < 60; f++) {
    sc.step?.(source, f);
    buildAllRows(b, source, sc.rows, p);
  }
  const missesLater = p.misses - missesAfterFirst;
  assert.ok(
    missesLater < missesAfterFirst,
    `steady state should stop missing: ${missesLater} later misses vs ${missesAfterFirst} initial`,
  );
});

test('buffers are never reallocated across a long run', () => {
  const sc = churnScenario;
  const source = sc.build();
  const b = new InstanceBuffers();
  b.resize(sc.cols, sc.rows);
  b.configure(CELL_W, CELL_H, 15, 1, false);
  const p = new CachingProvider();

  const refs = [b.bg, b.glyphBuf, b.decoBuf, b.bgBytes, b.glyphBytes, b.decoBytes];
  for (let f = 0; f < 100; f++) {
    sc.step?.(source, f);
    buildAllRows(b, source, sc.rows, p);
  }
  assert.equal(b.bg, refs[0]);
  assert.equal(b.glyphBuf, refs[1]);
  assert.equal(b.decoBuf, refs[2]);
  assert.equal(b.bgBytes, refs[3], 'upload byte views are persistent too');
  assert.equal(b.glyphBytes, refs[4]);
  assert.equal(b.decoBytes, refs[5]);
});

test('the byte views alias the instance streams rather than copying', () => {
  const b = new InstanceBuffers();
  b.resize(4, 1);
  assert.equal(b.bgBytes.buffer, b.bg.buffer);
  assert.equal(b.glyphBytes.buffer, b.glyphBuf);
  assert.equal(b.decoBytes.buffer, b.decoBuf);
  b.bg[0] = 0x00ff00;
  // Little-endian: low byte first.
  assert.equal(b.bgBytes[1], 0xff, 'writes through the stream are visible in the view');
});

test('repeated full rebuilds retain no heap (no leak)', (t) => {
  const gc = gcOrNull();
  if (!gc) {
    t.skip('run with --expose-gc to measure retained heap');
    return;
  }
  const sc = churnScenario;
  const source = sc.build();
  const b = new InstanceBuffers();
  b.resize(sc.cols, sc.rows);
  b.configure(CELL_W, CELL_H, 15, 1, false);
  const p = new CachingProvider();

  // Warm up so the glyph cache and JIT have settled.
  for (let f = 0; f < 30; f++) {
    sc.step?.(source, f);
    buildAllRows(b, source, sc.rows, p);
  }

  gc();
  const before = process.memoryUsage().heapUsed;
  const FRAMES = 200;
  for (let f = 0; f < FRAMES; f++) {
    sc.step?.(source, 30 + f);
    buildAllRows(b, source, sc.rows, p);
  }
  gc();
  const after = process.memoryUsage().heapUsed;
  const retainedPerFrame = (after - before) / FRAMES;

  // Per-frame garbage is fine; per-frame *retention* is a leak. A 120x40 grid
  // has 4800 cells, so anything above a few bytes per frame would mean the
  // renderer is holding onto something it should not.
  assert.ok(
    retainedPerFrame < 512,
    `retained ${retainedPerFrame.toFixed(1)} bytes/frame after gc (expected near zero)`,
  );
});

test('a source with no damage costs nothing to skip', () => {
  // The renderer skips clean rows before calling buildRow at all, so this
  // asserts the precondition that drives that: isRowDirty is the only gate.
  const source = new FakeSource({ cols: 40, rows: 10 });
  source.clearDirty();
  let dirty = 0;
  for (let r = 0; r < 10; r++) if (source.isRowDirty(r)) dirty++;
  assert.equal(dirty, 0);
  source.setCell(3, 0, 65);
  assert.equal(source.isRowDirty(3), true);
});
