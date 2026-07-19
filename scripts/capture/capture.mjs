// Produces the README images in docs/images.
//
//   node scripts/capture/capture.mjs
//
// Every image is the real WebGL2 renderer drawing in a real browser. Nothing is
// mocked up, composited from a design tool, or retouched. Node's job here is
// only to decide which cells exist; the pixels come from vtgl.
//
//   demo.png     the actual bytes of `git log --graph` and `npm test`, run in
//                this repo, parsed for SGR and drawn as a terminal frame.
//   unicode.png  the project's own grapheme torture corpus at 1:1, labelled
//                with the column and scalar counts each entry declares.
//   atlas.png    the glyph atlas page that drew unicode.png, read back off the
//                GPU with readPixels.
//
// The browser is the system chromium via Playwright (already a dev dependency),
// with the same ANGLE/SwiftShader flags the browser tests use, so this runs
// headless on a machine with no GPU.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

import { tortureCorpus } from '../../src/testing/torture.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const OUT = resolve(ROOT, 'docs/images');
const CHROMIUM = process.env.VTGL_CHROMIUM ?? '/usr/bin/chromium';

// "DejaVu Sans" sits ahead of the emoji font on purpose. JetBrains Mono has no
// U+2714/U+2139, which node's test reporter prints, and without a text-metric
// font in front of it chromium falls back to Noto Color Emoji: an emoji-sized
// glyph in a slot the width table sized for one column, which vtgl then clips
// (docs/limits.md, "Wide glyphs clip rather than bleed"). DejaVu carries the
// same codepoints at text metrics, so they fit the cell they were assigned.
const FONT =
  '"JetBrainsMono Nerd Font Mono", "Noto Sans CJK JP", "DejaVu Sans", "Noto Color Emoji", monospace';
const DPR = 2;

const THEME = { foreground: 0xc6ccd8, background: 0x11151c, cursor: 0x5b8cff };

const FLAG = { BOLD: 1, ITALIC: 2, UNDERLINE: 4, STRIKETHROUGH: 8, FAINT: 128 };

// Palette used to resolve the SGR colours in the captured output. Slots 0-15
// are a conventional dark-terminal set; 16-255 are the standard xterm cube and
// grey ramp, computed rather than tabulated.
const BASE16 = [
  0x11151c, 0xe06c75, 0x98c379, 0xe5c07b, 0x61afef, 0xc678dd, 0x56b6c2, 0xabb2bf,
  0x5c6370, 0xef7a85, 0xa8d68a, 0xf0cd8c, 0x74bcf5, 0xd08ce8, 0x66c6d2, 0xd6dbe4,
];

function xterm256(i) {
  if (i < 16) return BASE16[i];
  if (i < 232) {
    const n = i - 16;
    const level = (v) => (v === 0 ? 0 : 55 + v * 40);
    return (level(Math.floor(n / 36)) << 16) | (level(Math.floor(n / 6) % 6) << 8) | level(n % 6);
  }
  const v = 8 + (i - 232) * 10;
  return (v << 16) | (v << 8) | v;
}

/**
 * Turn a real program's stdout into terminal cells.
 *
 * Deliberately small: it understands SGR (which is all these programs emit),
 * skips any other CSI or OSC sequence rather than guessing at it, and treats
 * the stream as line-oriented. It is not a VT emulator and is not pretending to
 * be one; vtgl does not ship a VT, and the point of this image is the drawing,
 * not the parsing.
 */
