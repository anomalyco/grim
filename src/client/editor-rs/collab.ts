// A note's live connection with the Rust engine owning the shared document (phase C2): the engine (yrs inside
// the wasm) produces and consumes the y-protocols frames; this class only moves them over the WebSocket and
// runs the timers. Same connection behaviour, events and fields as provider.ts (GrimoireProvider), so the app
// shell (main.ts Session) treats both alike: URL, cookies, reconnect with backoff (500 ms doubling to 10 s,
// reset on hello, at once on "online"), room generation change / read-only with unsent edits → "reset",
// final close codes and "closed" control messages → "closed", leave on destroy.

import { Emitter } from "../emitter.ts";
import type { ConnStatus, ProviderEvents, SaveState } from "../provider.ts";
import { guardEngine, isEngineCrash } from "./guard.ts";
import type { CollabEngine, Patch, Received } from "./types.ts";

/**
 * provider.ts's events, plus remote presence changes (cursors, participants) and `crashed`: the engine trapped
 * (or rejected a sync frame it couldn't take) and the connection is over; `unsent` is our edits of this session
 * as a Yjs update (null if they couldn't be recovered): the app re-opens the note with the TS engine and applies
 * them there.
 */
export type CollabEvents = ProviderEvents & { awareness: []; crashed: [unsent: Uint8Array | null] };

/** The editor view currently showing the engine. */
export interface CollabView {
  /** Remote edits arrived (`patch.edits` = the change). */
  remotePatch(p: Patch): void;
  /** The engine was rebuilt from the shared document: render everything. */
  reload(): void;
  /** Remote cursors changed. */
  cursorsChanged(): void;
}

export type CollabFactory = ((clientId: number, user: object) => CollabEngine) & {
  /** Our edits of the session with this client id, readable even after the engine trapped. */
  recover?(clientId: number): Uint8Array | undefined;
  /** Throw the loaded wasm instance away (it trapped); later engines get a fresh one. */
  evict?(): void;
};

/** What RustCollab uses of a WebSocket (tests pass an in-page room). */
export interface SocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: Uint8Array): void;
  close(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface RustCollabOptions {
  /** WebSocket URL (default: /ws?repo=&path= on this host). */
  url?: string;
  /** Opens the socket (default: `new WebSocket(url)`). */
  socket?: (url: string) => SocketLike;
}

const OPEN = 1;

/** A random client id below 2^32 (the server reserves larger ids for agents). */
export function randomClientId(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0]!;
}

export class RustCollab extends Emitter<CollabEvents> {
  readonly engine: CollabEngine;
  status: ConnStatus = "disconnected";
  synced = false;
  readOnly = false;
  saveState: SaveState = { dirty: false, saving: false, commit: null, savedAt: null };
  view: CollabView | null = null;

  private ws: SocketLike | null = null;
  /** The session is over (reset, closed, crashed, destroyed): no more frames or reconnects. */
  private stopped = false;
  private destroyed = false;
  private crashed = false;
  /** The wasm instance trapped: never call into it again (not even free). */
  private trapped = false;
  private readonly factory: CollabFactory;
  private readonly id: number;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeAt = Infinity;
  private readonly url: string;
  private readonly socket: (url: string) => SocketLike;

  constructor(
    factory: CollabFactory,
    readonly repo: string,
    readonly path: string,
    user: object,
    opts: RustCollabOptions = {},
  ) {
    super();
    this.factory = factory;
    this.id = randomClientId();
    this.engine = guardEngine(factory(this.id, user), (err) => {
      this.trapped = true;
      this.crash(err);
    });
    this.url = opts.url ?? (opts.socket ? "" : `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws?${new URLSearchParams({ repo, path })}`);
    this.socket = opts.socket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    window.addEventListener("online", this.onOnline);
    this.connect();
  }

  get clientId(): number {
    return this.engine.client_id();
  }

  /** Other clients' presence states `[clientId, {user, cursor}]` (participants list). */
  peerStates(): [number, unknown][] {
    if (this.stopped) return [];
    return this.engine.peers().map((p) => [p.client, p.state]);
  }

  /** Ask the server to commit now. */
  flush(): void {
    if (this.stopped) return;
    this.send(this.engine.request_flush());
  }

  /** Send what the engine has after a command (edits, cursor, presence renewal) and arm its wake-up timer. */
  pump(): void {
    if (this.stopped) return;
    const o = this.engine.take_outgoing(performance.now());
    this.send(o.frames);
    if (o.awareness) this.presenceChanged();
    if (o.wakeInMs !== undefined && o.wakeInMs !== null) this.wake(o.wakeInMs);
  }

