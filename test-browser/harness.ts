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
import { CellFlags } from '../src/types.ts';
import type { Renderer, RendererOptions, RenderStats, Theme } from '../src/types.ts';

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
    scrollForcedFull: boolean;
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
  tortureInk(backend: 'webgl2' | 'canvas2d'): TortureInk[];
  bench(
    name: string,
    backend: 'webgl2' | 'canvas2d',
    frames: number,
    mode?: BenchMode,
  ): BenchResult;
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

export interface AllocResult {
  scenario: string;
  backend: string;
  frames: number;
  /** Glyphs drawn per frame, so bytes/glyph can be reasoned about. */
  glyphs: number;
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

/** Render the whole torture corpus, one entry per row, on a fresh canvas. */
function renderTorture(backend: 'webgl2' | 'canvas2d'): {
  canvas: HTMLCanvasElement;
  renderer: Renderer;
  metrics: { cellWidth: number; cellHeight: number };
} {
  const source = buildTortureSource();
  const renderer = build(backend);
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
    // 6 scrollback rows above a 3-row screen, each row uniquely colored so a
    // stale viewport is visible in the pixels rather than only in the stats.
    const source = new FakeSource({ cols: 8, rows: 3, scrollbackRows: 6 });
    source.setCursor({ visible: false });
    for (let r = 0; r < 9; r++) {
      source.writeText(r, 0, 'row' + r, { bg: 0x010000 * (r + 1) });
    }
    const renderer = build('webgl2');
    const canvas = makeCanvas(8, 8);
    renderer.mount(canvas);
    renderer.resize(8, 3, 1);
    const stats: RenderStats[] = [];
    renderer.on('render', (s) => stats.push(s));

    renderer.render(source, 0);
    const top = readPixels(canvas).data.slice(0, 4);
    source.clearDirty();

    // Scroll without dirtying anything: the renderer must still repaint.
    renderer.render(source, 3);
    const scrolled = readPixels(canvas).data.slice(0, 4);
    const scrolledStats = stats[stats.length - 1];

    // Rendering the same viewport again must fall back to incremental.
    source.clearDirty();
    renderer.render(source, 3);
    const restated = stats[stats.length - 1];
    renderer.dispose();

    return {
      pixelsChanged: top[0] !== scrolled[0] || top[1] !== scrolled[1] || top[2] !== scrolled[2],
      scrollForcedFull: scrolledStats.full,
      stationaryFull: restated.full,
      stationaryDirtyRows: restated.dirtyRows,
    };
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

  tortureInk(backend) {
    const { canvas, renderer, metrics } = renderTorture(backend);
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

  bench(name, backend, frames, mode = 'full') {
    const sc = scenarioByName(name);
    if (!sc) throw new Error('unknown scenario: ' + name);
    const source = sc.build();
    const renderer = build(backend);
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
