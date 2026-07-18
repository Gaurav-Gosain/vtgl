# vtgl design

vtgl is a terminal renderer and nothing else. It reads VT grid state through a
small read-only interface and produces pixels plus input events. It does not
parse escape sequences, own the terminal buffer, manage the clipboard, speak any
wire protocol, or load fonts beyond the family and size handed to its
constructor. That separation is the whole point: the same renderer draws any
grapheme-aware VT that can expose its grid, and it can be tested and benchmarked
against a fake grid with no VT at all.

The reference source is ghostty-vt compiled to wasm. The VtSource interface
below mirrors that wasm's cell model exactly, so it drops in as the source
without an adapter layer. Nothing in the renderer imports it.

This document is the contract. It fixes the public types, the glyph-atlas key
scheme, the instanced pipeline layout, the damage and upload strategy, the
Canvas2D fallback contract, and the hook that lets contextual shaping land
later. The types here are the authoritative copy; src/types.ts is kept in sync
with them.

## 1. Why this package exists

A performance study of the ghostty-web Canvas2D renderer concluded that it is
well tuned. It damages by dirty row, caches fill and font strings, and skips
blank cells. What it cannot do is beat the cost of one ctx.fillText per visible
cell. On a full-screen redraw of a large grid that per-cell text cost caps the
frame rate far below 60fps, no matter how clean the surrounding code is.

The only path to xterm.js-WebGL-class throughput is a glyph atlas: raster each
distinct glyph once into a texture, then draw every cell as a textured quad in a
single instanced draw call. That is the core vtgl is built to deliver. The
Canvas2D renderer ships today as the correctness reference and as the fallback
for environments without WebGL2; it is not the destination.

The 60fps goal stated concretely: a full-screen redraw of a 120x40 grid must
complete well under 16ms of combined CPU and GPU work on real hardware. Every
hot path is designed for near-zero per-frame allocation: preallocated typed
arrays, reused buffers, no per-cell object creation.

## 2. The source contract (VtSource)

The renderer consumes this interface strictly read-only. It never mutates the
source and never clears dirty state; whoever drives the VT owns the dirty
lifecycle and clears it out of band from render().

Row coordinates are absolute across the whole buffer. Rows `[0, scrollbackRows)`
are scrollback, oldest first; rows `[scrollbackRows, scrollbackRows + rows)` are
the active screen. `render(source, viewportY)` draws the `rows` lines starting at
absolute `viewportY`, so scrolling is just a different `viewportY`.

```ts
const enum CellFlags {
  NONE = 0,
  BOLD = 1,
  ITALIC = 2,
  UNDERLINE = 4,
  STRIKETHROUGH = 8,
  INVERSE = 16,
  INVISIBLE = 32,
  BLINK = 64,
  FAINT = 128,
}
// Shipped as a const object + union type for erasable-syntax runtimes; the
// bit values are exactly ghostty-vt's, so wasm flags pass through unchanged.

type Rgb = number; // packed 0xRRGGBB, palette and defaults pre-resolved

interface Cell {
  codepoint: number;   // primary scalar; 0 (empty) or 32 (space) = blank
  grapheme: string;    // full cluster to raster, e.g. an emoji ZWJ sequence
  width: number;       // 1 normal, 2 wide, 0 spacer tail of a wide cell
  fg: Rgb;
  bg: Rgb;
  flags: number;       // CellFlags bitfield
}

interface LineView {   // allocation-free column accessor
  readonly length: number;        // == cols
  codepoint(col: number): number;
  grapheme(col: number): string;  // may allocate; called only for non-blank cells
  width(col: number): number;
  fg(col: number): Rgb;
  bg(col: number): Rgb;
  flags(col: number): number;
}

interface CursorState {
  x: number;                             // active-screen column
  y: number;                             // absolute buffer row
  visible: boolean;
  shape: 'block' | 'bar' | 'underline';
  blink: boolean;
}

interface VtSource {
  readonly rows: number;           // viewport height
  readonly cols: number;
  readonly scrollbackRows: number; // rows above the active screen

  getLine(row: number): LineView;
  getCell(row: number, col: number): Cell;
  getGraphemeString(row: number, col: number): string;
  getCursor(): CursorState;
  isRowDirty(row: number): boolean;   // read-only; source clears its own dirty
  getMode?(mode: number): boolean;    // e.g. 2026 synchronized output
}
```

