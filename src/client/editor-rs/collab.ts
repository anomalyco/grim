// A note's live connection, the Rust engine owning the shared document: the engine (yrs inside the wasm)
// produces and consumes the y-protocols frames; this class only moves them over the WebSocket and runs the
// timers: URL, cookies, reconnect with backoff (500 ms doubling to 10 s, reset on hello, at once on "online"),
// room generation change / read-only with unsent edits → "reset", final close codes and "closed" control
// messages → "closed", leave on destroy.

import { Emitter } from "../emitter.ts";
import { crashSafe, guardEngine, isEngineCrash } from "./guard.ts";
import type { UnsentEdits } from "./recover.ts";
import type { CollabEngine, Patch, Received } from "./types.ts";

export type ConnStatus = "connecting" | "connected" | "disconnected";

export interface SaveState {
  dirty: boolean;
  saving: boolean;
  commit: string | null;
  savedAt: number | null;
}

export type ClosedReason = "deleted" | "renamed" | "removed" | "unauthorized" | "forbidden" | "notfound" | "toolarge" | string;

/**
 * Connection events, plus remote presence changes (cursors, participants); `crashed`: the engine trapped (or
 * rejected a sync frame it couldn't take) and the connection is over; `unsent` is our edits of this session as a
 * Yjs update (null if they couldn't be recovered): the app keeps them for the next page load (recover.ts).
 * `recovered`: what happened to edits kept from a crashed session (the `recover` option) once synced: merged
 * (`ok`; `changed`: false if the server already had them all), or not (`ok` false: they conflict with the
 * server's text, or the note is read-only now; the app keeps them).
 */
export type CollabEvents = {
  status: [ConnStatus];
  synced: [];
  saveState: [SaveState];
  closed: [ClosedReason, string | undefined];
  reset: [];
  external: [string | null];
  readOnly: [boolean];
  awareness: [];
  crashed: [unsent: Uint8Array | null];
  recovered: [ok: boolean, changed: boolean];
  blame: [];
};

/** One author of the room's `{t:"blame"}` message (docs/05-v1-architecture.md, "Line authors"). */
export interface BlameAuthor {
  id: string;
  name: string;
  kind: string;
  color: string;
}

/** Who wrote each line of the server's text: `lines[i]` indexes `authors`, -1 = unknown. */
export interface Blame {
  authors: BlameAuthor[];
  lines: number[];
}

/** The editor view currently showing the engine. */
export interface CollabView {
  /** Remote edits arrived (`patch.edits` = the change). */
  remotePatch(p: Patch): void;
  /** The engine was rebuilt from the shared document: render everything. */
  reload(): void;
  /** Remote cursors changed. */
  cursorsChanged(): void;
  /** A new `blame` (line authors) arrived. */
  blameChanged?(): void;
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
  /** Edits kept from a crashed session of this note: merged as local edits once the document is synced. */
  recover?: UnsentEdits;
}

const OPEN = 1;
const MSG_CONTROL = 2;

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
  /** The room generation (hello), null before it. */
  generation: string | null = null;
  /** The text when the document first synced, before this session changed it (crash recovery's merge base). */
  baseText: string | null = null;
  /** The room's latest line authors (null before the first). */
  blame: Blame | null = null;

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
  private recover: UnsentEdits | null;

  constructor(
    factory: CollabFactory,
    readonly repo: string,
    readonly path: string,
    /** Who we are (our presence user: id, name, color…). */
    readonly user: object,
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
    this.recover = opts.recover ?? null;
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
    ws.onmessage = crashSafe((ev: { data: unknown }) => {
      if (this.ws !== ws || this.stopped || typeof ev.data === "string") return;
      this.onFrame(new Uint8Array(ev.data as ArrayBuffer));
    });
    ws.onclose = crashSafe((ev: { code: number; reason: string }) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.onClose(ev.code, ev.reason);
    });
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
    this.retryTimer = setTimeout(
      crashSafe(() => {
        this.retryTimer = null;
        this.connect();
      }),
      after.retry,
    );
  }

  private onOnline = crashSafe(() => {
    if (this.retryTimer && !this.stopped && this.engine.online()) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.connect();
    }
  });

  private onFrame(data: Uint8Array): void {
    // the server's document, rebuilt alongside the engine's until the kept edits are merged
    this.recover?.feed(data);
    if (data[0] === MSG_CONTROL) this.readControl(data);
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
            this.baseText = this.engine.text();
            if (this.recover) this.mergeRecovered();
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

  /** Apply the edits kept from a crashed session on top of the synced document, as local edits (sent by pump). */
  private mergeRecovered(): void {
    const rec = this.recover!;
    this.recover = null;
    let ok = false;
    let changed = false;
    try {
      const edits = this.engine.read_only() ? null : rec.edits(this.engine.text(), this.generation);
      if (edits) {
        for (const e of edits) this.engine.replace_range(e.from, e.to, e.insert);
        ok = true;
        changed = edits.length > 0;
      }
    } catch (err) {
      if (isEngineCrash(err)) return;
      console.error("collab: couldn't merge the kept edits:", err);
    }
    if (!ok) console.warn("collab: the edits kept from the last session couldn't be merged");
    queueMicrotask(() => !this.stopped && this.emit("recovered", ok, changed));
  }

  /** The room's generation from its hello and its line authors (the engine reads control frames too, ignoring blame). */
  private readControl(frame: Uint8Array): void {
    try {
      // [MSG_CONTROL, varuint length, UTF-8 JSON]
      let i = 1;
      let len = 0;
      for (let shift = 0; ; shift += 7) {
        const b = frame[i++]!;
        len += (b & 0x7f) * 2 ** shift;
        if (b < 0x80 || i >= frame.length) break;
      }
      const msg = JSON.parse(new TextDecoder().decode(frame.subarray(i, i + len))) as { t?: unknown; generation?: unknown; authors?: unknown; lines?: unknown };
      if (msg.t === "hello" && typeof msg.generation === "string") this.generation = msg.generation;
      if (msg.t === "blame") {
        const blame = parseBlame(msg);
        if (blame) {
          this.blame = blame;
          this.view?.blameChanged?.();
          this.emit("blame");
        }
      }
    } catch {}
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
    this.wakeTimer = setTimeout(
      crashSafe(() => {
        this.wakeTimer = null;
        this.wakeAt = Infinity;
        this.pump();
      }),
      Math.max(0, ms),
    );
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

/** A blame message's authors and lines, checked (null if it isn't one). */
export function parseBlame(msg: { authors?: unknown; lines?: unknown }): Blame | null {
  if (!Array.isArray(msg.authors) || !Array.isArray(msg.lines)) return null;
  const authors: BlameAuthor[] = [];
  for (const a of msg.authors as Array<Record<string, unknown>>) {
    if (!a || typeof a.id !== "string" || typeof a.name !== "string") return null;
    authors.push({ id: a.id, name: a.name, kind: typeof a.kind === "string" ? a.kind : "human", color: typeof a.color === "string" && /^#[0-9a-f]{3,8}$/i.test(a.color) ? a.color : "#888" });
  }
  const lines = (msg.lines as unknown[]).map((v) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) < authors.length ? (v as number) : -1));
  return { authors, lines };
}