function ansiToCells(text, { row, col = 0, cols, fg = THEME.foreground }) {
  const cells = [];
  let r = row;
  let c = col;
  let state = { fg, bg: THEME.background, fl: 0 };
  const reset = () => ({ fg, bg: THEME.background, fl: 0 });

  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];

    if (ch === '\x1b') {
      const next = chars[i + 1];
      if (next === '[') {
        let j = i + 2;
        let params = '';
        while (j < chars.length && !/[@-~]/.test(chars[j])) params += chars[j++];
        const final = chars[j];
        if (final === 'm') state = applySgr(state, params, reset);
        i = j;
        continue;
      }
      if (next === ']') {
        // OSC: run to BEL or ST.
        let j = i + 2;
        while (j < chars.length && chars[j] !== '\x07') {
          if (chars[j] === '\x1b' && chars[j + 1] === '\\') {
            j++;
            break;
          }
          j++;
        }
        i = j;
        continue;
      }
      i++;
      continue;
    }

    if (ch === '\n') {
      r++;
      c = col;
      continue;
    }
    if (ch === '\r') {
      c = col;
      continue;
    }
    if (ch === '\t') {
      c = col + Math.ceil((c - col + 1) / 8) * 8;
      continue;
    }
    if (ch < ' ') continue;

    if (c < cols) {
      cells.push({ r, c, t: ch, fg: state.fg, bg: state.bg, fl: state.fl });
      c += ch.codePointAt(0) > 0x1100 ? 2 : 1;
    }
  }
  return { cells, nextRow: r + 1 };
}

function applySgr(state, params, reset) {
  const codes = (params === '' ? '0' : params).split(';').map((n) => Number(n) || 0);
  let s = { ...state };
  for (let i = 0; i < codes.length; i++) {
    const n = codes[i];
    if (n === 0) s = reset();
    else if (n === 1) s.fl |= FLAG.BOLD;
    else if (n === 2) s.fl |= FLAG.FAINT;
    else if (n === 3) s.fl |= FLAG.ITALIC;
    else if (n === 4) s.fl |= FLAG.UNDERLINE;
    else if (n === 9) s.fl |= FLAG.STRIKETHROUGH;
    else if (n === 22) s.fl &= ~(FLAG.BOLD | FLAG.FAINT);
    else if (n === 23) s.fl &= ~FLAG.ITALIC;
    else if (n === 24) s.fl &= ~FLAG.UNDERLINE;
    else if (n === 29) s.fl &= ~FLAG.STRIKETHROUGH;
    else if (n >= 30 && n <= 37) s.fg = BASE16[n - 30];
    else if (n === 39) s.fg = THEME.foreground;
    else if (n >= 40 && n <= 47) s.bg = BASE16[n - 40];
    else if (n === 49) s.bg = THEME.background;
    else if (n >= 90 && n <= 97) s.fg = BASE16[n - 90 + 8];
    else if (n >= 100 && n <= 107) s.bg = BASE16[n - 100 + 8];
    else if (n === 38 || n === 48) {
      const key = n === 38 ? 'fg' : 'bg';
      if (codes[i + 1] === 5) {
        s[key] = xterm256(codes[i + 2]);
        i += 2;
      } else if (codes[i + 1] === 2) {
        s[key] = (codes[i + 2] << 16) | (codes[i + 3] << 8) | codes[i + 4];
        i += 4;
      }
    }
  }
  return s;
}

/** ImageMagick 7 ships `magick`; ImageMagick 6 only has `convert`. */
function magickBin() {
  try {
    execFileSync('magick', ['-version'], { stdio: 'ignore' });
    return 'magick';
  } catch {
    return 'convert';
  }
}

/** Run a command in this repo and return its combined output verbatim. */
function run(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '1', COLUMNS: '96' },
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    // A non-zero exit still has output worth drawing, and hiding a failure here
    // would be exactly the kind of staged screenshot this script must not make.
    return (err.stdout ?? '') + (err.stderr ?? '');
  }
}

// --- grid 1: a real terminal frame ------------------------------------------

