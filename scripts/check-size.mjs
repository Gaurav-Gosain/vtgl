// Size budgets for the built package. Run after `npm run build`.
//
// Two things are checked, because each has regressed before:
//
// 1. A consumer that imports only WebGL2Renderer must not pay for the embedded
//    HarfBuzz wasm and Arabic font (about 830 KB of base64). dist is one flat
//    ESM bundle, so this depends on the /*#__PURE__*/ marks on the two decode
//    calls surviving into dist/index.js, where a bundler can drop them.
// 2. The npm tarball must not carry src/ (the base64 a second time) or the
//    README screenshots, and must export ./package.json.
//
// Exits non-zero on any breach and prints the measured numbers either way.

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

// Budgets, in bytes. The measured value sits well under each one; a breach
// means something large came back, not that the code grew a little.
const RENDERER_ONLY_MAX = 64 * 1024;
const UNPACKED_MAX = 3 * 1024 * 1024;
const FORBIDDEN_PREFIXES = ['src/', 'docs/images/', 'test/', 'test-browser/'];

const failures = [];

if (!existsSync('dist/index.js')) {
  console.error('size: dist/index.js is missing. Run `npm run build` first.');
  process.exit(1);
}

async function bundleSize(contents) {
  const out = await build({
    stdin: { contents, resolveDir: process.cwd(), loader: 'js' },
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    logLevel: 'silent',
  });
  const bytes = out.outputFiles[0].contents;
  return { raw: bytes.length, gzip: gzipSync(bytes).length };
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

const rendererOnly = await bundleSize(
  "import { WebGL2Renderer } from './dist/index.js'; globalThis.r = WebGL2Renderer;",
);
console.log(
  `size: import { WebGL2Renderer }: ${kb(rendererOnly.raw)} (${kb(rendererOnly.gzip)} gzip), budget ${kb(RENDERER_ONLY_MAX)}`,
);
if (rendererOnly.raw > RENDERER_ONLY_MAX) {
  failures.push(
    `import { WebGL2Renderer } bundles to ${rendererOnly.raw} B, over ${RENDERER_ONLY_MAX} B. ` +
      'Check that the decode(B64) calls in src/shaper/hb/ still carry /*#__PURE__*/.',
  );
}

const withShaper = await bundleSize(
  "import { createHarfBuzzShaper } from './dist/index.js'; globalThis.s = createHarfBuzzShaper;",
);
console.log(`size: import { createHarfBuzzShaper }: ${kb(withShaper.raw)} (${kb(withShaper.gzip)} gzip), no budget`);

const pack = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }),
)[0];
console.log(
  `size: npm tarball: ${kb(pack.size)} packed, ${kb(pack.unpackedSize)} unpacked, ${pack.entryCount} files, budget ${kb(UNPACKED_MAX)} unpacked`,
);
if (pack.unpackedSize > UNPACKED_MAX) {
  failures.push(`the tarball unpacks to ${pack.unpackedSize} B, over ${UNPACKED_MAX} B`);
}
for (const f of pack.files) {
  if (FORBIDDEN_PREFIXES.some((p) => f.path.startsWith(p))) {
    failures.push(`the tarball contains ${f.path}`);
  }
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (pkg.exports?.['./package.json'] !== './package.json') {
  failures.push('package.json does not export "./package.json"');
}

if (failures.length > 0) {
  for (const f of failures) console.error(`size: FAIL: ${f}`);
  process.exit(1);
}
console.log('size: ok');