The "cells" the study describes as `getLine(row)` returning are realized here as
LineView column accessors, not an array of Cell objects. This is deliberate: the
inner render loop must not allocate a Cell per cell per frame. The numeric
accessors read straight out of the source's backing arrays; `grapheme(col)` is
the only one that may allocate a string, and it is called only for cells that are
non-blank and non-spacer, and its result is immediately interned as an atlas key.
The Cell struct exists for convenience and hit-testing return values.

Width semantics drive both renderers. A width-2 cell is the head of a wide
glyph; the following cell is a width-0 spacer tail that must be skipped, never
drawn. A blank cell is codepoint 0 or 32.

## 3. The renderer contract (Renderer)

Both backends implement exactly this. Construction takes RendererOptions;
`createRenderer(options)` returns the best backend for the environment (WebGL2
when the core lands, else Canvas2D) typed as Renderer either way.

```ts
interface Theme {
  foreground: Rgb;
  background: Rgb;
  cursor: Rgb;
  cursorText?: Rgb;                     // defaults to background
  selection?: Rgb;
  palette?: Uint32Array | readonly number[]; // only for index-emitting sources
}

interface RendererOptions {
  fontFamily: string;                  // the renderer's only font input
  fontSize: number;                    // CSS px
  lineHeight?: number;                 // multiplier, default 1.2
  letterSpacing?: number;              // CSS px added to advance
  dpr?: number;                        // default devicePixelRatio or 1
  theme: Theme;
  resolveInverse?: boolean;            // swap fg/bg on CellFlags.INVERSE
  shaper?: ShaperHook;                 // optional contextual shaper (section 8)
}

interface Metrics {
  cols: number; rows: number;
  cellWidth: number; cellHeight: number;       // device px
  cssCellWidth: number; cssCellHeight: number; // CSS px
  baseline: number;                            // device px from cell top
  dpr: number;
  canvasWidth: number; canvasHeight: number;   // device px backing store
  fontFamily: string; fontSize: number; lineHeight: number;
}

interface CellCoord { col: number; row: number; } // absolute row
interface PixelRect { x: number; y: number; width: number; height: number; } // CSS px

interface RenderStats {
  dirtyRows: number;
  glyphs: number;        // instances drawn (WebGL) or fillText calls (Canvas2D)
  drawCalls: number;     // 1 for Canvas2D
  atlasUploads: number;  // raster+upload count this frame; 0 for Canvas2D
  full: boolean;         // full redraw (mount/resize/theme)
  cpuMs: number;
}

interface RendererEventMap {
  render: RenderStats;
  bell: void;
  cursorMove: CellCoord;
}

interface Renderer {
  readonly backend: 'webgl2' | 'canvas2d';
  mount(canvas: HTMLCanvasElement | OffscreenCanvas): void;
  render(source: VtSource, viewportY: number): void;
  resize(cols: number, rows: number, dpr: number): void; // forces full redraw
  setTheme(theme: Theme): void;                           // forces full redraw
  getMetrics(): Metrics;
  cellAtPixel(px: number, py: number): CellCoord | null;  // CSS px in, cell out
  pixelForCell(col: number, row: number): PixelRect;
  on<K extends keyof RendererEventMap>(e: K, h: (p: RendererEventMap[K]) => void): () => void;
  off<K extends keyof RendererEventMap>(e: K, h: (p: RendererEventMap[K]) => void): void;
  dispose(): void;
}
```

Fonts enter only through RendererOptions. setTheme carries colors only; it never
touches fonts. The renderer never reads the clipboard, never emits protocol
bytes; input events it surfaces (cursorMove, bell) are observations of VT state,
not I/O.

## 4. Atlas key scheme

The atlas is a cache from a rasterizable-glyph identity to a rectangle in a
texture page. The identity is a string. Keying by string is the load-bearing
decision: it is what lets a future contextual shaper mint per-shaped-glyph keys
that slot into the exact same atlas the per-grapheme path uses.

Default, tinting mode:

```
key = grapheme + styleMask
styleMask = flags & (BOLD | ITALIC)   // the only flags that change glyph shape
```

Monochrome glyphs are rastered as grayscale coverage and tinted per instance by
the foreground color in the shader, so foreground is not part of the key. This
collapses the atlas to one entry per (grapheme, bold/italic) regardless of how
many colors it appears in. Underline, strikethrough, inverse, blink, and faint
never enter the key: underline and strike are separate decoration quads; inverse
and faint are per-instance color and alpha; blink is a per-instance visibility
toggle driven by a clock uniform.

