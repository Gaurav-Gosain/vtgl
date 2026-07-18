# vtgl

vtgl is a WebGL2 glyph-atlas renderer for terminal grids. You give it read-only
VT state and a viewport row; it draws the frame. It does not parse escape
sequences, own a buffer, manage the clipboard, or speak any wire protocol, so it
is the drawing layer only, in roughly the role xterm.js's WebGL addon plays for
xterm.js.

The difference is the seam. vtgl reads its state through a small interface,
`VtSource`, so it can be driven by any grapheme-aware VT you like. The reference
source is ghostty-vt compiled to wasm, whose cell model the interface mirrors,
but nothing in the renderer imports a VT. It is for people building a terminal
in the browser who already have (or want to choose) their own VT implementation.

## Installation

```
npm install vtgl
```

The package ships ESM with type declarations. If you have no npm pipeline,
`npm run build:vendor` emits `dist/vtgl.vendor.js`, a minified dependency-free
ESM module carrying a banner with the version and git revision it was built
from, which a browser can import directly.

## A minimal example

```ts
import { createRenderer } from 'vtgl';

const canvas = document.querySelector('canvas')!;

const renderer = createRenderer({
  fontFamily: 'monospace',
  fontSize: 14,
  theme: {
    foreground: 0xd0d0d0,
    background: 0x101010,
    cursor: 0xffffff,
  },
});

renderer.mount(canvas);
renderer.resize(80, 24, window.devicePixelRatio);

// Each frame: hand over a VtSource and the absolute row at the top of the
// viewport. With no scrollback scrolled into view, that is source.scrollbackRows.
renderer.render(source, source.scrollbackRows);
```

`createRenderer` probes for WebGL2 and returns the Canvas2D fallback when it is
absent, so callers never branch on backend. To force one, construct
`WebGL2Renderer` or `Canvas2DRenderer` directly; both implement the identical
`Renderer` interface.

For experimenting before you have a VT wired up, `FakeSource` in
`src/testing/fake-source.ts` is a scriptable grid implementing `VtSource`.

## A realistic example

What vtgl is actually good at is redrawing a busy grid cheaply: the per-frame
cost tracks the number of damaged rows, and the draw-call count stays flat no
matter how much changed. A real loop therefore leans on the source's own damage
tracking and coalesces render requests to one per animation frame.

```ts
import { createRenderer } from 'vtgl';

const renderer = createRenderer({
  fontFamily: '"JetBrains Mono", monospace',
  fontSize: 14,
  lineHeight: 1.2,
  dpr: window.devicePixelRatio,
  theme,
  // ghostty-vt pre-resolves inverse; a source that does not should set this.
  resolveInverse: false,
});
renderer.mount(canvas);

let viewportY = source.scrollbackRows;

// requestRender coalesces any number of requests within one animation frame
// into a single render. The driver, not the renderer, owns dirty state.
renderer.on('render', () => vt.clearDirty());

vt.onData(() => renderer.requestRender(source, viewportY));

// Scrolling is a viewport move, not a write.
canvas.addEventListener('wheel', (e) => {
  viewportY = Math.max(
    0,
    Math.min(source.scrollbackRows, viewportY + Math.sign(e.deltaY) * 3),
  );
  renderer.requestRender(source, viewportY);
});

// Hit testing for selection or mouse reporting.
canvas.addEventListener('mousedown', (e) => {
  const rect = canvas.getBoundingClientRect();
  const cell = renderer.cellAtPixel(e.clientX - rect.left, e.clientY - rect.top);
  if (cell) console.log('clicked absolute row', cell.row, 'col', cell.col);
});

// Per-frame instrumentation.
renderer.on('render', (stats) => {
  console.log(stats.dirtyRows, stats.glyphs, stats.drawCalls, stats.cpuMs);
});

// A DPR change (window moved to another display) needs a resize with the new
// value; this rebuilds the atlas, since cell geometry drove its slot sizes.
matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener(
  'change',
  () => renderer.resize(cols, rows, window.devicePixelRatio),
);
```

## The VtSource contract

Implementing `VtSource` is how you adopt vtgl, so it is worth reading closely.
The renderer treats it as strictly read-only and never mutates it.

**Row coordinates are absolute across the whole buffer.** This is the single
thing adapters get wrong most often:

