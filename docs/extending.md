# Extending

vtgl has one seam that matters (the VT) and several smaller ones underneath it.
Each section names the interface, shows its source, states what qualifies as a
valid implementation, and gives a usage block.

## Swap the VT: VtSource

This is the seam the library exists for. Implement it and any grapheme-aware VT
drives the renderer.

```ts
interface VtSource {
  readonly rows: number;
  readonly cols: number;
  readonly scrollbackRows: number;

  getLine(row: number): LineView;
  getCell(row: number, col: number): Cell;
  getGraphemeString(row: number, col: number): string;
  getCursor(): CursorState;
  isRowDirty(row: number): boolean;
}
```

What qualifies: a source that addresses rows absolutely (`[0, scrollbackRows)`
scrollback, then the active screen), reports display widths (1, 2, and 0 for the
spacer tail after a wide cell), returns whole grapheme clusters on the head cell
of a cluster, and hands back resolved 24-bit colors rather than palette indices.
The contract is read-only in both directions: the renderer never mutates the
source, and never clears the dirty flags it reads.

Damage is also what the scroll fast path trusts. A row that enters the viewport
is always rebuilt, so a source only has to be right about rows that were already
on screen, which is the same guarantee the incremental path has always needed.

The costs are asymmetric. A VT that already tracks per-row damage is nearly free
to adapt. A VT with no damage tracking still works if `isRowDirty` returns true
always, at the price of a full rebuild every frame, which the benchmark table
prices at 0.2 to 1.3 ms of CPU on a 120x40 grid. A VT that reports
screen-relative rows plus a separate scrollback accessor needs a mapping layer,
and that layer is where most adapter bugs live.

The `LineView` accessors are the hot path and must not allocate. If your VT
stores cells in typed arrays, bind one `LineView` per row up front and have its
accessors index into them, which is what
[src/testing/fake-source.ts](../src/testing/fake-source.ts) does:

```ts
const renderer = createRenderer({ fontFamily: 'monospace', fontSize: 14, theme });
renderer.mount(canvas);
renderer.resize(source.cols, source.rows, window.devicePixelRatio);

renderer.on('render', () => myVt.clearDirty());
myVt.onData(() => renderer.requestRender(source, source.scrollbackRows));
```

## Force a backend: Renderer

`createRenderer` picks for you. Both backends export their classes, so a host
that wants to pin one, or to run both side by side (which is how pixel parity is
tested), constructs them directly:

```ts
import { WebGL2Renderer, Canvas2DRenderer, supportsWebGL2 } from 'vtgl';

const renderer = supportsWebGL2() && !forceFallback
  ? new WebGL2Renderer(options)
  : new Canvas2DRenderer(options);
```

A third backend is a larger job than it looks: `Renderer` is a dozen methods, but
the parts that must agree with the existing two are cell geometry (call
`computeCellMetrics` and `measureFont` rather than reinventing them), the
absolute-row convention, and the `RenderStats` semantics.

## Supply glyphs: GlyphProvider

`InstanceBuffers.buildRow` reaches the atlas only through this:

```ts
interface GlyphProvider {
  ensure(grapheme: string, styleMask: number, widthCols: number): AtlasRect | null;
}

interface AtlasRect {
  x: number; y: number; w: number; h: number;
  colored: boolean;   // sample the texel as-is instead of tinting by fg
  page: number;       // texture array layer
}
```

`GlyphAtlas` implements it against a `TEXTURE_2D_ARRAY`. Returning null means
"could not place", and the builder draws that cell blank for the frame rather
than failing.

This is the seam for a different rasterizer: a worker-side rasterizer, an SDF
atlas, a pre-baked atlas shipped as an image. The cost is one method plus
whatever the raster path needs, and the constraint is that the returned
rectangle is in atlas texels equal to device pixels, since the glyph vertex
shader multiplies the unit quad by `a_atlas.zw` directly.

It is also how the instance builder is tested without a GPU: unit tests pass a
fake provider that hands back deterministic rects.

