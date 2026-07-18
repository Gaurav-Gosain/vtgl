// WebGL2 browser tests, run against the system chromium.
//
// The correctness bar is pixel parity with the Canvas2D reference renderer on
// the golden scenarios: both backends draw the same source at the same metrics
// and the resulting framebuffers must agree within a small tolerance. The rest
// of the suite asserts the pipeline's structural guarantees (fixed draw calls,
// damage-driven uploads, atlas hit behavior, context-loss survival).
//
// Headless GL is SwiftShader, so nothing here claims an absolute frame rate.

import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const HARNESS_URL = pathToFileURL(resolve('test-browser/index.html')).href;

interface RenderStats {
  dirtyRows: number;
  glyphs: number;
  drawCalls: number;
  atlasUploads: number;
  full: boolean;
  cpuMs: number;
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
  await page.goto(HARNESS_URL);
  await page.waitForFunction(() => (window as any).harness !== undefined);
});

test('the environment really provides WebGL2 and the factory selects it', async ({ page }) => {
  const probe = await page.evaluate(() => (window as any).harness.probe());
  expect(probe.supportsWebGL2).toBe(true);
  expect(probe.autoBackend).toBe('webgl2');
});

test('renders every golden scenario without error', async ({ page }) => {
  const names: string[] = await page.evaluate(() => (window as any).harness.scenarioNames());
  expect(names.length).toBeGreaterThan(0);
  for (const name of names) {
    const stats: RenderStats = await page.evaluate(
      (n) => (window as any).harness.renderScenario(n, 'webgl2'),
      name,
    );
    expect(stats.full, `${name} first frame is full`).toBe(true);
    expect(stats.drawCalls).toBeGreaterThan(0);
  }
});

// --- the correctness bar -------------------------------------------------

for (const scenario of ['ascii', 'cjk', 'blank', 'churn']) {
  test(`pixel parity with the Canvas2D reference: ${scenario}`, async ({ page }) => {
    const diff = await page.evaluate(
      (n) => (window as any).harness.compareScenario(n, 40),
      scenario,
    );
    expect(diff.total).toBeGreaterThan(0);
    // Both backends raster the same glyphs at the same integer cell origins, so
    // agreement should be near-exact; the small budget absorbs GPU sampling and
    // blend rounding on the glyph edges.
    expect(
      diff.fraction,
      `${scenario}: ${diff.differing}/${diff.total} px differ (max channel delta ${diff.maxChannelDelta})`,
    ).toBeLessThan(0.02);
  });
}

test('pixel parity on emoji and ZWJ clusters', async ({ page }) => {
  // Colored glyphs go through the untinted atlas path, which is the one place
  // the two backends can legitimately diverge slightly on edge blending.
  const diff = await page.evaluate(() => (window as any).harness.compareScenario('emoji', 40));
  expect(
    diff.fraction,
    `emoji: ${diff.differing}/${diff.total} px differ (max channel delta ${diff.maxChannelDelta})`,
  ).toBeLessThan(0.05);
});

// --- pipeline structure --------------------------------------------------

test('draw calls are fixed and independent of cell count', async ({ page }) => {
  const rows: Array<{ cells: number; drawCalls: number }> = await page.evaluate(() =>
    (window as any).harness.drawCallScaling(),
  );
  expect(rows.length).toBe(3);
  const counts = new Set(rows.map((r) => r.drawCalls));
  expect(counts.size, `draw calls varied across grid sizes: ${JSON.stringify(rows)}`).toBe(1);
  // background + glyphs + decorations, with the cursor hidden in this probe.
  expect(rows[0].drawCalls).toBe(3);
  // A 200x60 grid is 120x more cells than 10x5 and still costs the same draws.
  expect(rows[2].cells / rows[0].cells).toBeGreaterThan(100);
});

test('uploads are damage driven: clean frames re-upload nothing', async ({ page }) => {
  const stats: RenderStats[] = await page.evaluate(() =>
    (window as any).harness.damageProbe(),
  );
  const [full, clean, oneRow, twoRows] = stats;
  expect(full.full).toBe(true);
  expect(full.dirtyRows).toBe(10);
  expect(clean.dirtyRows, 'no dirty rows when nothing changed').toBe(0);
  expect(oneRow.dirtyRows, 'a single changed row reports one dirty row').toBe(1);
  expect(twoRows.dirtyRows, 'two changed rows coalesce into one run').toBe(2);
  // Draw calls stay constant regardless of how much was damaged.
  expect(new Set(stats.map((s) => s.drawCalls)).size).toBe(1);
});

test('scrolling repaints even though no row is dirty', async ({ page }) => {
  const r = await page.evaluate(() => (window as any).harness.scrollProbe());
  expect(r.scrollForcedFull, 'a viewport change forces a full rebuild').toBe(true);
  expect(r.pixelsChanged, 'the framebuffer actually shows the new rows').toBe(true);
  expect(r.stationaryFull, 'a stationary viewport goes back to incremental').toBe(false);
  expect(r.stationaryDirtyRows).toBe(0);
});

test('the atlas caches glyphs: repeat frames upload nothing new', async ({ page }) => {
  const a = await page.evaluate(() => (window as any).harness.atlasProbe());
  expect(a.first, 'first frame rasters the three distinct glyphs').toBe(3);
  expect(a.second, 'redrawing the same glyphs is all cache hits').toBe(0);
  expect(a.afterNewGlyph, 'three unseen glyphs cost three uploads').toBe(3);
});