```
row in [0, scrollbackRows)                     -> scrollback, oldest first
row in [scrollbackRows, scrollbackRows + rows) -> the active screen
```

`render(source, viewportY)` draws `rows` lines starting at absolute row
`viewportY`. So `viewportY === scrollbackRows` means "bottom, no scrollback
visible", and `viewportY === 0` means "scrolled to the very top". A VT that
reports screen-relative rows plus a separate scrollback accessor needs a mapping
layer here. `viewportY` is an absolute row, not a scroll offset.

```ts
interface VtSource {
  readonly rows: number;            // visible viewport height
  readonly cols: number;            // width in columns
  readonly scrollbackRows: number;  // rows available above the active screen

  getLine(row: number): LineView;
  getCell(row: number, col: number): Cell;
  getGraphemeString(row: number, col: number): string;

  getCursor(): CursorState;

  // True if the absolute row changed since the driver last cleared dirty state.
  // A source with no damage tracking may return true always: correct, slower.
  isRowDirty(row: number): boolean;

  // Optional DEC/ANSI mode query, e.g. 2026 synchronized output. May be omitted.
  getMode?(mode: number): boolean;
}
```

`getLine` returns a `LineView`, the allocation-free row accessor the hot path
uses. The renderer's inner loop reads numeric fields per column and never
materializes a cell object:

```ts
interface LineView {
  readonly length: number;   // equals source.cols
  codepoint(col: number): number;
  grapheme(col: number): string;  // may allocate; called only for drawable cells
  width(col: number): number;
  fg(col: number): Rgb;
  bg(col: number): Rgb;
  flags(col: number): number;
}
```

Rules your implementation must honour:

- **`width` is display columns**: 1 normal, 2 for a wide cell (CJK, most emoji),
  and 0 for the spacer tail that follows a wide cell. The renderer skips
  width-0 columns; getting this wrong is what makes CJK overlap.
- **`grapheme` returns the whole cluster**, not the first scalar. A ZWJ family
  emoji is one string on the head cell. The atlas is keyed by this string, which
  is what makes cluster rendering correct without a shaper.
- **`codepoint` 0 or 32 marks a blank cell**, which lets the renderer skip
  glyph work while still painting the background.
- **Colors are already resolved.** `fg` and `bg` are packed 24-bit `0xRRGGBB`.
  The renderer does no palette lookup. If your VT reports a sentinel for "use
  the terminal default" (ghostty-vt reports `rgb(0,0,0)`), your adapter must
  substitute the theme's foreground and background, or you will draw black on
  black. A `Theme.palette` field exists for sources that emit indices instead.
- **Inverse** is either pre-resolved by you, or handled by the renderer if you
  set `resolveInverse: true` in the options. Do not do both.
- **`flags`** is a bitfield of `CellFlags`: `BOLD`, `ITALIC`, `UNDERLINE`,
  `STRIKETHROUGH`, `INVERSE`, `INVISIBLE`, `BLINK`, `FAINT`. The values match
  the ghostty-vt layout so the reference adapter passes them through unchanged.
- **`isRowDirty` is read-only for the renderer.** Whoever drives the source owns
  clearing dirty state, out of band from `render()`.

`getCursor` returns `{ x, y, visible, shape, blink }` where `x` is a 0-based
column and `y` is an **absolute** buffer row, shape is `'block' | 'bar' |
'underline'`, and `blink` says whether the cursor is in its visible phase right
now (the renderer does not run a blink clock for you).

## The Renderer interface

Both backends implement exactly this.

```ts
interface Renderer {
  readonly backend: 'webgl2' | 'canvas2d';

  mount(canvas: HTMLCanvasElement | OffscreenCanvas): void;

  render(source: VtSource, viewportY: number): void;      // draw now
  requestRender(source: VtSource, viewportY: number): void; // coalesce to next frame
  flushRender(): void;                                     // draw any booked frame now

  resize(cols: number, rows: number, dpr: number): void;  // forces a full redraw
  setTheme(theme: Theme): void;                            // forces a full redraw
  getMetrics(): Metrics;

  cellAtPixel(px: number, py: number): CellCoord | null;   // CSS px -> cell
  pixelForCell(col: number, row: number): PixelRect;       // cell -> CSS px

  on<K>(event: K, handler: (payload) => void): () => void; // returns an unsubscribe
  off<K>(event: K, handler: (payload) => void): void;

  dispose(): void;
}
```

