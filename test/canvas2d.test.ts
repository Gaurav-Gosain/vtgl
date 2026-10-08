import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Canvas2DRenderer } from '../src/renderer/canvas2d.ts';
import { makeFakeCanvas } from '../src/testing/fake-canvas.ts';
import { FakeSource } from '../src/testing/fake-source.ts';
import { scenarios } from '../src/testing/scenarios.ts';
import { CellFlags } from '../src/types.ts';
import type { RenderStats } from '../src/types.ts';

const THEME = { foreground: 0xd0d0d0, background: 0x101010, cursor: 0xffffff };

function setup(cols: number, rows: number, scrollbackRows = 0) {
  const canvas = makeFakeCanvas();
  const renderer = new Canvas2DRenderer({ fontFamily: 'monospace', fontSize: 14, dpr: 2, theme: THEME });
  renderer.mount(canvas as unknown as HTMLCanvasElement);
  renderer.resize(cols, rows, 2);
  const source = new FakeSource({ cols, rows, scrollbackRows, fg: THEME.foreground, bg: THEME.background });
  source.setCursor({ visible: false });
  return { canvas, renderer, source };
}

test('renders visible glyphs and reports full frame on first paint', () => {
  const { canvas, renderer, source } = setup(10, 2);
  source.writeText(0, 0, 'hello');
  let stats: RenderStats | undefined;
  renderer.on('render', (s) => (stats = s));
  renderer.render(source, 0);
  assert.ok(stats);
  assert.equal(stats!.full, true);
  assert.equal(canvas.context.texts().join(''), 'hello');
});

test('every golden scenario renders on the recording canvas', () => {
  // `npm run bench` drives these scenarios through this same canvas. The
  // box-drawing arcs in `blocks` stroke a path, so the recording canvas has to
  // take path calls as well as fills.
  for (const sc of scenarios) {
    const source = sc.build();
    const canvas = makeFakeCanvas();
    const renderer = new Canvas2DRenderer({ fontFamily: 'monospace', fontSize: 14, dpr: 2, theme: THEME });
    renderer.mount(canvas as unknown as HTMLCanvasElement);
    renderer.resize(sc.cols, sc.rows, 2);
    for (let f = 0; f < 3; f++) {
      sc.step?.(source, f);
      assert.doesNotThrow(() => renderer.render(source, source.scrollbackRows), `${sc.name} frame ${f}`);
      source.clearDirty();
    }
    assert.ok(canvas.context.ops.length > 0, `${sc.name} drew something`);
  }
});

test('blank cells with default background draw no glyph and no fill', () => {
  const { canvas, renderer, source } = setup(10, 1);
  source.clearRegion(0, 1); // all spaces, default bg
  renderer.render(source, 0);
  assert.equal(canvas.context.count('fillText'), 0, 'no glyphs for blanks');
});

test('incremental render only repaints dirty rows', () => {
  const { canvas, renderer, source } = setup(6, 3);
  source.writeText(0, 0, 'A');
  source.writeText(1, 0, 'B');
  source.writeText(2, 0, 'C');
  renderer.render(source, 0); // full paint
  source.clearDirty();

  canvas.context.reset();
  source.setCell(1, 0, 'X'.codePointAt(0)!); // dirties row 1 only
  renderer.render(source, 0);

  const texts = canvas.context.texts();
  assert.deepEqual(texts, ['X'], 'only the dirty row is redrawn');
  let stats: RenderStats | undefined;
  renderer.on('render', (s) => (stats = s));
  source.clearDirty();
  source.setCell(1, 0, 'Y'.codePointAt(0)!);
  canvas.context.reset();
  renderer.render(source, 0);
  assert.equal(stats!.dirtyRows, 1);
});

test('wide char draws one glyph and the spacer tail draws none', () => {
  const { canvas, renderer, source } = setup(8, 1);
  source.writeText(0, 0, '世界'); // two wide chars -> cols 0..3
  renderer.render(source, 0);
  const texts = canvas.context.texts();
  assert.deepEqual(texts, ['世', '界'], 'one glyph per wide head, tails skipped');
});

