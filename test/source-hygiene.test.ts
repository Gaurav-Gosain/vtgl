// Source hygiene.
//
// Both checks here exist because of real defects found in review, not as
// speculative lint. Two source files had control characters written as raw
// bytes rather than escapes, which made git classify them as binary: they
// produced no diffs in review and could not be merged. One of them also
// carried a second, divergent copy of the atlas key scheme, so the key the
// tests covered was not the key the renderer actually used.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

test('no source file embeds a raw control character', () => {
  // A literal control byte inside a string literal makes the whole file binary
  // to git. Write the unicode escape instead; it compiles to the same value.
  const offenders: string[] = [];
  for (const file of sourceFiles('src')) {
    const text = readFileSync(file, 'utf8');
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c < 0x20 && c !== 0x0a && c !== 0x09 && c !== 0x0d) {
        offenders.push(`${file}: U+${c.toString(16).padStart(4, '0')} at offset ${i}`);
        break;
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('the atlas builds keys through the one exported key scheme', () => {
  // The renderer must not carry its own copy of the key format, or changing
  // atlasKey (say, to the baked fg-quant mode) would silently not apply to the
  // glyphs the renderer actually rasters.
  const src = readFileSync('src/atlas/glyph-atlas.ts', 'utf8');
  assert.ok(src.includes('atlasKey('), 'glyph-atlas must call atlasKey');
  assert.ok(
    !/const\s+KEY_SEP/.test(src),
    'glyph-atlas must not define its own key separator',
  );
});