`RendererOptions` takes `fontFamily`, `fontSize`, optional `lineHeight`
(default 1.2), `letterSpacing`, `dpr`, a `theme`, `resolveInverse`, and an
optional `shaper`. `getMetrics()` reports both device-pixel and CSS-pixel cell
sizes, the baseline offset, the backing store size, and the resolved font
settings, which is what you need to keep a host application's geometry in sync.

Events are `render` (a `RenderStats` with `dirtyRows`, `glyphs`, `drawCalls`,
`atlasUploads`, `full` and `cpuMs`) and `cursorMove` (a `CellCoord`). A `bell`
event is declared in the type map but is never emitted, because the renderer has
no VT event stream to raise it from; raise it yourself from your VT.

Also exported: `supportsWebGL2()`, `RenderScheduler`, `computeCellMetrics` and
`measureFont`, the atlas internals (`GlyphAtlas`, `AtlasPacker`,
`ShelfAllocator`, `atlasKey`, `styleMask`), `InstanceBuffers`, the color helpers
(`rgb`, `toCss`, `quantize`), and `Emitter`.

## How it works

**Glyph atlas.** Rasterized glyphs live in a dynamic multi-page texture atlas,
packed by a shelf allocator with LRU eviction across pages. The key is the
grapheme cluster string plus a style mask, not a codepoint, which is why a ZWJ
emoji or a combining stack caches as one entry and draws as one glyph.
Foreground colour is tinted per instance rather than baked into the key, so a
log dump with 24-bit SGR on every cell causes no atlas traffic at all.

**Instanced rendering.** Each frame builds instance data for a quad pipeline and
issues separate background, glyph, decoration and cursor passes. That is three
to five draw calls for the whole grid regardless of its size, against one
`fillText` per non-blank cell for a 2D renderer. The instance buffers are
preallocated and reused; a full 120x40 repaint of 4700 glyphs allocates a few
hundred bytes, all of it the short-lived atlas key string.

**Damage-driven uploads.** The renderer reads the source's own `isRowDirty` and
uploads only the rows that changed, so an idle TUI ticking a status line costs
one row of work. A clean frame uploads nothing. Full redraws are forced only on
mount, resize, theme change, and viewport movement.

**Canvas2D fallback.** A second renderer implements the same interface, shares
the cell-metric code, and is selected automatically when WebGL2 is missing. It
doubles as the correctness reference: the browser suite compares WebGL2 output
against it pixel by pixel on every scenario.

**Context loss.** `webglcontextlost` and `webglcontextrestored` are handled; the
renderer tears down and rebuilds its GPU resources and forces a full redraw.

## Status and limitations

Working and reasonably well tested, but not proven on real hardware or in
production. Verified: WebGL2 output matches the Canvas2D reference pixel by
pixel on every golden scenario including wide CJK and ZWJ emoji; draw calls stay
fixed as the grid grows; clean frames upload nothing; repeated frames hit the
atlas cache; a lost context is recovered. All 24 clusters of a Unicode torture
corpus (CJK, ZWJ emoji, flags, keycaps, skin tones, VS15 and VS16, combining
stacks, Devanagari) were checked against a real ghostty-vt wasm buffer rather
than reasoned about, and two corpus records were corrected by that measurement.

What is not done:

- **No contextual shaping.** Arabic joining is wrong: the VT puts one Arabic
  letter per cell and vtgl draws each in isolated form, so a word does not join.
  This is the most visible correctness gap. It is also not a gap relative to the
  obvious alternative, since xterm.js does not do contextual shaping either. The
  atlas is keyed by string specifically so shaped runs can slot into the same
  cache later, and the `ShaperHook` interface is defined for it, but the shaper
  itself is unwritten.
- **Scrolling repaints in full.** Moving the viewport forces a whole frame even
  though no cell changed. Correct but pessimistic, and the largest remaining
  optimisation: shifting instance data by the scroll delta would make a one-line
  scroll cost about what a one-line edit costs.
- **A DPR change rebuilds rather than rescales.** Cell geometry drove the atlas
  slot sizes, so `resize()` with a new device pixel ratio throws the atlas away
  and rebuilds it.
- **Blink is implemented but untested.** It exists as a time gate in the glyph
  shader; no scenario sets the flag, so it has never been exercised. The
  Canvas2D fallback ignores blink entirely.
