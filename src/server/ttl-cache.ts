// A small in-memory cache: entries expire after their TTL, and the least recently used one is dropped once the cache
// holds `max` entries. Per process (or Workers isolate); nothing is shared between them.

export interface TtlCacheOptions {
  /** The most entries kept (default 10 000). */
  max?: number;
  /** The clock, in ms (tests inject one). */
  now?: () => number;
}

export class TtlCache<K, V> {
  readonly max: number;
  private readonly now: () => number;
  // A Map iterates in insertion order: re-inserting on each hit keeps the least recently used entry first.
  private readonly map = new Map<K, { value: V; expires: number }>();

  constructor(opts: TtlCacheOptions = {}) {
    this.max = Math.max(1, opts.max ?? 10_000);
    this.now = opts.now ?? Date.now;
  }

  /** The entry for `key`, if present and not expired (it becomes the most recently used). */
  lookup(key: K): { value: V } | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    this.map.delete(key);
    if (e.expires <= this.now()) return undefined;
    this.map.set(key, e);
    return { value: e.value };
  }

  get(key: K): V | undefined {
    return this.lookup(key)?.value;
  }

  set(key: K, value: V, ttlMs: number): void {
    this.map.delete(key);
    if (!(ttlMs > 0)) return;
    this.map.set(key, { value, expires: this.now() + ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as K);
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  /** Remove every entry whose value matches. */
  deleteWhere(match: (value: V, key: K) => boolean): number {
    let n = 0;
    for (const [k, e] of this.map) {
      if (match(e.value, k)) {
        this.map.delete(k);
        n++;
      }
    }
    return n;
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
