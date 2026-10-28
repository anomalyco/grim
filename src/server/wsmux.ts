// The server side of protocol v2 (docs/07-workspace-socket.md, "Implementation shape"): one WorkspaceSocket per
// socket, shared by Bun (WorkspaceRuntime) and the WorkspaceDO, with small host hooks (MuxHost). The framing and the
// messages are in ../shared/wsmux.ts.
import * as Y from "yjs";
import type { Conn, Participant, Room } from "./room.ts";
import type { WsReject } from "./seams/workspace-host.ts";
import type { PresenceUser } from "../shared/presence.ts";
import { cleanPath } from "./repos.ts";
import {
  AWARENESS_TIMEOUT_MS,
  CODE,
  decodeControl,
  decodeFrame,
  decodeSv,
  encodeControl,
  FRAME_AWARENESS,
  FRAME_CONTROL,
  MAX_CHANNELS,
  OPEN_RATE_MAX,
  OPEN_RATE_WINDOW_MS,
  parseClientSocketMsg,
  PING,
  PONG,
  SOCKET_CHANNEL,
  welcome,
  withChannel,
  type OpenErrorCode,
  type OpenMsg,
  type PresenceMsg,
  type PresenceSnapshotMsg,
  type WorkspaceEventMsg,
  type WorkspaceStatus,
} from "../shared/wsmux.ts";

export * from "../shared/wsmux.ts";

/** Channel flags in the attachment (§5.1). */
export const CH_READ_ONLY = 1;
export const CH_HIDDEN = 2;

/** The admission of a v2 socket (`X-Grim-Admission` v2 on Workers): the workspace, no path. */
export interface AdmittedSocket {
  v: 2;
  repoId: string;
  branch: string;
  status: WorkspaceStatus;
  error?: string;
  participant: Participant;
  /** The whole workspace is read-only. */
  readOnly: boolean;
}

/** One open channel. */
export interface ChannelInfo {
  ch: number;
  /** Cleaned path. */
  path: string;
  generation: string;
  readOnly: boolean;
  hidden: boolean;
}

/**
 * The multiplexer's state, enough to rebuild it without the rooms: the DO's hibernation attachment (§5.1) is this,
 * serialized and fitted by the host. Awareness states are the visible channels' only.
 */
export interface MuxState {
  v: 2;
  u: Participant;
  b: string;
  ro: boolean;
  /** Next channel id (never reused on a socket). */
  n: number;
  c: Array<[ch: number, path: string, generation: string, flags: number]>;
  aw: Array<[ch: number, clientId: number, clock: number, state: string]>;
}

/** A note channel as the room sees it: `send` adds the channel prefix, `close(code, reason)` sends `end`. */
export interface ChannelConn extends Conn {
  readonly ch: number;
  /** Hidden channels aren't presence (Room.participants skips them unless they have an awareness state). */
  hidden: boolean;
  /** Owned awareness states expire after this (AWARENESS_TIMEOUT_MS for v2; v1 conns keep 30 s). */
  readonly awarenessTimeoutMs: number;
}

/** What opening a note's room gave: the room, or an `error` for the open. */
export type OpenRoomResult = { room: Room } | { reject: WsReject & { code: OpenErrorCode } };

/** What a WorkspaceSocket needs from where it runs. */
export interface MuxHost {
  /**
   * Open (or wake) the room of a cleaned path: admitFile's logic (4404, 4413, 1013 incl. a workspace that isn't
   * ready, 1011). Opens run in parallel.
   */
  openRoom(path: string): Promise<OpenRoomResult>;
  /** Puts a frame on the socket (binary, or the "pong" text on Bun). */
  send(data: Uint8Array | string): void;
  /** Closes the whole socket (4404 removed, 1013 too slow, 1012 restart). */
  closeSocket(code: number, reason?: string): void;
  /** The state changed (open, close, view, an awareness update): no-op on Bun; serializeAttachment + fit in the DO. */
  persist(state: MuxState): void;
  /** Channel open/close/view changed this socket's presence: the workspace recomputes and fans it out. */
  presenceChanged(paths: string[]): void;
  /**
   * The DO after a wake: a frame came for a channel whose room isn't in memory. Return the room (open, or woken from
   * its crash log with no store calls), ideally with every channel on that path put back (WorkspaceSocket.reattach,
   * from WorkspaceSockets.channelsOn); null when it can't be woken. The socket reattaches its own channel if the host
   * didn't, and ends the channel `1013` when there's no room or its generation isn't the channel's. Without this
   * hook (Bun: rooms outlive their channels), such a frame ends the channel `1013`.
   */
  wakeRoom?(path: string): Room | null;
  /** Now, in ms (tests: a fake clock for the open rate limit). */
  now?(): number;
}

