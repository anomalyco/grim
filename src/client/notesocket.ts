// The open workspace's socket (protocol v2) and its warm notes: note sessions get their RustCollab on a channel
// of it, and notes likely to be opened again or next stay open as hidden channels, each with its synced engine, so
// switching to one shows its text at once: the recently shown ones (while the socket has channels to spare) and at
// most MAX_PREFETCH prefetches (a hovered row, a tree neighbour).
// Only the selected workspace has a socket: switching closes the old one (its channels and prefetches with it)
// before opening the new one, and a tab with no workspace open has none.

import { RustCollab, type CollabFactory } from "./editor-rs/collab.ts";
import { WsClient } from "./wsclient.ts";
import { MAX_CHANNELS, MAX_PREFETCH, type WelcomeMsg, type WorkspaceEventMsg } from "../shared/wsmux.ts";

interface Warm {
  collab: RustCollab;
  /** Why it's warm: a user's intent (hover), a guess (a neighbour), or a note shown before. */
  kind: "intent" | "guess" | "released";
  off: Array<() => void>;
}

export interface NoteSocketOptions {
  /** A guest's anon / name / color for the socket URL. */
  query: () => Record<string, string>;
  /** Our presence user for new engines. */
  user: () => object;
  onEvent(repo: string, e: WorkspaceEventMsg): void;
  onWelcome?(repo: string, w: WelcomeMsg, reconnect: boolean): void;
  /** The socket closed for good (WsClient.onClose). */
  onClose?(repo: string, code: number, reason: string): void;
}

const key = (path: string) => path;

export class NoteSocket {
  private client: WsClient | null = null;
  /** Hidden notes of `client`'s workspace, least recently used first. */
  private readonly warm = new Map<string, Warm>();
  /** The note shown before the current one: kept warm in preference to others. */
  private previous: string | null = null;
  private factory: CollabFactory | null = null;

  constructor(private readonly opts: NoteSocketOptions) {}

  /** The collab engine factory, once loaded (warm notes need it; nothing is prefetched before). */
  setFactory(f: CollabFactory): void {
    this.factory = f;
  }

  /** The socket for `repo`, opening it (and retiring the previous workspace's) when it isn't the current one. */
  socket(repo: string): WsClient {
    if (this.client?.workspace === repo) return this.client;
    this.close();
    const c = new WsClient(repo, { query: this.opts.query() });
    this.client = c;
    c.onWelcome((w, reconnect) => this.client === c && this.opts.onWelcome?.(repo, w, reconnect));
    c.onEvent((e) => this.client === c && this.opts.onEvent(repo, e));
    c.onClose((code, reason) => this.client === c && this.opts.onClose?.(repo, code, reason));
    return c;
  }

  /** A new note session's connection: the warm one for this note if there is one, else a new channel. */
  open(repo: string, path: string, make: (ws: WsClient) => RustCollab): RustCollab {
    const ws = this.socket(repo);
    return this.take(repo, path) ?? make(ws);
  }

  /** The warm connection of this note, now shown (null if there's none). */
  take(repo: string, path: string): RustCollab | null {
    if (this.client?.workspace !== repo) return null;
    const w = this.warm.get(key(path));
    if (!w) return null;
    this.warm.delete(key(path));
    for (const off of w.off) off();
    if (!w.collab.live) {
      w.collab.destroy();
      return null;
    }
    if (this.previous === key(path)) this.previous = null;
    w.collab.setHidden(false);
    return w.collab;
  }

  /** A note session ended: keep its connection warm (hidden) as the previous note, or close it. */
  release(repo: string, path: string, collab: RustCollab): void {
    if (!collab.live || this.client?.workspace !== repo || !this.factory) return collab.destroy();
    collab.setHidden(true);
    collab.view = null;
    this.previous = key(path);
    // trimmed after the next session has taken its note (it may be one of the warm ones)
    this.add(path, collab, "released", false);
    queueMicrotask(() => this.trim(null));
  }

  /**
   * Prefetch a note likely to be opened next (no-op if it's warm or open, or when the open rate says no). At most
   * MAX_PREFETCH prefetches at a time: `intent` (hover, pointer down) pushes out the oldest, a guess (a tree
   * neighbour) only another guess.
   */
  prefetch(repo: string, path: string, intent = true, user = this.opts.user()): void {
    if (!this.factory || this.client?.workspace !== repo) return;
    const k = key(path);
    const w = this.warm.get(k);
    if (w) {
      // most recently wanted last
      this.warm.delete(k);
      this.warm.set(k, w);
      if (intent && w.kind === "guess") w.kind = "intent";
      return;
    }
    // open already (the note shown, or one being opened): nothing to prefetch
    if (this.client.isOpen(path)) return;
    const prefetches = [...this.warm].filter(([, w]) => w.kind !== "released");
    if (prefetches.length >= MAX_PREFETCH) {
      const victim = prefetches.find(([, w]) => intent || w.kind === "guess");
      if (!victim) return;
      this.evict(victim[0]);
    }
    // (the socket refuses prefetches when the open rate is getting near the server's limit)
    this.add(path, new RustCollab(this.factory, repo, path, user, { workspace: this.client, hidden: true }), intent ? "intent" : "guess");
  }

  /** Whether `path` is warm (prefetched and not yet taken). */
  isWarm(path: string): boolean {
    return this.warm.has(key(path));
  }

  /** The workspace whose socket is open, if any. */
  get workspace(): string | null {
    return this.client?.workspace ?? null;
  }

  /** No workspace selected: close the socket, its channels and prefetches. */
  close(): void {
    this.dropWarm();
    this.client?.close();
    this.client = null;
  }

  private add(path: string, collab: RustCollab, kind: Warm["kind"], trim = true): void {
    const k = key(path);
    const drop = () => {
      if (this.warm.get(k)?.collab !== collab) return;
      this.warm.delete(k);
      for (const off of w.off) off();
      collab.destroy();
    };
    const w: Warm = { collab, kind, off: [collab.on("closed", drop), collab.on("reset", drop), collab.on("crashed", drop)] };
    this.warm.get(k)?.collab.destroy();
    this.warm.delete(k);
    this.warm.set(k, w);
    if (trim) this.trim(k);
  }

  /**
   * Over the caps: the least recently used go. Notes shown before stay open (hidden) while the socket has room
   * (RECENT_MAX: going back costs no open and shows at once); prefetches are capped at MAX_PREFETCH. `k` (just
   * added) and the previous note are spared.
   */
  private trim(k: string | null): void {
    const recentMax = (this.client?.welcome?.maxChannels ?? MAX_CHANNELS) - 1 - MAX_PREFETCH;
    const spared = (p: string) => p === k || p === this.previous;
    for (const [released, cap] of [[true, recentMax], [false, MAX_PREFETCH]] as const) {
      const all = [...this.warm.keys()].filter((p) => (this.warm.get(p)!.kind === "released") === released);
      const over = all.length - cap;
      // least recently used first
      for (const p of all.filter((p) => !spared(p)).slice(0, Math.max(0, over))) this.evict(p);
    }
  }

  private evict(path: string): void {
    const w = this.warm.get(path);
    if (!w) return;
    this.warm.delete(path);
    for (const off of w.off) off();
    w.collab.destroy();
  }

  private dropWarm(): void {
    for (const w of this.warm.values()) {
      for (const off of w.off) off();
      w.collab.destroy();
    }
    this.warm.clear();
    this.previous = null;
  }
}
