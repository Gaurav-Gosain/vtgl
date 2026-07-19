# Limits

What vtgl cannot do today, what it costs, and where it stops being the right
tool. Every gap here was checked against the code rather than remembered.

## Correctness gaps

### No contextual shaping

Arabic joining is wrong, and it is the most visible correctness gap. A
grapheme-aware VT puts one Arabic letter in each cell (the torture corpus records
that as the `split` layout, measured against a real ghostty-vt buffer), and vtgl
draws each cell's cluster in isolation, so the letters render in isolated form
and a word does not join.

The `ShaperHook` interface is defined, the atlas keys by string so shaped runs
would slot into the same cache, and the glyph instance already carries a
per-cell pixel offset for shaped placement. None of it is wired: no backend
calls `shapeRun`, and the `shaper` option is accepted and dropped.

This is not a gap relative to the obvious alternative. xterm.js does not do
contextual shaping either, so Arabic is not a reason to choose one over the
other. It is a reason to choose neither if joining matters to you.

### Ligatures, selection, subpixel antialiasing

None are implemented. Ligatures need the same run grouping shaping needs.
Selection is a host concern: `Theme.selection` is declared and no backend reads
it, so a host that wants selection draws its own overlay. Subpixel antialiasing
would need foreground baked into the glyph, which is why `atlasKeyBaked` and
`quantize` exist; nothing calls them.

### Blink is implemented but untested

The glyph fragment shader gates alpha on `step(0.5, fract(u_time))` with
`u_time = performance.now() / 500`, so a cell carrying `CellFlags.BLINK` is
visible for half of each 500 ms phase. No golden scenario and no test sets that
flag, so the path has never been exercised. The Canvas2D fallback ignores blink
entirely, which means the two backends disagree on any blinking cell.

There is a second problem behind the first: the renderer runs no clock. A
blinking cell only visibly toggles if something else keeps requesting frames, so
on an idle screen it stays in whatever phase the last frame caught.

Cursor blink is not implemented at all. `CursorState.blink` is part of the
contract and neither backend reads it; a host that wants a blinking cursor
toggles `visible` in its own source and requests frames.

### Wide glyphs clip rather than bleed

The atlas rasters a glyph into a slot exactly `widthCols * cellW` wide, so a
glyph whose font advance exceeds the cells the VT assigned it is clipped.
Canvas2D lets the same glyph paint outside its cells. Measured on the 24-entry
torture corpus, Canvas2D puts ink in the following cell on 9 entries (simple and
ZWJ emoji, flags, keycaps, both variation-selector cases, a Devanagari conjunct)
and the WebGL2 path on none.

Both behaviours are defensible and the tests record each rather than averaging
them into one loose threshold, which is why those entries are excluded from the
ink-ratio comparison. It does mean the backends are not interchangeable
pixel-for-pixel on emoji-dense content.

### Canvas2D can strand a cursor

The WebGL2 path rebuilds the whole screen from instance data every frame, so a
cursor that moves off a clean row vanishes from it automatically. The Canvas2D
path repaints only dirty rows, so if the source does not mark the row the cursor
left as dirty, the old cursor stays painted. Most VTs dirty the cursor's row on
movement, so this rarely surfaces, but it is a real divergence between the two
backends and not something the renderer can fix without tracking the previous
cursor position itself.

### Declared and inert

These are in the type surface and read by nothing:

| surface | status |
| --- | --- |
| `Theme.selection` | declared; no backend draws selection |
| `Theme.palette` | declared; the renderer resolves no palette indices |
| `RendererOptions.shaper` | accepted; never called |
| `VtSource.getMode` | declared; no backend queries a mode, including 2026 |
| `CursorState.blink` | declared; neither backend reads it |
| `bell` event | in the event map; never emitted |
| `atlasKeyBaked`, `quantize` | exported for a baked-foreground atlas mode that does not exist |
| `GlyphAtlas.onContextRestored` | dead code; the renderer rebuilds the atlas instead |

They are kept because each is a designed extension point with a real
implementation sketch behind it, but nothing in the shipped renderer depends on
any of them.

## Performance gaps

### Scrolling repaints in full