Colored glyphs (emoji, including ZWJ sequences) are rastered with their own
colors and drawn untinted. They still key by grapheme + styleMask (styleMask is
0 for emoji, which ignore bold/italic). The atlas entry records a `colored` bit
so the shader knows whether to multiply by the instance foreground or sample the
texel as-is.

Baked, fg-quant mode (optional):

```
key = grapheme + styleMask + quantize(fg)   // 5-bit-per-channel bucket
```

For renderer variants that must bake foreground into the glyph, such as subpixel
antialiasing where coverage differs per color. This is why the study mentions fg
quantization. It is off by default; tinting is preferred because it keeps the
atlas small. When on, only the trailing fg bucket differs.

## 5. Instanced pipeline (WebGL2 core)

Two passes per frame, each a single instanced draw of a unit quad. Geometry is a
static 4-vertex quad in a VBO (or expanded from `gl_VertexID`); everything
per-cell is an instance attribute.

Background pass. One instance per grid cell, `cols * rows` instances, drawn
first with blending off.

```
per-instance:
  a_cell    : vec2  (col, row) as unsigned, expanded to pixels in the shader
  a_bg      : uint  packed RGBA (bg color; default-bg cells still drawn, cheap)
uniforms:
  u_resolution : vec2  device px
  u_cellSize   : vec2  device px
```

Glyph pass. One instance per cell as well, `cols * rows` instances, so the
instance buffer is fixed-size and never reallocated. Blank and spacer-tail cells
emit a degenerate (zero-area) quad via a zero-size atlas rect, costing no fill.
Blending on, drawn over the background pass.

```
per-instance:
  a_cell     : vec2  (col, row)
  a_atlas    : vec4  (x, y, w, h) in atlas texels, zero for blank/spacer
  a_fg       : uint  packed RGBA foreground (tint for mono, ignored for colored)
  a_glyphOff : vec2  device-px offset within the cell (shaper x-offset, wide glyphs)
  a_style    : uint  bitfield: colored, faint, blink, underline, strike
uniforms:
  u_resolution : vec2
  u_cellSize   : vec2
  u_atlasSize  : vec2  texels
  u_atlas      : sampler2D (the current page; multi-page loops or texture array)
  u_time       : float (blink phase)
  u_dpr        : float
```

Vertex shader: `pos = (a_cell * u_cellSize + quad * a_atlas.zw + a_glyphOff)`,
projected to clip space by `u_resolution`. Fragment shader: sample coverage or
color from `u_atlas` at `a_atlas.xy + quad * a_atlas.zw`; if `colored`, output
the texel; else output `a_fg.rgb` with alpha = texel coverage; apply faint as an
alpha scale and blink as a `u_time`-gated multiply.

Decorations. Underline and strikethrough are a third tiny instanced draw of
solid quads, one instance per decorated cell, keyed off the style bits. Cursor
is one more small draw (block, bar, or underline rect, plus an optional
inverted-glyph quad).

Total draw calls per frame: background, glyphs, decorations, cursor. Four fixed
calls, independent of cell count. That is the whole speed argument.

Wide glyphs. A width-2 head emits one glyph instance whose atlas rect is two
cells wide; its spacer tail (width 0) emits a degenerate instance. The head glyph
is allowed to overhang into the tail cell because the background and glyph passes
are separate: the tail's background is still painted by the background pass.

## 6. Damage and upload strategy

The renderer keeps a CPU-side shadow of the instance data in preallocated typed
arrays sized `cols * rows` for each pass. Nothing in the per-frame path
allocates.

Per frame:

1. If forceFull (first frame after mount, resize, or setTheme), every row is
   treated as dirty.
2. For each viewport row, `absRow = viewportY + vr`. If not full and
   `!source.isRowDirty(absRow)`, skip it entirely. This reuses the source's
   existing damage tracking; the renderer adds none of its own beyond the
   forceFull flag.
3. For each dirty row, recompute that row's slice of both instance arrays. While
   filling the glyph slice, resolve each cell's atlas key (section 4); on a miss,
   raster the glyph and upload it (below), recording the atlas rect.
4. Mark the changed instance-buffer byte range. Dirty rows are contiguous within
   a row, so the upload is a coalesced `bufferSubData` over the min..max dirty
   row span, or one call per contiguous run of dirty rows.
5. Issue the four draws. Instance counts are fixed at `cols * rows`; degenerate
   quads make blank and spacer cells free.

