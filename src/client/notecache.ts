// Recently seen note text, kept in memory, so a note shows at once when it's opened: the text it had when it was
// last open here, or what a prefetch (hovering or focusing its row, the rows next to the open note, the click itself)
// got over HTTP. It's only ever shown read-only until the note's live document has synced, which then replaces it.

export interface CachedNote {
  text: string;
  /** When it was stored (ms, `now()`). */
  at: number;
}

export interface NoteCacheOptions {
  /** Reads a note's current text (GET /api/workspace/:id/file). */
  fetch(repo: string, path: string): Promise<string>;
  /** At most this many notes (default 100) … */
  max?: number;
  /** … and this many characters in all (default 8M). */
  maxChars?: number;
  now?: () => number;
}

const key = (repo: string, path: string) => `${repo}\u0000${path}`;

export class NoteCache {
  private notes = new Map<string, CachedNote>();
  private inflight = new Map<string, Promise<string | null>>();
  private chars = 0;
  private readonly max: number;
  private readonly maxChars: number;
  private readonly now: () => number;

  constructor(private opts: NoteCacheOptions) {
    this.max = opts.max ?? 100;
    this.maxChars = opts.maxChars ?? 8_000_000;
    this.now = opts.now ?? (() => performance.now());
  }

  get(repo: string, path: string): CachedNote | null {
    const k = key(repo, path);
    const e = this.notes.get(k);
    if (!e) return null;
    // most recently used last
    this.notes.delete(k);
    this.notes.set(k, e);
    return e;
  }

  put(repo: string, path: string, text: string) {
    const k = key(repo, path);
    this.drop(k);
    if (text.length > this.maxChars) return;
    this.notes.set(k, { text, at: this.now() });
    this.chars += text.length;
    for (const [old] of this.notes) {
      if (this.notes.size <= this.max && this.chars <= this.maxChars) break;
      this.drop(old);
    }
  }

  forget(repo: string, path: string) {
    this.drop(key(repo, path));
  }

  /**
   * Fetch the note's text into the cache unless what's there is younger than `maxAgeMs`; one request per note at a
   * time. Resolves with the text (null when it couldn't be read: missing, too large, offline).
   */
  prefetch(repo: string, path: string, maxAgeMs = 0): Promise<string | null> {
    const k = key(repo, path);
    const e = this.notes.get(k);
    if (e && maxAgeMs > 0 && this.now() - e.at < maxAgeMs) return Promise.resolve(e.text);
    let p = this.inflight.get(k);
    if (!p) {
      const started = this.now();
      p = this.opts.fetch(repo, path).then(
        (text) => {
          // a newer copy stored meanwhile (the note was open here) wins
          const cur = this.notes.get(k);
          if (!cur || cur.at <= started) this.put(repo, path, text);
          return this.notes.get(k)?.text ?? text;
        },
        () => null,
      );
      this.inflight.set(k, p);
      void p.finally(() => this.inflight.delete(k));
    }
    return p;
  }

  private drop(k: string) {
    const e = this.notes.get(k);
    if (!e) return;
    this.chars -= e.text.length;
    this.notes.delete(k);
  }
}
