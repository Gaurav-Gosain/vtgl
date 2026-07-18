import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InstanceBuffers, StyleBit, GLYPH_UNITS, DECO_UNITS, DECO_PER_CELL } from '../src/renderer/instances.ts';
import type { AtlasRect, GlyphProvider } from '../src/renderer/instances.ts';
import { FakeSource } from '../src/testing/fake-source.ts';
import { CellFlags } from '../src/types.ts';

const THEME = { foreground: 0xd0d0d0, background: 0x101010, cursor: 0xffffff };

const CELL_W = 10;
const CELL_H = 20;
const BASELINE = 15;

/** Deterministic stand-in for the GL atlas: every key gets a stable fake slot. */
class FakeProvider implements GlyphProvider {
  readonly seen: string[] = [];
  private next = 0;
  private readonly slots = new Map<string, AtlasRect>();
  colored = new Set<string>();
  /** Keys for which ensure() reports failure (atlas could not place). */
  reject = new Set<string>();

  ensure(grapheme: string, styleMask: number, widthCols: number): AtlasRect | null {
    const key = grapheme + '|' + styleMask + '|' + widthCols;
    this.seen.push(key);
    if (this.reject.has(grapheme)) return null;
    let s = this.slots.get(key);
    if (!s) {
      s = {
        x: (this.next % 16) * 32,
        y: Math.floor(this.next / 16) * 32,
        w: widthCols * CELL_W,
        h: CELL_H,
        colored: this.colored.has(grapheme),
        page: 0,
      };
      this.next++;
      this.slots.set(key, s);
    }
    return s;
  }
}

function setup(cols: number, rows: number, resolveInverse = false) {
  const b = new InstanceBuffers();
  b.resize(cols, rows);
  b.configure(CELL_W, CELL_H, BASELINE, 1, resolveInverse);
  b.clearAll(THEME);
  const source = new FakeSource({ cols, rows, fg: THEME.foreground, bg: THEME.background });
  return { b, source, provider: new FakeProvider() };
}

function glyphAt(b: InstanceBuffers, cols: number, vr: number, col: number) {
  const base = (vr * cols + col) * GLYPH_UNITS;
  return {
    x: b.glyphF32[base + 0],
    y: b.glyphF32[base + 1],
    w: b.glyphF32[base + 2],
    h: b.glyphF32[base + 3],
    offX: b.glyphF32[base + 4],
    offY: b.glyphF32[base + 5],
    fg: b.glyphU32[base + 6],
    style: b.glyphU32[base + 7],
  };
}

function decoAt(b: InstanceBuffers, cols: number, vr: number, col: number, which: 0 | 1) {
  const base = (vr * cols + col) * DECO_PER_CELL * DECO_UNITS + which * DECO_UNITS;
  return {
    x: b.decoF32[base + 0],
    y: b.decoF32[base + 1],
    w: b.decoF32[base + 2],
    h: b.decoF32[base + 3],
    color: b.decoU32[base + 4],
  };
}

test('writes a glyph instance per visible cell and packs fg', () => {
  const { b, source, provider } = setup(8, 1);
  source.writeText(0, 0, 'hi', { fg: 0x00ff00 });
  const res = b.buildRow(source, 0, 0, provider);
  assert.equal(res.glyphs, 2);
  const g = glyphAt(b, 8, 0, 0);
  assert.equal(g.w, CELL_W, 'single-width glyph spans one cell');
  assert.equal(g.h, CELL_H);
  assert.equal(g.fg, 0x00ff00);
  assert.equal(g.offX, 0);
  assert.equal(g.offY, 0);
});

test('blank cells emit a degenerate quad but still carry their background', () => {
  const { b, source, provider } = setup(4, 1);
  source.clearRegion(0, 1); // spaces, default bg
  source.setCell(0, 2, 32, { bg: 0x223344 });
  const res = b.buildRow(source, 0, 0, provider);
  assert.equal(res.glyphs, 0, 'no glyph instances for blanks');
  for (let c = 0; c < 4; c++) {
    const g = glyphAt(b, 4, 0, c);
    assert.equal(g.w, 0, `cell ${c} glyph is zero-area`);
    assert.equal(g.h, 0);
  }
  assert.equal(b.bg[2], 0x223344, 'colored blank still paints its background');
  assert.equal(b.bg[0], THEME.background);
});

