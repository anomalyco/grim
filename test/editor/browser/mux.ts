// A fake protocol v2 server (docs/07-workspace-socket.md) for the web client's tests: one workspace socket whose
// channels are FakeRooms (one per path). It speaks welcome / open / opened / error / close / view, prefixes each
// room's v1 frames with the channel, answers "ping", and can drop the socket, end a channel or push events.
import type { SocketLike } from "../../../src/client/editor-rs/collab.ts";
import {
  decodeControl,
  decodeFrame,
  encodeControl,
  parseClientSocketMsg,
  welcome,
  withChannel,
  type ClientSocketMsg,
  type WelcomeMsg,
} from "../../../src/shared/wsmux.ts";
import type { FakeRoom } from "./room.ts";

export class FakeMux {
  readonly rooms = new Map<string, FakeRoom>();
  readonly sockets: MuxSocket[] = [];
  /** Every channel-0 message from the client, in order. */
  readonly received: ClientSocketMsg[] = [];
  pings = 0;
  answerPings = true;
  welcome: WelcomeMsg = welcome({ id: "a", name: "Alice", color: "#d63b3b", kind: "human" }, false, "ready");
  /** Answer `open` with this error code instead (once per path). */
  readonly failOpen = new Map<string, number>();
  private waiters: Array<() => void> = [];

  connect = (): SocketLike => {
    const s = new MuxSocket(this);
    this.sockets.push(s);
    return s;
  };

  get socket(): MuxSocket {
    return this.sockets[this.sockets.length - 1]!;
  }

  /** Resolves on the next channel-0 message or ping from the client. */
  next(): Promise<void> {
    return new Promise((r) => this.waiters.push(r));
  }

  /** Resolves once `cond` holds, re-checked on every client message. */
  async until(cond: () => boolean): Promise<void> {
    while (!cond()) await this.next();
  }

  notify(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const r of w) r();
  }
}

interface Chan {
  path: string;
  sock: SocketLike;
  hidden: boolean;
}

export class MuxSocket implements SocketLike {
  binaryType = "arraybuffer";
  readyState = 1;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly channels = new Map<number, Chan>();
  private nextCh = 1;

  constructor(private readonly mux: FakeMux) {
    queueMicrotask(() => this.toClient(encodeControl(0, mux.welcome)));
  }

  /** The channel id of `path`, if open. */
  chOf(path: string): number | undefined {
    for (const [ch, c] of this.channels) if (c.path === path) return ch;
    return undefined;
  }

  toClient(data: Uint8Array | string): void {
    if (this.readyState !== 1) return;
    const d = typeof data === "string" ? data : data.slice().buffer;
    queueMicrotask(() => this.readyState === 1 && this.onmessage?.({ data: d }));
  }

  event(msg: object): void {
    this.toClient(encodeControl(0, msg));
  }

  send(data: Uint8Array | string): void {
    if (this.readyState !== 1) return;
    if (typeof data === "string") {
      if (data === "ping") {
        this.mux.pings++;
        if (this.mux.answerPings) this.toClient("pong");
        this.mux.notify();
      }
      return;
    }
    const f = decodeFrame(data);
    if (!f) return;
    if (f.ch !== 0) {
      this.channels.get(f.ch)?.sock.send(f.body.slice());
      return;
    }
    const raw = decodeControl(f.payload);
    const msg = raw && parseClientSocketMsg(raw);
    if (!msg) return;
    this.mux.received.push(msg);
    switch (msg.t) {
      case "open": {
        const existing = this.chOf(msg.path);
        const room = this.mux.rooms.get(msg.path);
        const fail = this.mux.failOpen.get(msg.path);
        if (fail) {
          this.mux.failOpen.delete(msg.path);
          this.event({ t: "error", req: msg.path, code: fail, reason: "test" });
        } else if (existing !== undefined) {
          // a repeat (as the server): the same channel, shown or hidden as the repeat asks
          this.channels.get(existing)!.hidden = !!msg.hidden;
          this.event({ t: "opened", req: msg.path, path: msg.path, ch: existing, generation: room!.generation, readOnly: room!.readOnly });
        } else if (!room) {
          this.event({ t: "error", req: msg.path, code: 4404, reason: "not found" });
        } else {
          const ch = this.nextCh++;
          // opened goes out before the room's first frames (queued in a microtask by connect)
          this.event({ t: "opened", req: msg.path, path: msg.path, ch, generation: room.generation, readOnly: room.readOnly });
          const sock = room.connect();
          sock.onmessage = (ev) => this.channels.has(ch) && this.toClient(withChannel(ch, new Uint8Array(ev.data as ArrayBuffer)));
          this.channels.set(ch, { path: msg.path, sock, hidden: !!msg.hidden });
        }
        break;
      }
      case "close": {
        const c = this.channels.get(msg.ch);
        c?.sock.close();
        this.channels.delete(msg.ch);
        break;
      }
      case "view": {
        const c = this.channels.get(msg.ch);
        if (c) c.hidden = msg.hidden;
        break;
      }
    }
    this.mux.notify();
  }

  /** Ends a channel (`end`), as a room reset or a closed note does. */
  end(path: string, code: number, reason = ""): void {
    const ch = this.chOf(path);
    if (ch === undefined) return;
    this.event({ t: "x" }); // an unknown message is ignored
    this.toClient(encodeControl(ch, { t: "end", code, reason }));
    this.channels.get(ch)!.sock.close();
    this.channels.delete(ch);
  }

  renew(path: string, ms: number): void {
    const ch = this.chOf(path);
    if (ch !== undefined) this.toClient(encodeControl(ch, { t: "renew", ms }));
  }

  /** The connection drops (or the server closes it with `code`). */
  drop(code = 1006, reason = ""): void {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    for (const c of this.channels.values()) c.sock.close();
    this.channels.clear();
    queueMicrotask(() => this.onclose?.({ code, reason }));
  }

  close(): void {
    this.readyState = 3;
    for (const c of this.channels.values()) c.sock.close();
    this.channels.clear();
  }
}
