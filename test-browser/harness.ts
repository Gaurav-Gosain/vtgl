// Browser test harness entry. Bundled by scripts/build-harness.mjs into
// test-browser/harness.js and loaded by index.html, so the Playwright specs can
// drive the real renderers against the golden scenarios in a real GPU context.
// This file is test-only and is not part of the shipped package.

import { WebGL2Renderer } from '../src/renderer/webgl2.ts';
import { Canvas2DRenderer } from '../src/renderer/canvas2d.ts';
import { createRenderer, supportsWebGL2 } from '../src/index.ts';
import { FakeSource } from '../src/testing/fake-source.ts';
import { allScenarios, scenarioByName } from '../src/testing/scenarios.ts';
import { buildTortureSource, tortureCorpus } from '../src/testing/torture.ts';
import { arabicShaper } from '../src/shaper/arabic.ts';
import { CellFlags } from '../src/types.ts';
import type {
  Renderer,
  RendererOptions,
  RenderStats,
  ShapedRun,
  ShaperHook,
  Theme,
} from '../src/types.ts';

const THEME: Theme = { foreground: 0xd0d0d0, background: 0x101010, cursor: 0xffffff };

const BASE_OPTIONS: RendererOptions = {
  fontFamily: 'monospace',
  fontSize: 14,
  dpr: 1,
  theme: THEME,
};

interface Harness {
  scenarioNames(): string[];
  renderScenario(name: string, backend: 'webgl2' | 'canvas2d'): RenderStats;
  /** Fraction of pixels that differ between the two backends, 0..1. */
  compareScenario(name: string, threshold: number): DiffResult;
  statsFor(name: string, backend: 'webgl2' | 'canvas2d', frames: number): RenderStats[];
  probe(): { supportsWebGL2: boolean; autoBackend: string };
  damageProbe(): RenderStats[];
  scrollProbe(): {
    pixelsChanged: boolean;
    scrollFull: boolean;
    scrollDirtyRows: number;
    beyondViewportFull: boolean;
    stationaryFull: boolean;
    stationaryDirtyRows: number;
  };
  contextLossProbe(): Promise<{
    before: string;
    sawLost: boolean;
    sawRestored: boolean;
    renderedWhileLost: boolean;
    framesAfterRestore: number;
    afterFull: boolean;
    afterUploads: number;
  }>;
  /**
   * The scroll fast path against a forced full rebuild of the same frame. Every
   * case must come out pixel-identical, because that equivalence is the entire
   * correctness argument for shifting instead of repainting.
   */
  /**
   * Pixel equivalence of the scroll fast path against a forced full rebuild.
   * `shaped` runs the same cases with the Arabic shaper configured, which is the
   * only place the two features meet: shaping reorders cells within a row and
   * scrolling moves rows between screen positions, and neither may leak into the
   * other.
   */
  scrollEquivalence(
    backend: 'webgl2' | 'canvas2d',
    shaped?: boolean,
  ): ScrollCaseResult[];
  /**
   * Drive the partial-update scenario incrementally and diff the whole surface
   * against a full rebuild of the same final state. Carries its own controls:
   * a negative case that must disagree, and a distinct-colour and ink floor on
   * the reference, so an agreement over two empty readbacks cannot pass.
   */
  partialUpdateEquivalence(
    backend: 'webgl2' | 'canvas2d',
    frames?: number,
  ): {
    differing: number;
    total: number;
    maxChannelDelta: number;
    offDiffering: number;
    distinctColours: number;
    inkFraction: number;
    skipped: number;
    dirtyRows: number[];
  };
  /** Ink on a blinking cell sampled across a blink period, in real pixels. */
  blinkProbe(backend: 'webgl2' | 'canvas2d'): Promise<{ inked: number; blank: number }>;
  atlasProbe(): { first: number; second: number; afterNewGlyph: number };
  drawCallScaling(): Array<{ cells: number; drawCalls: number }>;
  /**
   * Renderer-only allocation pressure. Renders the same unchanging content with
   * every row forced dirty, so nothing but render() runs inside the measured
   * window: no step(), no source mutation, no string building by the driver.
   * Allocation is measured by the caller via the CDP heap profiler, not here;
   * this method only shapes the window.
   */
  allocProbe(
    name: string,
    backend: 'webgl2' | 'canvas2d',
    frames: number,
  ): AllocResult;
  /** Pixel diff of the torture corpus between the two backends. */
  compareTorture(threshold: number): DiffResult;
  /** Per-entry pixel diff, so divergence can be attributed to a cluster. */
  compareTortureRows(threshold: number): TortureRowDiff[];
  /** Per-entry ink coverage, so an unrendered or clipped cluster is visible. */
  tortureInk(backend: 'webgl2' | 'canvas2d', shaped?: boolean): TortureInk[];
  /**
   * Per-column ink profile of one corpus row. Joining changes where the ink sits
   * across a word's cells, which a single per-row total cannot see, so this is
   * what the Arabic before/after is actually asserted on.
   */
  tortureColumnInk(
    name: string,
    backend: 'webgl2' | 'canvas2d',
    shaped: boolean,
  ): number[];
  /** Whole-corpus pixel diff between shaped and unshaped, per row. */
  shapingRowDiff(backend: 'webgl2' | 'canvas2d'): TortureRowDiff[];
  /**
   * Ground-truth check on the contextual forms.
   *
   * Unicode encodes the four Arabic joining forms explicitly in Presentation
   * Forms-B (U+FE70..U+FEFF), so "did the shaper pick the right glyph, and put
   * it in the right column" can be asked against a reference rather than by eye.
   * This renders the word twice through the same renderer: once as the plain
   * letters with the Arabic shaper, and once as the expected presentation forms
   * in the expected visual order with a shaper that only fits advances. If
   * joining and reordering are both right the two rows agree.
   *
   * `plain` renders the same reference against the unshaped letters, which is
   * the before half of the comparison.
   */
  arabicFormCheck(backend: 'webgl2' | 'canvas2d'): {
    shaped: number;
    plain: number;
    total: number;
  };
  /** The same three rows as PNG data URLs, for eyeballing them. */
  arabicFormImages(backend: 'webgl2' | 'canvas2d'): string[];
  /** The corpus as a PNG data URL, for eyeballing the rendered output. */
  torturePng(backend: 'webgl2' | 'canvas2d', shaped: boolean): string;
  /** Row index and cell height of the corpus, so a caller can crop one entry. */
  tortureGeometry(): { index: Record<string, number>; cellHeight: number; cellWidth: number };
  bench(
    name: string,
    backend: 'webgl2' | 'canvas2d',
    frames: number,
    mode?: BenchMode,
    /** Configure the Arabic shaper, so its cost can be measured against not having it. */
    shaped?: boolean,
  ): BenchResult;
  /**
   * Fill a grid with a repeating pattern of box/block characters and report how
   * much of each pixel row and column is at full foreground. `grid` is one
   * string per cell row, repeated across the row's columns. A seam shows up as a
   * pixel row or column at a cell boundary carrying less than the rows or
   * columns inside the cell.
   */
  seamProbe(
    backend: 'webgl2' | 'canvas2d',
    grid: string[],
    cols: number,
    rows: number,
    dpr: number,
    fontSize: number,
  ): SeamProfile;
  /** The same grid as a PNG data URL, for looking at it. */
  seamPng(
    backend: 'webgl2' | 'canvas2d',
    grid: string[],
    cols: number,
    rows: number,
    dpr: number,
    fontSize: number,
  ): string;
}