/** One v2 socket. */
export interface WorkspaceSocket {
  readonly user: Participant;
  readonly readOnly: boolean;
  readonly channels: ReadonlyMap<number, ChannelInfo>;
  /** Sends `welcome` and the presence snapshot (the first frames after the upgrade). */
  start(status: WorkspaceStatus, error: string | undefined, presence: WorkspaceEventMsg): void;
  /** A frame from the client: channel-0 control (open/close/view), a note channel's v1 frame, or "ping". */
  onMessage(data: Uint8Array | string): void;
  /** A workspace event on channel 0. */
  sendEvent(msg: WorkspaceEventMsg): void;
  /** Ends one channel (`end code reason`), leaving its room; the socket stays. */
  end(ch: number, code: number, reason: string): void;
  /** The socket is gone: every channel leaves its room (presence and awareness go at once). */
  closed(): void;
  /** The state to persist (also what `persist` gets). */
  state(): MuxState;
  /** Closes the whole socket (host.closeSocket); the host then calls closed(). */
  closeSocket(code: number, reason?: string): void;
  /** The DO after a wake: puts a restored channel back into its (woken) room with its awareness states. Idempotent. */
  reattach(ch: number, room: Room): void;
  /** A channel's room connection (null when it isn't open). */
  conn(ch: number): ChannelConn | null;
}

/** Makes a socket: fresh from an admission, or (the DO after a wake) from a persisted state, with no room wakes. */
export type CreateWorkspaceSocket = (host: MuxHost, from: { admission: AdmittedSocket } | { restore: MuxState }) => WorkspaceSocket;

/** The sockets of one workspace (WorkspaceRuntime on Bun, the WorkspaceDO): events and presence from the channel table. */
export interface WorkspaceSockets {
  add(sock: WorkspaceSocket): void;
  remove(sock: WorkspaceSocket): void;
  /** To every socket of the workspace. */
  broadcast(msg: WorkspaceEventMsg): void;
  /** Every note with someone in it: visible channels plus agents' cursors in rooms in memory. */
  presenceSnapshot(): WorkspaceEventMsg;
  /** The socket channels on a path (the DO's wake index; Room.reattach puts them all back). */
  channelsOn(path: string): Array<[WorkspaceSocket, ChannelInfo]>;
}

// ---- The implementation ----

interface Channel {
  info: ChannelInfo;
  conn: ChannelConn;
  /** Null after a restore until a frame wakes the room. */
  room: Room | null;
  /** Restored awareness states, for reattach. */
  aw: Array<[number, number, Record<string, unknown> | null]>;
}

const presenceUser = (u: { id: string; name: string; color: string; kind: string }): PresenceUser => ({ id: u.id, name: u.name, color: u.color, kind: u.kind as PresenceUser["kind"] });

/** Makes a WorkspaceSocket (see CreateWorkspaceSocket). */
export const createWorkspaceSocket: CreateWorkspaceSocket = (host, from) => new MuxSocket(host, from);

class MuxSocket implements WorkspaceSocket {
  readonly user: Participant;
  readonly readOnly: boolean;
  private readonly branch: string;
  private next = 1;
  private chans = new Map<number, Channel>();
  private byPath = new Map<string, number>();
  /** Opens waiting on their room, by cleaned path: a second open of the path waits for the first. */
  private opening = new Map<string, Promise<void>>();
  private opens: number[] = [];
  private gone = false;