test('non-default background fills even when the cell is blank', () => {
  const { canvas, renderer, source } = setup(4, 1);
  source.clearRegion(0, 1);
  source.setCell(0, 2, 32, { bg: 0x223344 }); // blank but colored bg
  renderer.render(source, 0);
  const colored = canvas.context.ops.filter((o) => o.op === 'fillRect' && o.fillStyle === '#223344');
  assert.equal(colored.length, 1, 'colored blank still fills its background');
});

test('resize forces a full redraw on the next frame', () => {
  const { canvas, renderer, source } = setup(5, 2);
  source.writeText(0, 0, 'ab');
  renderer.render(source, 0);
  source.clearDirty();
  renderer.resize(5, 2, 2);
  let stats: RenderStats | undefined;
  renderer.on('render', (s) => (stats = s));
  canvas.context.reset();
  renderer.render(source, 0);
  assert.equal(stats!.full, true, 'resize forces a full frame regardless of dirty');
});

test('setTheme forces a full redraw', () => {
  const { renderer, source } = setup(5, 2);
  renderer.render(source, 0);
  source.clearDirty();
  renderer.setTheme({ ...THEME, background: 0x000000 });
  let stats: RenderStats | undefined;
  renderer.on('render', (s) => (stats = s));
  renderer.render(source, 0);
  assert.equal(stats!.full, true);
});

test('cursorMove fires when the cursor position changes', () => {
  const { renderer, source } = setup(8, 3);
  source.setCursor({ visible: true, x: 1, y: 0, shape: 'block' });
  const moves: Array<{ col: number; row: number }> = [];
  renderer.on('cursorMove', (c) => moves.push(c));
  renderer.render(source, 0);
  source.setCursor({ x: 3, y: 1 });
  renderer.render(source, 0);
  assert.deepEqual(moves, [
    { col: 1, row: 0 },
    { col: 3, row: 1 },
  ]);
});

test('inverse is resolved by swapping fg/bg when enabled', () => {
  const canvas = makeFakeCanvas();
  const renderer = new Canvas2DRenderer({
    fontFamily: 'monospace',
    fontSize: 14,
    dpr: 1,
    theme: THEME,
    resolveInverse: true,
  });
  renderer.mount(canvas as unknown as HTMLCanvasElement);
  renderer.resize(4, 1, 1);
  const source = new FakeSource({ cols: 4, rows: 1, fg: 0xffffff, bg: 0x000000 });
  source.setCursor({ visible: false });
  source.setCell(0, 0, 'Z'.codePointAt(0)!, { fg: 0xffffff, bg: 0x000000, flags: CellFlags.INVERSE });
  renderer.render(source, 0);
  // Glyph should be drawn in the (swapped) foreground = original bg = black.
  const glyph = canvas.context.ops.find((o) => o.op === 'fillText');
  assert.ok(glyph);
  assert.equal(glyph!.fillStyle, '#000000');
});

test('metrics and hit testing round-trip', () => {
  const { renderer } = setup(20, 10);
  const m = renderer.getMetrics();
  assert.equal(m.cols, 20);
  assert.equal(m.rows, 10);
  const rect = renderer.pixelForCell(5, 3);
  const hit = renderer.cellAtPixel(rect.x + 1, rect.y + 1);
  assert.deepEqual(hit, { col: 5, row: 3 });
  assert.equal(renderer.cellAtPixel(-1, 0), null);
  assert.equal(renderer.cellAtPixel(m.cssCellWidth * 100, 0), null);
});

test('scrolled viewport draws scrollback rows at the top', () => {
  const { canvas, renderer, source } = setup(6, 2, 4); // 4 scrollback + 2 active
  source.writeText(0, 0, 'S'); // absolute row 0 = oldest scrollback
  source.writeText(source.activeTop, 0, 'A');
  renderer.render(source, 0); // viewportY=0 -> shows rows 0 and 1
  assert.ok(canvas.context.texts().includes('S'), 'scrollback row rendered when scrolled to top');
});

