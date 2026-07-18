// Coalesces render requests into one render per animation frame.
//
// Without this, a caller that renders eagerly on every state change does N
// renders for N changes that land in the same frame, and worse, does them
// synchronously on whatever callback delivered the change -- a websocket
// message, a keystroke -- so rendering serialises behind input instead of
// riding the compositor's clock.
//
// The contract is: after any number of schedule() calls, exactly one render
// happens, on the next frame, and no update is ever dropped. A schedule()
// during a render defers to the following frame rather than re-entering.
//
// Modelled on xterm.js's RenderDebouncer (src/browser/RenderDebouncer.ts,
// MIT); see THIRD-PARTY.md.

export type RafLike = (cb: (time: number) => void) => number;
export type CancelRafLike = (handle: number) => void;

/** The environment's rAF, or a timer when there is no document. */
function defaultRaf(): { raf: RafLike; cancel: CancelRafLike } {
  const g = globalThis as unknown as {
    requestAnimationFrame?: RafLike;
    cancelAnimationFrame?: CancelRafLike;
  };
  if (typeof g.requestAnimationFrame === 'function' && typeof g.cancelAnimationFrame === 'function') {
    return { raf: g.requestAnimationFrame.bind(g), cancel: g.cancelAnimationFrame.bind(g) };
  }
  return {
    raf: (cb) => setTimeout(() => cb(Date.now()), 16) as unknown as number,
    cancel: (h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>),
  };
}

export interface RenderSchedulerOptions {
  /** Override the frame clock. Tests drive this by hand. */
  requestAnimationFrame?: RafLike;
  cancelAnimationFrame?: CancelRafLike;
}

export class RenderScheduler {
  private readonly raf: RafLike;
  private readonly cancel: CancelRafLike;
  private handle: number | null = null;
  private pending = false;
  private rendering = false;
  private disposed = false;

  /** Renders coalesced away since construction. Diagnostics and tests. */
  coalesced = 0;

  private readonly callback: () => void;

  constructor(callback: () => void, opts: RenderSchedulerOptions = {}) {
    this.callback = callback;
    const d = defaultRaf();
    this.raf = opts.requestAnimationFrame ?? d.raf;
    this.cancel = opts.cancelAnimationFrame ?? d.cancel;
  }

  /** True while a frame is booked. */
  get scheduled(): boolean {
    return this.handle !== null;
  }

  /**
   * Ask for a render on the next frame. Calling this repeatedly within one
   * frame books exactly one render; the extra calls are counted, not queued.
   */
  schedule(): void {
    if (this.disposed) return;
    if (this.handle !== null || (this.rendering && this.pending)) {
      this.coalesced++;
      return;
    }
    if (this.rendering) {
      // Re-entrant request: run it on the following frame instead of
      // recursing, so a render that dirties state cannot spin.
      this.pending = true;
      return;
    }
    this.handle = this.raf(() => this.fire());
  }

  /**
   * Render now if one is booked, and drop the booking. Use when a frame must
   * land before an observable side effect (a resize, a teardown).
   */
  flush(): void {
    if (this.disposed || this.handle === null) return;
    this.cancel(this.handle);
    this.handle = null;
    this.run();
  }

  private fire(): void {
    this.handle = null;
    if (this.disposed) return;
    this.run();
    // A request that arrived mid-render still has to land.
    if (this.pending) {
      this.pending = false;
      this.schedule();
    }
  }

  private run(): void {
    this.rendering = true;
    try {
      this.callback();
    } finally {
      this.rendering = false;
    }
  }

  /** Cancel any booked frame. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.handle !== null) {
      this.cancel(this.handle);
      this.handle = null;
    }
    this.pending = false;
  }
}