test('wide glyph spans two cells and its spacer tail is degenerate', () => {
  const { b, source, provider } = setup(8, 1);
  source.writeText(0, 0, '世', { bg: 0x445566 });
  const res = b.buildRow(source, 0, 0, provider);
  assert.equal(res.glyphs, 1, 'one glyph for the wide head');

  const head = glyphAt(b, 8, 0, 0);
  assert.equal(head.w, CELL_W * 2, 'atlas rect spans two cells');
  const tail = glyphAt(b, 8, 0, 1);
  assert.equal(tail.w, 0, 'spacer tail draws nothing');
  assert.equal(b.bg[0], 0x445566);
  assert.equal(b.bg[1], 0x445566, 'tail inherits the head background');
  assert.ok(provider.seen.some((k) => k.endsWith('|2')), 'provider asked for a 2-column slot');
});

test('underline and strikethrough become solid quads sized to the glyph span', () => {
  const { b, source, provider } = setup(4, 1);
  source.setCell(0, 0, 'A'.codePointAt(0)!, {
    fg: 0xabcdef,
    flags: CellFlags.UNDERLINE | CellFlags.STRIKETHROUGH,
  });
  b.buildRow(source, 0, 0, provider);

  const under = decoAt(b, 4, 0, 0, 0);
  const strike = decoAt(b, 4, 0, 0, 1);
  assert.equal(under.w, CELL_W);
  assert.equal(under.h, 1, 'thickness scales with dpr (1 here)');
  assert.equal(under.color, 0xabcdef);
  assert.equal(strike.w, CELL_W);
  assert.equal(strike.y, Math.round(CELL_H * 0.5));
  assert.ok(under.y > strike.y, 'underline sits below the strikethrough');
});

test('undecorated cells emit zero-area decoration quads', () => {
  const { b, source, provider } = setup(4, 1);
  source.writeText(0, 0, 'ab');
  b.buildRow(source, 0, 0, provider);
  for (let c = 0; c < 4; c++) {
    assert.equal(decoAt(b, 4, 0, c, 0).w, 0);
    assert.equal(decoAt(b, 4, 0, c, 1).w, 0);
  }
});

test('wide decorated glyph gets a two-cell-wide decoration', () => {
  const { b, source, provider } = setup(6, 1);
  source.setCell(0, 0, '世'.codePointAt(0)!, { width: 2, flags: CellFlags.UNDERLINE });
  source.setCell(0, 1, 0, { width: 0 });
  b.buildRow(source, 0, 0, provider);
  assert.equal(decoAt(b, 6, 0, 0, 0).w, CELL_W * 2);
});

test('inverse swaps fg and bg when resolveInverse is set', () => {
  const { b, source, provider } = setup(4, 1, true);
  source.setCell(0, 0, 'Z'.codePointAt(0)!, {
    fg: 0xffffff,
    bg: 0x000000,
    flags: CellFlags.INVERSE,
  });
  b.buildRow(source, 0, 0, provider);
  assert.equal(glyphAt(b, 4, 0, 0).fg, 0x000000, 'glyph takes the original background');
  assert.equal(b.bg[0], 0xffffff, 'cell background takes the original foreground');
});

test('inverse is left to the source when resolveInverse is off', () => {
  const { b, source, provider } = setup(4, 1, false);
  source.setCell(0, 0, 'Z'.codePointAt(0)!, {
    fg: 0xffffff,
    bg: 0x000000,
    flags: CellFlags.INVERSE,
  });
  b.buildRow(source, 0, 0, provider);
  assert.equal(glyphAt(b, 4, 0, 0).fg, 0xffffff);
  assert.equal(b.bg[0], 0x000000);
});

test('faint, blink and colored land in the style bitfield with the atlas page', () => {
  const { b, source, provider } = setup(4, 1);
  provider.colored.add('X');
  source.setCell(0, 0, 'X'.codePointAt(0)!, { flags: CellFlags.FAINT | CellFlags.BLINK });
  b.buildRow(source, 0, 0, provider);
  const style = glyphAt(b, 4, 0, 0).style;
  assert.ok(style & StyleBit.COLORED, 'colored bit set from the atlas entry');
  assert.ok(style & StyleBit.FAINT);
  assert.ok(style & StyleBit.BLINK);
  assert.equal((style >> 8) & 0xff, 0, 'page 0 encoded in the high bits');
});

test('invisible cells paint background but no glyph', () => {
  const { b, source, provider } = setup(4, 1);
  source.setCell(0, 0, 'A'.codePointAt(0)!, { bg: 0x111111, flags: CellFlags.INVISIBLE });
  const res = b.buildRow(source, 0, 0, provider);
  assert.equal(res.glyphs, 0);
  assert.equal(glyphAt(b, 4, 0, 0).w, 0);
  assert.equal(b.bg[0], 0x111111);
});