Atlas uploads. On a key miss, raster the glyph to a small offscreen 2D canvas
using the constructor font, then `texSubImage2D` into the current page at an
allocated slot. Slots are packed by a shelf/skyline allocator. The atlas is a
dynamic LRU: each entry records the frame it was last used; when a page fills,
evict least-recently-used entries not touched in the current frame, and if the
current frame alone overflows a page, allocate another page (texture array layer
or additional sampler in the loop). `atlasUploads` in RenderStats counts misses
per frame so thrash is observable.

Synchronized output. If `source.getMode?.(2026)` is true, the driver is mid
atomic update; the renderer may coalesce to the frame where it clears, avoiding
tearing on full-screen TUI repaints. This is advisory; correctness does not
depend on it.

## 7. Canvas2D fallback contract

The fallback implements the identical Renderer interface with a 2D context, for
environments without WebGL2. It is also the correctness reference: the WebGL2
core must reproduce its pixel decisions. It ships today (src/renderer/canvas2d.ts)
and mirrors the known-good ghostty-web canvas2d behavior, written fresh:

- Dirty-row redraw. A full frame clears the whole backing store to the default
  background once; an incremental frame repaints only rows where
  `source.isRowDirty(absRow)` is true, each preceded by a default-background band
  fill over just that row.
- Blank-cell skip. A cell with codepoint 0 or 32 whose background equals the
  default background paints nothing (the band already covers it). A blank cell
  with a non-default background still fills its background rect.
- Wide-char spacer handling. A width-2 cell draws its glyph once, spanning two
  columns for background and decorations; the following width-0 spacer tail is
  skipped.
- Caches. Font strings are cached by (bold, italic) mask; fill styles are cached
  by packed color. Faint applies a 0.5 alpha; underline and strikethrough draw
  as rects; inverse swaps fg/bg when `resolveInverse` is set.
- Cursor. Block, bar, or underline; a block cursor overpaints the cell and
  redraws the covered glyph in `cursorText`.

The fallback issues one draw "call" conceptually (many fillRect/fillText); its
RenderStats reports `drawCalls: 1` and `atlasUploads: 0`. It is correct at any
grid size and fast enough for small ones, but its per-cell fillText cost is
exactly the ceiling the WebGL2 core removes.

## 8. Shaping-later hook

The atlas keys by string precisely so contextual shaping can land later without
touching the atlas or the pipeline. The hook:

```ts
interface RunStyle { bold: boolean; italic: boolean; }
interface ShapedGlyph {
  atlasKey: string;  // stable per-glyph key, e.g. `${fontId}:${glyphId}`
  cluster: string;   // substring to raster (contextual form)
  col: number;       // starting column within the run
  xOffset: number;   // device-px offset from the run origin
}
interface ShapedRun { glyphs: ShapedGlyph[]; }
interface ShaperHook { shapeRun(text: string, style: RunStyle): ShapedRun; }
```

The renderer groups contiguous cells of identical style into runs. With no
shaper (the default), each cell is a length-1 run whose atlas key is its grapheme
string, which is exactly the current behavior. With a shaper present, the run
text is shaped once; each returned glyph is rastered and atlas-keyed by its
`atlasKey`, and placed at `col` plus `xOffset`. Because the atlas rect and the
instance layout already carry a per-glyph offset (`a_glyphOff`), shaped output
needs no new pipeline state.

The differentiator this enables is Arabic contextual joining, which the current
ghostty-web bundle and xterm.js both get wrong. It is acceptable to land the
shaper as a follow-up; the constraint honored now is that the atlas keys by
grapheme string, so shaped runs slot in without a redesign.

## 9. Testing and benchmarking

A fake VtSource (src/testing/fake-source.ts) is a scriptable absolute grid with
explicit dirty tracking: writeText lays down ASCII, wide CJK (width-2 head plus
width-0 tail), and ZWJ emoji clusters; setCell/markDirty/clearDirty drive damage
precisely; setCursor and setMode complete the surface. It is the reference source
for tests and benchmarks and stands in for ghostty-vt.wasm.

A golden-scenario module (src/testing/scenarios.ts) provides ASCII, CJK, emoji
ZWJ, a blank-heavy screen, and full-screen churn, all at 120x40, shared by unit
tests and the benchmark. Unit tests run under node:test with Node's type
stripping; the WebGL2 core's browser tests run under Playwright with the system
chromium.

