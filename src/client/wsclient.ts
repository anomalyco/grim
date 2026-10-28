// Protocol v2 (docs/07-workspace-socket.md): one WebSocket per open workspace per tab. Notes are channels on it:
// `open` → `opened` + the note's v1 frames, `close`, `view` (hidden = prefetch). The socket carries the workspace
// events (tree, presence, saved, workspace) in place of /api/events. On a drop it reconnects with backoff (500 ms
// doubling to 10 s, at once on "online" / the tab showing again, reset on `welcome`) and re-opens every channel in
// one flight; the per-note sync then sends what each side lacks, so no edits are lost. A "ping" goes out every
// `pingMs`; no "pong" within PONG_TIMEOUT_MS → reconnect.

import type { SocketLike } from "./editor-rs/collab.ts";
import {
  CLOSE,
  CODE,
  FRAME_CONTROL,
  MAX_CHANNELS,
  PING,
  PING_MS,
  PONG,
  PONG_TIMEOUT_MS,
  RECONNECT_MAX_MS,
  RECONNECT_MIN_MS,
  SOCKET_CHANNEL,
  decodeControl,
  decodeFrame,
  encodeControl,
  encodeSv,
  parseNoteEnd,
  parseServerSocketMsg,
  withChannel,
  type ClientSocketMsg,
  type OpenedMsg,
  type WelcomeMsg,
  type WorkspaceChannel,
  type WorkspaceChannelHandlers,
  type WorkspaceClient,
  type WorkspaceEventMsg,
} from "../shared/wsmux.ts";

const OPEN = 1;

/** The handlers, plus what an engine needs to know between `opened`s. */
export interface ChannelHandlers extends WorkspaceChannelHandlers {
  /** The channel lost its id (the socket dropped, or `end`/`error` 1013): nothing flows until the next `onOpened`. */
  onDown?(): void;
}

export interface WsClientOptions {
  /** The socket URL (default: /ws?repo=<workspace> on this host, plus `query`). */
  url?: string;
  /** Extra query parameters (a guest's anon, name, color). */
  query?: Record<string, string>;
  /** Opens the socket (default: `new WebSocket(url)`); tests pass a fake mux. */
  socket?: (url: string) => SocketLike;
}

/** Socket closes after which reconnecting can't help. */
const FINAL_CLOSES = new Set<number>([CLOSE.unauthorized, CLOSE.forbidden, CLOSE.notFound, CLOSE.upgrade]);

class Channel implements WorkspaceChannel {
  ch: number | null = null;
  readOnly = false;
  /** An `open` is out with no reply yet (on the current socket). */
  opening = false;
  /** The `hidden` the last open asked for (a `view` while opening is sent once `opened` comes). */
  openedHidden = false;
  closed = false;
  /** For the LRU: when it was last made visible (or opened). */
  shownAt: number;
  retryTimer: ReturnType<typeof setTimeout> | null = null;
  retryDelay = RECONNECT_MIN_MS;

  constructor(
    private readonly client: WsClient,
    readonly path: string,
    public handlers: ChannelHandlers,
    public hidden: boolean,
    readonly askReadOnly: boolean,
    seq: number,
  ) {
    this.shownAt = seq;
  }

  send(body: Uint8Array): void {
    if (this.ch !== null) this.client.sendRaw(withChannel(this.ch, body));
  }

  view(hidden: boolean): void {
    if (this.closed || hidden === this.hidden) return;
    this.hidden = hidden;
    if (!hidden) this.shownAt = this.client.nextSeq();
    if (this.ch !== null) this.client.sendControl({ t: "view", ch: this.ch, hidden });
  }

  close(): void {
    this.client.closeChannel(this);
  }
}

export class WsClient implements WorkspaceClient {
  welcome: WelcomeMsg | null = null;
  /** Workspace socket state, for the UI. */
  connected = false;

  private ws: SocketLike | null = null;
  private readonly url: string;
  private readonly socket: (url: string) => SocketLike;
  private readonly channels = new Map<string, Channel>();
  private readonly byCh = new Map<number, Channel>();
  private readonly listeners = new Set<(msg: WorkspaceEventMsg) => void>();
  private readonly welcomeListeners = new Set<(w: WelcomeMsg, reconnect: boolean) => void>();
  private readonly closeListeners = new Set<(code: number, reason: string) => void>();
  private stopped = false;
  private backoff = RECONNECT_MIN_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private welcomed = false;
  private seq = 0;

  constructor(
    readonly workspace: string,
    opts: WsClientOptions = {},
  ) {
    this.url = opts.url ?? (opts.socket ? "" : `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws?${new URLSearchParams({ repo: workspace, ...opts.query })}`);
    this.socket = opts.socket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    if (typeof window !== "undefined") {
      window.addEventListener("online", this.onOnline);
      document.addEventListener("visibilitychange", this.onVisible);
    }
    this.connect();
  }

