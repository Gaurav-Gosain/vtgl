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

Working, not yet proven in production. This repository contains:

- The full API contract as TypeScript types (see DESIGN.md and src/types.ts).
- A WebGL2 glyph-atlas renderer: a dynamic multi-page atlas with LRU eviction,
  instanced background, glyph and decoration passes, and damage-driven buffer
  uploads that reuse the source's own dirty-row tracking.
- A Canvas2D renderer implementing the same interface, used both as the
  no-WebGL2 fallback and as the correctness reference for the WebGL2 path.
- createRenderer, which probes for WebGL2 and picks the backend for you.
- A scriptable fake VtSource and a set of golden scenarios shared by tests and
  benchmarks.
- Unit tests under node, browser tests under Playwright, and an esbuild build.

What is verified. The WebGL2 output is compared pixel by pixel against the
Canvas2D reference on every golden scenario, including wide CJK cells and ZWJ
emoji clusters, and must agree within a small tolerance. The browser suite also
pins the structural claims: draw calls stay fixed as the grid grows, clean
frames upload nothing, repeated frames hit the atlas cache, and a lost GPU
context is recovered.

What is not done. There is no contextual shaper yet, so Arabic joining is still
wrong (the hook and the string-keyed atlas are in place for it). Selection
overlays, ligatures, and subpixel antialiasing are unimplemented. Performance has
only been measured under software rendering, so the timings below are a floor
rather than a hardware result. See the gaps listed at the end of DESIGN.md.

The renderer has now been driven by a real ghostty-vt wasm buffer as well as by
the fake source: see the integration notes below.

The name vtgl is a working name and is trivial to change.

## Performance

Measured with `npm run bench:browser` on a 120x40 grid, forcing every row dirty
each frame so every scenario is a worst-case full-screen repaint. The figures
are the median CPU milliseconds spent inside render(), which covers rebuilding
the instance data and issuing the uploads and draws.

```
scenario   webgl2   canvas2d
ascii       0.7ms      3.5ms
cjk         0.6ms      2.2ms
emoji       0.6ms      1.3ms
churn       0.8ms      7.4ms
blank       0.2ms      0.1ms
```

Read these as relative signals. Headless chromium runs GL on SwiftShader, which
rasterizes on the CPU, so the absolute GPU-side cost in that environment is not
representative and no frame rate is claimed here. What does transfer is the
shape of the result: the WebGL2 path spends under a millisecond of CPU on a full
repaint that costs the per-cell fillText path several, and it issues a fixed
handful of draw calls no matter how many cells changed. The blank screen is the
one case where Canvas2D wins, because skipping almost every cell beats
uploading and drawing a full grid of mostly degenerate quads.

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
`npm run bench:browser` reports per-frame cost for both backends in the browser.

## Licensing

MIT. The renderer is fresh code. It mirrors the cell model of ghostty-vt (MIT)
and takes conceptual cues from the MIT-licensed ghostty-web canvas2d renderer,
but shares no code with either.