function buildDemoGrid() {
  const cols = 96;
  const rows = 32;
  const cells = [];
  const accent = 0x5b8cff;

  const prompt = (r, text) => {
    cells.push({ r, c: 0, t: '~/dev/vtgl', fg: 0x56b6c2 });
    cells.push({ r, c: 11, t: '$', fg: accent, fl: FLAG.BOLD });
    cells.push({ r, c: 13, t: text, fg: THEME.foreground });
  };

  let r = 0;

  prompt(r, 'git log --graph --oneline -8');
  r += 1;
  const log = run('git', ['log', '--graph', '--oneline', '--color=always', '-8']);
  const logCells = ansiToCells(log, { row: r, cols });
  cells.push(...logCells.cells);
  r = logCells.nextRow;

  prompt(r, 'npm test 2>&1 | tail -12');
  r += 1;
  const test = run('npm', ['test']);
  const tail = test.trimEnd().split('\n').slice(-12).join('\n');
  const testCells = ansiToCells(tail, { row: r, cols });
  cells.push(...testCells.cells);
  r = testCells.nextRow;

  // A box-drawing block, to show that adjacent atlas slots tile without a seam.
  // Box drawing is where a glyph atlas most visibly fails: a half-texel error in
  // the slot rectangle leaves a hairline gap down every join.
  r += 1;
  const box = [
    '┌──────────────┬──────────────┐  ╔══════════════╗  ▁▂▃▄▅▆▇█▇▆▅▄▃▂▁',
    '│ instanced    │ 1 draw call  │  ║ shelf-packed ║  ░░▒▒▓▓██▓▓▒▒░░',
    '├──────────────┼──────────────┤  ╟──────────────╢  ▏▎▍▌▋▊▉█▉▊▋▌▍▎▏',
    '│ damage-driven│ dirty rows   │  ║ 1024px pages ║  ◢◣◤◥◢◣◤◥◢◣◤◥',
    '└──────────────┴──────────────┘  ╚══════════════╝  ├─┼─┤├─┼─┤├─┼─┤',
  ];
  for (const line of box) {
    cells.push({ r, c: 0, t: line, fg: 0x74bcf5 });
    r++;
  }

  r += 1;
  cells.push({ r, c: 0, t: 'bold', fg: THEME.foreground, fl: FLAG.BOLD });
  cells.push({ r, c: 6, t: 'italic', fg: THEME.foreground, fl: FLAG.ITALIC });
  cells.push({ r, c: 14, t: 'underline', fg: THEME.foreground, fl: FLAG.UNDERLINE });
  cells.push({ r, c: 25, t: 'strikethrough', fg: THEME.foreground, fl: FLAG.STRIKETHROUGH });
  cells.push({ r, c: 40, t: 'faint', fg: THEME.foreground, fl: FLAG.FAINT });
  cells.push({ r, c: 47, t: 'reverse', fg: THEME.background, bg: 0xe5c07b });
  for (let i = 0; i < 16; i++) {
    cells.push({ r, c: 57 + i * 2, t: '  ', bg: BASE16[i] });
  }

  return { cols, rows: Math.max(rows, r + 1), cells };
}

// --- grid 2: the grapheme torture corpus ------------------------------------