```ts
import { InstanceBuffers } from 'vtgl';

const buffers = new InstanceBuffers();
buffers.resize(cols, rows);
buffers.configure(cellW, cellH, baseline, dpr, resolveInverse);
const { glyphs } = buffers.buildRow(source, absRow, viewportRow, provider);
// buffers.bgBytes / glyphBytes / decoBytes are now current for that row
```

## Change the raster surface: RasterFont

`GlyphAtlas` takes its font and geometry as data, not as a renderer reference:

```ts
interface RasterFont {
  cellW: number;
  cellH: number;
  baseline: number;
  ctx: Ctx2D;                       // scratch, at least (2 * cellW) x cellH
  fontFor(styleMask: number): string;  // a CSS font string in device px
}
```

Anything that can answer those five things can drive the atlas, including an
`OffscreenCanvas` context on a worker. `fontFor` is where a host would add a
bold-face substitution, a fallback stack per style, or a synthetic-italic
transform.

## Repack the atlas: AtlasPacker and ShelfAllocator

Both are GL-free and separately exported. `ShelfAllocator` packs one page;
`AtlasPacker` owns the key map, the page list, growth up to a cap, and the flush
that bumps the generation counter. Replacing either is one class each, and the
contract to preserve is that `alloc` reports `isNew` so the caller knows to
raster, and that any wholesale invalidation bumps `generation`, because the
renderer restarts a frame on a generation change.

If you want individually freeable slots (a real MaxRects allocator with
coalescing, say) this is where it goes, and the whole-atlas flush in
`AtlasPacker.alloc` is the behaviour to replace.

## Change the frame clock: RenderScheduler

```ts
new RenderScheduler(callback, {
  requestAnimationFrame: myRaf,
  cancelAnimationFrame: myCancel,
});
```

Both functions are injectable, which is how the scheduler tests step frames by
hand and how a host on a fixed-tick loop, a worker, or a headless environment
substitutes its own clock. The contract to preserve: any number of `schedule()`
calls produce exactly one callback, no update is ever dropped, and a `schedule()`
during the callback lands on the following frame rather than re-entering.

## Write a shaper: ShaperHook

Run grouping is wired into both backends, so a shaper is now a self-contained
thing to write. `arabicShaper()` in `src/shaper/arabic.ts` is the worked example
and is about 200 lines including its joining table.

```ts
interface ShaperHook {
  participates(codepoint: number): boolean;
  shapeRun(cells: readonly string[], style: RunStyle): ShapedRun;
}
```

`RowShaper` (`src/renderer/runs.ts`) does the grouping: it walks a row, collects
maximal spans of width-1 cells that `participates` accepts and that share fg, bg
and flags, and hands each span to `shapeRun`. Grouping on colour is what makes
reordering safe, since reversing across a colour boundary would carry characters
into cells painted the other colour.

Each returned glyph names the column it is drawn in, the string to raster, and a
key. Three things are worth knowing:

- **The key is yours to mint and it must vary with anything that changes pixels.**
  The atlas keys by string, so shaped entries share the same cache as the
  default path. Keep them in your own namespace: a fitted raster of some letter
  is not interchangeable with the plain one, and colliding would poison the
  unshaped entry.
- **`rtl` is not cosmetic.** Chromium's canvas only honours a following joining
  context when the raster context is right-to-left; under the default direction a
  trailing ZWJ is dropped and every Arabic letter comes back isolated or final.
  That was measured, and it is why the flag exists.
- **`fitAdvance` is how a glyph is made to fit the cell the VT assigned it.** A
  shaped letter's natural advance has nothing to do with a monospace cell, so
  without it joining strokes land wherever the font puts them and do not meet.

The mechanism generalises past Arabic: Syriac, N'Ko, Mongolian, Adlam and Thaana
all join and would fall out of the same code given their joining tables. What
does not generalise is Devanagari and the other complex scripts, which need
reordering inside a cluster that the VT has already split across cells.

## Replace a whole layer

The WebGL2 renderer is roughly 800 lines and the Canvas2D fallback roughly 430,
and both are single files with no inheritance and no framework. If the seams
above do not fit what you are doing, forking one of them is a reasonable answer:
the pieces that took the most iteration (cell metrics, the atlas key scheme, the
packer, the scheduler) are separate modules you keep, and what you rewrite is
the several hundred lines that walk a grid and issue draws.
