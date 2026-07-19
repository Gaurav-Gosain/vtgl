# Benchmarks

Reproduce with `npm run bench:browser`. Everything below is a single run on one
machine in headless chromium; treat the numbers as the shape of the result, not
as a specification.

## What this environment can and cannot tell you

Headless chromium runs WebGL on SwiftShader, which rasterizes on the CPU. The
GPU-side cost measured here is therefore software emulation and says nothing
about real hardware. Concretely:

- `syncP50` (130 to 160 ms) is the wall time of a frame with a forced 1x1
  readback that blocks until the pipeline drains. Under SwiftShader that is the
  cost of rasterizing every pixel in software. It is not a hardware figure and
  no frame rate is claimed from it.
- `cpuP50` / `cpuMean` (the time inside `render()`, spent walking the grid,
  building instance data and issuing uploads and draws) is CPU work that a real
  GPU does not remove. This transfers.
- Draw calls transfer. They are a property of the pipeline, not the rasterizer.
- Allocation transfers.

So the 60 fps question, restated in terms this harness can actually answer: is
the CPU-side per-frame work well under 16 ms, and is the draw-call count flat?
Both are answered below. What remains genuinely unanswered is GPU-side cost on
real hardware, which needs the burn-in listed at the end.

`cpuMean` rather than `cpuP50` is used for every ratio. Chromium clamps
`performance.now()` to 100 microseconds, so a single sub-millisecond sample
carries one significant digit; an early version of this table reported a "100x"
speedup that was entirely timer quantisation.

## Full-screen repaint, 120x40

Every visible row forced dirty each frame, which is the worst case rather than
any real workload. 60 frames after a 10-frame warmup.

| scenario | webgl2 cpu | canvas2d cpu | ratio | webgl2 draws | canvas2d draws |
| --- | --- | --- | --- | --- | --- |
| ascii | 0.67 ms | 3.58 ms | 5.4x | 5 | 4080 |
| cjk | 0.50 ms | 2.07 ms | 4.1x | 5 | 2390 |
| emoji | 0.52 ms | 1.44 ms | 2.8x | 5 | 1560 |
| churn | 0.83 ms | 7.05 ms | 8.5x | 5 | 4702 |
| blank | 0.20 ms | 0.11 ms | 0.6x | 4 | 31 |
| dump | 1.17 ms | 3.41 ms | 2.9x | 5 | 3870 |
| altscreen | 0.43 ms | 1.00 ms | 2.3x | 5 | 1080 |
| scrollstorm | 0.71 ms | 5.16 ms | 7.3x | 3 | 3663 |
| tui | 0.26 ms | 0.24 ms | 0.9x | 4 | 125 |

The Canvas2D "draws" column is its `fillText` count, which is the honest
comparison: the 2D path issues one text draw per non-blank cell, the WebGL path
issues three to five draw calls for the entire grid regardless of size.

Blank and tui are the two cases Canvas2D wins or ties. Both are nearly empty
screens, and skipping almost every cell beats uploading and drawing a full grid
of mostly degenerate quads. This is a real property of the design, not noise.

## The study workloads at their natural damage

The table above forces every row dirty. These are the same workloads left to
produce the damage they actually produce, which is what the original study
measured against the 2D bundle.

| workload | dirty rows | webgl2 cpu | canvas2d cpu | ratio |
| --- | --- | --- | --- | --- |
| dump (colored log scrolling) | 40 | 1.27 ms | 3.28 ms | 2.6x |
| altscreen (animated panel) | 8 | 0.21 ms | 0.62 ms | 3.0x |
| scrollstorm (viewport dragged) | 40 | 1.04 ms | 3.30 ms | 3.2x |
| tui (idle, status line ticks) | 1 | 0.06 ms | 0.07 ms | 1.1x |

Two things worth reading off this. A dump genuinely dirties the whole screen
every frame, so damage tracking buys nothing there and the win is entirely the
draw-call collapse. An idle TUI dirties one row, both backends are effectively
free, and the renderer choice does not matter.

Scrollstorm shows 40 dirty rows in natural mode despite nothing being written,
because vtgl currently repaints in full whenever the viewport moves. That is
correct but pessimistic, and it is the largest remaining optimisation: shifting
instance data by the scroll delta would make a one-line scroll cost about what
a one-line edit costs.

## Comparison against the previously measured 2D bundle

The earlier study measured roughly 100 to 126 ms per painted frame for the
shipped ghostty-web 2D renderer on these workloads in a software harness. This
suite does not reproduce that figure and should not be read as contradicting it.
The Canvas2D column here is vtgl's own fallback renderer, which is a different
implementation: it shares the cell-metric code with the WebGL path, skips blank
cells, and does no selection, link or kitty work. It is a clean-room reference
for pixel parity, not the incumbent bundle.

