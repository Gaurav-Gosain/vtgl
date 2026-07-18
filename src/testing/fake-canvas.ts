// A recording 2D canvas for headless unit tests. Not a real rasterizer: it
// records the drawing operations the renderer issues so tests can assert on
// decisions (which cells filled, which glyphs drawn, dirty-row scoping) without
// a DOM or GPU. Browser pixel tests run separately under Playwright.

export interface RecordedOp {
  op: 'fillRect' | 'fillText' | 'clearRect';
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

  fillRect(x: number, y: number, w: number, h: number): void {
    this.ops.push({ op: 'fillRect', x, y, w, h, fillStyle: this.fillStyle, font: this.font, globalAlpha: this.globalAlpha });
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    this.ops.push({ op: 'clearRect', x, y, w, h, fillStyle: this.fillStyle, font: this.font, globalAlpha: this.globalAlpha });
  }

  fillText(text: string, x: number, y: number): void {
    this.ops.push({ op: 'fillText', x, y, text, fillStyle: this.fillStyle, font: this.font, globalAlpha: this.globalAlpha });
  }

  measureText(text: string): { width: number } {
    const px = parseFloat(this.font) || 10;
    return { width: text.length * px * this.advanceRatio };
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
