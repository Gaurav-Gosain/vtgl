// Minimal synchronous event emitter. Zero dependencies, no per-emit allocation
// beyond iterating the handler set.

export class Emitter<EventMap> {
  private readonly handlers = new Map<keyof EventMap, Set<(p: unknown) => void>>();

  on<K extends keyof EventMap>(event: K, handler: (payload: EventMap[K]) => void): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as (p: unknown) => void);
    return () => this.off(event, handler);
  }

  off<K extends keyof EventMap>(event: K, handler: (payload: EventMap[K]) => void): void {
    this.handlers.get(event)?.delete(handler as (p: unknown) => void);
  }

  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const h of set) h(payload);
  }

  clear(): void {
    this.handlers.clear();
  }
}
