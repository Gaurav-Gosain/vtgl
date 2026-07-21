// Runner for the damage-tracking measurement.
//
// Launches a headed Chromium on a virtual Hyprland output, parks it off every
// visible workspace, and refuses to report anything measured on a software
// rasteriser or in a throttled window. Total CPU comes from /proc across the
// whole browser process tree, the same shape of reading as the gpubench
// harness's metric 5, so the two are comparable.

import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { extname, join } from 'node:path';
import { writeFileSync } from 'node:fs';

const CACHE = process.env.HOME + '/.cache';
const PORT = 8787;
const WORKSPACE = process.env.VTBENCH_WS ?? '97';
const MS = Number(process.env.VTBENCH_MS ?? 5000);
const REPS = Number(process.env.VTBENCH_REPS ?? 3);

const GRIDS = [
  [80, 24],
  [120, 40],
  [200, 55],
];
const WORKLOADS = ['static', 'typing', 'flood'];
const BUILDS = ['before', 'damage'];

const MIME = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.map': 'application/json' };

function serve() {
  return new Promise((res) => {
    const server = createServer(async (req, resp) => {
      const path = req.url.split('?')[0];
      let file;
      if (path === '/' || path === '/page.html') file = join(CACHE, 'vtgl-damage/bench-damage/page.html');
      else if (path === '/driver.mjs') file = join(CACHE, 'vtgl-damage/bench-damage/driver.mjs');
      else if (path.startsWith('/before/')) file = join(CACHE, 'vtgl-before', path.slice(8));
      else if (path.startsWith('/damage/')) file = join(CACHE, 'vtgl-damage', path.slice(8));
      else { resp.writeHead(404); return resp.end(); }
      try {
        const body = await readFile(file);
        // COOP/COEP so the page is crossOriginIsolated and performance.now()
        // resolves to microseconds rather than the 100us coarsening, which is
        // wider than the frame times being measured.
        resp.writeHead(200, {
          'content-type': MIME[extname(file)] ?? 'application/octet-stream',
          'cross-origin-opener-policy': 'same-origin',
          'cross-origin-embedder-policy': 'require-corp',
          'cross-origin-resource-policy': 'same-origin',
        });
        resp.end(body);
      } catch {
        resp.writeHead(404);
        resp.end();
      }
    });
    server.listen(PORT, () => res(server));
  });
}

// --- total CPU across the browser process tree -----------------------------

const CLK = 100; // USER_HZ; Linux x86_64 is 100 everywhere in practice.

/** utime+stime in seconds for every process under `root`, from /proc. */
async function treeCpu(root) {
  const seen = new Set();
  const stack = [root];
  let total = 0;
  const children = await childMap();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // The comm field can contain spaces and parentheses; split after the last ')'.
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      total += (Number(rest[11]) + Number(rest[12])) / CLK; // utime, stime
    } catch {
      continue;
    }
    for (const c of children.get(pid) ?? []) stack.push(c);
  }
  return total;
}

async function childMap() {
  const map = new Map();
  const entries = await readdir('/proc');
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    try {
      const stat = readFileSync(`/proc/${e}/stat`, 'utf8');
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ppid = Number(rest[1]);
      if (!map.has(ppid)) map.set(ppid, []);
      map.get(ppid).push(Number(e));
    } catch {
      continue;
    }
  }
  return map;
}

/** The pid of our own browser, identified by the class flag we launched it with. */
async function findBrowserPid() {
  const entries = await readdir('/proc');
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    try {
      const cmd = readFileSync(`/proc/${e}/cmdline`, 'utf8');
      if (cmd.includes('--class=vtbench-damage') && !cmd.includes('--type=')) return Number(e);
    } catch {
      continue;
    }
  }
  throw new Error('could not find the browser process');
}

// --- window parking --------------------------------------------------------

function park() {
  try {
    const clients = JSON.parse(execFileSync('hyprctl', ['clients', '-j'], { encoding: 'utf8' }));
    for (const c of clients) {
      if (c.class !== 'vtbench-damage' && c.initialClass !== 'vtbench-damage') continue;
      execFileSync('hyprctl', ['dispatch', 'movetoworkspacesilent', `${WORKSPACE},address:${c.address}`]);
    }
  } catch {
    // Parking is best effort; the guards below are what decide if a run counts.
  }
}

// --- main ------------------------------------------------------------------

const server = await serve();
const browser = await chromium.launch({
  headless: false,
  args: [
    '--class=vtbench-damage',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-features=CalculateNativeWinOcclusion',
    '--enable-gpu-rasterization',
    '--ignore-gpu-blocklist',
  ],
});
// The browser root, found by its own launch flag rather than asked of
// Playwright, so the walk below covers every child it spawned: renderers, the
// GPU process, the network service.
const browserPid = await findBrowserPid();
const parker = setInterval(park, 500);
park();

const page = await browser.newPage();
page.on('pageerror', (e) => {
  console.error('PAGE ERROR', e.message);
});

const results = [];
let guard = null;

try {
  for (const build of BUILDS) {
    await page.goto(`http://127.0.0.1:${PORT}/page.html?build=${build}`);
    await page.waitForFunction(() => window.ready === true, null, { timeout: 20000 });
    park();

    // Guards. A run on SwiftShader or in a throttled window is discarded, not
    // reported: either one makes every number below fiction.
    const renderer = await page.evaluate(() => window.glInfo());
    const raf = await page.evaluate(() => window.rafRate());
    if (!renderer || !/NVIDIA/.test(renderer) || /swiftshader|llvmpipe|software/i.test(renderer)) {
      throw new Error(`guard failed: not on the NVIDIA GPU: ${renderer}`);
    }
    if (raf < 55) throw new Error(`guard failed: rAF only ${raf}/s, window is throttled`);
    const isolated = await page.evaluate(() => window.isolated());
    if (!isolated) throw new Error('guard failed: page is not crossOriginIsolated, timers are coarsened');
    guard = { renderer, raf, isolated };
    console.error(`[${build}] guard ok: ${renderer}, rAF ${raf}/s, isolated ${isolated}`);

    for (const workload of WORKLOADS) {
      for (const [cols, rows] of GRIDS) {
        for (let rep = 0; rep < REPS; rep++) {
          const cpu0 = await treeCpu(browserPid);
          const t0 = Date.now();
          const r = await page.evaluate(
            ([w, c, rr, ms]) => window.run(w, c, rr, ms),
            [workload, cols, rows, MS],
          );
          const cpu1 = await treeCpu(browserPid);
          const wall = (Date.now() - t0) / 1000;
          r.build = build;
          r.rep = rep;
          // CPU seconds per second of wall clock, every thread in every
          // process of the browser tree, GPU process included.
          r.totalCpu = (cpu1 - cpu0) / wall;
          results.push(r);
          console.error(
            `[${build}] ${workload} ${cols}x${rows} rep${rep}: ` +
              `cpuP50 ${r.cpuP50.toFixed(3)}ms fps ${r.fps.toFixed(1)} ` +
              `totalCPU ${r.totalCpu.toFixed(3)} skipped ${r.skippedFrames}/${r.frames}`,
          );
        }
      }
    }
  }
} finally {
  clearInterval(parker);
  await browser.close();
  server.close();
}

writeFileSync(
  process.env.VTBENCH_OUT ?? join(CACHE, 'vtgl-damage/bench-damage/results.json'),
  JSON.stringify({ guard, ms: MS, reps: REPS, results }, null, 2),
);
console.error('wrote results');