  /** The editor gained or lost focus: our cursor is shown to others only while focused. */
  setFocused(focused: boolean): void {
    if (this.stopped) return;
    this.send(this.engine.set_focused(focused, performance.now()));
    this.pump();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    // tell the others we left while the socket is still open
    if (!this.stopped) {
      try {
        this.send(this.engine.leave());
      } catch {}
    }
    this.stop();
    window.removeEventListener("online", this.onOnline);
    this.closeSocket();
    this.view = null;
    this.clear();
    if (!this.trapped) {
      try {
        this.engine.free?.();
      } catch {}
    }
  }

  /** The session ends: timers off, nothing more is sent or reconnected (destroy() still cleans up). */
  private stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.retryTimer = this.wakeTimer = null;
    this.wakeAt = Infinity;
  }

  /**
   * The engine trapped, or took a sync frame it couldn't apply (its document now misses what the others have):
   * stop, and hand the app what can be recovered of our edits.
   */
  private crash(err: unknown): void {
    if (this.crashed) return;
    this.crashed = true;
    console.error("collab: the Rust engine can't go on:", err);
    let unsent: Uint8Array | null = null;
    try {
      unsent = this.factory.recover?.(this.id) ?? null;
    } catch {}
    if (this.trapped) this.factory.evict?.();
    this.stop();
    this.closeSocket();
    // not from inside the engine call that trapped
    queueMicrotask(() => !this.destroyed && this.emit("crashed", unsent));
  }

  // ---------------------------------------------------------------------------------------------

  private connect(): void {
    if (this.stopped) return;
    this.engine.connecting();
    this.setStatus("connecting");
    const ws = this.socket(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onmessage = (ev) => {
      if (this.ws !== ws || this.stopped || typeof ev.data === "string") return;
      this.onFrame(new Uint8Array(ev.data as ArrayBuffer));
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.onClose(ev.code, ev.reason);
    };
    ws.onerror = () => {};
  }

  private closeSocket(): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {}
    }
    this.setStatus("disconnected");
  }

  private onClose(code: number, reason: string): void {
    if (this.stopped) return;
    const after = this.engine.disconnected(code, reason);
    this.setStatus("disconnected");
    // the engine forgot the others' presence
    this.presenceChanged();
    if ("closed" in after) {
      this.stop();
      this.emit("closed", after.closed, after.to ?? undefined);
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, after.retry);
  }

  private onOnline = () => {
    if (this.retryTimer && !this.stopped && this.engine.online()) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.connect();
    }
  };

  private onFrame(data: Uint8Array): void {
    let r: Received;
    try {
      r = this.engine.receive(data, performance.now());
    } catch (err) {
      if (isEngineCrash(err)) return; // crash() took over
      throw err;
    }
    if (r.error) {
      console.warn("collab: bad frame:", r.error);
      // a sync frame the engine couldn't take: its document now misses what the others have
      if (data[0] === 0) return this.crash(new Error(r.error));
    }
    this.send(r.frames);
    if (r.reloaded) this.view?.reload();
    else if (r.patch) this.view?.remotePatch(r.patch);
    if (r.awareness) this.presenceChanged();
    for (const n of r.notices) {
      switch (n.t) {
        case "hello":
          this.setSaveState(n.saveState);
          this.setStatus("connected");
          break;
        case "readOnly":
          this.readOnly = n.readOnly;
          this.emit("readOnly", n.readOnly);
          break;
        case "synced":
          if (!this.synced) {
            this.synced = true;
            this.emit("synced");
          }
          break;
        case "saveState":
          this.setSaveState(n.saveState);
          break;
        case "external":
          this.emit("external", n.commit);
          break;
        case "reset":
          // the room was recreated, or read-only would drop our offline edits: the app starts over
          this.stop();
          this.closeSocket();
          this.emit("reset");
          return;
      }
    }
    // the hello's re-announce, the cursor after remote edits, and the wake-up timer
    this.pump();
  }

  private presenceChanged(): void {
    this.view?.cursorsChanged();
    this.emit("awareness");
  }

  private wake(ms: number): void {
    const at = performance.now() + Math.max(0, ms);
    if (this.wakeTimer && at >= this.wakeAt) return;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeAt = at;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.wakeAt = Infinity;
      this.pump();
    }, Math.max(0, ms));
  }

  private setSaveState(s: SaveState | null | undefined): void {
    if (!s) return;
    this.saveState = { dirty: !!s.dirty, saving: !!s.saving, commit: s.commit ?? null, savedAt: s.savedAt ?? null };
    this.emit("saveState", this.saveState);
  }

  private setStatus(s: ConnStatus): void {
    if (s === this.status) return;
    this.status = s;
    this.emit("status", s);
  }

  private send(frames: Uint8Array[]): void {
    if (!frames.length) return;
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN) {
      // closing (or closed, its close event not handled yet): the edits in these go out with the next step2
      if (!this.stopped && frames.some((f) => f[0] === 0)) this.engine.frames_lost();
      return;
    }
    for (const f of frames) ws.send(f);
  }
}