function buildUnicodeGrid() {
  // A one-column left margin, so a wide cluster in the first data column is
  // plainly inside its own cells rather than running off the edge of the image.
  const M = 2;
  const cols = 62 + M * 2;
  const cells = [];
  const dim = 0x5c6370;
  const label = 0x8b93a1;
  const accent = 0x74bcf5;

  cells.push({ r: 1, c: M, t: 'cluster', fg: dim, fl: FLAG.BOLD });
  cells.push({ r: 1, c: M + 10, t: 'name', fg: dim, fl: FLAG.BOLD });
  cells.push({ r: 1, c: M + 34, t: 'cols', fg: dim, fl: FLAG.BOLD });
  cells.push({ r: 1, c: M + 40, t: 'scalars', fg: dim, fl: FLAG.BOLD });
  cells.push({ r: 1, c: M + 49, t: 'layout', fg: dim, fl: FLAG.BOLD });
  cells.push({ r: 2, c: M, t: '─'.repeat(58), fg: 0x2b3140 });

  let r = 3;
  for (const entry of tortureCorpus) {
    // Columns M..M+1 hold the cluster, then a guard column that must stay
    // empty: ink there would mean a wide glyph escaped its own cells.
    cells.push({ r, c: M, t: entry.text, fg: THEME.foreground });
    cells.push({ r, c: M + 4, t: '│', fg: 0x2b3140 });
    cells.push({ r, c: M + 6, t: entry.name, fg: label });
    cells.push({ r, c: M + 35, t: String(entry.columns), fg: accent });
    cells.push({ r, c: M + 42, t: String(entry.scalars), fg: accent });
    cells.push({
      r,
      c: M + 49,
      t: entry.layout,
      fg: entry.layout === 'wide' ? 0x98c379 : 0xe5c07b,
    });
    r++;
  }

  r += 1;
  cells.push({
    r,
    c: M,
    t: 'one grapheme cluster per row, each drawn as one atlas slot',
    fg: dim,
    fl: FLAG.ITALIC,
  });
  r++;
  cells.push({
    r,
    c: M,
    t: 'arabic draws in isolated forms: vtgl ships no shaper',
    fg: 0xe5c07b,
    fl: FLAG.ITALIC,
  });

  return { cols, rows: r + 2, cells };
}

// --- driver ------------------------------------------------------------------

async function main() {
  mkdirSync(OUT, { recursive: true });

  await build({
    entryPoints: [resolve(HERE, 'harness.ts')],
    outfile: resolve(HERE, 'harness.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2022'],
    logLevel: 'warning',
  });

  const demo = buildDemoGrid();
  const unicode = buildUnicodeGrid();

  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--disable-lcd-text',
      '--force-device-scale-factor=1',
    ],
  });

  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => {
      throw e;
    });
    await page.goto(pathToFileURL(resolve(HERE, 'index.html')).href);
    await page.evaluate(() => document.fonts.ready);

    // Chromium's toDataURL encoder leaves a fair amount on the table and stamps
    // the file with metadata, so the PNG is re-encoded stripped and at maximum
    // compression. This is lossless and it is done here rather than by hand,
    // so re-running the script reproduces the committed bytes.
    const write = (name, dataUrl) => {
      const file = resolve(OUT, name);
      writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
      execFileSync(magickBin(), [file, '-strip', '-define', 'png:compression-level=9', file]);
      return file;
    };

    const common = { fontSize: 14, dpr: DPR, fontFamily: FONT, theme: THEME };

    const demoResult = await page.evaluate(
      (spec) => window.capture.renderGrid(spec),
      { ...common, ...demo },
    );
    write('demo.png', demoResult.png);
    report('demo.png', demoResult);

    const uniResult = await page.evaluate(
      (spec) => window.capture.renderGrid(spec),
      { ...common, fontSize: 17, ...unicode },
    );
    write('unicode.png', uniResult.png);
    report('unicode.png', uniResult);

    // Read back the atlas that just drew unicode.png, before anything else
    // touches the renderer.
    const atlas = await page.evaluate(
      ({ bg, scale, rule }) => window.capture.atlasPage(0, bg, scale, rule),
      { bg: THEME.background, scale: 2, rule: 0x2f3a4d },
    );
    write('atlas.png', atlas.png);
    console.log(
      `atlas.png    ${atlas.usedWidth}x${atlas.usedHeight} of a ${atlas.pageSize}px page, ` +
        `${atlas.entries} slots across ${atlas.pages} page(s)`,
    );
  } finally {
    await browser.close();
  }
}

function report(name, r) {
  const s = r.stats;
  console.log(
    `${name.padEnd(12)} ${r.width}x${r.height}  ` +
      `${s.glyphs} glyphs, ${s.drawCalls} draw calls, ${s.atlasUploads} atlas uploads, ` +
      `${s.cpuMs.toFixed(2)}ms cpu`,
  );
}

await main();
