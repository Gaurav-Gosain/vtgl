import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AtlasPacker } from '../src/atlas/packer.ts';

test('first alloc is new, repeat alloc hits the same entry', () => {
  const p = new AtlasPacker(256, 2);
  const a = p.alloc('A0', 16, 32, false);
  const b = p.alloc('A0', 16, 32, false);
  assert.ok(a && b);
  assert.equal(a!.isNew, true);
  assert.equal(b!.isNew, false);
  assert.equal(a!.entry, b!.entry, 'same entry object');
  assert.equal(p.stats().entries, 1);
});

test('distinct keys get distinct slots', () => {
  const p = new AtlasPacker(256, 2);
  const a = p.alloc('A0', 16, 32, false)!;
  const b = p.alloc('A1', 16, 32, false)!; // same grapheme, bold style mask
  assert.notEqual(a.entry.x === b.entry.x && a.entry.y === b.entry.y, true);
  assert.equal(p.stats().entries, 2);
});

test('colored flag round-trips on the entry', () => {
  const p = new AtlasPacker(256, 2);
  const e = p.alloc('emoji', 32, 32, true)!;
  assert.equal(e.entry.colored, true);
  assert.equal(p.get('emoji')!.colored, true);
});

test('grows onto a second page before evicting', () => {
  const p = new AtlasPacker(64, 2);
  // 4 slots fit per 64x64 page at 30x30 (31px padded shelves).
  for (let i = 0; i < 4; i++) assert.ok(p.alloc('k' + i, 30, 30, false));
  assert.equal(p.stats().pages, 1);
  assert.ok(p.alloc('k4', 30, 30, false));
  assert.equal(p.stats().pages, 2, 'a second page was added, not a flush');
  assert.equal(p.stats().flushes, 0);
});

test('flushes and bumps the generation when every page is full', () => {
  const p = new AtlasPacker(64, 2);
  const gen0 = p.currentGeneration;
  for (let i = 0; i < 8; i++) assert.ok(p.alloc('k' + i, 30, 30, false));
  assert.equal(p.stats().flushes, 0);
  assert.equal(p.stats().pages, 2);

  const overflow = p.alloc('k8', 30, 30, false);
  assert.ok(overflow, 'the overflowing glyph is still placed after the flush');
  const s = p.stats();
  assert.equal(s.flushes, 1);
  assert.ok(p.currentGeneration > gen0, 'generation bumped so callers re-raster');
  assert.equal(s.entries, 1, 'only the re-placed glyph survives a flush');
});

test('entries used in the current frame are not counted as evictions', () => {
  const p = new AtlasPacker(64, 2);
  p.beginFrame();
  for (let i = 0; i < 8; i++) p.alloc('k' + i, 30, 30, false);
  // All 8 were touched this frame, so the flush evicts no stale entries.
  p.alloc('k8', 30, 30, false);
  assert.equal(p.stats().evictions, 0);
  assert.equal(p.stats().flushes, 1);
});

test('stale entries from an earlier frame count as evictions', () => {
  const p = new AtlasPacker(64, 2);
  p.beginFrame();
  for (let i = 0; i < 8; i++) p.alloc('k' + i, 30, 30, false);
  p.beginFrame(); // new frame: the 8 entries are now stale
  p.alloc('fresh', 30, 30, false);
  assert.equal(p.stats().evictions, 8);
  assert.equal(p.stats().flushes, 1);
});

test('lastFrame advances on a hit so the LRU clock tracks use', () => {
  const p = new AtlasPacker(256, 1);
  p.beginFrame();
  const e = p.alloc('A0', 16, 32, false)!.entry;
  const f1 = e.lastFrame;
  p.beginFrame();
  p.alloc('A0', 16, 32, false);
  assert.ok(e.lastFrame > f1, 're-request refreshes the entry');
});

test('a glyph larger than a page is rejected rather than looping', () => {
  const p = new AtlasPacker(32, 2);
  assert.equal(p.alloc('huge', 64, 64, false), null);
});