/**
 * "full" forces every visible row dirty each frame: the worst-case full-screen
 * repaint, comparable across scenarios but not what any real workload does.
 * "natural" lets the scenario's own step() and viewportY() decide what is
 * damaged, which is what the performance study measured.
 */
export type BenchMode = 'full' | 'natural';

export interface TortureRowDiff {
  name: string;
  /** Fraction of this row's pixels that differ between the backends, 0..1. */
  fraction: number;
  maxChannelDelta: number;
}

export interface TortureInk {
  name: string;
  columns: number;
  /** Non-background pixels inside the cluster's own cells. */
  ink: number;
  /** Non-background pixels in the cell immediately past the cluster. */
  bleed: number;
}

export interface ScrollCaseResult {
  name: string;
  /** Rows the fast-path frame actually rebuilt. */
  dirtyRows: number;
  /** Whether the fast-path frame fell back to a full rebuild. */
  full: boolean;
  /** Pixels differing from the forced full rebuild. Must be 0. */
  differing: number;
  total: number;
  maxChannelDelta: number;
  /**
   * Pixels the shaper changed in this frame, against the same frame rendered
   * with no shaper. 0 on the unshaped variant, and on the shaped one it is the
   * evidence that the equivalence above was tested on shaped output.
   */
  shapedDelta: number;
}

export interface AllocResult {
  scenario: string;
  backend: string;
  frames: number;
  /** Glyphs drawn per frame, so bytes/glyph can be reasoned about. */
  glyphs: number;
}

export interface SeamProfile {
  cellW: number;
  cellH: number;
  width: number;
  height: number;
  /**
   * Full-foreground coverage, one string per pixel row, '1' covered and '0'
   * not. A mask rather than per-row totals because a seam is a local property
   * of one boundary and the interesting patterns only tile over part of the
   * frame, so the caller has to be able to ask about a sub-rectangle.
   */
  mask: string[];
}

interface BenchResult {
  scenario: string;
  backend: string;
  cols: number;
  rows: number;
  /** Renderer-internal CPU time in render(), median and p95, ms. */
  cpuP50: number;
  cpuP95: number;
  /**
   * Mean CPU ms over the measured window. performance.now() is clamped to 100us
   * in Chromium, so a single sub-millisecond sample carries only one or two
   * significant digits; averaging the window recovers the resolution that the
   * clamp destroys, and is the figure to compare when p50 reads 0.0.
   */
  cpuMean: number;
  /** Wall time around render() including the driver call overhead, ms. */
  wallP50: number;
  /** Wall time including a forced pipeline sync (readback), ms. */
  syncP50: number;
  drawCalls: number;
  glyphs: number;
  atlasUploads: number;
  mode: BenchMode;
  /** Rows the source reported dirty on the median frame. */
  dirtyRowsP50: number;
  /** Total glyph rasters uploaded to the atlas across the measured frames. */
  totalUploads: number;
  /**
   * JS heap growth per frame in bytes across the measured window, or null when
   * the browser did not expose performance.memory. This covers the whole loop,
   * including the scenario's own step() writing into the FakeSource, so it is
   * NOT a renderer allocation figure: use allocProbe for that. Only meaningful
   * with --enable-precise-memory-info; a GC inside the window shows up as a
   * negative number, which we clamp to 0.
   */
  heapBytesPerFrame: number | null;
}

interface DiffResult {
  differing: number;
  total: number;
  fraction: number;
  maxChannelDelta: number;
  width: number;
  height: number;
}

/** Resolve true when the event fires, false if it does not within `ms`. */
function waitForEvent(target: EventTarget, type: string, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      target.removeEventListener(type, onEvent);
      resolve(false);
    }, ms);
    const onEvent = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    target.addEventListener(type, onEvent, { once: true });
  });
}

/**
 * Test-only shaper for the Presentation Forms-B block. It picks no forms and
 * reorders nothing; it only asks for the same advance fitting the Arabic shaper
 * applies, so a reference row of explicit presentation forms goes through the
 * identical raster path and the comparison isolates glyph choice and column.
 */
function fitOnlyShaper(): ShaperHook {
  return {
    participates: (cp) => cp >= 0xfe70 && cp <= 0xfeff,
    shapeRun(cells) {
      // A lam-alef ligature form spans two cells the same way the Arabic shaper
      // emits it, consuming the following filler cell as a blank, so the
      // reference lands in the columns the shaper's own ligature does.
      const glyphs: ShapedRun['glyphs'] = [];
      let col = 0;
      for (let i = 0; i < cells.length && col < cells.length; i++, col++) {
        const cluster = cells[i];
        const cp = cluster.codePointAt(0)!;
        const lig = cp >= 0xfef5 && cp <= 0xfefc;
        glyphs.push({ atlasKey: 'pf' + cluster, cluster, col, xOffset: 0, rtl: false, fitAdvance: true, cols: lig ? 2 : 1 });
        if (lig) {
          glyphs.push({ atlasKey: 'pfblank', cluster: '', col: col + 1, xOffset: 0, rtl: false, fitAdvance: false });
          i++;
          col++;
        }
      }
      return { glyphs };
    },
  };
}

/**
 * The three rows the Arabic ground-truth comparison rests on, rendered through
 * the real renderer at identical metrics: the expected presentation forms, the
 * plain letters with the Arabic shaper, and the plain letters with no shaper.
 */
