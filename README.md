# vtgl

A standalone terminal renderer. It takes read-only VT grid state and produces
pixels and input events. It does not parse escape sequences, manage clipboard,
speak any wire protocol, or own the terminal buffer. Those belong to whatever
drives it. vtgl is the drawing layer only, in the same role xterm.js's renderer
plays, but backed by any grapheme-aware VT that implements a small read-only
interface.

The target VT is ghostty-vt (compiled to wasm), whose cell model the interface
mirrors, so it drops in as the reference source. Nothing in the renderer imports
the VT.

## Status

Working and reasonably well tested, but not yet proven on real hardware or in
production. What exists:

- The full API contract as TypeScript types (see DESIGN.md and src/types.ts).
- A WebGL2 glyph-atlas renderer: a dynamic multi-page atlas with LRU eviction,
  instanced background, glyph and decoration passes, and damage-driven buffer
  uploads that reuse the source's own dirty-row tracking.
- A Canvas2D renderer implementing the same interface, used both as the
  no-WebGL2 fallback and as the correctness reference for the WebGL2 path.
- createRenderer, which probes for WebGL2 and picks the backend for you.
- A scriptable fake VtSource, golden scenarios, the four workloads from the
  performance study, and a 24-cluster grapheme torture corpus.
- 82 unit tests under node, 16 browser tests under Playwright, a benchmark
  suite, and an esbuild build.

### What is verified

WebGL2 output is compared pixel by pixel against the Canvas2D reference on
every golden scenario, including wide CJK cells and ZWJ emoji clusters, and
must agree within a small tolerance. The browser suite also pins the structural
claims: draw calls stay fixed as the grid grows, clean frames upload nothing,
repeated frames hit the atlas cache, and a lost GPU context is recovered.

The renderer has been driven by a real ghostty-vt wasm buffer, not only by the
fake source, through the sip integration described below. The torture corpus is
checked against that real VT: for all 24 clusters, the cell widths and layout
vtgl assumes are the widths and layout ghostty-vt actually reports. Two of those
records were corrected by the measurement rather than confirmed by it, which is
the argument for doing it against a real VT instead of reasoning about Unicode.

Allocation is measured rather than asserted: a full 120x40 repaint of 4700
glyphs allocates a few hundred bytes. See BENCHMARKS.md.

### What is not done

- **No contextual shaper.** Arabic joining is still wrong: ghostty-vt puts one
  Arabic letter per cell, and vtgl draws each in isolated form, so a word does
  not join. The atlas is keyed by grapheme string precisely so shaped runs can
  slot into the same cache later, but the shaper itself is unwritten. This is
  the most visible correctness gap.
- **Performance is only measured under software rendering.** Headless GL is
  SwiftShader. The CPU-side numbers and draw-call counts transfer; the GPU-side
  cost does not, and no frame rate is claimed anywhere in this repository.
- **Scrolling repaints in full.** Moving the viewport forces a whole frame even
  though no cell changed. Correct, but the largest remaining optimisation.
- **Wide glyphs are clipped, not bled.** A glyph whose font advance exceeds the
  cells the VT assigned it is clipped by the atlas, where Canvas2D lets it paint
  outside. Measured on the torture corpus, Canvas2D bleeds on 9 of 24 entries
  and vtgl on none. Both behaviours are defensible; they are not identical, and
  the tests record each rather than pretending to parity.
- Selection overlays, ligatures, subpixel antialiasing, and the baked fg-quant
  atlas mode are unimplemented. Blink is implemented as a shader time gate but
  is untested, since no scenario sets the flag.

The name vtgl is a working name and is trivial to change.

## Performance

Summary only; BENCHMARKS.md has the full tables, the methodology and the
caveats. Measured with `npm run bench:browser` on a 120x40 grid, forcing every
row dirty so each scenario is a worst-case full-screen repaint. Figures are the
mean CPU milliseconds inside render().

```
scenario      webgl2   canvas2d   draw calls (webgl2 / canvas2d fillText)
ascii          0.67ms     3.58ms     5 / 4080
cjk            0.50ms     2.07ms     5 / 2390
emoji          0.52ms     1.44ms     5 / 1560
churn          0.83ms     7.05ms     5 / 4702
dump           1.17ms     3.41ms     5 / 3870
scrollstorm    0.71ms     5.16ms     3 / 3663
altscreen      0.43ms     1.00ms     5 / 1080
tui            0.26ms     0.24ms     4 / 125
blank          0.20ms     0.11ms     4 / 31
```

