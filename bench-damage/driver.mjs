// Damage-tracking measurement driver.
//
// Drives one vtgl WebGL2Renderer over three workloads that differ only in how
// much of the grid changes per frame: nothing (static), one row (typing), and
// everything (flood). The same source implementation feeds every build, so a
// before/after comparison measures the renderer and not the driver.
//
// The build under test is selected by ?build=, which the runner maps onto the
// two dist bundles. Nothing here imports from vtgl's test tree: the source is
// local so the bundle's own testing exports cannot drift between builds.

const params = new URLSearchParams(location.search);
const BUILD = params.get('build') ?? 'damage';

const mod = await import(`/${BUILD}/dist/index.js`);
const { WebGL2Renderer } = mod;

const FG = 0xd0d0d0;
const BG = 0x101010;
const RAMP = '@#S%?*+;:,. abcdefghijklmnopqrstuvwxyz0123456789';

/** Minimal VtSource with per-row damage, matching vtgl's dirty contract. */
class Source {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.scrollbackRows = 0;
    this.cp = new Uint32Array(cols * rows);
    this.fgv = new Uint32Array(cols * rows);
    this.dirty = new Uint8Array(rows).fill(1);
    this.cursor = { x: 0, y: 0, visible: true, shape: 'block' };
    const self = this;
    this.lines = [];
    for (let r = 0; r < rows; r++) {
      const base = r * cols;
      this.lines.push({
        length: cols,
        codepoint: (c) => self.cp[base + c],
        grapheme: (c) => String.fromCodePoint(self.cp[base + c] || 32),
        width: () => 1,
        fg: (c) => self.fgv[base + c],
        bg: () => BG,
        flags: () => 0,
      });
    }
  }
  set(r, c, code, fg) {
    this.cp[r * this.cols + c] = code;
    this.fgv[r * this.cols + c] = fg;
    this.dirty[r] = 1;
  }
  fillRow(r, phase) {
    for (let c = 0; c < this.cols; c++) {
      const ch = RAMP[(r * 5 + c * 3 + phase) % RAMP.length];
      this.set(r, c, ch.codePointAt(0), 0x000000 | (((r * 9 + phase) & 0xff) << 16) | ((c * 2) & 0xff));
    }
  }
  getLine(r) { return this.lines[r]; }
  getCell(r, c) {
    const l = this.lines[r];
    return { codepoint: l.codepoint(c), grapheme: l.grapheme(c), width: 1, fg: l.fg(c), bg: BG, flags: 0 };
  }
  getGraphemeString(r, c) { return this.lines[r].grapheme(c); }
  getCursor() { return this.cursor; }
  isRowDirty(r) { return this.dirty[r] !== 0; }
  clearDirty() { this.dirty.fill(0); }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

/** WebGL unmasked renderer string, for the software-rasteriser guard. */
window.glInfo = () => {
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) return null;
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
};

/** rAF callbacks delivered in one second, for the throttling guard. */
window.rafRate = () =>
  new Promise((res) => {
    let n = 0;
    const t0 = performance.now();
    const tick = () => {
      n++;
      if (performance.now() - t0 >= 1000) res(n);
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

/**
 * Run one workload for `ms` and return the frame statistics.
 *
 * Every workload renders on every animation frame, which is what a terminal
 * driven by a frame loop does. What differs is how much the source changed
 * since the last frame, which is exactly the axis damage tracking acts on.
 */
window.run = async (workload, cols, rows, ms) => {
  const canvas = document.getElementById('c');
  const renderer = new WebGL2Renderer({
    fontFamily: 'monospace',
    fontSize: 14,
    lineHeight: 1.2,
    theme: { foreground: FG, background: BG, cursor: 0xd0d0d0 },
  });
  renderer.mount(canvas);
  renderer.resize(cols, rows, 1);

  const src = new Source(cols, rows);
  for (let r = 0; r < rows; r++) src.fillRow(r, 0);

  const cpu = [];
  const stamps = [];
  let skipped = 0;
  let dirtyTotal = 0;
  renderer.on('render', (s) => {
    cpu.push(s.cpuMs);
    dirtyTotal += s.dirtyRows;
    if (s.skipped) skipped++;
  });

  // Warm the atlas and let the first full frame land outside the window.
  renderer.render(src, 0);
  src.clearDirty();
  await new Promise((r) => requestAnimationFrame(r));
  cpu.length = 0;
  skipped = 0;
  dirtyTotal = 0;

  let frame = 0;
  const t0 = performance.now();
  await new Promise((done) => {
    const tick = () => {
      const now = performance.now();
      if (now - t0 >= ms) return done();
      stamps.push(now);
      src.clearDirty();
      if (workload === 'flood') {
        for (let r = 0; r < rows; r++) src.fillRow(r, frame);
      } else if (workload === 'typing') {
        // One cell per frame, as an echoed keystroke would be, with the cursor
        // following it. Dirties exactly one row.
        const r = rows - 1;
        const c = frame % cols;
        src.set(r, c, RAMP[frame % RAMP.length].codePointAt(0), FG);
        src.cursor = { x: (c + 1) % cols, y: r, visible: true, shape: 'block' };
      }
      // 'static' changes nothing at all.
      renderer.render(src, 0);
      frame++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const wall = performance.now() - t0;

  const intervals = [];
  for (let i = 1; i < stamps.length; i++) intervals.push(stamps[i] - stamps[i - 1]);
  intervals.sort((a, b) => a - b);
  const sortedCpu = cpu.slice().sort((a, b) => a - b);
  renderer.dispose();

  return {
    workload,
    cols,
    rows,
    frames: frame,
    wallMs: wall,
    fps: (frame / wall) * 1000,
    cpuP50: percentile(sortedCpu, 50),
    cpuP95: percentile(sortedCpu, 95),
    cpuMean: sortedCpu.reduce((a, b) => a + b, 0) / (sortedCpu.length || 1),
    intervalP50: percentile(intervals, 50),
    intervalP95: percentile(intervals, 95),
    skippedFrames: skipped,
    dirtyRowsPerFrame: dirtyTotal / (frame || 1),
  };
};

window.isolated = () => globalThis.crossOriginIsolated === true;
window.ready = true;
