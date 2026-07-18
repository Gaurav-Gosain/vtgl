# vtgl

A standalone terminal renderer. It takes read-only VT grid state and produces
pixels and input events. It does not parse escape sequences, manage clipboard,
speak any wire protocol, or own the terminal buffer. Those belong to whatever
drives it. vtgl is the drawing layer only, in the same role xterm.js's renderer
plays, but backed by any grapheme-aware VT that implements a small read-only
interface.

The target VT is ghostty-vt (compiled to wasm), whose cell model the interface
mirrors, so it drops in as the reference source. Nothing in the renderer imports
the VT.

## Status

Early. This repository currently contains:

- The full API contract as TypeScript types (see DESIGN.md and src/types.ts).
- A working Canvas2D renderer implementing the Renderer interface.
- A scriptable fake VtSource and a set of golden scenarios shared by tests and
  benchmarks.
- Unit tests and an esbuild-based build.

Not yet built: the WebGL2 glyph-atlas core, which is the reason the package
exists. The Canvas2D renderer is correct but, like every per-cell fillText
renderer, it caps full-screen redraw rate well below 60fps on large grids. The
WebGL2 core described in DESIGN.md is the path to xterm.js-WebGL-class speed. The
Canvas2D path stays as the no-WebGL2 fallback.

The name vtgl is a working name and is trivial to change.

## Design

See DESIGN.md for the API contract, the atlas key scheme, the instanced pipeline
layout, the damage and upload strategy, the fallback contract, and the hook for
contextual shaping.

## Usage

```ts
import { createRenderer } from 'vtgl';

const renderer = createRenderer({
  fontFamily: 'monospace',
  fontSize: 14,
  theme: { foreground: 0xd0d0d0, background: 0x101010, cursor: 0xffffff },
});

renderer.mount(canvas);
renderer.resize(cols, rows, devicePixelRatio);

// Each frame, hand the renderer a read-only VtSource and the top viewport row.
renderer.render(source, viewportY);
```

The source is any object implementing the VtSource interface in src/types.ts.
For tests and experiments, FakeSource in src/testing provides a scriptable grid.

## Development

```
npm install
npm run typecheck
npm run test
npm run build
```

Node 24 or newer is required for the type-stripping test runner.

## Licensing

MIT. The renderer is fresh code. It mirrors the cell model of ghostty-vt (MIT)
and takes conceptual cues from the MIT-licensed ghostty-web canvas2d renderer,
but shares no code with either.