test('a scroll past the viewport repaints in full: nothing on screen survives', () => {
  const { canvas, renderer, source } = setup(6, 2, 4); // 4 scrollback + 2 active
  source.writeText(0, 0, 'AAA');
  source.writeText(1, 0, 'BBB');
  source.writeText(2, 0, 'CCC');
  source.writeText(3, 0, 'DDD');

  renderer.render(source, 0);
  assert.deepEqual(canvas.context.texts(), ['A', 'A', 'A', 'B', 'B', 'B']);

  source.clearDirty();
  canvas.context.reset();
  let stats: RenderStats | undefined;
  renderer.on('render', (s) => (stats = s));
  renderer.render(source, 2); // two rows on a two-row screen: no overlap

  assert.equal(stats!.full, true, 'a scroll of a whole viewport forces a full frame');
  assert.equal(canvas.context.count('drawImage'), 0, 'nothing worth shifting');
  assert.deepEqual(
    canvas.context.texts(),
    ['C', 'C', 'C', 'D', 'D', 'D'],
    'the newly visible rows are drawn',
  );
});

test('a scroll inside the viewport shifts the pixels and repaints only what it uncovered', () => {
  // Changing viewportY remaps absolute rows onto screen rows without dirtying
  // any of them. The rows that stay on screen keep the pixels they already have,
  // moved by the scroll delta; only the row that entered is drawn again.
  const { canvas, renderer, source } = setup(6, 4, 8);
  for (let r = 0; r < 12; r++) source.writeText(r, 0, String(r % 10));

  renderer.render(source, 0);
  source.clearDirty();
  canvas.context.reset();
  let stats: RenderStats | undefined;
  renderer.on('render', (s) => (stats = s));
  renderer.render(source, 1); // scroll down one row

  assert.equal(stats!.full, false, 'a one-row scroll is not a full frame');
  assert.equal(stats!.dirtyRows, 1, 'only the row that entered the viewport');
  const blits = canvas.context.ops.filter((o) => o.op === 'drawImage');
  assert.equal(blits.length, 1, 'the surviving rows are shifted, not redrawn');
  const cellH = renderer.getMetrics().cellHeight;
  assert.equal(blits[0].y, -cellH, 'shifted up by exactly one row');
  assert.deepEqual(canvas.context.texts(), ['4'], 'only the newly exposed row is drawn');
});

test('scrolling up shifts the other way and repaints the top', () => {
  const { canvas, renderer, source } = setup(6, 4, 8);
  for (let r = 0; r < 12; r++) source.writeText(r, 0, String(r % 10));

  renderer.render(source, 4);
  source.clearDirty();
  canvas.context.reset();
  let stats: RenderStats | undefined;
  renderer.on('render', (s) => (stats = s));
  renderer.render(source, 2); // scroll up two rows

  assert.equal(stats!.dirtyRows, 2);
  const blits = canvas.context.ops.filter((o) => o.op === 'drawImage');
  assert.equal(blits[0].y, 2 * renderer.getMetrics().cellHeight, 'shifted down two rows');
  assert.deepEqual(canvas.context.texts(), ['2', '3'], 'the two rows uncovered at the top');
});

test('a row written in the same frame as a scroll is still repainted', () => {
  // The case a naive shift loses: the row both moved and changed, so reusing
  // its shifted pixels would show the pre-edit content at the new position.
  const { canvas, renderer, source } = setup(6, 4, 8);
  for (let r = 0; r < 12; r++) source.writeText(r, 0, String(r % 10));

  renderer.render(source, 0);
  source.clearDirty();
  canvas.context.reset();
  source.writeText(2, 0, 'X'); // stays on screen, but its content changed
  let stats: RenderStats | undefined;
  renderer.on('render', (s) => (stats = s));
  renderer.render(source, 1);

  assert.equal(stats!.dirtyRows, 2, 'the exposed row plus the edited one');
  assert.deepEqual(canvas.context.texts().sort(), ['4', 'X']);
});

