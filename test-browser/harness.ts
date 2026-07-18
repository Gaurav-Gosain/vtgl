// Browser test harness entry. Bundled by scripts/build-harness.mjs into
// test-browser/harness.js and loaded by index.html, so the Playwright specs can
// drive the real renderers against the golden scenarios in a real GPU context.
// This file is test-only and is not part of the shipped package.

import { WebGL2Renderer } from '../src/renderer/webgl2.ts';
import { Canvas2DRenderer } from '../src/renderer/canvas2d.ts';
import { createRenderer, supportsWebGL2 } from '../src/index.ts';
import { FakeSource } from '../src/testing/fake-source.ts';
import { scenarios, scenarioByName } from '../src/testing/scenarios.ts';
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
  bench(name: string, backend: 'webgl2' | 'canvas2d', frames: number): BenchResult;
}

interface BenchResult {
  scenario: string;
  backend: string;
  cols: number;
  rows: number;
  /** Renderer-internal CPU time in render(), median and p95, ms. */
  cpuP50: number;
  cpuP95: number;
  /** Wall time around render() including the driver call overhead, ms. */
  wallP50: number;
  /** Wall time including a forced pipeline sync (readback), ms. */
  syncP50: number;
  drawCalls: number;
  glyphs: number;
  atlasUploads: number;
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
    renderer.render(source, source.scrollbackRows);
    if (f + 1 < frames) source.clearDirty();
  }
  return { canvas, stats, renderer };
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
    return scenarios.map((s) => s.name);
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

  bench(name, backend, frames) {
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

    const top = source.scrollbackRows;
    const markAllDirty = (): void => {
      for (let r = 0; r < sc.rows; r++) source.markDirty(top + r);
    };

    for (let f = 0; f < 10; f++) {
      sc.step?.(source, f);
      markAllDirty();
      renderer.render(source, top);
      source.clearDirty();
    }

    const cpu: number[] = [];
    const wall: number[] = [];
    const syncMs: number[] = [];
    for (let f = 0; f < frames; f++) {
      sc.step?.(source, 10 + f);
      // Worst case: every visible row dirty, i.e. a full-screen repaint.
      markAllDirty();
      const t0 = performance.now();
      renderer.render(source, top);
      const t1 = performance.now();
      sync();
      const t2 = performance.now();
      source.clearDirty();
      cpu.push(last!.cpuMs);
      wall.push(t1 - t0);
      syncMs.push(t2 - t0);
    }

    const result: BenchResult = {
      scenario: name,
      backend,
      cols: sc.cols,
      rows: sc.rows,
      cpuP50: percentile(cpu, 50),
      cpuP95: percentile(cpu, 95),
      wallP50: percentile(wall, 50),
      syncP50: percentile(syncMs, 50),
      drawCalls: last!.drawCalls,
      glyphs: last!.glyphs,
      atlasUploads: last!.atlasUploads,
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