- **Wide glyphs are clipped, not bled.** A glyph whose font advance exceeds the
  cells the VT assigned it is clipped by the atlas, where Canvas2D lets it paint
  outside. On the torture corpus, Canvas2D bleeds on 9 of 24 entries and vtgl on
  none. Both behaviours are defensible; the tests record each rather than
  pretending they match.
- **No selection overlays, ligatures, or subpixel antialiasing.** A host that
  wants selection draws it itself. The baked foreground-quantized atlas mode is
  also unimplemented.
- **Benchmarks were measured under software rasterization.** See below.

## Performance

Full tables, methodology and caveats are in [BENCHMARKS.md](BENCHMARKS.md).
Measured with `npm run bench:browser` on a 120x40 grid, forcing every row dirty
so each scenario is a worst-case full-screen repaint. Figures are mean CPU
milliseconds inside `render()`.

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

Read these as relative signals only. Headless chromium runs GL on SwiftShader,
which rasterizes on the CPU, so GPU-side cost in that environment is software
emulation and **no frame rate is claimed anywhere in this repository**. What
transfers is the CPU-side figure (grid walking and buffer building, which a real
GPU does not remove), the draw-call counts, and the allocation numbers. What
remains genuinely unmeasured is GPU cost on real hardware.

Blank and idle screens are the cases Canvas2D wins, because skipping almost
every cell beats drawing a full grid of mostly degenerate quads. That is a real
property of the design, not noise.

## Comparison with xterm.js

xterm.js is the obvious alternative and, for most people, the right answer. It
is mature, battle-tested in VS Code and everywhere else, and it is a complete
terminal: parser, buffer, input handling, selection, links, accessibility,
addons. vtgl is a renderer and nothing else, and it has not been through a
fraction of the same production exposure.

The renderer architecture is not the differentiator. xterm.js's WebGL addon uses
the same approach vtgl does, a glyph atlas with instanced draws, and vtgl's
font-measurement and render-scheduling code deliberately follows theirs (see
[THIRD-PARTY.md](THIRD-PARTY.md)). Expect comparable rendering performance, not
a leap.

The two real differences:

- **The VT is pluggable.** xterm.js's renderer draws from the xterm.js buffer.
  vtgl draws from anything implementing `VtSource`, which is the point of the
  library: if you want a different VT (a wasm one, a server-side one, one with
  different scrollback semantics) you can keep it and still get a GPU renderer.
- **Grapheme correctness comes from the source.** Because the atlas keys on the
  cluster string supplied by the VT, a ghostty-vt-backed vtgl renders ZWJ
  sequences, skin-tone modifiers, variation selectors and combining stacks as
  the VT segmented them, verified against that VT rather than against an
  independent guess about Unicode.

Neither project does contextual shaping, so Arabic is not a reason to choose one
over the other.

If you want a terminal, use xterm.js. If you are building one and want to own
the VT, vtgl is the renderer half.

## Development

```
npm install
npm run typecheck
npm run test          # 100 unit tests under node
npm run test:browser  # 16 Playwright tests
npm run build
```

`npm run check` runs all of the above in order.

Node 24 or newer is required for the type-stripping test runner. The browser
tests drive the system chromium at `/usr/bin/chromium` and download no browser
binaries; point `VTGL_CHROMIUM` at another executable to override. They load the
harness from disk over a `file://` URL, so no static server is involved.

`npm run bench` reports Canvas2D draw-decision counts under node.
`npm run bench:browser` reports per-frame cost, draw calls, atlas traffic and
sampled allocation for both backends in the browser.

[DESIGN.md](DESIGN.md) covers the API contract, the atlas key scheme, the
instanced pipeline layout, the damage and upload strategy, the fallback
contract, and the shaping hook.

## License

MIT. See [LICENSE](LICENSE).

The renderer is fresh code and vendors no third-party source. Two modules follow
approaches taken in xterm.js (also MIT): the font measurement in
`src/renderer/metrics.ts` and the render scheduling in
`src/renderer/scheduler.ts`. [THIRD-PARTY.md](THIRD-PARTY.md) records that
provenance in full. vtgl mirrors the cell model of ghostty-vt (MIT) and takes
conceptual cues from the MIT-licensed ghostty-web Canvas2D renderer, but shares
code with neither.
