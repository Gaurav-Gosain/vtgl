# Third-party provenance

Three modules were written by following the approach taken in xterm.js, which is
MIT licensed; none is a verbatim copy. The optional HarfBuzz shaper vendors the
harfbuzzjs engine and bundles an Arabic font, both under permissive licences.
This file records the provenance so the lineage is not lost.

## xterm.js

Copyright (c) 2017, The xterm.js authors (https://github.com/xtermjs/xterm.js)
Licensed under the MIT License.

- `src/renderer/metrics.ts` measures a font's vertical extents through the
  TextMetrics API (`fontBoundingBoxAscent` / `fontBoundingBoxDescent`) rather
  than deriving them from the nominal font size. The approach follows xterm.js's
  `TextMetricsMeasureStrategy` in `src/browser/services/CharSizeService.ts` and
  the cell-dimension arithmetic in `addons/addon-webgl/src/WebglRenderer.ts`.

- `src/renderer/scheduler.ts` coalesces render requests into one render per
  animation frame. The contract follows xterm.js's `RenderDebouncer` in
  `src/browser/RenderDebouncer.ts`.

- `src/renderer/box-drawing.ts` draws U+2500..U+259F as vector sprites over the
  cell rectangle instead of rastering the font's glyphs, so that adjacent cells
  abut. xterm.js does the same thing and for the same reason, in
  `src/browser/renderer/shared/CustomGlyphs.ts`. The shape definitions here were
  written from the Unicode charts rather than taken from that file: the arm
  table, the double-junction rules and the shade lattice are vtgl's own.

The MIT License permits this use. The full license text is available at
https://github.com/xtermjs/xterm.js/blob/master/LICENSE

## harfbuzzjs (optional HarfBuzz shaper)

Copyright the HarfBuzz and harfbuzzjs authors. harfbuzzjs 1.4.0 (HarfBuzz
14.2.1), MIT licensed (https://github.com/harfbuzz/harfbuzzjs).

Used only by `createHarfBuzzShaper()`; nothing else in vtgl imports it, so a
host that does not construct that shaper does not pull it in. The following are
vendored under `src/shaper/hb/`:

- `harfbuzz-glue.js` is harfbuzzjs's Emscripten glue (`dist/harfbuzz.js`),
  patched only to be environment-neutral: the Node-only dynamic `import`,
  `ENVIRONMENT_IS_NODE` branch and `import.meta.url` references are removed so it
  bundles cleanly into an IIFE and always takes its wasm bytes from the caller.
- `harfbuzz-wrapper.js` is harfbuzzjs's ESM wrapper (`dist/index.mjs`), patched
  to drop the top-level `await` auto-init (illegal in an IIFE bundle) and expose
  an async `initHarfBuzz(wasmBinary)` instead.
- `harfbuzz-wasm.ts` embeds `dist/harfbuzz.wasm` (the shaping module, not the
  508 KB subsetting module, which is not used) as base64.

The MIT License permits this use.

## Noto Sans Arabic (optional HarfBuzz shaper)

Copyright the Noto Project Authors. Licensed under the SIL Open Font License 1.1,
which permits embedding and redistribution (https://github.com/notofonts/arabic).

`src/shaper/hb/font-noto-arabic.ts` embeds the regular face as base64, used only
as the default Arabic face for `createHarfBuzzShaper()`. A host may supply its
own OFL/embeddable face via `HarfBuzzShaperOptions.fontBytes`.