function arabicFormRows(backend: 'webgl2' | 'canvas2d'): ImageData[] {
  const WORD = 'سلام';
  // salaam in Presentation Forms-B, already in the visual order a correct
  // right-to-left layout produces: meem isolated, then the lam-alef ligature in
  // its final form (the lam joins the seen before it), then seen initial. Lam and
  // alef collapse into the one mandatory ligature, so it spans two of the four
  // columns; the third form below is a filler the reference shaper consumes as
  // that second cell. Alef is right-joining, which is why the meem beside it is
  // isolated rather than final.
  const FORMS = ['ﻡ', 'ﻼ', 'ﻼ', 'ﺳ'];
  const cols = WORD.length;

  const render = (chars: string[], shaper: RendererOptions['shaper']): ImageData => {
    const src = new FakeSource({ cols, rows: 1, fg: 0xd0d0d0, bg: 0x101010 });
    src.setCursor({ visible: false });
    src.clearRegion(0, 1);
    chars.forEach((ch, i) => src.setCell(0, i, ch.codePointAt(0)!, { width: 1 }));
    const r = build(backend, shaper ? { ...BASE_OPTIONS, shaper } : BASE_OPTIONS);
    const canvas = makeCanvas(8, 8);
    r.mount(canvas);
    r.resize(cols, 1, 1);
    r.render(src, 0);
    // Read back before disposing: the WebGL drawing buffer only survives until
    // the next composite, so every probe here reads eagerly.
    const px = readPixels(canvas);
    r.dispose();
    return px;
  };

  return [
    // The reference goes through the same advance fitting the Arabic shaper
    // applies, so the comparison isolates glyph choice and column rather than
    // the fitting itself.
    render(FORMS, fitOnlyShaper()),
    render([...WORD], arabicShaper()),
    render([...WORD], undefined),
  ];
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  document.body.appendChild(c);
  return c;
}

function build(
  backend: 'webgl2' | 'canvas2d',
  options: RendererOptions = BASE_OPTIONS,
): Renderer {
  return backend === 'webgl2'
    ? new WebGL2Renderer(options)
    : new Canvas2DRenderer(options);
}

/** Render one scenario on a fresh canvas and return the canvas plus stats. */
function renderOn(
  backend: 'webgl2' | 'canvas2d',
  name: string,
  frames = 1,
): { canvas: HTMLCanvasElement; stats: RenderStats[]; renderer: Renderer } {
  const sc = scenarioByName(name);
  if (!sc) throw new Error('unknown scenario: ' + name);
  const source = sc.build();
  const renderer = build(backend);
  const canvas = makeCanvas(8, 8);
  renderer.mount(canvas);
  renderer.resize(sc.cols, sc.rows, 1);

  const stats: RenderStats[] = [];
  renderer.on('render', (s) => stats.push(s));
  for (let f = 0; f < frames; f++) {
    sc.step?.(source, f);
    renderer.render(source, sc.viewportY?.(source, f) ?? source.scrollbackRows);
    if (f + 1 < frames) source.clearDirty();
  }
  return { canvas, stats, renderer };
}

/**
 * Used JS heap in bytes when the browser exposes it. Chromium only reports a
 * useful granularity under --enable-precise-memory-info; without that flag the
 * value is bucketed and the deltas are noise, so callers must treat a null or
 * a zero as "not measured" rather than "no allocation".
 */
/** Count non-background pixels in a cell range of one row. */
function inkIn(
  px: ImageData,
  metrics: { cellWidth: number; cellHeight: number },
  row: number,
  col: number,
  cols: number,
): number {
  const x0 = Math.round(col * metrics.cellWidth);
  const x1 = Math.min(px.width, Math.round((col + cols) * metrics.cellWidth));
  const y0 = Math.round(row * metrics.cellHeight);
  const y1 = Math.min(px.height, Math.round((row + 1) * metrics.cellHeight));
  const d = px.data;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * px.width + x) * 4;
      // Background is 0x101010; anything meaningfully brighter is a glyph.
      if (d[i] > 0x30 || d[i + 1] > 0x30 || d[i + 2] > 0x30) n++;
    }
  }
  return n;
}

function diff(a: ImageData, b: ImageData, threshold: number): DiffResult {
  const x = a.data;
  const y = b.data;
  let differing = 0;
  let maxChannelDelta = 0;
  const total = a.width * a.height;
  for (let i = 0; i < x.length; i += 4) {
    const d = Math.max(
      Math.abs(x[i] - y[i]),
      Math.abs(x[i + 1] - y[i + 1]),
      Math.abs(x[i + 2] - y[i + 2]),
    );
    if (d > maxChannelDelta) maxChannelDelta = d;
    if (d > threshold) differing++;
  }
  return {
    differing,
    total,
    fraction: differing / total,
    maxChannelDelta,
    width: a.width,
    height: a.height,
  };
}

/**
 * Render the whole torture corpus, one entry per row, on a fresh canvas.
 * `shaped` opts the renderer into the Arabic shaper, which is what the
 * before/after evidence for contextual joining compares.
 */
function renderTorture(
  backend: 'webgl2' | 'canvas2d',
  shaped = false,
): {
  canvas: HTMLCanvasElement;
  renderer: Renderer;
  metrics: { cellWidth: number; cellHeight: number };
} {
  const source = buildTortureSource();
  const renderer = build(
    backend,
    shaped ? { ...BASE_OPTIONS, shaper: arabicShaper() } : BASE_OPTIONS,
  );
  const canvas = makeCanvas(8, 8);
  renderer.mount(canvas);
  renderer.resize(source.cols, source.rows, 1);
  renderer.render(source, 0);
  const m = renderer.getMetrics();
  return {
    canvas,
    renderer,
    metrics: { cellWidth: m.cellWidth, cellHeight: m.cellHeight },
  };
}

function readHeap(): number | null {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return mem ? mem.usedJSHeapSize : null;
}

function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return Math.round(s[i] * 1000) / 1000;
}

/**
 * A cheap forced sync. For WebGL a 1x1 readPixels blocks until the frame has
 * actually been produced; for 2D a 1x1 getImageData does the same. Without it,
 * GL timings only measure how fast commands were queued.
 */
function makeSyncProbe(canvas: HTMLCanvasElement, backend: string): () => void {
  if (backend === 'webgl2') {
    const gl = canvas.getContext('webgl2')!;
    const px = new Uint8Array(4);
    return () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  }
  const ctx = canvas.getContext('2d')!;
  return () => void ctx.getImageData(0, 0, 1, 1);
}

