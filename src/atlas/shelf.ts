// Shelf (skyline-lite) rectangle allocator for one atlas page.
//
// Slots are packed into horizontal shelves: a new rectangle goes onto the first
// shelf whose height fits and that has room left on its row, otherwise a fresh
// shelf is opened at the current fill height. This is the classic terminal
// glyph-atlas packer: glyphs of a page cluster into a handful of shelf heights
// (cellH, 2*cellH for tall clusters), so packing stays tight without a full
// MaxRects allocator. Pure and GL-free so it is unit-testable under node.

export interface Slot {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Shelf {
  y: number;
  h: number;
  used: number; // x cursor along this shelf
}

export class ShelfAllocator {
  readonly width: number;
  readonly height: number;
  private shelves: Shelf[] = [];
  private top = 0; // next free y for a new shelf

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  /**
   * Allocate a w x h slot. Returns the slot, or null if the page has no room.
   * A 1px gutter is added around each slot to keep bilinear sampling from
   * bleeding a neighbor's coverage into a glyph's edge.
   */
  alloc(w: number, h: number): Slot | null {
    const pw = w + PAD;
    const ph = h + PAD;
    if (pw > this.width || ph > this.height) return null;

    // Best-fit among existing shelves: least wasted vertical space that still
    // has horizontal room.
    let best: Shelf | null = null;
    for (const s of this.shelves) {
      if (s.h < ph) continue;
      if (this.width - s.used < pw) continue;
      if (best === null || s.h < best.h) best = s;
    }

    if (best === null) {
      // Open a new shelf at the current top if it fits vertically.
      if (this.top + ph > this.height) return null;
      best = { y: this.top, h: ph, used: 0 };
      this.shelves.push(best);
      this.top += ph;
    }

    const slot: Slot = { x: best.used, y: best.y, w, h };
    best.used += pw;
    return slot;
  }

  /** Drop all shelves; the page becomes empty. */
  reset(): void {
    this.shelves.length = 0;
    this.top = 0;
  }

  /** Fraction of page height consumed by opened shelves, 0..1. */
  fill(): number {
    return this.top / this.height;
  }
}

const PAD = 1;
