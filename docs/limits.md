# Limits

What vtgl cannot do today, what it costs, and where it stops being the right
tool. Every gap here was checked against the code rather than remembered.

## Correctness gaps

### Contextual shaping is opt-in, Arabic only, and does not do bidi

Arabic joining used to be simply wrong. It is now correct within one run of one
line, if you ask for it. `RendererOptions.shaper` is honoured by both backends,
and `arabicShaper()` is the one shaper shipped.

What it does. A grapheme-aware VT puts one Arabic letter in each cell (the
torture corpus records that as the `split` layout, measured against a real
ghostty-vt buffer). The shaper groups contiguous Arabic cells of uniform style
into a run, derives each letter's joining context from the Unicode joining
types, and rasters it with a zero-width joiner on whichever side joins, so the
browser's own text engine returns the initial, medial, final or isolated form.
The run's cells are then laid out right to left, and each glyph's advance is
scaled to its cell so the connecting strokes meet on the cell boundary.

No shaping engine is shipped and no dependency was added. The browser was
already doing the shaping; the renderer was bypassing it by rasterising one
isolated cell at a time.

The verification is a ground-truth comparison rather than an eyeball. Unicode
encodes the four joining forms explicitly in Presentation Forms-B, so the
expected picture of a word is a known string. Rendering that reference through
the same renderer and diffing puts shaped salaam 10 pixels of edge antialiasing
away from it, out of 736, on both backends; unshaped it is 176 pixels away.

**Reordering is why this is opt-in, and it is a real trade.** Reversing a run
breaks the identity between a cell's index and the column its character is drawn
in, so inside a shaped run `cellAtPixel` names a cell whose character is
somewhere else in that run. A host that wants selection or hit testing to line
up with the buffer should leave the shaper off. Shaping without reordering is
not offered as a middle ground because it is not one: a joined letter's
connecting stroke points at its neighbour, and with the letters still in logical
left-to-right order those strokes point away from each other, which reads worse
than the isolated forms it replaces.

What it is not:

- **Not the Unicode Bidirectional Algorithm.** Only a maximal run of Arabic-block
  cells with identical fg, bg and flags is reversed. Neutrals are not resolved,
  brackets are not mirrored, there is no paragraph direction, and no embedding
  levels. The one concession is that a span of Arabic-Indic digits inside a run
  keeps its own digits in reading order, because reversing a number is the kind
  of quiet wrongness a visible improvement would otherwise hide.
- **Word order across a space is not reversed.** A space is not an Arabic-block
  character, so it ends the run. Two Arabic words on a line each join correctly
  and each read right to left internally, but the words stay in logical order
  left to right. A full sentence is therefore still not laid out correctly.
- **No lam-alef ligature.** The VT gave lam and alef a cell each and the renderer
  draws one glyph per cell, so they come out as lam-initial plus alef-final
  rather than the single ligature glyph a real shaper produces. The corpus
  records this as `arabic-lam-alef`.
- **Arabic block only.** The joining table covers U+0600..U+06FF. Syriac, N'Ko,
  Mongolian, Adlam and Thaana join by the same mechanism and would fall out of
  the same code, but their tables are not transcribed and nothing tests them.
  Arabic Supplement and Extended-A are likewise out.
- **Nothing for Devanagari or the other complex scripts.** They need reordering
  inside a cluster, which the VT has already split across cells; joining forms
  do not help.
- **Letterforms are distorted.** Fitting each glyph's advance to its cell
  stretches narrow forms and squeezes wide ones. Arabic in a monospace grid is
  distorted by construction; this picks a specific distortion and applies it
  consistently, and it is what makes the strokes meet.
- **A run that changes colour mid-word is split.** Each part joins and reverses
  on its own, so a word with a colour change in the middle comes out in two
  pieces. Grouping on colour is deliberate: reversing across a colour boundary
  would carry characters into cells painted the other colour.

Costs are measured in [benchmarks.md](benchmarks.md). Nothing changes when no
shaper is configured, which is the default: the run-grouping pass is not
constructed and the render path is what it always was.

xterm.js does not do contextual shaping at all, so this is now a small edge
rather than parity. It is not a reason to pick vtgl if you need real bidi, which
neither has.

### Ligatures, selection, subpixel antialiasing

None are implemented. Ligatures now have the run grouping they need, but nothing
produces them: a ligature is several cells collapsing into one glyph, and the
renderer draws one glyph per cell. Selection is a host concern and the type
surface says so: there is no `Theme.selection`, and a host that wants selection
draws its own overlay over the canvas. Subpixel antialiasing would need
foreground baked into the glyph, which is why `atlasKeyBaked` and `quantize`
exist; nothing calls them.

### Blink needs a driver