Read these as relative signals. Headless chromium runs GL on SwiftShader, which
rasterizes on the CPU, so the absolute GPU-side cost in that environment is not
representative and no frame rate is claimed here. What transfers is the shape:
the WebGL2 path spends well under a millisecond of CPU on a full repaint that
costs the per-cell fillText path several, and it issues a fixed handful of draw
calls no matter how many cells changed. Blank and idle screens are the cases
Canvas2D wins, because skipping almost every cell beats drawing a full grid of
mostly degenerate quads.

## Design

See DESIGN.md for the API contract, the atlas key scheme, the instanced pipeline
layout, the damage and upload strategy, the fallback contract, and the hook for
contextual shaping.

## Usage

```ts
import { createRenderer } from 'vtgl';

const renderer = createRenderer({
  fontFamily: 'monospace',
  fontSize: 14,
  theme: { foreground: 0xd0d0d0, background: 0x101010, cursor: 0xffffff },
});

renderer.mount(canvas);
renderer.resize(cols, rows, devicePixelRatio);

// Each frame, hand the renderer a read-only VtSource and the top viewport row.
renderer.render(source, viewportY);
```

The source is any object implementing the VtSource interface in src/types.ts.
For tests and experiments, FakeSource in src/testing provides a scriptable grid.

### Vendoring the built bundle

Consumers with no npm pipeline can vendor a single file. `npm run build:vendor`
emits `dist/vtgl.vendor.js`, a minified dependency-free ESM module with a banner
recording the version and git revision it was built from, which a browser can
import directly.

## Integrating with a real VT

vtgl has been integrated into sip, which renders terminals in the browser over
ghostty-vt wasm. That integration is the reference for what adapting a real VT
involves, and it needed no changes to the renderer core. Three things came up
that are worth knowing before writing another adapter.

Coordinate translation. vtgl addresses rows absolutely across scrollback plus
the active screen. A VT that reports screen-relative rows plus a separate
scrollback accessor needs a mapping layer, and the viewport row vtgl is asked to
draw is the absolute row at the top of the screen, not a scroll offset.

Default colors. ghostty-vt reports rgb(0,0,0) for "use the terminal default"
rather than for black. vtgl expects colors already resolved, so the adapter has
to substitute the theme's foreground and background. A renderer that skips this
draws black-on-black.

Cell geometry. vtgl derives its cell box from fontSize, lineHeight and
letterSpacing rather than accepting a measured cell size. When an existing
renderer's geometry has to stay authoritative (so that switching renderers does
not reflow the terminal or move mouse hit-testing), solve for lineHeight and
letterSpacing from the measured cell instead of forcing the host onto vtgl's
numbers. Because both depend on device pixel ratio, a DPR change means rebuilding
the renderer rather than only resizing it.

Coexisting with another renderer. A WebGL2 context and a 2D context cannot share
a canvas, so vtgl needs its own. In sip it sits behind the incumbent 2D canvas,
which becomes a transparent overlay still responsible for the cursor, kitty
graphics, the scrollbar and the selection tint. vtgl draws no selection, so a
host with selection has to draw it itself.

## Development

```
npm install
npm run typecheck
npm run test
npm run test:browser
npm run build
```

`npm run check` runs all of the above in order.

Node 24 or newer is required for the type-stripping test runner. The browser
tests drive the system chromium at /usr/bin/chromium and download no browser
binaries; point VTGL_CHROMIUM at another executable to override it. They load
the harness from disk over a file URL, so no static server is involved.

`npm run bench` reports Canvas2D draw-decision counts under node.
`npm run bench:browser` reports per-frame cost, draw calls, atlas traffic and
sampled allocation for both backends in the browser. See BENCHMARKS.md.

## Licensing

MIT. The renderer is fresh code. It mirrors the cell model of ghostty-vt (MIT)
and takes conceptual cues from the MIT-licensed ghostty-web canvas2d renderer,
but shares no code with either.