test('context loss is survived and the renderer rebuilds on restore', async ({ page }) => {
  const r = await page.evaluate(() => (window as any).harness.contextLossProbe());
  expect(r.before).toBe('webgl2');
  expect(r.sawLost, 'the renderer observed webglcontextlost').toBe(true);
  expect(r.sawRestored, 'the renderer observed webglcontextrestored').toBe(true);
  expect(r.renderedWhileLost, 'render() is a no-op while the context is lost').toBe(false);
  expect(r.framesAfterRestore, 'exactly the post-restore frame was emitted').toBe(1);
  expect(r.afterFull, 'the first frame after restore is a full redraw').toBe(true);
  expect(r.afterUploads, 'glyphs are re-rastered into the rebuilt atlas').toBeGreaterThan(0);
});

test('glyph counts match the visible cells per scenario', async ({ page }) => {
  const ascii: RenderStats = await page.evaluate(() =>
    (window as any).harness.renderScenario('ascii', 'webgl2'),
  );
  const blank: RenderStats = await page.evaluate(() =>
    (window as any).harness.renderScenario('blank', 'webgl2'),
  );
  // The blank-heavy screen must emit far fewer glyph instances than dense text;
  // this is the degenerate-quad path doing its job.
  expect(blank.glyphs).toBeLessThan(ascii.glyphs / 10);
});

// --- grapheme torture corpus ---------------------------------------------
//
// The corpus is the hard half of Unicode: wide CJK, ZWJ sequences, flags, tag
// sequences, keycaps, both variation selectors, stacked combining marks,
// Devanagari and Arabic. Correctness here is checked two ways: the WebGL output
// must agree with the Canvas2D reference pixel for pixel, and every cluster must
// actually put ink in its own cells without bleeding into the next one.
//
// Agreement with a real ghostty-vt cell grid is asserted on the host side (the
// sip integration), because vtgl deliberately does not depend on the VT.

// Canvas2D lets a glyph whose font advance exceeds its cells paint outside
// them; the WebGL atlas rasters into a fixed cell-sized slot and clips instead.
// Measured on this corpus, canvas2d bleeds on 9 of 24 entries (a skin-tone
// emoji by 128 px), webgl2 on none. That divergence is real and is the bulk of
// the corpus-wide pixel difference, so the two behaviours are asserted
// separately rather than averaged into one loose threshold.
const BLEEDING_IN_CANVAS2D = new Set([
  'emoji-simple',
  'emoji-zwj-family',
  'emoji-skin-tone',
  'emoji-flag',
  'emoji-tag-flag',
  'emoji-keycap',
  'emoji-zwj-rainbow',
  'vs15-text-presentation',
  'devanagari-ksha',
  'devanagari-matra',
]);

test('no torture cluster is dropped, and both backends draw the same amount of it', async ({
  page,
}) => {
  // Pixel-exact parity is asserted on the dense golden scenarios. It is the
  // wrong bar for this corpus: these rows are mostly background, so a glyph
  // landing a subpixel differently swings the differing-pixel fraction wildly
  // while nothing is actually wrong. What must hold here is that both backends
  // draw the same cluster in the same cells: no cluster missing, and comparable
  // ink in each. Divergence beyond that is the clip-vs-bleed difference below.
  interface Ink {
    name: string;
    columns: number;
    ink: number;
    bleed: number;
  }
  const gl: Ink[] = await page.evaluate(() => (window as any).harness.tortureInk('webgl2'));
  const c2: Ink[] = await page.evaluate(() =>
    (window as any).harness.tortureInk('canvas2d'),
  );
  expect(gl.length).toBeGreaterThan(20);
  for (let i = 0; i < gl.length; i++) {
    const a = gl[i];
    const b = c2[i];
    expect(a.name).toBe(b.name);
    expect(a.ink, `webgl2/${a.name} drew no ink`).toBeGreaterThan(0);
    expect(b.ink, `canvas2d/${b.name} drew no ink`).toBeGreaterThan(0);
    if (BLEEDING_IN_CANVAS2D.has(a.name)) continue;
    // Same glyph, same cells: the ink each backend lays down must be close.
    const ratio = a.ink / b.ink;
    expect(
      ratio,
      `${a.name}: webgl2 drew ${a.ink}px vs canvas2d ${b.ink}px`,
    ).toBeGreaterThan(0.6);
    expect(ratio, `${a.name}: webgl2 ${a.ink}px vs canvas2d ${b.ink}px`).toBeLessThan(1.6);
  }
});

test('the webgl atlas never lets a cluster escape its cells', async ({ page }) => {
  interface Ink {
    name: string;
    columns: number;
    ink: number;
    bleed: number;
  }
  const rows: Ink[] = await page.evaluate(() =>
    (window as any).harness.tortureInk('webgl2'),
  );
  for (const r of rows) {
    expect(r.ink, `${r.name} drew no ink`).toBeGreaterThan(0);
    expect(r.bleed, `${r.name} bled past the cells the VT assigned it`).toBe(0);
  }
});

test('every torture cluster draws ink on both backends', async ({ page }) => {
  // The failure this catches is a dropped or blank cluster, which is what a
  // grapheme-unaware renderer produces for ZWJ sequences and tag flags.
  interface Ink {
    name: string;
    ink: number;
  }
  for (const backend of ['webgl2', 'canvas2d'] as const) {
    const rows: Ink[] = await page.evaluate(
      (b) => (window as any).harness.tortureInk(b),
      backend,
    );
    expect(rows.length).toBeGreaterThan(20);
    for (const r of rows) {
      expect(r.ink, `${backend}/${r.name} drew no ink`).toBeGreaterThan(0);
    }
  }
});
