// Sanity benchmark, not a pass/fail suite. It reports per-frame cost for a
// worst-case full-screen repaint of each golden scenario on both backends.
//
// Read these as relative signals only. Headless chromium runs GL on SwiftShader
// (software rasterization on the CPU), so the WebGL numbers here are a floor,
// not a prediction of hardware performance: the draw-call count and the CPU
// time spent building and uploading instances are the transferable figures.
// Absolute fps claims from this environment would be meaningless.

import { test } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const HARNESS_URL = pathToFileURL(resolve('test-browser/index.html')).href;
const FRAMES = 60;

interface BenchResult {
  scenario: string;
  backend: string;
  cols: number;
  rows: number;
  cpuP50: number;
  cpuP95: number;
  wallP50: number;
  syncP50: number;
  drawCalls: number;
  glyphs: number;
  atlasUploads: number;
}

test('full-screen repaint benchmark', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(HARNESS_URL);
  await page.waitForFunction(() => (window as any).harness !== undefined);

  const names: string[] = await page.evaluate(() => (window as any).harness.scenarioNames());
  const rows: BenchResult[] = [];
  for (const name of names) {
    for (const backend of ['webgl2', 'canvas2d'] as const) {
      const r: BenchResult = await page.evaluate(
        ([n, b, f]) => (window as any).harness.bench(n, b, f),
        [name, backend, FRAMES] as const,
      );
      rows.push(r);
    }
  }

  const head =
    'scenario  backend   grid     cpuP50  cpuP95  wallP50  syncP50  draws  glyphs  uploads';
  const lines = rows.map((r) =>
    [
      r.scenario.padEnd(9),
      r.backend.padEnd(9),
      `${r.cols}x${r.rows}`.padEnd(8),
      r.cpuP50.toFixed(3).padStart(6),
      r.cpuP95.toFixed(3).padStart(7),
      r.wallP50.toFixed(3).padStart(8),
      r.syncP50.toFixed(3).padStart(8),
      String(r.drawCalls).padStart(6),
      String(r.glyphs).padStart(7),
      String(r.atlasUploads).padStart(8),
    ].join(' '),
  );
  console.log('\n' + head + '\n' + lines.join('\n') + '\n');
  console.log('NOTE: headless GL is SwiftShader software rendering; treat WebGL');
  console.log('timings as a software floor and compare relative deltas only.\n');
});
