// Vendor bundle: a single minified ESM file for consumers with no npm
// pipeline, which vendor a built artifact directly into their static assets.
// sip (static/vtgl/vtgl.js) is the reference consumer of this output.

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';

mkdirSync('dist', { recursive: true });

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

let rev = 'unknown';
try {
  rev = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
} catch {
  // Not a git checkout, or git is unavailable. The banner degrades to "unknown".
}

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/vtgl.vendor.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  sourcemap: false,
  minify: true,
  legalComments: 'none',
  banner: {
    js: `// vtgl ${pkg.version} (${rev}) - MIT. Built artifact, do not edit.`,
  },
  logLevel: 'info',
});

console.log(`build:vendor: dist/vtgl.vendor.js (vtgl ${pkg.version} ${rev})`);