Cell blink works on both backends and is asserted in real pixels on each. The
glyph fragment shader gates alpha on `step(0.5, fract(u_time))` with
`u_time = performance.now() / 500`, and the Canvas2D path applies the same gate
to its `fillText`, so a cell carrying `CellFlags.BLINK` is visible for half of
each 500 ms phase on either backend.

What remains is that the renderer runs no clock, deliberately: it draws when it
is asked to. A blinking cell only visibly toggles while something keeps calling
`requestRender`, so on an idle screen it stays in whatever phase the last frame
caught. The Canvas2D path at least does not need the host to know which rows
blink: it notices the phase flip and repaints itself for that one frame, and
only when a blinking cell was on screen.

Cursor blink is not implemented and is not in the contract. A host that wants a
blinking cursor owns the clock and toggles `visible` in its own source; the
README has the four-line version.

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

### The shades cost the 2D path what a font glyph did not

U+2500..U+259F is not rastered from the face. A font glyph is drawn into a
cell-sized box at whatever size and position the face asks for, so two stacked
block cells do not meet: measured on Noto Sans Mono at a 14px font and dpr 1,
U+2588's ink stopped 4 device pixels short of the top of its cell and 3 short of
the bottom, which is a 7 pixel band of background between two stacked full
blocks and up to 14 at dpr 2. Every tiling pattern in the range failed the same
way on both backends, at every device pixel ratio and font size tried. The range
is drawn from the cell rectangle instead, and the seam is now zero.

What that costs is not uniform:

- On the WebGL2 path, nothing. A sprite is drawn into its atlas slot once and
  cached like any other glyph, so a steady-state frame of nothing but box
  characters measured 1.06 ms against 1.12 ms, which is inside the run to run
  spread.
- On the Canvas2D path it is a saving on everything except the three shades. A
  screen of box characters with the shades left out measured 2.36 ms of render
  CPU against the font path's 4.23 ms, and 5.4 ms of wall time against 7.5 ms.
- The three shades are an ordered dither on a two-by-two lattice, drawn through
  a cached repeating fill. A screen that is one third shades measured 4.23 ms of
  render CPU before and 2.73 ms after, but 7.5 ms of wall time before and 80 ms
  after, both including a forced readback. A dithered fill is expensive for a
  software rasterizer in a way a font glyph's antialiased blob is not.

Three ways of drawing the shades were measured and the pattern is the one
shipped, because it has the lowest cost inside `render()` and that is the figure
that blocks a host's main thread. Filling one pixel at a time measured 51 ms of
render CPU; blitting a cached cell-sized bitmap measured 5.3 ms of render CPU
and 128 ms of wall time. Whether a GPU-composited 2D canvas closes the wall-time
gap is not measured here and is not claimed; the benchmark environment
rasterizes both backends on the CPU.

An alpha-blended flat fill would cost one rectangle per cell and sidestep all of
this, and it is not what a terminal draws.

### Declared and inert

Most of what used to be listed here is gone. `Theme.selection`, `Theme.palette`,
`VtSource.getMode`, `CursorState.blink` and the `bell` event were declared and
read by nothing, so they were removed rather than left as traps for a consumer
who sets one and reasonably expects an effect. `RendererOptions.shaper` was the
other entry and went the other way: both backends now call it. What is left:

| surface | status |
| --- | --- |
| `atlasKeyBaked`, `quantize` | exported for a baked-foreground atlas mode that does not exist |
| `GlyphAtlas.onContextRestored` | dead code; the renderer rebuilds the atlas instead |

`atlasKeyBaked` and `quantize` are one unit, since the quantizer exists only to
build the baked key. Shaping has since settled the key scheme around them: a
shaped glyph carries its own atlas key from the shaper, so a baked-foreground
mode would have to compose with that rather than replace it.

## Performance gaps

### A scroll larger than the viewport repaints in full

Scrolling inside the viewport no longer rebuilds. WebGL2 addresses its instance
streams by slot and rotates the slot-to-screen-row map, so a scroll of n rows
rebuilds n rows and uploads n rows; Canvas2D blits the canvas onto itself and
repaints the n rows the blit uncovered. Both are asserted pixel-identical to a
full rebuild of the same frame, including when the scroll and a write land
together. The `scrollstorm` workload dropped from 40 dirty rows to 3, and its
CPU time from 1.10 ms to 0.14 ms on WebGL2 and 3.84 ms to 0.44 ms on Canvas2D.

Past a viewport's worth of movement there is nothing on screen to reuse, so the
crossover falls back to a full rebuild. That is the right answer rather than a
gap, but it does mean a page-down costs a full frame.

The shift also does nothing for a source that does not track damage and reports
every row dirty. Motion is cheap now; damage still costs what it costs.

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
are asserted by 128 unit tests and 27 browser tests, and the performance
properties are measured under software rasterization. What has not happened is
burn-in on a real GPU, at several device pixel ratios and grid sizes, with a
display attached. Until that exists, treat the GPU-side cost as unmeasured.
