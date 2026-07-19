// Sanity benchmark, not a pass/fail suite. It reports per-frame cost, draw
// calls, atlas traffic and heap growth for both backends across the golden
// scenarios and the four workloads the performance study characterised.
//
// Read these as relative signals only. Headless chromium runs GL on SwiftShader
// (software rasterization on the CPU), so the WebGL numbers here are a floor,
// not a prediction of hardware performance: the draw-call count and the CPU
// time spent building and uploading instances are the transferable figures.
// Absolute fps claims from this environment would be meaningless.
//
// Two modes are reported per workload:
//   full     every visible row forced dirty, i.e. worst-case full repaint.
//   natural  the damage the workload actually produces, which is what the
//            study measured against the 2D bundle.

import { test } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const HARNESS_URL = pathToFileURL(resolve('test-browser/index.html')).href;
const FRAMES = 60;
const ALLOC_FRAMES = 100;

type BenchMode = 'full' | 'natural';

interface BenchResult {
  scenario: string;
  backend: string;
  cols: number;
  rows: number;
  cpuP50: number;
  cpuP95: number;
  cpuMean: number;
  wallP50: number;
  syncP50: number;
  drawCalls: number;
  glyphs: number;
  atlasUploads: number;
  mode: BenchMode;
  dirtyRowsP50: number;
  totalUploads: number;
  heapBytesPerFrame: number | null;
}

interface AllocResult {
  scenario: string;
  backend: string;
  frames: number;
  glyphs: number;
}

interface AllocRow {
  scenario: string;
  backend: string;
  glyphs: number;
  totalBytes: number;
  bytesPerFrame: number;
  bytesPerGlyph: number;
}

interface SamplingNode {
  selfSize: number;
  children: SamplingNode[];
}

interface SamplingProfile {
  head: SamplingNode;
}

/** Sum sampled self sizes over the whole allocation tree. */
function totalBytes(node: SamplingNode): number {
  let sum = node.selfSize;
  for (const c of node.children) sum += totalBytes(c);
  return sum;
}

/** The four workloads the study measured; the rest are the golden scenarios. */
const WORKLOADS = ['dump', 'altscreen', 'scrollstorm', 'tui'];

function table(rows: BenchResult[]): string {
  const head = [
    'scenario'.padEnd(12),
    'backend'.padEnd(9),
    'mode'.padEnd(8),
    'cpuP50'.padStart(7),
    'cpuMean'.padStart(8),
    'cpuP95'.padStart(7),
    'wallP50'.padStart(8),
    'syncP50'.padStart(8),
    'draws'.padStart(6),
    'glyphs'.padStart(7),
    'dirty'.padStart(6),
    'uploads'.padStart(8),
    'B/frame'.padStart(8),
  ].join(' ');
  const body = rows.map((r) =>
    [
      r.scenario.padEnd(12),
      r.backend.padEnd(9),
      r.mode.padEnd(8),
      r.cpuP50.toFixed(3).padStart(7),
      r.cpuMean.toFixed(3).padStart(8),
      r.cpuP95.toFixed(3).padStart(7),
      r.wallP50.toFixed(3).padStart(8),
      r.syncP50.toFixed(3).padStart(8),
      String(r.drawCalls).padStart(6),
      String(r.glyphs).padStart(7),
      String(r.dirtyRowsP50).padStart(6),
      String(r.totalUploads).padStart(8),
      (r.heapBytesPerFrame === null ? 'n/a' : String(r.heapBytesPerFrame)).padStart(8),
    ].join(' '),
  );
  return head + '\n' + body.join('\n');
}

test('contextual shaping cost', async ({ page }) => {
  // What configuring a shaper costs, measured three ways, because the three
  // answers are different and a host needs all of them:
  //
  //   ascii   no cell the shaper wants. Cost is the per-cell participates()
  //           scan on every dirty row, which is the tax a host pays for leaving
  //           the shaper on when the content is not Arabic.
  //   arabic  almost every cell in a run. Cost is grouping, shaping and
  //           reordering the whole screen, i.e. the worst case.
  //   dump    a mixed scrolling workload, as a sanity check.
  test.setTimeout(900_000);
  await page.goto(HARNESS_URL);
  await page.waitForFunction(() => (window as any).harness !== undefined);

  // Paired and interleaved, five rounds. Absolute timings here drift by 2x with
  // whatever else the machine is doing, so an off-run and an on-run measured
  // minutes apart are not comparable. Measuring the pair back to back and
  // reporting the median of the per-round ratios cancels the drift; only the
  // ratio is meaningful, which is why the raw means are printed as context
  // rather than as a result.
  const ROUNDS = 5;
  const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  const lines: string[] = [];
  for (const name of ['ascii', 'arabic', 'dump']) {
    for (const backend of ['webgl2', 'canvas2d'] as const) {
      const offs: number[] = [];
      const ons: number[] = [];
      const ratios: number[] = [];
      for (let round = 0; round < ROUNDS; round++) {
        const off: BenchResult = await page.evaluate(
          ([n, b, f, m, s]) => (window as any).harness.bench(n, b, f, m, s),
          [name, backend, FRAMES, 'full', false] as const,
        );
        const on: BenchResult = await page.evaluate(
          ([n, b, f, m, s]) => (window as any).harness.bench(n, b, f, m, s),
          [name, backend, FRAMES, 'full', true] as const,
        );
        offs.push(off.cpuMean);
        ons.push(on.cpuMean);
        ratios.push(on.cpuMean / Math.max(off.cpuMean, 0.0005));
      }
      const r = median(ratios);
      lines.push(
        `${name.padEnd(8)} ${backend.padEnd(9)} ` +
          `off ${median(offs).toFixed(3)}ms  on ${median(ons).toFixed(3)}ms  ` +
          `median ratio ${r.toFixed(2)}x  ` +
          `(rounds ${ratios.map((x) => x.toFixed(2)).join(' ')})`,
      );
    }
  }
  console.log(
    '\nCPU ms inside render(), shaper off vs on, full repaint, ' +
      `${ROUNDS} interleaved rounds:\n` +
      lines.join('\n') +
      '\n',
  );
});

