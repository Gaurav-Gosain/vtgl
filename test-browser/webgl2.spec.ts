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

// `blocks` is here because the sprite path draws those cells twice over, once
// into the atlas slot and once straight onto the 2D canvas, and the two
// drawings have to agree pixel for pixel like every other glyph does.
for (const scenario of ['ascii', 'cjk', 'blank', 'churn', 'blocks']) {
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

test('scrolling rebuilds only the rows that entered the viewport', async ({ page }) => {
  const r = await page.evaluate(() => (window as any).harness.scrollProbe());
  expect(r.scrollFull, 'a one-row scroll is not a full rebuild').toBe(false);
  expect(r.scrollDirtyRows, 'a one-row scroll costs one row').toBe(1);
  expect(r.pixelsChanged, 'the framebuffer actually shows the new rows').toBe(true);
  expect(r.beyondViewportFull, 'a jump past the viewport has nothing to reuse').toBe(true);
  expect(r.stationaryFull, 'a stationary viewport goes back to incremental').toBe(false);
  expect(r.stationaryDirtyRows).toBe(0);
});

// The scroll fast path reuses instance data and pixels that were produced for a
// different screen row. The only argument that this is sound is that the frame
// it produces is indistinguishable from one rebuilt from scratch, so that is
// asserted directly, pixel for pixel, on both backends. The cases deliberately
// include scroll and writes landing in the same frame, which is where a naive
// implementation loses a row.
interface ScrollCase {
  name: string;
  dirtyRows: number;
  full: boolean;
  differing: number;
  total: number;
  maxChannelDelta: number;
  shapedDelta: number;
}

for (const backend of ['webgl2', 'canvas2d'] as const) {
  test(`the scroll fast path is pixel-identical to a full rebuild: ${backend}`, async ({
    page,
  }) => {
    type Case = ScrollCase;
    const cases: Case[] = await page.evaluate(
      (b) => (window as any).harness.scrollEquivalence(b),
      backend,
    );
    expect(cases.length).toBeGreaterThan(8);
    for (const c of cases) {
      expect(c.total).toBeGreaterThan(0);
      expect(
        c.differing,
        `${backend}/${c.name}: ${c.differing}/${c.total} px differ from a full rebuild ` +
          `(max channel delta ${c.maxChannelDelta})`,
      ).toBe(0);
    }
    // Equivalence alone would also be satisfied by never taking the fast path,
    // so pin the work each case did: a scroll inside the viewport must rebuild
    // only the rows it uncovered plus whatever the source dirtied.
    const byName = new Map(cases.map((c) => [c.name, c]));
    expect(byName.get('down-one')!.full).toBe(false);
    expect(byName.get('down-one')!.dirtyRows).toBe(1);
    expect(byName.get('up-one')!.dirtyRows).toBe(1);
    expect(byName.get('down-seven')!.dirtyRows).toBe(7);
    expect(byName.get('beyond-viewport')!.full, 'past a viewport, rebuild').toBe(true);
    // Two rows uncovered by the scroll plus the two written rows, both of which
    // are inside the frame's viewport.
    expect(byName.get('scroll-and-write-down')!.full).toBe(false);
    expect(byName.get('scroll-and-write-down')!.dirtyRows).toBe(4);
  });
}

// Shaping and the scroll fast path are independent features that meet in the
// instance build path, so neither branch's own suite covers them together. The
// risk is specific: shaping reorders cells within a run and writes a horizontal
// glyph offset, and if any of that encoded a screen position rather than a
// position within the row, a rotated slot would draw it in the wrong place and
// the shift would smear. Every scroll row carries an Arabic word, so this runs
// the same equivalence cases with a reordering shaper configured.
for (const backend of ['webgl2', 'canvas2d'] as const) {
  test(`the scroll fast path stays exact with a shaper configured: ${backend}`, async ({
    page,
  }) => {
    const cases: ScrollCase[] = await page.evaluate(
      (b) => (window as any).harness.scrollEquivalence(b, true),
      backend,
    );
    expect(cases.length).toBeGreaterThan(8);
    for (const c of cases) {
      expect(c.total).toBeGreaterThan(0);
      expect(
        c.differing,
        `${backend}/${c.name} shaped: ${c.differing}/${c.total} px differ from a full ` +
          `rebuild (max channel delta ${c.maxChannelDelta})`,
      ).toBe(0);
      // Equivalence under a shaper that never fired would be the same assertion
      // as the test above, so pin that the shaper actually changed this frame.
      expect(
        c.shapedDelta,
        `${backend}/${c.name}: the shaper changed nothing, so this proves nothing`,
      ).toBeGreaterThan(0);
    }
    // And it is still the fast path doing it, not a full rebuild hiding behind
    // an equal picture.
    const byName = new Map(cases.map((c) => [c.name, c]));
    expect(byName.get('down-one')!.full).toBe(false);
    expect(byName.get('down-one')!.dirtyRows).toBe(1);
    expect(byName.get('down-seven')!.dirtyRows).toBe(7);
  });
}

// Blink used to be shader-only and untested. It is asserted in real pixels on
// both backends now, because the Canvas2D path implements it too and the two
// disagreeing on a blinking cell was a genuine divergence.
for (const backend of ['webgl2', 'canvas2d'] as const) {
  test(`a blinking cell is drawn in one phase and hidden in the other: ${backend}`, async ({
    page,
  }) => {
    const r = await page.evaluate(
      (b) => (window as any).harness.blinkProbe(b),
      backend,
    );
    expect(r.inked, `${backend} never drew the blinking glyph`).toBeGreaterThan(0);
    expect(r.blank, `${backend} never hid the blinking glyph`).toBeGreaterThan(0);
  });
}

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

// --- contextual shaping --------------------------------------------------
//
// The corpus records Arabic as the honest failure: one letter per cell, each
// drawn in isolated form, so a word does not join. `arabicShaper` fixes that by
// asking the browser for each letter's contextual form and laying the run out
// right to left. These assert the change is real in pixels, that it is confined
// to Arabic, and that the guarantees the rest of the suite rests on still hold.

const ARABIC_WORDS = ['arabic-word', 'arabic-lam-alef'];

test('shaping visibly changes the Arabic words and nothing else', async ({ page }) => {
  interface RowDiff {
    name: string;
    fraction: number;
    maxChannelDelta: number;
  }
  const rows: RowDiff[] = await page.evaluate(() =>
    (window as any).harness.shapingRowDiff('webgl2'),
  );
  const byName = new Map(rows.map((r) => [r.name, r]));
  for (const name of ARABIC_WORDS) {
    // A joined word puts ink in materially different places from four isolated
    // letters. If this ever drops to zero the shaper has silently stopped.
    expect(
      byName.get(name)!.fraction,
      `${name} should look different once shaped`,
    ).toBeGreaterThan(0.01);
  }
  for (const r of rows) {
    if (ARABIC_WORDS.includes(r.name)) continue;
    // Everything else, a lone alef included, must be untouched: a shaper that
    // quietly re-rendered CJK or emoji differently would be a regression hiding
    // behind an improvement.
    expect(r.fraction, `${r.name} must be unaffected by the shaper`).toBe(0);
  }
});

test('the shaped word matches the Unicode presentation forms', async ({ page }) => {
  // The ground-truth check, and the one that would catch a shaper that made the
  // output merely different rather than right. Unicode encodes the Arabic joining
  // forms explicitly in Presentation Forms-B, including the lam-alef ligature, so
  // the expected picture of salaam is a known layout: meem isolated, then the
  // final lam-alef ligature spanning two cells, then seen initial, in that
  // left-to-right order. Rendering that reference through the same renderer and
  // comparing pixels tests the joining decision, the ligature and the
  // right-to-left column assignment at once.
  for (const backend of ['webgl2', 'canvas2d'] as const) {
    const r = await page.evaluate(
      (b) => (window as any).harness.arabicFormCheck(b),
      backend,
    );
    const shapedFraction = r.shaped / r.total;
    const plainFraction = r.plain / r.total;
    // Measured at 10/736 on both backends: the residue is edge antialiasing on
    // glyphs that are otherwise the same picture. The unshaped row sits at
    // 176/736, so the budget is wide enough to be stable and still nowhere near
    // admitting a word that failed to join.
    expect(
      shapedFraction,
      `${backend}: shaped salaam differs from the presentation forms by ${r.shaped}/${r.total} px`,
    ).toBeLessThan(0.04);
    // And the unshaped rendering is nothing like it, which is the gap being closed.
    expect(
      plainFraction,
      `${backend}: unshaped ${r.plain}/${r.total} vs shaped ${r.shaped}/${r.total}`,
    ).toBeGreaterThan(0.15);
  }
});

test('a joined word puts ink in every cell of the run', async ({ page }) => {
  for (const backend of ['webgl2', 'canvas2d'] as const) {
    const after: number[] = await page.evaluate(
      (b) => (window as any).harness.tortureColumnInk('arabic-word', b, true),
      backend,
    );
    expect(after.length).toBe(4);
    for (let i = 0; i < after.length; i++) {
      expect(after[i], `${backend}: shaped column ${i} is empty`).toBeGreaterThan(0);
    }
  }
});

test('the two backends agree on shaped Arabic', async ({ page }) => {
  // The whole point of fitting each glyph's advance to its cell is that both
  // backends then draw the same picture: the WebGL atlas has nothing to clip
  // and Canvas2D has nothing to bleed.
  for (const name of ARABIC_WORDS) {
    const gl: number[] = await page.evaluate(
      (n) => (window as any).harness.tortureColumnInk(n, 'webgl2', true),
      name,
    );
    const c2: number[] = await page.evaluate(
      (n) => (window as any).harness.tortureColumnInk(n, 'canvas2d', true),
      name,
    );
    for (let i = 0; i < gl.length; i++) {
      const ratio = gl[i] / c2[i];
      expect(
        ratio,
        `${name} column ${i}: webgl2 ${gl[i]}px vs canvas2d ${c2[i]}px`,
      ).toBeGreaterThan(0.6);
      expect(ratio, `${name} column ${i}`).toBeLessThan(1.6);
    }
  }
});

test('shaped glyphs still never escape their cells', async ({ page }) => {
  // The no-bleed guarantee is what the atlas slot buys, and fitting must not
  // have traded it away.
  interface Ink {
    name: string;
    ink: number;
    bleed: number;
  }
  const rows: Ink[] = await page.evaluate(() =>
    (window as any).harness.tortureInk('webgl2', true),
  );
  for (const r of rows) {
    expect(r.ink, `${r.name} drew no ink when shaped`).toBeGreaterThan(0);
    expect(r.bleed, `${r.name} bled past its cells when shaped`).toBe(0);
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
