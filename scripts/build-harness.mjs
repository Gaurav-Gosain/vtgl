// Bundles the browser test harness into test-browser/harness.js. Test-only:
// the harness pulls in the renderers, the fake source, and the golden scenarios
// so Playwright can drive them in a real browser. Not part of the package build.

import { build } from 'esbuild';

await build({
  entryPoints: ['test-browser/harness.ts'],
  outfile: 'test-browser/harness.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  sourcemap: true,
  minify: false,
  logLevel: 'info',
});