The one number that is comparable across both harnesses is `syncP50`, which
includes the forced software rasterization: 130 to 160 ms, the same order as the
study's 100 to 126 ms. That similarity is a property of SwiftShader, not of
either renderer.

The defensible claim from this suite is the relative one: against a per-cell
`fillText` renderer on the same machine in the same browser, the glyph-atlas
path spends 3x to 9x less CPU on a full repaint and issues a fixed handful of
draw calls instead of thousands.

## Allocation

Sampled with the CDP heap profiler over 100 frames of static content with every
row forced dirty, so the measured window contains `render()` and nothing else.

| workload | glyphs/frame | webgl2 bytes/frame | webgl2 bytes/glyph |
| --- | --- | --- | --- |
| dump | 3865 | 65 | 0.02 |
| altscreen | 1080 | 196 | 0.18 |
| scrollstorm | 3620 | 406 | 0.11 |
| tui | 125 | 88 | 0.70 |
| churn | 4703 | 321 | 0.07 |

A full 120x40 repaint of 4700 glyphs allocates a few hundred bytes total. The
near-zero-allocation goal is met: there is no per-cell allocation, and the
residue is the short-lived atlas key string built per dirty cell, which interning
by codepoint would remove.

Sampled heap deltas were tried first and discarded. `usedJSHeapSize` is a
snapshot of a collected heap, so a GC inside the measurement window produces a
negative allocation figure; the first version of this table reported minus 29 KB
per frame. Sampling allocations as they happen survives collection.

## Atlas behaviour

Across every workload, atlas uploads in steady state are zero: once the glyph
set has been rastered, a full-screen repaint uploads nothing and the draws are
all cache hits. Foreground colour is tinted per instance rather than baked into
the key, so the colored dump (24-bit SGR on every cell) causes no atlas traffic
at all. The `dump` row confirms this directly.

## Contextual shaping

`npm run bench:browser` reports this as "contextual shaping cost". It measures
the same scenario twice back to back, once with `arabicShaper()` configured and
once without, five interleaved rounds, and reports the median of the per-round
ratios. Interleaving is not optional here: absolute timings on this machine
drift by a factor of two over the minutes a run takes, so an off-run and an
on-run measured apart are not comparable. Only the paired ratio is.

| scenario | backend | shaper off | shaper on | median ratio |
| --- | --- | --- | --- | --- |
| ascii | webgl2 | 2.05 ms | 2.28 ms | 1.03x |
| ascii | canvas2d | 11.15 ms | 10.72 ms | 0.96x |
| arabic | webgl2 | 2.36 ms | 4.52 ms | 1.98x |
| arabic | canvas2d | 4.17 ms | 12.34 ms | 2.96x |
| dump | webgl2 | 1.43 ms | 1.65 ms | 0.91x |
| dump | canvas2d | 6.15 ms | 5.38 ms | 1.14x |

Two results, and the difference between them is the point.

**On content with no Arabic in it, the cost is not measurable.** The `ascii` and
`dump` ratios straddle 1.0 and their individual rounds scatter from 0.69x to
2.06x, so the noise floor on this machine is around 35%. The honest reading is
"below the noise", not "zero": what the shaper adds on those rows is a code
point range compare per cell on each dirty row, and the compare rejects before
anything else is touched. It is not free, it is just smaller than this
environment can see.

**On an all-Arabic screen it roughly doubles WebGL2 and triples Canvas2D.** The
`arabic` scenario is deliberately the worst case: 120x40 with one Arabic letter
per cell, so nearly every cell belongs to a run that has to be grouped, shaped
and reordered every dirty row. Those ratios are consistent across all five
rounds (1.70x to 2.14x, and 2.08x to 3.36x), well clear of the noise.

Canvas2D costs more than WebGL2 for a structural reason. The WebGL path rasters
each shaped form once into the atlas and every later frame is a cache hit, so
what it pays per frame is the grouping and the shaping decision. Canvas2D has no
glyph cache, so it also re-runs a save, a scale and a fillText per shaped cell
every frame. Advance measurement is memoised per cluster and font, which is what
keeps that figure from being worse still.

This is why the shaper is opt-in rather than on by default. A host that renders
Arabic can pay it; a host that does not should not have to reason about whether
it is paying it.

## What would change on real hardware

The CPU column stays roughly as measured, because it is grid-walking and buffer
building. The `syncP50` column collapses, because that is the part SwiftShader is
emulating. Draw calls do not change. The expectation, unverified, is that a
120x40 full repaint lands comfortably inside a 16 ms budget on any GPU that
supports WebGL2, with the CPU side (0.2 to 1.3 ms measured here) as the floor.

That expectation is the thing to test in burn-in, on a real GPU, at several
device pixel ratios and grid sizes, with a display attached.