test('bold and italic reach the provider as a style mask; underline does not', () => {
  const { b, source, provider } = setup(4, 1);
  source.setCell(0, 0, 'A'.codePointAt(0)!, {
    flags: CellFlags.BOLD | CellFlags.UNDERLINE,
  });
  b.buildRow(source, 0, 0, provider);
  assert.equal(provider.seen[0], 'A|1|1', 'only BOLD survives into the atlas key');
});

test('a glyph the atlas cannot place is skipped, not drawn garbage', () => {
  const { b, source, provider } = setup(4, 1);
  provider.reject.add('A');
  source.writeText(0, 0, 'AB');
  const res = b.buildRow(source, 0, 0, provider);
  assert.equal(res.glyphs, 1, 'only the placeable glyph is counted');
  assert.equal(glyphAt(b, 4, 0, 0).w, 0, 'rejected glyph stays degenerate');
  assert.ok(glyphAt(b, 4, 0, 1).w > 0);
});

test('rebuilding a row overwrites its previous instances', () => {
  const { b, source, provider } = setup(6, 1);
  source.writeText(0, 0, 'abcdef');
  b.buildRow(source, 0, 0, provider);
  assert.ok(glyphAt(b, 6, 0, 5).w > 0);

  source.clearRegion(0, 1); // now all blanks
  b.buildRow(source, 0, 0, provider);
  for (let c = 0; c < 6; c++) {
    assert.equal(glyphAt(b, 6, 0, c).w, 0, `cell ${c} cleared on rebuild`);
  }
});

test('row slices are addressed independently', () => {
  const { b, source, provider } = setup(4, 3);
  source.writeText(0, 0, 'aa');
  source.writeText(1, 0, 'bb');
  source.writeText(2, 0, 'cc');
  b.buildRow(source, 1, 1, provider); // only viewport row 1
  assert.equal(glyphAt(b, 4, 0, 0).w, 0, 'row 0 untouched');
  assert.ok(glyphAt(b, 4, 1, 0).w > 0, 'row 1 written');
  assert.equal(glyphAt(b, 4, 2, 0).w, 0, 'row 2 untouched');
});

test('byte ranges cover exactly one row and tile without gaps', () => {
  const b = new InstanceBuffers();
  b.resize(120, 40);
  const bg0 = b.bgRange(0);
  const bg1 = b.bgRange(1);
  assert.equal(bg0.offset, 0);
  assert.equal(bg0.length, 120 * 4);
  assert.equal(bg1.offset, bg0.offset + bg0.length, 'row slices are contiguous');

  const g0 = b.glyphRange(0);
  assert.equal(g0.length, 120 * GLYPH_UNITS * 4);
  assert.equal(b.glyphRange(39).offset + g0.length, b.glyphBuf.byteLength, 'last row ends the buffer');

  const d0 = b.decoRange(0);
  assert.equal(d0.length, 120 * DECO_PER_CELL * DECO_UNITS * 4);
  assert.equal(b.decoRange(39).offset + d0.length, b.decoBuf.byteLength);
});

test('instance counts match the grid', () => {
  const b = new InstanceBuffers();
  b.resize(120, 40);
  assert.equal(b.cellCount, 4800);
  assert.equal(b.decoCount, 9600, 'two decoration instances per cell');
});

test('steady-state rebuilds allocate no new buffers', () => {
  const { b, source, provider } = setup(120, 40);
  const bgRef = b.bg;
  const glyphRef = b.glyphBuf;
  const decoRef = b.decoBuf;
  for (let r = 0; r < 40; r++) source.writeText(r, 0, 'the quick brown fox jumps');

  for (let frame = 0; frame < 10; frame++) {
    for (let vr = 0; vr < 40; vr++) b.buildRow(source, vr, vr, provider);
  }
  assert.equal(b.bg, bgRef, 'background array reused');
  assert.equal(b.glyphBuf, glyphRef, 'glyph buffer reused');
  assert.equal(b.decoBuf, decoRef, 'decoration buffer reused');

  // Resizing to the same dimensions must not reallocate either.
  b.resize(120, 40);
  assert.equal(b.bg, bgRef);
  assert.equal(b.glyphBuf, glyphRef);
});

test('resizing to a new grid reallocates and re-sizes the streams', () => {
  const b = new InstanceBuffers();
  b.resize(10, 2);
  const first = b.glyphBuf;
  b.resize(20, 4);
  assert.notEqual(b.glyphBuf, first);
  assert.equal(b.bg.length, 80);
  assert.equal(b.glyphBuf.byteLength, 80 * GLYPH_UNITS * 4);
});
