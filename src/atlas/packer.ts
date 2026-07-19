// Dynamic multi-page glyph packer with LRU eviction. Pure and GL-free: it owns
// the key->slot bookkeeping, the shelf allocators for each page, and the
// eviction policy, but knows nothing about rasterization or textures. The
// GL-backed GlyphAtlas drives it and does the actual raster+upload on a miss.
//
// Keying is by string (see atlas/key.ts and docs/architecture.md): the same map
// serves the per-grapheme path and a future contextual shaper's per-glyph keys.

import { ShelfAllocator } from './shelf.ts';

export interface AtlasEntry {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** True if the glyph carries its own color (emoji); false for tinted mono. */
  colored: boolean;
  /** Frame index this entry was last requested; drives LRU eviction. */
  lastFrame: number;
}

export interface AllocResult {
  entry: AtlasEntry;
  /** True when the slot was just created and the caller must raster+upload. */
  isNew: boolean;
}

export interface PackerStats {
  entries: number;
  pages: number;
  evictions: number;
  flushes: number;
  /** Generation counter; bumps on every full flush so callers can invalidate. */
  generation: number;
}

export class AtlasPacker {
  readonly pageSize: number;
  readonly maxPages: number;

  private pages: ShelfAllocator[] = [];
  private readonly map = new Map<string, AtlasEntry>();
  private frame = 0;
  private evictions = 0;
  private flushes = 0;
  private generation = 0;

  constructor(pageSize: number, maxPages: number) {
    this.pageSize = pageSize;
    this.maxPages = maxPages;
    this.pages.push(new ShelfAllocator(pageSize, pageSize));
  }

  /** Advance the frame clock. Call once at the start of each render. */
  beginFrame(): void {
    this.frame++;
  }

  get(key: string): AtlasEntry | undefined {
    const e = this.map.get(key);
    if (e) e.lastFrame = this.frame;
    return e;
  }

  /**
   * Look up or allocate a slot for `key`. On a hit, returns the existing entry
   * (isNew false). On a miss, packs a w x h slot and returns isNew true so the
   * caller rasters and uploads. Returns null only if the glyph cannot be placed
   * even after growing and evicting (glyph larger than a page).
   */
  alloc(key: string, w: number, h: number, colored: boolean): AllocResult | null {
    const hit = this.map.get(key);
    if (hit) {
      hit.lastFrame = this.frame;
      return { entry: hit, isNew: false };
    }

    let slot = this.tryPlace(w, h);
    if (slot === null) {
      // Grow: add a page if under the cap.
      if (this.pages.length < this.maxPages) {
        this.pages.push(new ShelfAllocator(this.pageSize, this.pageSize));
        slot = this.tryPlace(w, h);
      }
    }
    if (slot === null) {
      // Full at the page cap: evict the LRU working set by flushing the atlas
      // and bumping the generation. Slots cannot be freed individually (shelf
      // packing), so the renderer detects the generation change and restarts the
      // frame as a full redraw, re-rastering every live glyph into the fresh
      // atlas in one pass. Count stale (not-this-frame) entries as evicted.
      for (const e of this.map.values()) if (e.lastFrame !== this.frame) this.evictions++;
      this.flush();
      slot = this.tryPlace(w, h);
    }
    if (slot === null) return null; // glyph too big for a page

    const entry: AtlasEntry = {
      page: slot.page,
      x: slot.x,
      y: slot.y,
      w,
      h,
      colored,
      lastFrame: this.frame,
    };
    this.map.set(key, entry);
    return { entry, isNew: true };
  }

  stats(): PackerStats {
    return {
      entries: this.map.size,
      pages: this.pages.length,
      evictions: this.evictions,
      flushes: this.flushes,
      generation: this.generation,
    };
  }

  /** Drop every entry and reset every page. Bumps the generation. */
  flush(): void {
    for (const p of this.pages) p.reset();
    this.map.clear();
    this.flushes++;
    this.generation++;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  // --- internals ----------------------------------------------------------

  private tryPlace(w: number, h: number): { page: number; x: number; y: number } | null {
    for (let i = 0; i < this.pages.length; i++) {
      const s = this.pages[i].alloc(w, h);
      if (s) return { page: i, x: s.x, y: s.y };
    }
    return null;
  }
}
