// esbuild bundle script. Produces an ESM bundle plus type declarations.
// The renderer core is dependency-free, so this is a single entry point.

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

mkdirSync('dist', { recursive: true });

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  sourcemap: true,
  minify: false,
  logLevel: 'info',
});

// Type declarations, via the emit-only build config.
execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json'], { stdio: 'inherit' });

// emitDeclarationOnly keeps the source `.ts` import specifiers; rewrite them to
// `.js` so the shipped declarations resolve against their sibling `.d.ts`.
function rewriteDts(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) rewriteDts(p);
    else if (entry.name.endsWith('.d.ts')) {
      const src = readFileSync(p, 'utf8');
      const out = src.replace(/(from\s+['"]\.[^'"]+?)\.ts(['"])/g, '$1.js$2');
      if (out !== src) writeFileSync(p, out);
    }
  }
}
rewriteDts('dist');

console.log('build: dist/index.js + declarations');