  constructor(
    private host: MuxHost,
    from: { admission: AdmittedSocket } | { restore: MuxState },
  ) {
    if ("admission" in from) {
      const a = from.admission;
      this.user = a.participant;
      this.readOnly = a.readOnly;
      this.branch = a.branch;
      return;
    }
    const st = from.restore;
    this.user = st.u;
    this.readOnly = st.ro;
    this.branch = st.b;
    this.next = st.n;
    for (const [ch, path, generation, flags] of st.c) {
      const info: ChannelInfo = { ch, path, generation, readOnly: !!(flags & CH_READ_ONLY), hidden: !!(flags & CH_HIDDEN) };
      this.addChannel(info, null);
    }
    for (const [ch, id, clock, state] of st.aw) {
      const c = this.chans.get(ch);
      if (!c) continue;
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(state) as Record<string, unknown> | null;
      } catch {
        continue;
      }
      c.aw.push([id, clock, parsed]);
    }
  }

  get channels(): ReadonlyMap<number, ChannelInfo> {
    const m = new Map<number, ChannelInfo>();
    for (const [ch, c] of this.chans) m.set(ch, c.info);
    return m;
  }

  start(status: WorkspaceStatus, error: string | undefined, presence: WorkspaceEventMsg) {
    this.control(welcome(presenceUser(this.user), this.readOnly, status, error));
    this.control(presence);
  }

  onMessage(data: Uint8Array | string) {
    if (this.gone) return;
    if (typeof data === "string") {
      if (data === PING) this.host.send(PONG);
      return;
    }
    const f = decodeFrame(data);
    if (!f) return;
    if (f.ch === SOCKET_CHANNEL) {
      if (f.type !== FRAME_CONTROL) return;
      const raw = decodeControl(f.payload);
      const msg = raw && parseClientSocketMsg(raw);
      if (!msg) return;
      if (msg.t === "open") void this.open(msg);
      else if (msg.t === "close") this.close(msg.ch);
      else this.view(msg.ch, msg.hidden);
      return;
    }
    const c = this.chans.get(f.ch);
    if (!c) return;
    const room = this.roomOf(c);
    if (!room) return;
    try {
      room.onMessage(c.conn, f.body);
    } catch (e) {
      console.error(`[ws] ${room.key}: bad message:`, e);
    }
    if (f.type === FRAME_AWARENESS && this.chans.get(f.ch) === c) this.persist();
  }

  sendEvent(msg: WorkspaceEventMsg) {
    this.control(msg);
  }

  end(ch: number, code: number, reason: string) {
    const c = this.chans.get(ch);
    if (!c) return;
    this.drop(c);
    if (!this.gone) this.host.send(encodeControl(ch, { t: "end", code, reason }));
    c.room?.removeConn(c.conn);
    this.changed([c.info.path]);
  }

  closed() {
    if (this.gone) return;
    this.gone = true;
    const paths: string[] = [];
    for (const c of [...this.chans.values()]) {
      this.drop(c);
      c.room?.removeConn(c.conn);
      paths.push(c.info.path);
    }
    if (paths.length) this.host.presenceChanged(paths);
  }

  closeSocket(code: number, reason?: string) {
    this.host.closeSocket(code, reason);
  }

  state(): MuxState {
    const c: MuxState["c"] = [];
    const aw: MuxState["aw"] = [];
    for (const [ch, chan] of this.chans) {
      const { info } = chan;
      c.push([ch, info.path, info.generation, (info.readOnly ? CH_READ_ONLY : 0) | (info.hidden ? CH_HIDDEN : 0)]);
      if (info.hidden) continue;
      const room = chan.room && !chan.room.closed ? chan.room : null;
      if (!room) {
        for (const [id, clock, state] of chan.aw) if (state !== null) aw.push([ch, id, clock, JSON.stringify(state)]);
        continue;
      }
      for (const id of chan.conn.awarenessIds) {
        const state = room.awareness.states.get(id);
        const meta = room.awareness.meta.get(id);
        if (state && meta) aw.push([ch, id, meta.clock, JSON.stringify(state)]);
      }
    }
    return { v: 2, u: this.user, b: this.branch, ro: this.readOnly, n: this.next, c, aw };
  }

  reattach(ch: number, room: Room) {
    const c = this.chans.get(ch);
    if (!c || room.closed || c.info.path !== room.path) return;
    if (c.room === room && room.conns.has(c.conn)) return;
    c.room = room;
    room.reattach(c.conn, c.info.hidden ? [] : c.aw);
    c.aw = [];
  }

  conn(ch: number): ChannelConn | null {
    return this.chans.get(ch)?.conn ?? null;
  }

  // ---- channel 0 ----

  private async open(msg: OpenMsg, counted = false): Promise<void> {
    const req = msg.path;
    const path = cleanPath(req);
    if (!path) return this.control({ t: "error", req, code: CODE.invalidPath, reason: "invalid path" });
    const open = this.byPath.get(path);
    if (open !== undefined) return this.opened(req, this.chans.get(open)!);
    if (!counted) {
      const now = this.host.now?.() ?? Date.now();
      while (this.opens.length && now - this.opens[0]! >= OPEN_RATE_WINDOW_MS) this.opens.shift();
      if (this.opens.length >= OPEN_RATE_MAX) return this.control({ t: "error", req, path, code: CODE.tooMany, reason: "too many opens" });
      this.opens.push(now);
    }
    const pending = this.opening.get(path);
    if (pending) {
      await pending;
      if (!this.gone) return this.open(msg, true);
      return;
    }
    if (this.chans.size + this.opening.size >= MAX_CHANNELS) return this.control({ t: "error", req, path, code: CODE.tooMany, reason: "too many channels" });
    let done!: () => void;
    this.opening.set(path, new Promise<void>((r) => (done = r)));
    try {
      await this.openRoom(msg, req, path);
    } finally {
      this.opening.delete(path);
      done();
    }
  }

  private async openRoom(msg: OpenMsg, req: string, path: string) {
    let res: OpenRoomResult;
    try {
      res = await this.host.openRoom(path);
    } catch (e) {
      console.error(`[ws] open ${path}:`, e);
      res = { reject: { code: CODE.failed, reason: "could not open file" } };
    }
    if (this.gone) return;
    if ("reject" in res) return this.control({ t: "error", req, path, code: res.reject.code, reason: res.reject.reason });
    const room = res.room;
    if (room.closed) return this.control({ t: "error", req, path, code: CODE.retry, reason: "room closed, retry" });
    const ch = this.next++;
    const c = this.addChannel({ ch, path, generation: room.generation, readOnly: this.readOnly || !!msg.readOnly, hidden: !!msg.hidden }, room);
    this.opened(req, c);
    room.addConn(c.conn, stateVector(msg.sv));
    this.changed([path]);
  }

  private opened(req: string, c: Channel) {
    const generation = c.room && !c.room.closed ? c.room.generation : c.info.generation;
    this.control({ t: "opened", req, path: c.info.path, ch: c.info.ch, generation, readOnly: c.info.readOnly });
  }

  private close(ch: number) {
    const c = this.chans.get(ch);
    if (!c) return;
    this.drop(c);
    c.room?.removeConn(c.conn);
    this.changed([c.info.path]);
  }

  private view(ch: number, hidden: boolean) {
    const c = this.chans.get(ch);
    if (!c || c.info.hidden === hidden) return;
    c.info.hidden = hidden;
    c.conn.hidden = hidden;
    if (c.room && !c.room.closed && c.room.conns.has(c.conn)) c.room.emitPresence();
    this.changed([c.info.path]);
  }

  // ---- helpers ----

  private addChannel(info: ChannelInfo, room: Room | null): Channel {
    const { ch } = info;
    const self = this;
    const conn: ChannelConn = {
      ch,
      user: this.user,
      readOnly: info.readOnly,
      hidden: info.hidden,
      awarenessTimeoutMs: AWARENESS_TIMEOUT_MS,
      awarenessIds: new Set(),
      send(body) {
        if (self.gone || self.chans.get(ch)?.conn !== conn) return;
        self.host.send(withChannel(ch, body));
      },
      close(code = CODE.failed, reason = "") {
        self.end(ch, code, reason);
      },
      renew(ms) {
        if (self.gone || self.chans.get(ch)?.conn !== conn) return;
        self.host.send(encodeControl(ch, { t: "renew", ms }));
      },
    };
    const c: Channel = { info, conn, room, aw: [] };
    this.chans.set(ch, c);
    this.byPath.set(info.path, ch);
    return c;
  }

  private drop(c: Channel) {
    this.chans.delete(c.info.ch);
    if (this.byPath.get(c.info.path) === c.info.ch) this.byPath.delete(c.info.path);
  }

  /** The channel's room, waking it if the host can; null after ending the channel. */
  private roomOf(c: Channel): Room | null {
    if (c.room && !c.room.closed && c.room.conns.has(c.conn)) return c.room;
    const room = this.host.wakeRoom?.(c.info.path) ?? null;
    if (!room || room.closed || room.generation !== c.info.generation) {
      this.end(c.info.ch, CODE.retry, room ? "generation changed" : "room closed");
      return null;
    }
    this.reattach(c.info.ch, room);
    return room;
  }

  private changed(paths: string[]) {
    this.persist();
    this.host.presenceChanged(paths);
  }

  private persist() {
    if (!this.gone) this.host.persist(this.state());
  }

  private control(msg: object) {
    if (!this.gone) this.host.send(encodeControl(SOCKET_CHANNEL, msg));
  }
}

