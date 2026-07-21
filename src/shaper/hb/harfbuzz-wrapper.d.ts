// Types for the vendored HarfBuzz wrapper (src/shaper/hb/harfbuzz-wrapper.js).
// Only the surface vtgl uses is declared; the wrapper exposes more.

/** One shaped glyph, in font units at the face's upem scale. */
export interface HbGlyphInfo {
  /** Glyph id in the face. */
  codepoint: number;
  /** Input offset (UTF-16 code unit) this glyph's cluster starts at. */
  cluster: number;
  xAdvance: number;
  yAdvance: number;
  xOffset: number;
  yOffset: number;
}

export class Blob {
  constructor(data: Uint8Array);
}

export class Face {
  constructor(blob: Blob, index: number);
  readonly upem: number;
}

export class Font {
  constructor(face: Face);
  /** SVG path for a glyph id, in font units, y up. */
  glyphToPath(glyphId: number): string;
}

export class Buffer {
  constructor();
  addText(text: string): void;
  guessSegmentProperties(): void;
  reset(): void;
  clearContents(): void;
  setDirection(dir: string): void;
  setScript(script: string): void;
  setClusterLevel(level: number): void;
  getGlyphInfosAndPositions(): HbGlyphInfo[];
}

export function shape(font: Font, buffer: Buffer): void;
export function versionString(): string;

/** Initialize the module from raw wasm bytes. Await once before any other call. */
export function initHarfBuzz(wasmBinary: Uint8Array): Promise<void>;
export function harfBuzzReady(): boolean;
