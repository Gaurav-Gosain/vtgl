// The scheduler exists so that N state changes inside one frame produce one
// render rather than N synchronous renders on the callback that delivered
// them. These tests pin that contract, including the cases that make a naive
// debouncer drop the last update.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RenderScheduler } from '../src/renderer/scheduler.ts';

/** A hand-driven frame clock. */
function fakeClock() {
  const queued: Array<{ id: number; cb: (t: number) => void }> = [];
  let next = 1;
  return {
    raf: (cb: (t: number) => void) => {
      const id = next++;
      queued.push({ id, cb });
      return id;
    },
    cancel: (id: number) => {
      const i = queued.findIndex((q) => q.id === id);
      if (i >= 0) queued.splice(i, 1);
    },
    /** Run every callback booked so far. */
    tick() {
      const batch = queued.splice(0, queued.length);
      for (const q of batch) q.cb(0);
    },
    get depth() {
      return queued.length;
    },
  };
}

function setup(onRender?: () => void) {
  const clock = fakeClock();
  let renders = 0;
  const s = new RenderScheduler(
    () => {
      renders++;
      onRender?.();
    },
    { requestAnimationFrame: clock.raf, cancelAnimationFrame: clock.cancel },
  );
  return { clock, s, count: () => renders };
}

test('many changes in one frame produce exactly one render', () => {
  const { clock, s, count } = setup();
  for (let i = 0; i < 50; i++) s.schedule();
  assert.equal(count(), 0, 'nothing renders synchronously on schedule()');
  clock.tick();
  assert.equal(count(), 1);
  assert.equal(s.coalesced, 49);
});

test('nothing renders until a frame arrives', () => {
  const { clock, s, count } = setup();
  s.schedule();
  assert.equal(count(), 0);
  clock.tick();
  assert.equal(count(), 1);
});

test('a later change books a new frame', () => {
  const { clock, s, count } = setup();
  s.schedule();
  clock.tick();
  assert.equal(count(), 1);
  s.schedule();
  clock.tick();
  assert.equal(count(), 2);
});

test('an idle scheduler does not render', () => {
  const { clock, count } = setup();
  clock.tick();
  clock.tick();
  assert.equal(count(), 0);
});

test('a change made during a render still lands, on the next frame', () => {
  let armed = true;
  const holder: { s?: RenderScheduler } = {};
  const { clock, s: scheduler, count } = setup(() => {
    if (armed) {
      armed = false;
      holder.s!.schedule();
    }
  });
  holder.s = scheduler;

  scheduler.schedule();
  clock.tick();
  assert.equal(count(), 1, 'the re-entrant request must not recurse');
  clock.tick();
  assert.equal(count(), 2, 'and must not be dropped either');
  clock.tick();
  assert.equal(count(), 2, 'and must not repeat forever');
});

test('flush renders immediately and consumes the booked frame', () => {
  const { clock, s, count } = setup();
  s.schedule();
  s.flush();
  assert.equal(count(), 1);
  clock.tick();
  assert.equal(count(), 1, 'the cancelled frame must not fire a second render');
});

test('flush with nothing booked is a no-op', () => {
  const { clock, s, count } = setup();
  s.flush();
  assert.equal(count(), 0);
  clock.tick();
  assert.equal(count(), 0);
});

test('dispose cancels the booked frame', () => {
  const { clock, s, count } = setup();
  s.schedule();
  s.dispose();
  clock.tick();
  assert.equal(count(), 0);
});

test('dispose is idempotent and schedule after dispose does nothing', () => {
  const { clock, s, count } = setup();
  s.dispose();
  s.dispose();
  s.schedule();
  clock.tick();
  assert.equal(count(), 0);
  assert.equal(s.scheduled, false);
});

test('only one frame is ever booked at a time', () => {
  const { clock, s } = setup();
  for (let i = 0; i < 10; i++) s.schedule();
  assert.equal(clock.depth, 1);
});