/** `open.sv` as sync step 2's state vector: the client's, or the empty one (the whole document) if absent or bad. */
function stateVector(sv: string | undefined): Uint8Array {
  const bytes = sv === undefined ? null : decodeSv(sv);
  if (bytes) {
    try {
      Y.decodeStateVector(bytes);
      return bytes;
    } catch {
      // a bad state vector: send the whole document
    }
  }
  return Uint8Array.of(0);
}

/**
 * The sockets of one workspace and their events (see WorkspaceSockets). `room(path)` is the open room of a path,
 * `rooms()` every open room of the workspace (in memory only: no wakes).
 */
export class WorkspaceSocketSet implements WorkspaceSockets {
  private socks = new Set<WorkspaceSocket>();
  /** The users last sent per path, so a recomputation that changes nothing sends nothing. */
  private sent = new Map<string, string>();
  /** The workspace's status as its sockets last heard it (openRoom refuses notes while it isn't ready). */
  status: WorkspaceStatus | "removed" = "ready";
  error: string | undefined;

  constructor(private opts: { room(path: string): Room | undefined; rooms(): Iterable<Room> }) {}

  get size() {
    return this.socks.size;
  }

  all(): WorkspaceSocket[] {
    return [...this.socks];
  }

  add(sock: WorkspaceSocket) {
    this.socks.add(sock);
  }