test('full-screen repaint benchmark', async ({ page }) => {
  // Generous: a forced-full repaint of every scenario on both backends under
  // SwiftShader is minutes of software rasterization, not a fast suite.
  test.setTimeout(900_000);
  await page.goto(HARNESS_URL);
  await page.waitForFunction(() => (window as any).harness !== undefined);

  const names: string[] = await page.evaluate(() => (window as any).harness.scenarioNames());
  const rows: BenchResult[] = [];
  for (const name of names) {
    const modes: BenchMode[] = WORKLOADS.includes(name) ? ['full', 'natural'] : ['full'];
    for (const mode of modes) {
      for (const backend of ['webgl2', 'canvas2d'] as const) {
        const r: BenchResult = await page.evaluate(
          ([n, b, f, m]) => (window as any).harness.bench(n, b, f, m),
          [name, backend, FRAMES, mode] as const,
        );
        rows.push(r);
      }
    }
  }

  console.log('\n' + table(rows) + '\n');

  // Speedup summary, paired by scenario and mode.
  const lines: string[] = [];
  for (const r of rows.filter((x) => x.backend === 'webgl2')) {
    const c2 = rows.find(
      (x) => x.backend === 'canvas2d' && x.scenario === r.scenario && x.mode === r.mode,
    );
    if (!c2) continue;
    // Ratio off the window mean, not p50: a p50 of 0.0 is the timer clamp, not
    // a zero-cost frame, and dividing by it invents a speedup.
    const ratio = c2.cpuMean / Math.max(r.cpuMean, 0.0005);
    lines.push(
      `${r.scenario.padEnd(12)} ${r.mode.padEnd(8)} ` +
        `webgl2 ${r.cpuMean.toFixed(3)}ms vs canvas2d ${c2.cpuMean.toFixed(3)}ms  ` +
        `${ratio.toFixed(1)}x`,
    );
  }
  console.log('CPU ms inside render(), webgl2 vs canvas2d:\n' + lines.join('\n') + '\n');

  console.log('NOTE: headless GL is SwiftShader software rendering; treat WebGL');
  console.log('timings as a software floor and compare relative deltas only.');
  console.log('B/frame is JS heap growth per frame, which a GC inside the');
  console.log('measurement window can flatten to 0; read it as an upper bound.\n');

  // Renderer-only allocation pressure.
  //
  // Sampled heap deltas were tried first and thrown out: usedJSHeapSize is a
  // snapshot of a GC-managed heap, so a collection inside the window produces a
  // negative "allocation" figure and the numbers measure GC timing rather than
  // allocation rate. The CDP heap profiler samples allocations as they happen,
  // which survives collection and is attributable to a stack, so it is what the
  // near-zero-allocation claim is actually checked against.
  const cdp = await page.context().newCDPSession(page);
  const allocs: AllocRow[] = [];
  for (const name of [...WORKLOADS, 'churn']) {
    for (const backend of ['webgl2', 'canvas2d'] as const) {
      await cdp.send('HeapProfiler.enable');
      await cdp.send('HeapProfiler.startSampling', { samplingInterval: 2048 });
      const probe: AllocResult = await page.evaluate(
        ([n, b, f]) => (window as any).harness.allocProbe(n, b, f),
        [name, backend, ALLOC_FRAMES] as const,
      );
      const { profile } = (await cdp.send('HeapProfiler.stopSampling')) as {
        profile: SamplingProfile;
      };
      await cdp.send('HeapProfiler.disable');
      const total = totalBytes(profile.head);
      allocs.push({
        scenario: name,
        backend,
        glyphs: probe.glyphs,
        totalBytes: total,
        bytesPerFrame: Math.round(total / ALLOC_FRAMES),
        bytesPerGlyph:
          Math.round((total / (ALLOC_FRAMES * Math.max(probe.glyphs, 1))) * 100) / 100,
      });
    }
  }

  const allocHead = [
    'scenario'.padEnd(12),
    'backend'.padEnd(9),
    'glyphs'.padStart(7),
    'totalB'.padStart(11),
    'B/frame'.padStart(9),
    'B/glyph'.padStart(8),
  ].join(' ');
  const allocBody = allocs.map((a) =>
    [
      a.scenario.padEnd(12),
      a.backend.padEnd(9),
      String(a.glyphs).padStart(7),
      String(a.totalBytes).padStart(11),
      String(a.bytesPerFrame).padStart(9),
      a.bytesPerGlyph.toFixed(2).padStart(8),
    ].join(' '),
  );
  console.log(
    `\nRenderer-only allocation, CDP sampling over ${ALLOC_FRAMES} static ` +
      `forced-full frames:\n` + allocHead + '\n' + allocBody.join('\n') + '\n',
  );

  console.log('JSON ' + JSON.stringify({ rows, allocs }));
});
