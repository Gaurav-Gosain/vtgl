import { test } from 'node:test';
import assert from 'node:assert/strict';

import { atlasKey, atlasKeyBaked } from '../src/atlas/key.ts';
import { CellFlags } from '../src/types.ts';

test('same grapheme and style key regardless of foreground (tinting mode)', () => {
  const a = atlasKey('A', CellFlags.NONE);
  const b = atlasKey('A', CellFlags.NONE);
  assert.equal(a, b);
});

test('bold and italic change the key; underline and inverse do not', () => {
  const plain = atlasKey('A', CellFlags.NONE);
  assert.notEqual(atlasKey('A', CellFlags.BOLD), plain);
  assert.notEqual(atlasKey('A', CellFlags.ITALIC), plain);
  // Underline and strike are drawn as separate quads, not baked into the glyph.
  assert.equal(atlasKey('A', CellFlags.UNDERLINE), plain);
  assert.equal(atlasKey('A', CellFlags.STRIKETHROUGH), plain);
  assert.equal(atlasKey('A', CellFlags.INVERSE), plain);
});

test('ZWJ clusters get a distinct key from their base emoji', () => {
  assert.notEqual(atlasKey('👩‍💻', CellFlags.NONE), atlasKey('👩', CellFlags.NONE));
});

test('baked mode folds foreground quantization into the key', () => {
  const k1 = atlasKeyBaked('A', CellFlags.NONE, 0xff0000);
  const k2 = atlasKeyBaked('A', CellFlags.NONE, 0x00ff00);
  assert.notEqual(k1, k2);
  // Colors within the same 5-bit bucket collapse.
  assert.equal(atlasKeyBaked('A', CellFlags.NONE, 0xff0000), atlasKeyBaked('A', CellFlags.NONE, 0xf80000));
});
