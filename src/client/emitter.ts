// Tiny typed event emitter.
type Handler = (...args: any[]) => void;

export class Emitter<E extends Record<string, unknown[]>> {
  private handlers = new Map<keyof E, Set<Handler>>();

  on<K extends keyof E>(type: K, fn: (...args: E[K]) => void): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  emit<K extends keyof E>(type: K, ...args: E[K]) {
    for (const fn of [...(this.handlers.get(type) ?? [])]) {
      try {
        fn(...args);
      } catch (err) {
        console.error(err);
      }
    }
  }

  clear() {
    this.handlers.clear();
  }
}