  remove(sock: WorkspaceSocket) {
    this.socks.delete(sock);
  }

  broadcast(msg: WorkspaceEventMsg) {
    if (msg.t === "workspace") {
      this.status = msg.status;
      this.error = msg.error;
    }
    for (const s of this.socks) s.sendEvent(msg);
  }

  /** Who's in a note: the room's participants (if it's in memory), plus visible channels on it. */
  presence(path: string): PresenceUser[] {
    const seen = new Map<string, PresenceUser>();
    const room = this.opts.room(path);
    if (room && !room.closed) for (const u of room.participants()) seen.set(u.id, presenceUser(u));
    for (const [sock, info] of this.channelsOn(path)) if (!info.hidden && !seen.has(sock.user.id)) seen.set(sock.user.id, presenceUser(sock.user));
    return [...seen.values()];
  }

  /** Recompute a note's presence and send it to every socket if it changed. */
  updatePresence(path: string) {
    const users = this.presence(path);
    const json = JSON.stringify(users);
    if ((this.sent.get(path) ?? "[]") === json) return;
    if (users.length) this.sent.set(path, json);
    else this.sent.delete(path);
    const msg: PresenceMsg = { t: "presence", path, users };
    for (const s of this.socks) s.sendEvent(msg);
  }

  presenceSnapshot(): PresenceSnapshotMsg {
    const paths = new Set<string>();
    for (const r of this.opts.rooms()) if (!r.closed) paths.add(r.path);
    for (const s of this.socks) for (const info of s.channels.values()) paths.add(info.path);
    const files: PresenceSnapshotMsg["files"] = [];
    for (const path of paths) {
      const users = this.presence(path);
      if (users.length) files.push({ path, users });
    }
    return { t: "presence", files };
  }

  channelsOn(path: string): Array<[WorkspaceSocket, ChannelInfo]> {
    const out: Array<[WorkspaceSocket, ChannelInfo]> = [];
    for (const s of this.socks) for (const info of s.channels.values()) if (info.path === path) out.push([s, info]);
    return out;
  }
}
