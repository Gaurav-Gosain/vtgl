# API

Every type below lives in [src/types.ts](../src/types.ts) and is re-exported
from the package root. Where a field is part of the contract but not read by
either backend today, this document says so on the field.

## createRenderer

```ts
function supportsWebGL2(): boolean;
function createRenderer(options: RendererOptions): Renderer;
```

`supportsWebGL2()` probes a throwaway canvas for a `webgl2` context and returns
false rather than throwing in an environment with no `document`.
`createRenderer` returns a `WebGL2Renderer` when the probe succeeds and the
constructor does not throw, and a `Canvas2DRenderer` otherwise, typed as
`Renderer` either way. To force a backend, construct either class directly; both
implement the identical interface.

Call order is `mount` then `resize` then `render`. `render()` before `mount()`
throws. `resize()` before `mount()` records the geometry but cannot size GPU
buffers or build an atlas, so it is not useful on its own. If the source's
`cols`/`rows` disagree with the last `resize()`, `render()` adopts the source's
dimensions and resizes itself, which forces a full redraw and rebuilds the
atlas.

## VtSource

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

Row arguments are absolute buffer rows: `[0, scrollbackRows)` is scrollback,
oldest first, and `[scrollbackRows, scrollbackRows + rows)` is the active
screen.

`getLine` is the only accessor on the hot path; `getCell` and
`getGraphemeString` exist for host convenience and are called by no render path.

There is no mode query. A host that wants to defer frames during a synchronized
update (DEC 2026) does that in its own driver, by not calling `requestRender`
until the update closes, which is where the decision belongs.

### LineView

```ts
interface LineView {
  readonly length: number;        // equals source.cols
  codepoint(col: number): number;
  grapheme(col: number): string;
  width(col: number): number;
  fg(col: number): Rgb;
  bg(col: number): Rgb;
  flags(col: number): number;
}
```

The numeric accessors are called once per column per dirty row and must not
allocate. `grapheme(col)` may allocate; it is called only for cells that are
non-blank, non-invisible and non-spacer, and once more for the cell under a
block cursor.

`width(col)` is display columns: 1 normal, 2 wide, 0 for the spacer tail after a
wide cell. `codepoint(col)` of 0 or 32 marks the cell blank, which skips glyph
work while still painting the background.

### Cell

```ts
interface Cell {
  codepoint: number;
  grapheme: string;
  width: number;
  fg: Rgb;
  bg: Rgb;
  flags: number;
}
```

### CursorState

```ts
interface CursorState {
  x: number;                             // 0-based column
  y: number;                             // absolute buffer row
  visible: boolean;
  shape: 'block' | 'bar' | 'underline';
}
```

A cursor outside the drawn viewport, or outside the column range, is skipped. A
block cursor paints the cell in `theme.cursor` and repaints the covered glyph in
`theme.cursorText` (defaulting to `theme.background`). Bar and underline cursors
are `max(1, round(dpr * 2))` device pixels thick.

There is no `blink` field and no blink clock: the renderer draws when it is
asked to. A host that wants a blinking cursor toggles `visible` in its own
source on its own timer and calls `requestRender`.

Canvas2D repaints the row a moved cursor left, because the cursor lives in the
same pixels as the text and its movement is not damage. Without that, a block
cursor would survive on a row the source never marks dirty.

### CellFlags

```ts
const CellFlags = {
  NONE: 0, BOLD: 1, ITALIC: 2, UNDERLINE: 4, STRIKETHROUGH: 8,
  INVERSE: 16, INVISIBLE: 32, BLINK: 64, FAINT: 128,
};
```

Values match ghostty-vt's cell flag layout so an adapter over that wasm passes
flags through unchanged. `BOLD` and `ITALIC` select the raster font and are the
only two flags in the atlas key (`styleMask`). `UNDERLINE` and `STRIKETHROUGH`
become decoration quads. `INVERSE` swaps fg and bg only when
`resolveInverse: true`. `INVISIBLE` paints the background and skips the glyph.
`FAINT` halves glyph alpha. `BLINK` gates glyph alpha on a 500 ms phase in the
WebGL2 shader and is ignored by the Canvas2D fallback.

## RendererOptions

```ts
interface RendererOptions {
  fontFamily: string;      // CSS font stack; the renderer's only font input
  fontSize: number;        // CSS px
  lineHeight?: number;     // multiplier on the face's line box, default 1.2
  letterSpacing?: number;  // CSS px added to the measured advance
  dpr?: number;            // default devicePixelRatio, or 1
  theme: Theme;
  resolveInverse?: boolean;  // default false
  shaper?: ShaperHook;       // accepted and currently ignored
}
```

Fonts enter here and nowhere else, and the options are copied at construction,
so changing the font family or size means constructing a new renderer.
`setTheme()` carries colors only and never touches fonts.

`letterSpacing` widens the cell; it does not offset the glyph inside it.

## Theme

```ts
interface Theme {
  foreground: Rgb;   // packed 0xRRGGBB
  background: Rgb;
  cursor: Rgb;
  cursorText?: Rgb;  // defaults to background
}
```

`background` is the GL clear color, the Canvas2D full-frame and per-row band
fill, the value `InstanceBuffers.clearAll` writes into the background stream,
and the Canvas2D blank-cell skip test. `foreground` is read by neither backend:
every glyph takes its color from the cell's own `fg`, so `foreground` is there
for a host adapter to substitute when its VT reports a default-color sentinel.
`cursor` and `cursorText` are read on every visible-cursor frame.

There is no selection color and no palette. Selection is a host concern, drawn
as the host's own overlay over the canvas, and colors arrive from the source
already resolved to 24-bit RGB, so the renderer has no palette to index.

## Renderer

