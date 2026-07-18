# Third-party provenance

vtgl carries no vendored third-party code. Two modules were written by
following the approach taken in xterm.js, which is MIT licensed. Neither is a
verbatim copy; both are reimplementations against vtgl's own interfaces. This
file records the provenance anyway, so the lineage is not lost.

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

The MIT License permits this use. The full license text is available at
https://github.com/xtermjs/xterm.js/blob/master/LICENSE