Moving the viewport changes which absolute rows map to which screen rows without
dirtying any of them, so the renderer compares `viewportY` against the previous
frame and rebuilds everything when it moved. The `scrollstorm` workload shows 40
dirty rows at its natural damage with nothing written at all.

This is the largest remaining optimisation. Shifting instance data by the scroll
delta and rebuilding only the rows that entered the viewport would make a
one-line scroll cost about what a one-line edit costs. It is correct today and more
work than necessary: 0.71 ms of CPU where it could be near zero.

### A DPR change rebuilds rather than rescales

Cell geometry determined the atlas slot sizes, so `resize()` with a new device
pixel ratio destroys the atlas and creates a fresh one, re-rastering every
visible glyph over the following frames. Moving a window between displays with
different scaling therefore costs a full atlas rebuild, not a texture resample.

### Full-screen repaints cannot be made cheaper by damage tracking

A colored log scrolling past genuinely dirties every row every frame, which the
`dump` workload measures at 40 dirty rows in natural mode. Damage tracking buys
nothing there; the entire win over a per-cell `fillText` renderer is the
draw-call collapse. No amount of dirty-row cleverness improves that case.

### The benchmark environment cannot answer the GPU question

Headless chromium runs WebGL on SwiftShader, which rasterizes on the CPU. The
CPU-side figures, the draw-call counts, and the allocation numbers transfer to
real hardware. The wall-clock and synchronized-readback figures do not, and no
frame rate is claimed anywhere in this repository. See
[benchmarks.md](benchmarks.md).

Parity is also verified narrowly: four golden scenarios under a 2%
differing-pixel budget and the emoji scenario under 5%, at one device pixel
ratio, with `--disable-lcd-text`. It has never been checked at DPR 2, under
subpixel antialiasing, or on the remaining four scenarios.

## Memory

Three things hold memory, and only one of them scales with the grid.

| what | size | notes |
| --- | --- | --- |
| atlas texture | 16 MB, always | `texStorage3D` allocates all 4 layers of 1024x1024 RGBA8 up front, used or not |
| instance data | 76 bytes per cell on the CPU, mirrored on the GPU | 4 background, 32 glyph, 40 decoration |
| canvas backing store | `cols * cellW * rows * cellH * 4` bytes | usually the largest term |

Worked example, 120x40 at DPR 2 with 14 px monospace in chromium, where the
measured advance is 16.8 device px and the face's line box is 38, giving a
17x46 device-pixel cell: instance data is 356 KB on the CPU and 356 KB on the
GPU, and the backing store is 2040x1840 device pixels, or 14.3 MB. The atlas
adds its fixed 16 MB.

Rule of thumb: the atlas is a flat 16 MB, the backing store is about 4 bytes per
device pixel on screen, and everything else is noise.

### Atlas capacity

A page holds `floor(1024 / (cellH + 1))` shelves of `floor(1024 / (cellW + 1))`
slots each. At the 17x46 cell above that is 21 shelves of 56 slots, about 1176
narrow glyphs per page and roughly 4700 across the four-page cap; wide glyphs
take a double-width slot and halve that. A working set larger than the cap
triggers a whole-atlas flush and a full-frame rebuild, which is correct but
costs one frame of re-rastering every visible glyph.

Neither the page size nor the page cap is exposed through `RendererOptions`;
both are constructor defaults on `GlyphAtlas`. A larger cell (a big font at a
high DPR) shrinks capacity quadratically, so a 30x70 cell holds roughly a
quarter as many glyphs per page.

## What vtgl is not for

It is not a terminal. It has no parser, no buffer, no input handling, no
clipboard, no selection, no links, no accessibility tree, and no addon system.
If you want those, use xterm.js, which has all of them and years of production
exposure behind them.

It is not designed for text layout beyond a monospaced cell grid. Proportional
fonts, bidirectional reordering, and vertical writing modes are all outside the
model: the grid is the layout, and the VT decides which cluster occupies which
cell. A renderer that needs real layout wants a text engine, not a terminal
renderer.

It is not proven on real hardware or in production. The correctness properties
are asserted by 100 unit tests and 16 browser tests, and the performance
properties are measured under software rasterization. What has not happened is
burn-in on a real GPU, at several device pixel ratios and grid sizes, with a
display attached. Until that exists, treat the GPU-side cost as unmeasured.
