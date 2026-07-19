// A recording 2D canvas for headless unit tests. Not a real rasterizer: it
// records the drawing operations the renderer issues so tests can assert on
// decisions (which cells filled, which glyphs drawn, dirty-row scoping) without
// a DOM or GPU. Browser pixel tests run separately under Playwright.

export interface RecordedOp {
  op: 'fillRect' | 'fillText' | 'clearRect' | 'drawImage';
  x: number;
  y: number;
  w?: number;
  h?: number;
  text?: string;
  fillStyle: string;
  font: string;
  globalAlpha: number;
}

export class RecordingContext2D {
  fillStyle = '#000000';
  font = '10px monospace';
  globalAlpha = 1;
  textBaseline: CanvasTextBaseline = 'alphabetic';

  readonly ops: RecordedOp[] = [];
  /** Per-code-point advance used by measureText, in the current font's px. */
  private advanceRatio = 0.6;
  /**
   * Vertical extents reported by measureText, as a fraction of the font px.
   * Chosen so the natural line box is 1.2x the nominal size, which is what a
   * typical monospace face declares.
   */
  private ascentRatio = 1.0;
  private descentRatio = 0.2;

  fillRect(x: number, y: number, w: number, h: number): void {
    this.ops.push({ op: 'fillRect', x, y, w, h, fillStyle: this.fillStyle, font: this.font, globalAlpha: this.globalAlpha });
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    this.ops.push({ op: 'clearRect', x, y, w, h, fillStyle: this.fillStyle, font: this.font, globalAlpha: this.globalAlpha });
  }

  /**
   * Recorded, not simulated. The renderer blits the canvas onto itself to shift
   * rows on a scroll; there are no pixels here, so tests assert that the shift
   * was issued at the right offset and that the uncovered rows were repainted.
   */
  drawImage(_image: unknown, x: number, y: number): void {
    this.ops.push({ op: 'drawImage', x, y, fillStyle: this.fillStyle, font: this.font, globalAlpha: this.globalAlpha });
  }

  fillText(text: string, x: number, y: number): void {
    this.ops.push({ op: 'fillText', x, y, text, fillStyle: this.fillStyle, font: this.font, globalAlpha: this.globalAlpha });
  }

  measureText(text: string): {
    width: number;
    fontBoundingBoxAscent: number;
    fontBoundingBoxDescent: number;
  } {
    const px = parseFloat(this.font) || 10;
    return {
      width: text.length * px * this.advanceRatio,
      fontBoundingBoxAscent: px * this.ascentRatio,
      fontBoundingBoxDescent: px * this.descentRatio,
    };
  }

  // Methods the renderer may touch but the tests ignore.
  save(): void {}
  restore(): void {}
  beginPath(): void {}
  rect(): void {}
  clip(): void {}

  reset(): void {
    this.ops.length = 0;
  }

  count(op: RecordedOp['op']): number {
    let n = 0;
    for (const o of this.ops) if (o.op === op) n++;
    return n;
  }

  texts(): string[] {
    return this.ops.filter((o) => o.op === 'fillText').map((o) => o.text as string);
  }
}

export class FakeCanvas {
  width = 0;
  height = 0;
  private readonly ctx = new RecordingContext2D();

  getContext(kind: string): RecordingContext2D | null {
    return kind === '2d' ? this.ctx : null;
  }

  get context(): RecordingContext2D {
    return this.ctx;
  }
}

/** Build a FakeCanvas typed loosely enough to hand to Renderer.mount in tests. */
export function makeFakeCanvas(): FakeCanvas {
  return new FakeCanvas();
}
