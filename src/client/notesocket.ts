// The open workspace's socket (protocol v2) and its warm notes: note sessions get their RustCollab on a channel
// of it, and the notes likely to be opened next (the previous one, the tree neighbours, a hovered row) are kept open
// as hidden channels (at most MAX_PREFETCH), each with its synced engine, so switching to one shows its text at once.
// Only the selected workspace has a socket: switching closes the old one (its channels and prefetches with it)
// before opening the new one, and a tab with no workspace open has none.

import { RustCollab, type CollabFactory } from "./editor-rs/collab.ts";
import { WsClient } from "./wsclient.ts";
import { MAX_PREFETCH, OPEN_RATE_WINDOW_MS, type WelcomeMsg, type WorkspaceEventMsg } from "../shared/wsmux.ts";

/** Prefetch opens allowed per OPEN_RATE_WINDOW_MS (the server allows 16 opens in all; clicks need the rest). */
const PREFETCH_RATE = 6;

interface Warm {
  collab: RustCollab;
  off: Array<() => void>;
}

export interface NoteSocketOptions {
  /** A guest's anon / name / color for the socket URL. */
  query: () => Record<string, string>;
  /** Our presence user for new engines. */
  user: () => object;
  onEvent(repo: string, e: WorkspaceEventMsg): void;
  onWelcome?(repo: string, w: WelcomeMsg, reconnect: boolean): void;
}

const key = (path: string) => path;

export class NoteSocket {
  private client: WsClient | null = null;
  /** Hidden notes of `client`'s workspace, least recently used first. */
  private readonly warm = new Map<string, Warm>();
  /** The note shown before the current one: kept warm in preference to others. */
  private previous: string | null = null;
  private factory: CollabFactory | null = null;
  private prefetches: number[] = [];

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
    this.add(path, collab);
  }

  /** Prefetch a note likely to be opened next (no-op if it's warm, or the rate or the engine says no). */
  prefetch(repo: string, path: string, user = this.opts.user()): void {
    if (!this.factory || this.client?.workspace !== repo) return;
    const k = key(path);
    const w = this.warm.get(k);
    if (w) {
      // most recently wanted last
      this.warm.delete(k);
      this.warm.set(k, w);
      return;
    }
    const now = performance.now();
    this.prefetches = this.prefetches.filter((t) => now - t < OPEN_RATE_WINDOW_MS);
    if (this.prefetches.length >= PREFETCH_RATE) return;
    this.prefetches.push(now);
    this.add(path, new RustCollab(this.factory, repo, path, user, { workspace: this.client, hidden: true }));
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

  private add(path: string, collab: RustCollab): void {
    const k = key(path);
    const drop = () => {
      if (this.warm.get(k)?.collab !== collab) return;
      this.warm.delete(k);
      for (const off of w.off) off();
      collab.destroy();
    };
    const w: Warm = { collab, off: [collab.on("closed", drop), collab.on("reset", drop), collab.on("crashed", drop)] };
    this.warm.get(k)?.collab.destroy();
    this.warm.delete(k);
    this.warm.set(k, w);
    // over the cap: the least recently used, sparing the previous note and the one just added
    while (this.warm.size > MAX_PREFETCH) {
      let victim: string | null = null;
      for (const p of this.warm.keys()) {
        if (p !== k && p !== this.previous) {
          victim = p;
          break;
        }
      }
      victim ??= [...this.warm.keys()].find((p) => p !== k) ?? null;
      if (victim === null) break;
      const v = this.warm.get(victim)!;
      this.warm.delete(victim);
      for (const off of v.off) off();
      v.collab.destroy();
    }
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