/** Read a canvas (2D or WebGL) back as RGBA pixels via a scratch 2D canvas. */
function readPixels(canvas: HTMLCanvasElement): ImageData {
  const scratch = document.createElement('canvas');
  scratch.width = canvas.width;
  scratch.height = canvas.height;
  const ctx = scratch.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(canvas, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

// --- box/block seam probe --------------------------------------------------
//
// Two stacked box or block cells share an edge: the bottom pixel row of the
// upper cell and the top pixel row of the lower one are adjacent on screen, so
// anything short of full coverage on either side of that edge reads as a
// hairline gap running across the screen. The probe fills a grid with one
// pattern, reads the frame back, and reports full-foreground coverage per pixel
// row and per pixel column, which is what a caller compares across a boundary.
//
// White on black, so "covered" is unambiguous and a partially covered pixel
// left by antialiasing is not counted as covered.

const SEAM_FG = 0xffffff;
const SEAM_BG = 0x000000;
const SEAM_THEME: Theme = { foreground: SEAM_FG, background: SEAM_BG, cursor: SEAM_FG };

/** Render a repeating box/block grid and hand back the canvas it drew on. */
function renderSeamGrid(
  backend: 'webgl2' | 'canvas2d',
  grid: string[],
  cols: number,
  rows: number,
  dpr: number,
  fontSize: number,
): { canvas: HTMLCanvasElement; renderer: Renderer } {
  const source = new FakeSource({ cols, rows, fg: SEAM_FG, bg: SEAM_BG });
  source.setCursor({ visible: false });
  for (let r = 0; r < rows; r++) {
    const chars = [...grid[r % grid.length]];
    for (let c = 0; c < cols; c++) {
      const cp = chars[c % chars.length].codePointAt(0)!;
      source.setCell(r, c, cp, { width: 1, fg: SEAM_FG, bg: SEAM_BG });
    }
  }
  const renderer = build(backend, {
    ...BASE_OPTIONS,
    fontSize,
    dpr,
    theme: SEAM_THEME,
  });
  const canvas = makeCanvas(8, 8);
  renderer.mount(canvas);
  renderer.resize(cols, rows, dpr);
  renderer.render(source, 0);
  return { canvas, renderer };
}

/** True when a pixel is at (or within rounding of) the full foreground colour. */
function isCovered(d: Uint8ClampedArray, i: number): boolean {
  return d[i] >= 0xf0 && d[i + 1] >= 0xf0 && d[i + 2] >= 0xf0;
}

// --- scroll fast path vs forced full rebuild -------------------------------

const SCROLL_COLS = 32;
const SCROLL_ROWS = 12;
const SCROLL_BACK = 40;

interface ScrollCase {
  name: string;
  /** Viewport top of the priming frame. */
  from: number;
  /** Viewport top of the frame under test. */
  to: number;
  /** Writes applied between the two frames, so scroll and damage coincide. */
  writes?(s: FakeSource): void;
  /** Cursor state for the frame under test. */
  cursor?: { x: number; y: number };
}

/**
 * A buffer with something in every category whose handling is positional: wide
 * heads with their spacer tails, decorations, non-default backgrounds, and one
 * deliberately headless spacer at column 0, which is the only way a rebuilt row
 * can inherit a background from whatever the slot held before it.
 */
function buildScrollSource(): FakeSource {
  const s = new FakeSource({
    cols: SCROLL_COLS,
    rows: SCROLL_ROWS,
    scrollbackRows: SCROLL_BACK,
    fg: 0xd0d0d0,
    bg: 0x101010,
  });
  const total = SCROLL_BACK + SCROLL_ROWS;
  for (let row = 0; row < total; row++) {
    let col = s.writeText(row, 0, String(row).padStart(3, '0') + ' ', { fg: 0x5c6370 });
    switch (row % 5) {
      case 0:
        s.writeText(row, col, 'plain ascii line');
        break;
      case 1:
        s.writeText(row, col, '世界 wide 漢字');
        break;
      case 2:
        s.writeText(row, col, 'underlined', {
          fg: 0xe06c75,
          flags: CellFlags.UNDERLINE | CellFlags.BOLD,
        });
        break;
      case 3:
        s.writeText(row, col, 'struck out', {
          fg: 0x98c379,
          bg: 0x282c34,
          flags: CellFlags.STRIKETHROUGH | CellFlags.ITALIC,
        });
        break;
      default:
        // Headless spacer at column 0: no wide head ever writes this cell's
        // background, so a rebuilt slot must clear it rather than inherit.
        s.setCell(row, 0, 0, { width: 0 });
        s.writeText(row, 1, 'tail-spacer row', { bg: 0x3e4451 });
        break;
    }
    // Arabic on every row, so the shaped variant of every scroll case has a
    // reordered run in each slot the rotation moves. A shaper is per row and
    // holds no screen position, so shifting must stay exact with one configured;
    // that is the claim these rows exist to test.
    s.writeText(row, SCROLL_COLS - 8, 'سلام', { fg: 0xc678dd });
  }
  s.setCursor({ visible: true, x: 4, y: 25, shape: 'block' });
  s.clearDirty();
  return s;
}

const SCROLL_CASES: ScrollCase[] = [
  { name: 'down-one', from: 20, to: 21 },
  { name: 'up-one', from: 20, to: 19 },
  { name: 'down-seven', from: 20, to: 27 },
  { name: 'up-to-top', from: 5, to: 0 },
  { name: 'beyond-viewport', from: 20, to: 34 },
  {
    name: 'scroll-and-write-down',
    from: 20,
    to: 22,
    writes(s) {
      s.writeText(23, 4, 'EDITED IN FLIGHT', { fg: 0xe5c07b, flags: CellFlags.UNDERLINE });
      s.writeText(30, 0, '<<<', { bg: 0x61afef });
    },
  },
  {
    name: 'scroll-and-write-up',
    from: 20,
    to: 18,
    writes(s) {
      s.writeText(18, 2, '世 edited wide', { flags: CellFlags.STRIKETHROUGH });
      s.writeText(27, 0, 'bottom edit');
    },
  },
  { name: 'scroll-and-move-cursor', from: 20, to: 23, cursor: { x: 9, y: 27 } },
  // No scroll and no damage: the cursor moving is the only change, which is the
  // case that used to strand a block cursor on the row it left.
  { name: 'cursor-moves-without-damage', from: 20, to: 20, cursor: { x: 17, y: 28 } },
];

/**
 * Drive one case twice: once through the fast path on a renderer that was
 * already showing `from`, once as a first frame on a fresh renderer, which is
 * always a full rebuild. Read both back and compare exactly.
 */
function runScrollCase(
  backend: 'webgl2' | 'canvas2d',
  c: ScrollCase,
  shaped = false,
): ScrollCaseResult {
  const apply = (s: FakeSource): void => {
    c.writes?.(s);
    if (c.cursor) s.setCursor({ x: c.cursor.x, y: c.cursor.y });
  };
  const options = shaped ? { ...BASE_OPTIONS, shaper: arabicShaper() } : BASE_OPTIONS;

  const fastSource = buildScrollSource();
  const fast = build(backend, options);
  const fastCanvas = makeCanvas(8, 8);
  fast.mount(fastCanvas);
  fast.resize(SCROLL_COLS, SCROLL_ROWS, 1);
  let last: RenderStats | undefined;
  fast.on('render', (s) => (last = s));
  fast.render(fastSource, c.from);
  fastSource.clearDirty();
  apply(fastSource);
  fast.render(fastSource, c.to);
  const fastPixels = readPixels(fastCanvas);

  const refSource = buildScrollSource();
  apply(refSource);
  const ref = build(backend, options);
  const refCanvas = makeCanvas(8, 8);
  ref.mount(refCanvas);
  ref.resize(SCROLL_COLS, SCROLL_ROWS, 1);
  ref.render(refSource, c.to);
  const refPixels = readPixels(refCanvas);

  const d = diff(fastPixels, refPixels, 0);
  fast.dispose();
  ref.dispose();

  // Third rendering, unshaped, so the shaped variant can prove it is not
  // vacuous: equivalence with the shaper configured means nothing if the shaper
  // never fired on this content. Only rendered for the shaped variant.
  let shapedDelta = 0;
  if (shaped) {
    const bareSource = buildScrollSource();
    apply(bareSource);
    const bare = build(backend);
    const bareCanvas = makeCanvas(8, 8);
    bare.mount(bareCanvas);
    bare.resize(SCROLL_COLS, SCROLL_ROWS, 1);
    bare.render(bareSource, c.to);
    shapedDelta = diff(readPixels(bareCanvas), refPixels, 0).differing;
    bare.dispose();
  }

  return {
    name: c.name,
    dirtyRows: last!.dirtyRows,
    full: last!.full,
    differing: d.differing,
    total: d.total,
    maxChannelDelta: d.maxChannelDelta,
    shapedDelta,
  };
}

const harness: Harness = {
  scenarioNames() {
    return allScenarios.map((s) => s.name);
  },

  renderScenario(name, backend) {
    const { stats } = renderOn(backend, name);
    return stats[stats.length - 1];
  },

  statsFor(name, backend, frames) {
    return renderOn(backend, name, frames).stats;
  },

  compareScenario(name, threshold) {
    // Render both backends, reading each back immediately so the WebGL drawing
    // buffer is still intact (no preserveDrawingBuffer needed).
    const gl = renderOn('webgl2', name);
    const glPixels = readPixels(gl.canvas);
    const c2 = renderOn('canvas2d', name);
    const c2Pixels = readPixels(c2.canvas);

    const a = glPixels.data;
    const b = c2Pixels.data;
    let differing = 0;
    let maxChannelDelta = 0;
    const total = glPixels.width * glPixels.height;
    for (let i = 0; i < a.length; i += 4) {
      const dr = Math.abs(a[i] - b[i]);
      const dg = Math.abs(a[i + 1] - b[i + 1]);
      const db = Math.abs(a[i + 2] - b[i + 2]);
      const d = Math.max(dr, dg, db);
      if (d > maxChannelDelta) maxChannelDelta = d;
      if (d > threshold) differing++;
    }
    gl.renderer.dispose();
    c2.renderer.dispose();
    return {
      differing,
      total,
      fraction: differing / total,
      maxChannelDelta,
      width: glPixels.width,
      height: glPixels.height,
    };
  },

  probe() {
    const auto = createRenderer(BASE_OPTIONS);
    const backend = auto.backend;
    auto.dispose();
    return { supportsWebGL2: supportsWebGL2(), autoBackend: backend };
  },

  damageProbe() {
    const source = new FakeSource({ cols: 40, rows: 10, fg: 0xd0d0d0, bg: 0x101010 });
    source.setCursor({ visible: false });
    for (let r = 0; r < 10; r++) source.writeText(r, 0, 'row ' + r);
    const renderer = build('webgl2');
    const canvas = makeCanvas(8, 8);
    renderer.mount(canvas);
    renderer.resize(40, 10, 1);
    const stats: RenderStats[] = [];
    renderer.on('render', (s) => stats.push(s));

    renderer.render(source, 0); // full frame
    source.clearDirty();
    renderer.render(source, 0); // nothing dirty
    source.setCell(3, 0, 'X'.codePointAt(0)!);
    renderer.render(source, 0); // one dirty row
    source.clearDirty();
    source.setCell(1, 0, 'Y'.codePointAt(0)!);
    source.setCell(2, 0, 'Z'.codePointAt(0)!);
    renderer.render(source, 0); // two contiguous dirty rows
    renderer.dispose();
    return stats;
  },

  async contextLossProbe() {
    const source = new FakeSource({ cols: 20, rows: 5, fg: 0xd0d0d0, bg: 0x101010 });
    source.setCursor({ visible: false });
    source.writeText(0, 0, 'hello');
    const renderer = build('webgl2');
    const canvas = makeCanvas(8, 8);
    renderer.mount(canvas);
    renderer.resize(20, 5, 1);
    const stats: RenderStats[] = [];
    renderer.on('render', (s) => stats.push(s));

    renderer.render(source, 0);
    const before = renderer.backend;
    const framesBeforeLoss = stats.length;

    const gl = canvas.getContext('webgl2')!;
    const ext = gl.getExtension('WEBGL_lose_context')!;

    // loseContext dispatches webglcontextlost asynchronously; wait for the
    // renderer to actually observe it before probing the lost-state behavior.
    const lost = waitForEvent(canvas, 'webglcontextlost', 5000);
    ext.loseContext();
    const sawLost = await lost;

    // While lost, render must neither throw nor emit a frame.
    renderer.render(source, 0);
    const renderedWhileLost = stats.length > framesBeforeLoss;

    // Chromium only marks the context restorable once the contextlost dispatch
    // has fully unwound (that is when defaultPrevented is committed), so yield
    // to a macrotask before asking for restoration.
    await new Promise<void>((r) => setTimeout(r, 0));
    const restored = waitForEvent(canvas, 'webglcontextrestored', 5000);
    ext.restoreContext();
    const sawRestored = await restored;

    // After restore the renderer must rebuild and repaint a full frame,
    // re-rastering its glyphs into the fresh atlas.
    source.markDirty(0);
    renderer.render(source, 0);
    const after = stats[stats.length - 1];
    renderer.dispose();

    return {
      before,
      sawLost,
      sawRestored,
      renderedWhileLost,
      framesAfterRestore: stats.length - framesBeforeLoss,
      afterFull: after.full,
      afterUploads: after.atlasUploads,
    };
  },

  scrollProbe() {
    // 12 scrollback rows above a 4-row screen, each row uniquely colored so a
    // stale viewport is visible in the pixels rather than only in the stats.
    const source = new FakeSource({ cols: 8, rows: 4, scrollbackRows: 12 });
    source.setCursor({ visible: false });
    for (let r = 0; r < 16; r++) {
      source.writeText(r, 0, 'row' + r, { bg: 0x010000 * (r + 1) });
    }
    const renderer = build('webgl2');
    const canvas = makeCanvas(8, 8);
    renderer.mount(canvas);
    renderer.resize(8, 4, 1);
    const stats: RenderStats[] = [];
    renderer.on('render', (s) => stats.push(s));

    renderer.render(source, 0);
    const top = readPixels(canvas).data.slice(0, 4);
    source.clearDirty();

    // Scroll one row without dirtying anything: only the row that entered the
    // viewport should be rebuilt, and the screen must still show the new rows.
    renderer.render(source, 1);
    const scrolled = readPixels(canvas).data.slice(0, 4);
    const scrolledStats = stats[stats.length - 1];

    // A jump larger than the viewport has nothing to reuse.
    source.clearDirty();
    renderer.render(source, 9);
    const beyond = stats[stats.length - 1];

    // Rendering the same viewport again must fall back to incremental.
    source.clearDirty();
    renderer.render(source, 9);
    const restated = stats[stats.length - 1];
    renderer.dispose();

    return {
      pixelsChanged: top[0] !== scrolled[0] || top[1] !== scrolled[1] || top[2] !== scrolled[2],
      scrollFull: scrolledStats.full,
      scrollDirtyRows: scrolledStats.dirtyRows,
      beyondViewportFull: beyond.full,
      stationaryFull: restated.full,
      stationaryDirtyRows: restated.dirtyRows,
    };
  },

  scrollEquivalence(backend, shaped = false) {
    return SCROLL_CASES.map((c) => runScrollCase(backend, c, shaped));
  },

  partialUpdateEquivalence(backend, frames = 12) {
    const sc = scenarioByName('partial')!;

    // Incremental: one full first frame, then only the rows step() touches.
    // Frame 4 is left completely untouched so the redundant-frame skip fires
    // inside the run rather than only at the end of it.
    const src = sc.build();
    const inc = build(backend);
    const incCanvas = makeCanvas(8, 8);
    inc.mount(incCanvas);
    inc.resize(sc.cols, sc.rows, 1);
    const stats: RenderStats[] = [];
    inc.on('render', (s) => stats.push(s));
    inc.render(src, src.scrollbackRows);
    let last = 0;
    for (let f = 1; f < frames; f++) {
      src.clearDirty();
      if (f !== 4) {
        sc.step!(src, f);
        last = f;
      }
      inc.render(src, src.scrollbackRows);
    }
    const incPixels = readPixels(incCanvas);

    // Reference: a fresh renderer taken straight to the same final state, so
    // every row is built from scratch and nothing can be stale.
    const refSrc = sc.build();
    for (let f = 1; f <= last; f++) sc.step!(refSrc, f);
    const ref = build(backend);
    const refCanvas = makeCanvas(8, 8);
    ref.mount(refCanvas);
    ref.resize(sc.cols, sc.rows, 1);
    ref.render(refSrc, refSrc.scrollbackRows);
    const refPixels = readPixels(refCanvas);

    // Negative control. The same comparison against a state one step further on
    // must disagree. Without it, "differing == 0" is equally consistent with
    // both readbacks having returned the same blank buffer.
    const offSrc = sc.build();
    for (let f = 1; f <= last + 1; f++) sc.step!(offSrc, f);
    const off = build(backend);
    const offCanvas = makeCanvas(8, 8);
    off.mount(offCanvas);
    off.resize(sc.cols, sc.rows, 1);
    off.render(offSrc, offSrc.scrollbackRows);
    const offDiffering = diff(readPixels(offCanvas), refPixels, 0).differing;

    const d = diff(incPixels, refPixels, 0);

    // Anti-vacuity controls on the reference itself: a comparison over two
    // cleared buffers agrees perfectly and proves nothing.
    const px = refPixels.data;
    const colours = new Set<number>();
    let ink = 0;
    for (let i = 0; i < px.length; i += 4) {
      colours.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]);
      if (px[i] > 0x30 || px[i + 1] > 0x30 || px[i + 2] > 0x30) ink++;
    }

    inc.dispose();
    ref.dispose();
    off.dispose();

    return {
      differing: d.differing,
      total: d.total,
      maxChannelDelta: d.maxChannelDelta,
      offDiffering,
      distinctColours: colours.size,
      inkFraction: ink / (refPixels.width * refPixels.height),
      skipped: stats.filter((s) => s.skipped).length,
      dirtyRows: stats.map((s) => s.dirtyRows),
    };
  },

  async blinkProbe(backend) {
    // Blink is a wall-clock gate with no clock of its own, so the only way to
    // see it is to keep asking for frames and watch the pixels change. Sampled
    // per backend rather than compared across the two: a cross-backend diff
    // straddling a phase boundary would fail for the wrong reason.
    const source = new FakeSource({ cols: 4, rows: 1, fg: 0xd0d0d0, bg: 0x101010 });
    source.setCursor({ visible: false });
    source.setCell(0, 0, 'B'.codePointAt(0)!, { flags: CellFlags.BLINK });
    const renderer = build(backend);
    const canvas = makeCanvas(8, 8);
    renderer.mount(canvas);
    renderer.resize(4, 1, 1);
    const m = renderer.getMetrics();

    let inked = 0;
    let blank = 0;
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline && (inked === 0 || blank === 0)) {
      source.markDirty(0);
      renderer.render(source, 0);
      const px = readPixels(canvas);
      if (inkIn(px, { cellWidth: m.cellWidth, cellHeight: m.cellHeight }, 0, 0, 1) > 0) {
        inked++;
      } else {
        blank++;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    renderer.dispose();
    return { inked, blank };
  },

  atlasProbe() {
    const source = new FakeSource({ cols: 20, rows: 3, fg: 0xd0d0d0, bg: 0x101010 });
    source.setCursor({ visible: false });
    source.writeText(0, 0, 'abc');
    const renderer = build('webgl2');
    const canvas = makeCanvas(8, 8);
    renderer.mount(canvas);
    renderer.resize(20, 3, 1);
    const stats: RenderStats[] = [];
    renderer.on('render', (s) => stats.push(s));

    renderer.render(source, 0); // rasters a, b, c
    const first = stats[stats.length - 1].atlasUploads;
    source.clearDirty();
    source.markDirty(0); // same glyphs, forced rebuild: all atlas hits
    renderer.render(source, 0);
    const second = stats[stats.length - 1].atlasUploads;
    source.clearDirty();
    source.writeText(1, 0, 'xyz'); // three glyphs never seen before
    renderer.render(source, 0);
    const afterNewGlyph = stats[stats.length - 1].atlasUploads;
    renderer.dispose();
    return { first, second, afterNewGlyph };
  },

  allocProbe(name, backend, frames) {
    const sc = scenarioByName(name);
    if (!sc) throw new Error('unknown scenario: ' + name);
    const source = sc.build();
    const renderer = build(backend);
    const canvas = makeCanvas(8, 8);
    renderer.mount(canvas);
    renderer.resize(sc.cols, sc.rows, 1);
    let last: RenderStats | undefined;
    renderer.on('render', (s) => (last = s));

    const top = sc.viewportY?.(source, 0) ?? source.scrollbackRows;
    const markAllDirty = (): void => {
      for (let r = 0; r < sc.rows; r++) source.markDirty(top + r);
    };

    // Warm the atlas and the JIT first: a first-paint raster allocates by
    // design, and counting it would drown the steady-state figure.
    for (let f = 0; f < 20; f++) {
      markAllDirty();
      renderer.render(source, top);
      source.clearDirty();
    }

    // The caller brackets this loop with the CDP heap profiler, so the window
    // must contain render() and nothing else.
    for (let f = 0; f < frames; f++) {
      markAllDirty();
      renderer.render(source, top);
      source.clearDirty();
    }
    renderer.dispose();

    return { scenario: name, backend, frames, glyphs: last!.glyphs };
  },

  compareTorture(threshold) {
    const gl = renderTorture('webgl2');
    const glPixels = readPixels(gl.canvas);
    const c2 = renderTorture('canvas2d');
    const c2Pixels = readPixels(c2.canvas);
    gl.renderer.dispose();
    c2.renderer.dispose();
    return diff(glPixels, c2Pixels, threshold);
  },

  compareTortureRows(threshold) {
    const gl = renderTorture('webgl2');
    const glPixels = readPixels(gl.canvas);
    const c2 = renderTorture('canvas2d');
    const c2Pixels = readPixels(c2.canvas);
    const h = gl.metrics.cellHeight;
    const out: TortureRowDiff[] = tortureCorpus.map((entry, row) => {
      const y0 = Math.round(row * h);
      const y1 = Math.min(glPixels.height, Math.round((row + 1) * h));
      let differing = 0;
      let maxChannelDelta = 0;
      let total = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = 0; x < glPixels.width; x++) {
          const i = (y * glPixels.width + x) * 4;
          const d = Math.max(
            Math.abs(glPixels.data[i] - c2Pixels.data[i]),
            Math.abs(glPixels.data[i + 1] - c2Pixels.data[i + 1]),
            Math.abs(glPixels.data[i + 2] - c2Pixels.data[i + 2]),
          );
          if (d > maxChannelDelta) maxChannelDelta = d;
          if (d > threshold) differing++;
          total++;
        }
      }
      return {
        name: entry.name,
        fraction: total === 0 ? 0 : differing / total,
        maxChannelDelta,
      };
    });
    gl.renderer.dispose();
    c2.renderer.dispose();
    return out;
  },

  tortureInk(backend, shaped = false) {
    const { canvas, renderer, metrics } = renderTorture(backend, shaped);
    const px = readPixels(canvas);
    const out: TortureInk[] = [];
    tortureCorpus.forEach((entry, row) => {
      out.push({
        name: entry.name,
        columns: entry.columns,
        ink: inkIn(px, metrics, row, 0, entry.columns),
        // The blank column the builder leaves after each cluster: ink here
        // means a wide glyph bled out of its own cells.
        bleed: inkIn(px, metrics, row, entry.columns, 1),
      });
    });
    renderer.dispose();
    return out;
  },

  tortureColumnInk(name, backend, shaped) {
    const entry = tortureCorpus.find((e) => e.name === name);
    if (!entry) throw new Error('unknown corpus entry: ' + name);
    const row = tortureCorpus.indexOf(entry);
    const { canvas, renderer, metrics } = renderTorture(backend, shaped);
    const px = readPixels(canvas);
    const out: number[] = [];
    for (let col = 0; col < entry.columns; col++) {
      out.push(inkIn(px, metrics, row, col, 1));
    }
    renderer.dispose();
    return out;
  },

  shapingRowDiff(backend) {
    const plain = renderTorture(backend, false);
    const plainPx = readPixels(plain.canvas);
    const shaped = renderTorture(backend, true);
    const shapedPx = readPixels(shaped.canvas);
    const h = plain.metrics.cellHeight;
    const out: TortureRowDiff[] = tortureCorpus.map((entry, row) => {
      const y0 = Math.round(row * h);
      const y1 = Math.min(plainPx.height, Math.round((row + 1) * h));
      let differing = 0;
      let maxChannelDelta = 0;
      let total = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = 0; x < plainPx.width; x++) {
          const i = (y * plainPx.width + x) * 4;
          const d = Math.max(
            Math.abs(plainPx.data[i] - shapedPx.data[i]),
            Math.abs(plainPx.data[i + 1] - shapedPx.data[i + 1]),
            Math.abs(plainPx.data[i + 2] - shapedPx.data[i + 2]),
          );
          if (d > maxChannelDelta) maxChannelDelta = d;
          if (d > 40) differing++;
          total++;
        }
      }
      return { name: entry.name, fraction: total === 0 ? 0 : differing / total, maxChannelDelta };
    });
    plain.renderer.dispose();
    shaped.renderer.dispose();
    return out;
  },

  torturePng(backend, shaped) {
    const { canvas, renderer } = renderTorture(backend, shaped);
    const scratch = document.createElement('canvas');
    scratch.width = canvas.width;
    scratch.height = canvas.height;
    scratch.getContext('2d')!.drawImage(canvas, 0, 0);
    const url = scratch.toDataURL('image/png');
    renderer.dispose();
    return url;
  },

  arabicFormImages(backend) {
    return arabicFormRows(backend).map((px) => {
      const s = document.createElement('canvas');
      s.width = px.width;
      s.height = px.height;
      s.getContext('2d')!.putImageData(px, 0, 0);
      return s.toDataURL('image/png');
    });
  },

  arabicFormCheck(backend) {
    const [reference, shaped, plain] = arabicFormRows(backend);
    const differing = (a: ImageData, b: ImageData): number => {
      let n = 0;
      for (let i = 0; i < a.data.length; i += 4) {
        const d = Math.max(
          Math.abs(a.data[i] - b.data[i]),
          Math.abs(a.data[i + 1] - b.data[i + 1]),
          Math.abs(a.data[i + 2] - b.data[i + 2]),
        );
        if (d > 40) n++;
      }
      return n;
    };
    return {
      shaped: differing(shaped, reference),
      plain: differing(plain, reference),
      total: reference.width * reference.height,
    };
  },

  tortureGeometry() {
    const { renderer, metrics } = renderTorture('canvas2d', false);
    renderer.dispose();
    const index: Record<string, number> = {};
    tortureCorpus.forEach((e, i) => (index[e.name] = i));
    return { index, cellHeight: metrics.cellHeight, cellWidth: metrics.cellWidth };
  },

  bench(name, backend, frames, mode = 'full', shaped = false) {
    const sc = scenarioByName(name);
    if (!sc) throw new Error('unknown scenario: ' + name);
    const source = sc.build();
    const renderer = build(
      backend,
      shaped ? { ...BASE_OPTIONS, shaper: arabicShaper() } : BASE_OPTIONS,
    );
    const canvas = makeCanvas(8, 8);
    renderer.mount(canvas);
    renderer.resize(sc.cols, sc.rows, 1);

    let last: RenderStats | undefined;
    renderer.on('render', (s) => (last = s));

    // A 1x1 readback forces the pipeline to actually complete the frame, so the
    // sync timing includes GPU work instead of just the driver call.
    const sync = makeSyncProbe(canvas, backend);

    const activeTop = source.scrollbackRows;
    const viewportFor = (f: number): number =>
      sc.viewportY?.(source, f) ?? activeTop;
    const markAllDirty = (f: number): void => {
      // In full mode the damage is relative to whatever the viewport shows, so
      // a scrolling scenario still gets the rows it is about to draw dirtied.
      const top = viewportFor(f);
      for (let r = 0; r < sc.rows; r++) source.markDirty(top + r);
    };

    // Warm up: raster the glyph set into the atlas and let the JIT settle, so
    // the measured window is steady state rather than first-paint cost.
    for (let f = 0; f < 10; f++) {
      sc.step?.(source, f);
      if (mode === 'full') markAllDirty(f);
      renderer.render(source, viewportFor(f));
      source.clearDirty();
    }

    const cpu: number[] = [];
    const wall: number[] = [];
    const syncMs: number[] = [];
    const dirty: number[] = [];
    let totalUploads = 0;

    const heapBefore = readHeap();
    for (let f = 0; f < frames; f++) {
      const frame = 10 + f;
      sc.step?.(source, frame);
      if (mode === 'full') markAllDirty(frame);
      const t0 = performance.now();
      renderer.render(source, viewportFor(frame));
      const t1 = performance.now();
      sync();
      const t2 = performance.now();
      source.clearDirty();
      cpu.push(last!.cpuMs);
      wall.push(t1 - t0);
      syncMs.push(t2 - t0);
      dirty.push(last!.dirtyRows);
      totalUploads += last!.atlasUploads;
    }
    const heapAfter = readHeap();

    const heapBytesPerFrame =
      heapBefore === null || heapAfter === null
        ? null
        : Math.max(0, Math.round((heapAfter - heapBefore) / frames));

    const result: BenchResult = {
      scenario: name,
      backend,
      cols: sc.cols,
      rows: sc.rows,
      cpuP50: percentile(cpu, 50),
      cpuP95: percentile(cpu, 95),
      cpuMean: Math.round((cpu.reduce((a, b) => a + b, 0) / cpu.length) * 1000) / 1000,
      wallP50: percentile(wall, 50),
      syncP50: percentile(syncMs, 50),
      drawCalls: last!.drawCalls,
      glyphs: last!.glyphs,
      atlasUploads: last!.atlasUploads,
      mode,
      dirtyRowsP50: percentile(dirty, 50),
      totalUploads,
      heapBytesPerFrame,
    };
    renderer.dispose();
    return result;
  },

  seamProbe(backend, grid, cols, rows, dpr, fontSize) {
    const { canvas, renderer } = renderSeamGrid(backend, grid, cols, rows, dpr, fontSize);
    const px = readPixels(canvas);
    const m = renderer.getMetrics();
    const d = px.data;
    const mask: string[] = [];
    for (let y = 0; y < px.height; y++) {
      let row = '';
      for (let x = 0; x < px.width; x++) {
        row += isCovered(d, (y * px.width + x) * 4) ? '1' : '0';
      }
      mask.push(row);
    }
    renderer.dispose();
    return {
      cellW: m.cellWidth,
      cellH: m.cellHeight,
      width: px.width,
      height: px.height,
      mask,
    };
  },

  seamPng(backend, grid, cols, rows, dpr, fontSize) {
    const { canvas, renderer } = renderSeamGrid(backend, grid, cols, rows, dpr, fontSize);
    const px = readPixels(canvas);
    const out = document.createElement('canvas');
    out.width = px.width;
    out.height = px.height;
    out.getContext('2d')!.putImageData(px, 0, 0);
    renderer.dispose();
    return out.toDataURL('image/png');
  },

  drawCallScaling() {
    const out: Array<{ cells: number; drawCalls: number }> = [];
    for (const [cols, rows] of [
      [10, 5],
      [80, 24],
      [200, 60],
    ] as const) {
      const source = new FakeSource({ cols, rows, fg: 0xd0d0d0, bg: 0x101010 });
      source.setCursor({ visible: false });
      for (let r = 0; r < rows; r++) {
        source.writeText(r, 0, 'abcdefghij klmnopqrst', { flags: CellFlags.UNDERLINE });
      }
      const renderer = build('webgl2');
      const canvas = makeCanvas(8, 8);
      renderer.mount(canvas);
      renderer.resize(cols, rows, 1);
      let last: RenderStats | undefined;
      renderer.on('render', (s) => (last = s));
      renderer.render(source, 0);
      out.push({ cells: cols * rows, drawCalls: last!.drawCalls });
      renderer.dispose();
    }
    return out;
  },
};

(window as unknown as { harness: Harness }).harness = harness;