On measurement honesty: headless GL in chromium is SwiftShader software
rendering, so absolute fps from a headless run is meaningless. The core is judged
by draw-call counts (the design target is four fixed calls per frame), per-frame
CPU time, atlas upload counts, and relative deltas between scenarios and against
the Canvas2D baseline, not by absolute fps claims. The current Canvas2D benchmark
(bench/render-bench.ts) counts drawing operations against the recording canvas,
so its numbers measure the renderer's decision loop, not real raster cost; they
exist for regression tracking and to compare the future core's operation counts.

## 10. Core phase: what shipped

Everything in sections 5 and 6 landed as `src/renderer/webgl2.ts` plus its
supporting modules. Where the implementation makes a choice the sections above
left open, this is what it chose.

Module split. The GL-free parts are separated from the GL parts so the logic is
testable under node with no GPU: `atlas/shelf.ts` (shelf allocator),
`atlas/packer.ts` (multi-page LRU bookkeeping), and `renderer/instances.ts`
(instance-stream generation) are pure; `atlas/glyph-atlas.ts` and
`renderer/webgl2.ts` own the GL objects. `renderer/metrics.ts` holds the cell
geometry both backends share, which is what makes pixel parity testable.

Cell position is derived, not stored. The background and glyph passes recover
`col` and `row` from `gl_InstanceID` and a `u_cols` uniform rather than carrying
an `a_cell` attribute, so the background instance record is a single uint and
the glyph record is 32 bytes. Section 5 lists `a_cell`; deriving it is
equivalent and smaller.

Decorations are per-cell, not per-decorated-cell. Section 5 describes the
decoration pass as one instance per decorated cell, which would make its
instance count dynamic. Because the GPU redraws the whole grid every frame while
only dirty rows are re-uploaded, a dynamic list would have to be rebuilt in full
each frame and would defeat the damage tracking. Instead the decoration stream is
a fixed two instances per cell (underline, strikethrough), zero-area when absent,
so it is damage-driven exactly like the other two streams.

Multi-page sampling uses a texture array. Pages are layers of a
`TEXTURE_2D_ARRAY`; the layer index rides in bits 8..15 of `a_style`. This keeps
the glyph pass to one draw regardless of page count.

Draw calls. Background, glyphs, decorations, then the cursor: three fixed calls
plus one for the cursor rect and, for a block cursor over a non-blank cell, one
more for the overpainted glyph. So three to five per frame, independent of cell
count. The browser suite asserts the count does not move as the grid grows.

Eviction is a flush, not a partial reclaim. Shelf packing cannot free individual
slots, so when every page is full the packer drops all entries and bumps a
generation counter. The renderer notices the generation change mid-build and
restarts the frame as a full redraw, re-rastering the live working set into the
fresh atlas in one pass. This keeps CPU-side rects and GPU-side pixels from ever
disagreeing, at the cost of one expensive frame under atlas pressure. Stale
entries are counted as evictions for observability.

Allocation. The instance streams, their byte views, the dirty-row flags, and the
cursor scratch are all preallocated and reused; the upload path is arithmetic
over persistent views. Two things still allocate on the dirty-cell path by
design: `LineView.grapheme(col)` may mint a string, and the atlas key is a
string concatenation. Both are short-lived garbage rather than retained growth,
and `test/allocation.test.ts` asserts the retained heap does not grow.

## 11. Known gaps

- No contextual shaper. `ShaperHook` is defined and the atlas keys by string so
  shaped runs slot in, but nothing implements it, so Arabic joining is still
  wrong. This is the intended next piece of work.
- Never run against real ghostty-vt wasm. Every test drives the fake source. The
  interface was written to mirror the wasm cell model, but that claim is
  unverified against the real thing.
- Performance is measured only under SwiftShader software rendering. The CPU-side
  numbers are meaningful; the GPU-side cost on real hardware is not yet known.
- The atlas key concatenates a string per dirty cell. An interning cache keyed by
  codepoint for the common single-scalar case would remove most of that garbage.
- Scrolling repaints in full. A change in `viewportY` remaps absolute rows onto
  screen rows without dirtying any of them, so both backends force a full frame
  when it moves. That is correct but pessimistic: shifting the existing instance
  data by the scroll delta and rebuilding only the newly exposed rows would make
  a one-line scroll as cheap as a one-line edit.
- Selection overlays are in the Theme type but not drawn.
- Blink is implemented as a shader-side time gate and is untested, since no
  scenario sets the blink flag.
- Ligatures and subpixel antialiasing are not implemented. The baked fg-quant
  atlas mode from section 4 exists as a key function but no renderer uses it.
- A wide glyph whose raster overflows its two-cell slot is clipped by the atlas,
  where the Canvas2D path would let it bleed into the neighboring cell.