test('a cursor that moves is erased from the row it left', () => {
  // The cursor is painted into the same pixels as the text and its movement is
  // not damage, so without this the old block survives on a clean row.
  const canvas = makeFakeCanvas();
  const renderer = new Canvas2DRenderer({ fontFamily: 'monospace', fontSize: 14, dpr: 2, theme: THEME });
  renderer.mount(canvas as unknown as HTMLCanvasElement);
  renderer.resize(6, 4, 2);
  const source = new FakeSource({ cols: 6, rows: 4, fg: THEME.foreground, bg: THEME.background });
  for (let r = 0; r < 4; r++) source.writeText(r, 0, 'abc');
  source.setCursor({ visible: true, x: 0, y: 1, shape: 'block' });

  renderer.render(source, 0);
  source.clearDirty();
  canvas.context.reset();
  let stats: RenderStats | undefined;
  renderer.on('render', (s) => (stats = s));
  source.setCursor({ x: 2, y: 3 }); // moves, dirties nothing
  renderer.render(source, 0);

  assert.equal(stats!.dirtyRows, 1, 'the row the cursor left is repainted');
  assert.equal(stats!.full, false, 'and only that row');
  const cellH = renderer.getMetrics().cellHeight;
  const band = canvas.context.ops.find(
    (o) => o.op === 'fillRect' && o.y === cellH && o.h === cellH,
  );
  assert.ok(band, 'the vacated row got its background band back');
});

test('re-rendering the same viewport does not force a full frame', () => {
  const { renderer, source } = setup(6, 2, 4);
  source.writeText(4, 0, 'ab');
  renderer.render(source, 4);
  source.clearDirty();
  let stats: RenderStats | undefined;
  renderer.on('render', (s) => (stats = s));
  renderer.render(source, 4);
  assert.equal(stats!.full, false, 'a stationary viewport stays incremental');
  assert.equal(stats!.dirtyRows, 0);
});

test('a blinking cell toggles with the clock and the flip drives its own repaint', (t) => {
  // The renderer owns no clock: it reads performance.now() on each render, and
  // the phase only advances on screen because the host keeps asking for frames.
  // The test drives that clock by hand, so the result does not depend on how
  // fast the machine runs. What is asserted is that the glyph is drawn in one
  // phase and skipped in the other, and that each flip, and only a flip,
  // repaints without the source dirtying anything.
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);

  const { canvas, renderer, source } = setup(4, 1);
  source.setCell(0, 0, 'B'.codePointAt(0)!, { flags: CellFlags.BLINK });
  renderer.render(source, 0);
  source.clearDirty();

  let drawn = 0;
  let skipped = 0;
  let flips = 0;
  let repaints = 0;
  let stats: RenderStats | undefined;
  renderer.on('render', (s) => (stats = s));

  // The phase flips every 250 ms. Two full periods at 50 ms steps see 4 flips.
  const visibleAt = (ms: number): boolean => (ms / 500) % 1 >= 0.5;
  for (let ms = 50; ms <= 1000; ms += 50) {
    clock = ms;
    if (visibleAt(ms) !== visibleAt(ms - 50)) flips++;
    canvas.context.reset();
    renderer.render(source, 0);
    if (stats!.dirtyRows === 0) continue;
    repaints++;
    if (canvas.context.texts().includes('B')) drawn++;
    else skipped++;
    assert.equal(
      canvas.context.texts().includes('B'),
      visibleAt(ms),
      `at ${ms} ms the glyph follows the phase`,
    );
  }

  assert.equal(flips, 4);
  assert.ok(drawn > 0, 'the blinking cell is drawn in its visible phase');
  assert.ok(skipped > 0, 'and skipped in the other');
  assert.equal(repaints, flips, 'each phase flip repaints, and nothing else does');
});

test('a non-blinking screen never repaints itself on the clock', () => {
  const { renderer, source } = setup(4, 1);
  source.writeText(0, 0, 'ab');
  renderer.render(source, 0);
  source.clearDirty();
  let stats: RenderStats | undefined;
  renderer.on('render', (s) => (stats = s));
  for (let i = 0; i < 5; i++) renderer.render(source, 0);
  assert.equal(stats!.dirtyRows, 0, 'no blinking cell, no clock-driven repaint');
  assert.equal(stats!.full, false);
});