```ts
interface Renderer {
  readonly backend: 'webgl2' | 'canvas2d';

  mount(canvas: HTMLCanvasElement | OffscreenCanvas): void;
  render(source: VtSource, viewportY: number): void;
  requestRender(source: VtSource, viewportY: number): void;
  flushRender(): void;
  resize(cols: number, rows: number, dpr: number): void;
  setTheme(theme: Theme): void;
  getMetrics(): Metrics;
  cellAtPixel(px: number, py: number): CellCoord | null;
  pixelForCell(col: number, row: number): PixelRect;
  on<K extends keyof RendererEventMap>(e: K, h: (p: RendererEventMap[K]) => void): () => void;
  off<K extends keyof RendererEventMap>(e: K, h: (p: RendererEventMap[K]) => void): void;
  dispose(): void;
}
```

`requestRender` overwrites any frame already booked for this animation frame and
schedules one render; the source and `viewportY` used are those of the last call
before the frame fires. `flushRender` runs a booked frame immediately, which is
what you want before an observable side effect such as a resize or a teardown.

`resize` and `setTheme` both force a full redraw on the next frame. On the WebGL2
path `resize` additionally reallocates instance buffers, resizes the backing
store, and rebuilds the atlas, since cell geometry determined the slot sizes.

`dispose` cancels any booked frame, removes the context-loss listeners, deletes
programs, buffers, vertex array objects and the atlas texture, and clears all
event handlers.

### Coordinates

`cellAtPixel(px, py)` takes CSS pixels relative to the canvas and returns a
**viewport-relative** row in `[0, rows)` together with a column, or null outside
the grid. Add `viewportY` yourself to get an absolute buffer row.
`pixelForCell(col, row)` is the inverse and also takes a viewport row.

`cursorMove`, by contrast, reports an **absolute** row, because it is derived
from `CursorState.y`. The two uses of `CellCoord` differ; the type carries no
marker for which is which.

### Metrics

```ts
interface Metrics {
  cols: number; rows: number;
  cellWidth: number; cellHeight: number;        // device px
  cssCellWidth: number; cssCellHeight: number;  // CSS px
  baseline: number;                             // device px from the cell top
  dpr: number;
  canvasWidth: number; canvasHeight: number;    // device px backing store
  fontFamily: string; fontSize: number; lineHeight: number;
}
```

The renderer sets `canvas.width` and `canvas.height` (the backing store) and
nothing else. CSS size is the host's job: divide `canvasWidth`/`canvasHeight` by
`dpr`, or lay the canvas out and derive the grid size from `cssCellWidth` and
`cssCellHeight`.

### Events

```ts
interface RendererEventMap {
  render: RenderStats;
  cursorMove: CellCoord;
}

interface RenderStats {
  dirtyRows: number;     // rows rebuilt this frame, including rows a scroll uncovered
  glyphs: number;        // glyph instances (WebGL2) or fillText calls (Canvas2D)
  drawCalls: number;     // 3 to 5 on WebGL2; always 1 on Canvas2D
  atlasUploads: number;  // raster and upload count this frame; 0 on Canvas2D
  full: boolean;         // mount, resize, setTheme, or a scroll past the viewport
  cpuMs: number;         // time inside render()
}
```

`on()` returns an unsubscribe function. `cursorMove` fires when the cursor's
absolute row, column or shape changes and the cursor is visible within the drawn
viewport. There is no bell event: the renderer sees no VT event stream and has
nothing to raise one from, so a host routes its bell through its own emitter.

`glyphs` counts only the grid; the glyph drawn under a block cursor is not
included on either backend.

## ShaperHook

```ts
interface RunStyle { bold: boolean; italic: boolean; }

interface ShapedGlyph {
  atlasKey: string;  // stable per-glyph key, e.g. `${fontId}:${glyphId}`
  cluster: string;   // the contextual form to raster
  col: number;       // column within the run this glyph advances from
  xOffset: number;   // device-px offset from the run origin
}

interface ShapedRun { glyphs: ShapedGlyph[]; }
interface ShaperHook { shapeRun(text: string, style: RunStyle): ShapedRun; }
```

This is a designed seam, not a working one. No backend calls `shapeRun`, and the
`shaper` option is accepted and dropped. The pieces that exist for it are real:
the atlas keys by string, so shaper-minted keys slot into the same cache, and
the glyph instance already carries a device-pixel offset within the cell
(`a_glyphOff`), currently always zero, so shaped placement needs no new pipeline
state. What is missing is run grouping in the renderers and a shaper
implementation.

## Lower-level exports

These are exported so the pieces can be used or replaced individually. See
[extending.md](extending.md).

| export | what it is |
| --- | --- |
| `WebGL2Renderer`, `Canvas2DRenderer` | the two backends, constructed directly to force one |
| `RenderScheduler` | frame coalescing with an injectable clock |
| `computeCellMetrics`, `measureFont` | font measurement and cell geometry |
| `GlyphAtlas` | GL-backed raster and upload, implements `GlyphProvider` |
| `AtlasPacker` | multi-page LRU key-to-slot bookkeeping, GL-free |
| `ShelfAllocator` | single-page shelf rectangle packing, GL-free |
| `atlasKey`, `atlasKeyBaked`, `styleMask`, `GLYPH_STYLE_MASK` | the key scheme |
| `InstanceBuffers`, `StyleBit` | the GL-free instance builder and its style bits |
| `rgb`, `toCss`, `quantize` | packed-color helpers |
| `Emitter` | the minimal synchronous emitter both backends use |

`FakeSource`, the golden scenarios, the recording canvas and the torture corpus
live under [src/testing](../src/testing) and are shipped in the `src` directory
of the package but are not re-exported from the root barrel; import them by
path.
