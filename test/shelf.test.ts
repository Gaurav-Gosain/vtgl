import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ShelfAllocator } from '../src/atlas/shelf.ts';

test('packs slots left to right along a shelf', () => {
  const a = new ShelfAllocator(64, 64);
  const s1 = a.alloc(20, 30);
  const s2 = a.alloc(20, 30);
  assert.ok(s1 && s2);
  assert.equal(s1!.y, s2!.y, 'same shelf');
  assert.ok(s2!.x > s1!.x, 'advances along the shelf');
  assert.equal(s1!.w, 20);
  assert.equal(s1!.h, 30);
});

test('opens a new shelf when the current row is full', () => {
  const a = new ShelfAllocator(64, 128);
  const s1 = a.alloc(30, 30);
  const s2 = a.alloc(30, 30);
  const s3 = a.alloc(30, 30);
  assert.ok(s1 && s2 && s3);
  assert.equal(s1!.y, s2!.y);
  assert.ok(s3!.y > s1!.y, 'third slot lands on a new shelf');
});

test('returns null when the page is exhausted', () => {
  const a = new ShelfAllocator(64, 64);
  // 31px-padded shelves: two shelves of two slots each = 4 slots.
  for (let i = 0; i < 4; i++) assert.ok(a.alloc(30, 30), `slot ${i} fits`);
  assert.equal(a.alloc(30, 30), null, 'fifth slot does not fit');
});

test('rejects slots larger than the page', () => {
  const a = new ShelfAllocator(32, 32);
  assert.equal(a.alloc(64, 8), null);
  assert.equal(a.alloc(8, 64), null);
});

test('reset makes the page empty again', () => {
  const a = new ShelfAllocator(64, 64);
  for (let i = 0; i < 4; i++) a.alloc(30, 30);
  assert.equal(a.alloc(30, 30), null);
  a.reset();
  assert.ok(a.alloc(30, 30), 'allocations succeed after reset');
  assert.ok(a.fill() > 0 && a.fill() <= 1);
});

test('best-fit prefers the shortest shelf that still has room', () => {
  const a = new ShelfAllocator(256, 256);
  const short = a.alloc(10, 10)!; // opens a short shelf at y=0
  const tall = a.alloc(10, 40)!; // too tall for the short shelf: new shelf below
  assert.equal(short.y, 0);
  assert.ok(tall.y > short.y, 'the tall slot opened its own shelf');

  // Both shelves have horizontal room; a small slot must take the short one.
  const small = a.alloc(10, 10)!;
  assert.equal(small.y, short.y, 'small slot reuses the short shelf, not the tall one');
});

test('an existing shelf is reused when it fits rather than opening a new one', () => {
  const a = new ShelfAllocator(256, 256);
  const first = a.alloc(10, 40)!;
  // A short slot fits under the tall shelf, so no new shelf is opened.
  const second = a.alloc(10, 10)!;
  assert.equal(second.y, first.y, 'packs into the existing shelf');
});
