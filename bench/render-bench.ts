// Draw-decision benchmark for the Canvas2D renderer against the golden
// scenarios. This measures CPU time in render() and counts the drawing
// operations issued (fillRect, fillText), NOT real GPU throughput. It runs
// under Node with the recording canvas, so numbers are relative signals about
// how much work each scenario asks the renderer to do, useful for regression
// tracking and for comparing the future WebGL2 core's draw-call counts. Do not
// read absolute fps from these.

import { Canvas2DRenderer } from '../src/renderer/canvas2d.ts';
import { makeFakeCanvas } from '../src/testing/fake-canvas.ts';
import { scenarios } from '../src/testing/scenarios.ts';
import type { RenderStats } from '../src/types.ts';

const FRAMES = 200;
const WARMUP = 20;

function bench(): void {
  const theme = { foreground: 0xd0d0d0, background: 0x101010, cursor: 0xffffff };

  for (const sc of scenarios) {
    const source = sc.build();
    const canvas = makeFakeCanvas();
    const renderer = new Canvas2DRenderer({ fontFamily: 'monospace', fontSize: 14, dpr: 2, theme });
    renderer.mount(canvas as unknown as HTMLCanvasElement);
    renderer.resize(sc.cols, sc.rows, 2);

    let last: RenderStats | undefined;
    renderer.on('render', (s) => (last = s));

    // Warmup.
    for (let f = 0; f < WARMUP; f++) {
      sc.step?.(source, f);
      renderer.render(source, source.scrollbackRows);
      source.clearDirty();
    }

    let totalMs = 0;
    let totalGlyphs = 0;
    let totalRects = 0;
    let maxMs = 0;

    for (let f = 0; f < FRAMES; f++) {
      canvas.context.reset();
      sc.step?.(source, WARMUP + f);
      // Benchmark the full-screen redraw path: mark the whole viewport dirty so
      // every scenario measures a worst-case repaint, not an idle frame.
      for (let r = 0; r < sc.rows; r++) source.markDirty(source.scrollbackRows + r);
      const t0 = performance.now();
      renderer.render(source, source.scrollbackRows);
      const dt = performance.now() - t0;
      source.clearDirty();
      totalMs += dt;
      if (dt > maxMs) maxMs = dt;
      totalGlyphs += last?.glyphs ?? 0;
      totalRects += canvas.context.count('fillRect');
    }

    const avg = totalMs / FRAMES;
    const grid = `${sc.cols}x${sc.rows}`;
    console.log(
      `${sc.name.padEnd(7)} ${grid.padEnd(8)} ` +
        `avg=${avg.toFixed(3)}ms max=${maxMs.toFixed(3)}ms ` +
        `glyphs/frame=${Math.round(totalGlyphs / FRAMES)} ` +
        `fillRect/frame=${Math.round(totalRects / FRAMES)}`,
    );
  }
}

bench();