  /** Channels open (or opening) on this socket, by path. */
  get openPaths(): string[] {
    return [...this.channels.keys()];
  }

  open(path: string, handlers: ChannelHandlers, opts: { hidden?: boolean; readOnly?: boolean } = {}): WorkspaceChannel {
    let c = this.channels.get(path);
    if (c) {
      // idempotent: the same channel, now reporting to whoever asked last
      c.handlers = handlers;
      c.view(!!opts.hidden);
      return c;
    }
    this.makeRoom(opts.hidden ? null : path);
    c = new Channel(this, path, handlers, !!opts.hidden, !!opts.readOnly, this.nextSeq());
    this.channels.set(path, c);
    this.sendOpen(c);
    return c;
  }

  onEvent(fn: (msg: WorkspaceEventMsg) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Every `welcome`; `reconnect` is false for the first. */
  onWelcome(fn: (w: WelcomeMsg, reconnect: boolean) => void): () => void {
    this.welcomeListeners.add(fn);
    return () => this.welcomeListeners.delete(fn);
  }

  /** The socket closed for good (4401/4403/4404/4426). */
  onClose(fn: (code: number, reason: string) => void): () => void {
    this.closeListeners.add(fn);
    return () => this.closeListeners.delete(fn);
  }

  close(): void {
    if (this.stopped) return;
    for (const c of [...this.channels.values()]) this.closeChannel(c);
    this.stop();
  }

  // ---- internals (Channel calls these) ----

  nextSeq(): number {
    return ++this.seq;
  }

  sendRaw(data: Uint8Array | string): void {
    const ws = this.ws;
    if (ws && ws.readyState === OPEN) (ws.send as (d: Uint8Array | string) => void)(data);
  }

  sendControl(msg: ClientSocketMsg): void {
    this.sendRaw(encodeControl(SOCKET_CHANNEL, msg));
  }

  closeChannel(c: Channel): void {
    if (c.closed) return;
    c.closed = true;
    if (c.retryTimer) clearTimeout(c.retryTimer);
    if (this.channels.get(c.path) === c) this.channels.delete(c.path);
    if (c.ch !== null) {
      this.byCh.delete(c.ch);
      this.sendControl({ t: "close", ch: c.ch });
      c.ch = null;
    }
  }

  /** Past maxChannels: close the least recently shown hidden channel (never `keep`, never a visible one). */
  private makeRoom(keep: string | null): void {
    const max = this.welcome?.maxChannels ?? MAX_CHANNELS;
    while (this.channels.size >= max) {
      let lru: Channel | null = null;
      for (const c of this.channels.values()) if (c.hidden && c.path !== keep && (!lru || c.shownAt < lru.shownAt)) lru = c;
      if (!lru) return;
      this.closeChannel(lru);
      lru.handlers.onEnd(CODE.tooMany, "evicted");
    }
  }

  private sendOpen(c: Channel): void {
    if (c.closed || !this.welcomed) return;
    const sv = c.handlers.stateVector?.() ?? null;
    c.opening = true;
    c.openedHidden = c.hidden;
    this.sendControl({ t: "open", path: c.path, ...(sv ? { sv: encodeSv(sv) } : {}), ...(c.askReadOnly ? { readOnly: true } : {}), ...(c.hidden ? { hidden: true } : {}) });
  }

  private connect(): void {
    if (this.stopped) return;
    this.welcomed = false;
    const ws = this.socket(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      if (typeof ev.data === "string") {
        if (ev.data === PONG) this.onPong();
        return;
      }
      this.onData(new Uint8Array(ev.data as ArrayBuffer));
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.onSocketClose(ev.code, ev.reason);
    };
    ws.onerror = () => {};
  }

  private onData(data: Uint8Array): void {
    const f = decodeFrame(data);
    if (!f) return;
    if (f.ch === SOCKET_CHANNEL) {
      if (f.type !== FRAME_CONTROL) return;
      const raw = decodeControl(f.payload);
      const msg = raw && parseServerSocketMsg(raw);
      if (msg) this.onSocketMsg(msg);
      return;
    }
    const c = this.byCh.get(f.ch);
    if (!c) return;
    if (f.type === FRAME_CONTROL) {
      const raw = decodeControl(f.payload);
      const v2 = raw && parseNoteEnd(raw);
      if (v2?.t === "renew") return c.handlers.onRenew?.(v2.ms);
      if (v2?.t === "end") return this.onEnd(c, v2.code, v2.reason);
    }
    c.handlers.onFrame(f.body);
  }

  private onSocketMsg(msg: NonNullable<ReturnType<typeof parseServerSocketMsg>>): void {
    switch (msg.t) {
      case "welcome": {
        const reconnect = this.welcome !== null;
        this.welcome = msg;
        this.welcomed = true;
        this.connected = true;
        this.backoff = RECONNECT_MIN_MS;
        this.schedulePing();
        // every channel again, all at once, each with its document's state vector
        for (const c of this.channels.values()) this.sendOpen(c);
        for (const fn of this.welcomeListeners) fn(msg, reconnect);
        return;
      }
      case "opened":
        return this.onOpened(msg);
      case "error": {
        const c = this.channels.get(msg.req);
        if (!c || !c.opening) return;
        c.opening = false;
        if (msg.code === CODE.retry || (msg.code === CODE.tooMany && !c.hidden)) {
          // try again later (the store, a workspace not ready, the open rate)
          c.handlers.onDown?.();
          const delay = c.retryDelay;
          c.retryDelay = Math.min(delay * 2, RECONNECT_MAX_MS);
          c.retryTimer = setTimeout(() => {
            c.retryTimer = null;
            this.sendOpen(c);
          }, delay);
          return;
        }
        this.closeChannel(c);
        c.handlers.onEnd(msg.code, msg.reason);
        return;
      }
      default:
        for (const fn of this.listeners) fn(msg);
    }
  }

  private onOpened(msg: OpenedMsg): void {
    const c = this.channels.get(msg.req);
    if (!c) {
      // closed before the reply: let the server know (unless another channel holds that id)
      if (!this.byCh.has(msg.ch)) this.sendControl({ t: "close", ch: msg.ch });
      return;
    }
    if (c.ch === msg.ch) return; // a repeated open of an open channel
    if (c.ch !== null) this.byCh.delete(c.ch);
    c.opening = false;
    c.ch = msg.ch;
    c.readOnly = msg.readOnly;
    c.retryDelay = RECONNECT_MIN_MS;
    this.byCh.set(msg.ch, c);
    if (c.hidden !== c.openedHidden) this.sendControl({ t: "view", ch: msg.ch, hidden: c.hidden });
    c.handlers.onOpened?.(msg);
  }

  private onEnd(c: Channel, code: number, reason: string): void {
    if (c.ch !== null) this.byCh.delete(c.ch);
    c.ch = null;
    if (code === CODE.retry) {
      // the room was discarded, reset or woke with another generation: reopen; the hello tells the engine which
      c.handlers.onDown?.();
      this.sendOpen(c);
      return;
    }
    if (this.channels.get(c.path) === c) this.channels.delete(c.path);
    c.closed = true;
    c.handlers.onEnd(code, reason);
  }

  private onSocketClose(code: number, reason: string): void {
    this.connected = false;
    this.welcomed = false;
    this.clearPing();
    this.byCh.clear();
    for (const c of this.channels.values()) {
      c.opening = false;
      if (c.retryTimer) clearTimeout(c.retryTimer);
      c.retryTimer = null;
      if (c.ch !== null) {
        c.ch = null;
        c.handlers.onDown?.();
      }
    }
    if (FINAL_CLOSES.has(code)) {
      const chans = [...this.channels.values()];
      this.channels.clear();
      this.stop();
      for (const c of chans) {
        c.closed = true;
        c.handlers.onEnd(code, reason);
      }
      for (const fn of this.closeListeners) fn(code, reason);
      return;
    }
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private reconnectNow(): void {
    if (this.stopped || !this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.backoff = RECONNECT_MIN_MS;
    this.connect();
  }

  private onOnline = () => this.reconnectNow();

  private onVisible = () => {
    if (document.visibilityState !== "visible") return;
    this.reconnectNow();
    // a socket that went quiet while the tab was hidden (a sleeping laptop): check it now
    if (this.welcomed && !this.pongTimer) this.ping();
  };

  private schedulePing(): void {
    this.clearPing();
    this.pingTimer = setTimeout(() => this.ping(), this.welcome?.pingMs ?? PING_MS);
  }

  private ping(): void {
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.pingTimer = null;
    if (!this.ws || this.ws.readyState !== OPEN) return;
    this.sendRaw(PING);
    if (!this.pongTimer) {
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        // no answer: the socket is dead even if the browser hasn't noticed
        const ws = this.ws;
        if (!ws) return;
        this.ws = null;
        ws.onmessage = ws.onclose = ws.onerror = null;
        try {
          ws.close();
        } catch {}
        this.onSocketClose(1006, "no pong");
      }, PONG_TIMEOUT_MS);
    }
  }

  private onPong(): void {
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = null;
    this.schedulePing();
  }

  private clearPing(): void {
    if (this.pingTimer) clearTimeout(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pingTimer = this.pongTimer = null;
  }

  private stop(): void {
    this.stopped = true;
    this.connected = false;
    this.clearPing();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.onOnline);
      document.removeEventListener("visibilitychange", this.onVisible);
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {}
    }
  }
}
