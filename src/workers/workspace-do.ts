// One workspace (a Git repo) as a Durable Object: it hosts the workspace's WorkspaceRuntime (rooms, tree cache, heads,
// rename queue) and the note sockets.
//
// - RPC: the WorkspaceApi methods, forwarded to the runtime (plain data in and out, errors keep their names). The
//   runtime, its rooms and the store are never handed out: everything internal is #private, off the RPC surface.
// - Sockets: the Worker admits the workspace (auth, origin, status) and forwards the upgrade with the admission
//   (router.ts readAdmission); here the note's room is opened (4404/4413/1013 by upgrade-then-close) and the socket
//   is accepted for hibernation, tagged with a hash of the path, its attachment holding the path, participant,
//   read-only flag, room generation and up to 2 awareness states.
// - Hibernation: after a wake the rooms are gone from memory. The first socket message rebuilds its room from the
//   crash log synchronously (RoomManager.wake: no store, no Db) and puts the path's sockets back with their awareness
//   (Room.reattach) before the frame is applied.
// - Timers: the rooms' own setTimeouts (quiet flush, blame, 250 ms batch) and one safety alarm while anything is
//   open: sweep awareness, flush dirty rooms, poll the head while sockets exist, close idle rooms without sockets,
//   reopen crash logs left by an eviction, and clear the presence of files nobody has open any more. The alarm also
//   runs a GitHub import step by step (startImport, repos.ts runDueImport).
// - Events the runtime emits for this workspace go to HubDO.
// - The demo workspace (id "demo") is all in memory, as on Bun: a MemoryStore seeded by each new instance, rooms
//   without crash logs, and standard sockets (not hibernatable), so the object stays put while anyone is connected.
//   The cron resets it (resetDemo; src/workers/demo.ts).
import { DurableObject } from "cloudflare:workers";
import { config } from "../server/config.ts";
import { bus } from "../server/events.ts";
import { sha256 } from "../server/ids.ts";
import type { Participant, Room } from "../server/room.ts";
import { repoCacheDb } from "../server/repo-cache.ts";
import { runDueImport, type ImportState, type RepoRow } from "../server/repos.ts";
import { ensureRoomTables, RoomManager, type Conn } from "../server/rooms.ts";
import type { AppEvent } from "../server/seams/events.ts";
import type { ShellWrite, WorkspaceApi } from "../server/seams/workspace-host.ts";
import { CachedHeadStore, repoHeadWriter } from "../server/store/cached-head.ts";
import type { GitStore } from "../server/store/types.ts";
import { WorkspaceRuntime } from "../server/workspace.ts";
import {
  CH_HIDDEN,
  CLOSE,
  CODE,
  DEAD_SOCKET_MS,
  PING,
  PONG,
  createWorkspaceSocket,
  decodeFrame,
  type AdmittedSocket,
  type ChannelInfo,
  type MuxHost,
  type MuxState,
  type OpenErrorCode,
  type OpenRoomResult,
  type WorkspaceSocket,
  type WorkspaceSocketSet,
} from "../server/wsmux.ts";
import { d1Db } from "./db-d1.ts";
import { DEMO_ID, newDemoStore, openDemo, resetDemoWorkspace } from "./demo.ts";
import type { Env } from "./index.ts";
import { DoRoomStorage } from "./room-storage-do.ts";
import { gitStore, inRequestScope, LOCATION, readAdmission, type Admission } from "./router.ts";
import { StoreCalls, Timing } from "./timing.ts";

/** How often the safety alarm runs while rooms, sockets or crash logs exist (WORKSPACE_ALARM_MS overrides). */
export const ALARM_MS = 60_000;
/** The safety alarm while only idle v2 sockets are held (WORKSPACE_IDLE_ALARM_MS overrides): no work, the dead-socket check and (EXTERNAL_SYNC) a missed-webhook poll. */
export const IDLE_ALARM_MS = 600_000;
/** Note text kept per commit in memory, so reopening a note at the same head reads nothing from Code Storage. */
const FILE_CACHE_CHARS = 8_000_000;
/** Attachments are capped at 2 KiB serialized; the JSON is kept under this to leave room for the encoding. */
const ATTACHMENT_MAX = 1800;
/** The tag of protocol v2 sockets (one per tab, channels inside); v1 sockets have their note's `p:` tag. */
export const V2_TAG = "w2";
/** Paths longer than this (UTF-8 bytes) are kept in v2 attachments as a hash, the path in `channel_paths`, when the attachment doesn't fit. */
const LONG_PATH_BYTES = 64;

/** What each hibernatable socket carries across a wake. */
interface Attachment {
  path: string;
  branch: string;
  user: Participant;
  readOnly: boolean;
  /** the room generation the client joined; a reopened room with another one makes the client reconnect */
  generation: string;
  /** the socket's awareness states: [clientId, clock, state JSON] (at most 2, dropped when too big) */
  aw: Array<[number, number, string]>;
}

interface SocketConn extends Conn {
  ws: WebSocket;
  att: Attachment;
}

/** Rooms opened or woken here (an RPC, a v1 socket, recovery, a v2 open) get every v2 channel on their path put back. */
class DoRooms extends RoomManager {
  onRoom: (room: Room) => void = () => {};

  override async get(repo: string, path: string, branch: string, create: string | null = null): Promise<Room> {
    const room = await super.get(repo, path, branch, create);
    this.onRoom(room);
    return room;
  }

  override wake(repo: string, path: string, branch: string): Room | null {
    const room = super.wake(repo, path, branch);
    if (room) this.onRoom(room);
    return room;
  }
}

/** The Git store the Durable Objects use (tests and the demo swap it); default the isolate's store (router.ts). */
let storeFor: (env: Env, id: string) => GitStore = () => gitStore();

export function useWorkspaceStore(fn: (env: Env, id: string) => GitStore) {
  storeFor = fn;
}

/** The live WorkspaceDO per workspace in this isolate, for forwarding events (an evicted one is replaced). */
const live = new Map<string, WorkspaceDO>();
let subscribed = false;

/** The socket tag for a note: paths can be longer than a tag (256 chars), so the first 16 bytes of its SHA-256. */
export function pathTag(path: string): string {
  return "p:" + sha256(path).slice(0, 32);
}

export class WorkspaceDO extends DurableObject<Env> implements WorkspaceApi {
  #id: string;
  #db: ReturnType<typeof repoCacheDb>;
  #storage: DoRoomStorage;
  #store: CachedHeadStore;
  #rooms: DoRooms;
  #runtime: WorkspaceRuntime;
  #sockets = new Map<WebSocket, { room: Room; conn: SocketConn }>();
  #watched = new WeakSet<Room>();
  #hub: ReturnType<Env["HUB"]["getByName"]> | null = null;
  #recovering: Promise<void> | null = null;
  #alarmAt: number | null | undefined = undefined;
  #branch: string | null | undefined = undefined;
  /** The demo workspace: in memory, not hibernatable. */
  #demo: boolean;
  /** When this instance was constructed, until its first socket reports it (Server-Timing do-start). */
  #startedAt: number | null = performance.now();
  /** Recent store calls with their durations (Server-Timing on the 101). */
  #calls = new StoreCalls();
  /** v2 sockets known to this instance (accepted here, or restored from their attachments after a wake). */
  #v2 = new Map<WebSocket, WorkspaceSocket>();
  /** Whether the hibernated v2 sockets were restored into #v2 (once per instance). */
  #restored = false;
  /** The room the last v2 frame woke (its blame is fetched after the frame). */
  #woken: Room | null = null;
  /** channel_paths rows known to exist: hash → path. */
  #longPaths = new Map<string, string>();
  /** The branch head this instance last saw (for `tree` events). */
  #head: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#id = ctx.id.name ?? "";
    this.#storage = new DoRoomStorage(ctx.storage);
    ensureRoomTables(this.#storage);
    this.#storage.exec("CREATE TABLE IF NOT EXISTS workspace_meta (k TEXT PRIMARY KEY, v TEXT)");
    this.#storage.exec("CREATE TABLE IF NOT EXISTS presence_files (path TEXT PRIMARY KEY)");
    this.#storage.exec("CREATE TABLE IF NOT EXISTS channel_paths (hash TEXT PRIMARY KEY, path TEXT NOT NULL)");
    // its repos writes (head, import status) empty this isolate's workspace-row cache
    const db = (this.#db = repoCacheDb(d1Db(env.DB)));
    const demo = (this.#demo = this.#id === DEMO_ID);
    const writeHead = repoHeadWriter(db);
    this.#store = new CachedHeadStore(this.#calls.wrap(demo ? newDemoStore() : storeFor(env, this.#id)), {
      onHeadChange: (repo, branch, sha) => {
        if (repo === this.#id) this.#head = sha;
        return writeHead(repo, branch, sha);
      },
      fileCacheChars: FILE_CACHE_CHARS,
    });
    this.#rooms = new DoRooms(this.#store, { storage: this.#storage, db, ephemeral: () => demo, room: { closeTimer: false, sweepTimer: false, catchUpLater: true } });
    this.#rooms.onRoom = (room) => this.#adopt(room);
    this.#runtime = new WorkspaceRuntime(this.#id, this.#store, this.#rooms);
    live.set(this.#id, this);
    // v2 heartbeats are answered by the runtime without waking the object (§3.6)
    if (!demo) ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    if (demo) void ctx.blockConcurrencyWhile(() => openDemo(this.#store, db).catch((e) => console.error("[demo] seed:", e)));
    if (!subscribed) {
      subscribed = true;
      // Emits made while handling a Worker request are the router's to forward; the rest belong to a workspace.
      bus.subscribe((e: AppEvent) => {
        if (!("repo" in e) || inRequestScope()) return;
        const target = live.get(e.repo);
        if (target) target.#forward(e);
      });
    }
  }

  // ---- sockets ----

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket upgrade", { status: 426 });
    const adm = readAdmission(req);
    if (!adm || adm.repoId !== this.#id) return new Response("Bad admission", { status: 400 });
    if (isV2(adm)) return this.#acceptV2(adm);
    const a = adm;
    this.#noteBranch(a.branch);
    const t = new Timing();
    if (this.#startedAt !== null) {
      t.add("do-start", performance.now() - this.#startedAt, "first request of this instance");
      this.#startedAt = null;
    }
    const was = this.#rooms.peek(this.#id, a.path) ? "open" : "closed";
    const since = performance.now();
    const d = await t.time("file", () => this.#runtime.admitFile(a), `room ${was}`);
    for (const c of this.#calls.since(since)) t.add(c.name, c.ms);
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    if ("reject" in d || d.room.closed) {
      const { code, reason } = "reject" in d ? d.reject : { code: 1013, reason: "room closed, retry" };
      server.accept();
      server.close(code, reason);
      return new Response(null, { status: 101, webSocket: client, headers: { "server-timing": t.header() } });
    }
    const { room } = d;
    if (this.#demo) this.#acceptResident(server);
    else this.ctx.acceptWebSocket(server, [pathTag(a.path)]);
    const att: Attachment = { path: a.path, branch: a.branch, user: d.participant, readOnly: d.readOnly, generation: room.generation, aw: [] };
    const conn = this.#conn(server, att);
    this.#save(conn, room);
    this.#watch(room);
    this.#sockets.set(server, { room, conn });
    room.addConn(conn);
    this.#armAlarm();
    return new Response(null, { status: 101, webSocket: client, headers: { "server-timing": t.header() } });
  }

  /** A standard socket (the demo's): while it is open the object isn't hibernated, so nothing in memory is lost. */
  #acceptResident(ws: WebSocket) {
    ws.accept();
    (ws as WebSocket & { binaryType: string }).binaryType = "arraybuffer";
    ws.addEventListener("message", (e) => this.webSocketMessage(ws, e.data as string | ArrayBuffer));
    ws.addEventListener("close", (e) => this.webSocketClose(ws, e.code, e.reason));
    ws.addEventListener("error", () => this.webSocketError(ws));
  }

  webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    const v2 = this.#v2Of(ws);
    if (v2) return this.#v2Message(v2, msg);
    if (typeof msg === "string") return;
    const woke = !this.#sockets.has(ws);
    const s = this.#socket(ws);
    if (!s) return;
    try {
      s.room.onMessage(s.conn, new Uint8Array(msg));
    } catch (e) {
      console.error(`[ws] ${this.#id}: bad message:`, e);
    }
    // A woken room whose blame wasn't cached fetches it (from the store): after the frame, never before it.
    if (woke) s.room.ensureBlame();
  }

  webSocketClose(ws: WebSocket, code: number, reason: string) {
    if (!this.#v2Gone(ws)) this.#gone(ws);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {}
  }

  webSocketError(ws: WebSocket) {
    if (!this.#v2Gone(ws)) this.#gone(ws);
  }

  #gone(ws: WebSocket) {
    const s = this.#socket(ws, false);
    this.#sockets.delete(ws);
    if (s) s.room.removeConn(s.conn);
    this.#clearPresence(ws);
    this.#armAlarm();
  }

  #conn(ws: WebSocket, att: Attachment): SocketConn {
    return {
      ws,
      att,
      user: att.user,
      readOnly: att.readOnly,
      awarenessIds: new Set(),
      send(m) {
        try {
          ws.send(m);
        } catch {}
      },
      close(code, reason) {
        try {
          ws.close(code, reason);
        } catch {}
      },
    };
  }

  /**
   * The room and connection of a socket. After a hibernation wake, the first socket of a note rebuilds the room from
   * its crash log synchronously (no store, no Db) and puts back every socket of that note, awareness included.
   * `reopen: false` (a close) doesn't ask a client to reconnect.
   */
  #socket(ws: WebSocket, reopen = true): { room: Room; conn: SocketConn } | null {
    const known = this.#sockets.get(ws);
    if (known && !known.room.closed) return known;
    if (known) {
      this.#sockets.delete(ws);
      return null;
    }
    const att = attachment(ws);
    if (!att) return null;
    const room = this.#rooms.wake(this.#id, att.path, att.branch);
    if (!room || room.generation !== att.generation) {
      // No crash log (the room is gone) or a different document: the client reconnects and resyncs.
      if (reopen) {
        try {
          ws.close(1013, "room closed, retry");
        } catch {}
      }
      return null;
    }
    this.#reattachV1(room, ws);
    this.#armAlarm();
    return this.#sockets.get(ws) ?? null;
  }

  /** Put back the v1 sockets of a room's note that this instance doesn't have yet (after a wake), with their awareness. */
  #reattachV1(room: Room, extra?: WebSocket) {
    this.#watch(room);
    const others = this.ctx.getWebSockets(pathTag(room.path));
    for (const other of !extra || others.includes(extra) ? others : [...others, extra]) {
      if (this.#sockets.has(other)) continue;
      const a = attachment(other);
      if (!a || a.path !== room.path || a.generation !== room.generation) continue;
      const conn = this.#conn(other, a);
      room.reattach(conn, a.aw.flatMap(([id, clock, s]) => {
        try {
          return [[id, clock, JSON.parse(s) as Record<string, unknown> | null] as [number, number, Record<string, unknown> | null]];
        } catch {
          return [];
        }
      }));
      this.#sockets.set(other, { room, conn });
    }
  }

  /** Keep each socket's attachment in step with its awareness states (they are restored from it after a wake). */
  #watch(room: Room) {
    if (this.#watched.has(room)) return;
    this.#watched.add(room);
    room.awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      const ids = [...added, ...updated, ...removed];
      for (const c of room.conns) {
        if ("ws" in c && ids.some((id) => c.awarenessIds.has(id))) this.#save(c as SocketConn, room);
      }
    });
  }

  #save(conn: SocketConn, room: Room) {
    const aw: Attachment["aw"] = [];
    for (const id of conn.awarenessIds) {
      const meta = room.awareness.meta.get(id);
      const state = room.awareness.states.get(id);
      if (meta && state) aw.push([id, meta.clock, JSON.stringify(state)]);
    }
    conn.att = fit({ ...conn.att, aw });
    try {
      conn.ws.serializeAttachment(conn.att);
    } catch {}
  }

  // ---- protocol v2: one socket per tab, a channel per open note (docs/07-workspace-socket.md) ----

  /** A v2 upgrade: the Worker admitted the workspace; notes are opened on the socket's channels. */
  #acceptV2(a: AdmittedSocket): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const table = this.#table();
    this.#noteBranch(a.branch);
    // the admission read the workspace row just now: the newest status there is
    table.status = a.status;
    table.error = a.error;
    if (this.#demo) this.#acceptResident(server);
    else this.ctx.acceptWebSocket(server, [V2_TAG]);
    const sock = createWorkspaceSocket(this.#host(server, a.participant, a.readOnly), { admission: a });
    this.#v2.set(server, sock);
    table.add(sock);
    sock.start(a.status, a.error, table.presenceSnapshot());
    this.#persist(server, sock.state());
    this.#armAlarm(idleAlarmMs(this.env));
    return new Response(null, { status: 101, webSocket: client });
  }

  #host(ws: WebSocket, user: Participant, readOnly: boolean): MuxHost {
    return {
      openRoom: (path) => this.#openRoom(path, user, readOnly),
      send(data) {
        try {
          ws.send(data);
        } catch {}
      },
      closeSocket: (code, reason) => {
        try {
          ws.close(code, reason);
        } catch {}
        this.#v2Gone(ws);
      },
      persist: (state) => this.#persist(ws, state),
      presenceChanged: (paths) => {
        const table = this.#table();
        for (const path of paths) this.#forward({ type: "presence", repo: this.#id, path, users: table.presence(path) });
        this.#armForRooms();
      },
      wakeRoom: (path) => this.#wakeRoom(path),
    };
  }

  async #openRoom(path: string, user: Participant, readOnly: boolean): Promise<OpenRoomResult> {
    const branch = this.#getBranch();
    const status = this.#table().status;
    if (!branch || status !== "ready") return { reject: { code: CODE.retry, reason: `workspace ${branch ? status : "not ready"}` } };
    // a room asleep with channels on it wakes from its log (same generation), so those channels are put back too
    if (!this.#rooms.peek(this.#id, path)) this.#rooms.wake(this.#id, path, branch);
    const d = await this.#runtime.admitFile({ repoId: this.#id, branch, path, participant: user, readOnly });
    if ("reject" in d) return { reject: { code: d.reject.code as OpenErrorCode, reason: d.reject.reason } };
    if (d.room.closed) return { reject: { code: CODE.retry, reason: "room closed, retry" } };
    this.#watch(d.room);
    this.#armForRooms();
    return { room: d.room };
  }

  /** The v2 socket of `ws`; after a wake, the first call restores every v2 socket from its attachment (no store, no fetch). */
  #v2Of(ws: WebSocket): WorkspaceSocket | null {
    const known = this.#v2.get(ws);
    if (known || this.#restored) return known ?? null;
    this.#table();
    return this.#v2.get(ws) ?? null;
  }

  /** The workspace's v2 sockets, restored from their attachments once per instance (and dead ones closed). */
  #table(): WorkspaceSocketSet {
    const table = this.#runtime.sockets;
    if (this.#restored) return table;
    this.#restored = true;
    if (this.#demo) return table;
    for (const ws of this.ctx.getWebSockets(V2_TAG)) {
      if (this.#v2.has(ws)) continue;
      const state = this.#unfit(ws);
      if (!state) {
        try {
          ws.close(CLOSE.retry, "lost state, reconnect");
        } catch {}
        continue;
      }
      const sock = createWorkspaceSocket(this.#host(ws, state.u, state.ro), { restore: state });
      this.#v2.set(ws, sock);
      table.add(sock);
    }
    this.#closeDead();
    return table;
  }

  /** v2 sockets whose heartbeat stopped (no auto-answered ping for DEAD_SOCKET_MS): closed, their channels leave. */
  #closeDead() {
    if (this.#demo) return;
    const now = Date.now();
    for (const ws of [...this.#v2.keys()]) {
      const at = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      if (!at || now - at.getTime() < DEAD_SOCKET_MS) continue;
      try {
        ws.close(CLOSE.retry, "no heartbeat");
      } catch {}
      this.#v2Gone(ws);
    }
  }

  #v2Message(sock: WorkspaceSocket, msg: string | ArrayBuffer) {
    // text is only the heartbeat (answered here only where the auto-response isn't set: the demo)
    if (typeof msg === "string") return sock.onMessage(msg);
    const data = new Uint8Array(msg);
    // a frame for a channel whose room is asleep wakes that room only (wakeRoom), from its crash log
    this.#woken = null;
    try {
      sock.onMessage(data);
    } catch (e) {
      console.error(`[ws] ${this.#id}: bad message:`, e);
    }
    // A woken room whose blame wasn't cached fetches it (from the store): after the frame, never before it.
    const woke = this.#woken as Room | null;
    this.#woken = null;
    if (woke) woke.ensureBlame();
    const ch = decodeFrame(data)?.ch;
    if (ch && sock.roomOf(ch)?.dirty) this.#armAlarm();
  }

  /**
   * A frame came for a v2 channel whose room isn't in memory: wake it from its crash log (no store, no Db), and
   * DoRooms puts back every channel on that path (all sockets) and the note's v1 sockets. Null when there's no log:
   * the socket ends that channel 1013 and the others carry on.
   */
  #wakeRoom(path: string): Room | null {
    const branch = this.#getBranch();
    const room = branch ? this.#rooms.wake(this.#id, path, branch) : null;
    if (!room || room.closed) return null;
    this.#woken = room;
    return room;
  }

  /** A room was opened or woken: bind every v2 channel on its path that isn't bound yet (another generation ends 1013). */
  #adopt(room: Room) {
    if (room.repo !== this.#id || room.closed) return;
    // v1 sockets of the same note too (mixed rooms), unless this is the demo (its sockets never hibernate)
    if (!this.#demo) this.#reattachV1(room);
    for (const [sock, c] of this.#channels(room.path)) {
      if (sock.roomOf(c.ch) === room) continue;
      if (!sock.reattach(c.ch, room)) sock.end(c.ch, CODE.retry, "generation changed");
    }
  }

  #channels(path: string): Array<[WorkspaceSocket, ChannelInfo]> {
    return this.#table().channelsOn(path);
  }

  /** A v2 socket closed: its channels leave their rooms. False for a v1 socket. */
  #v2Gone(ws: WebSocket): boolean {
    const sock = this.#v2Of(ws);
    if (!sock) return false;
    this.#v2.delete(ws);
    this.#table().remove(sock);
    sock.closed();
    this.#armForRooms();
    return true;
  }

  /** The attachment of a v2 socket: the state, fitted to the cap (§5.1). The demo's sockets aren't hibernatable. */
  #persist(ws: WebSocket, state: MuxState) {
    if (this.#demo) return;
    const att = fitState(state, (path) => this.#hashPath(path));
    if (attachmentSize(att) > ATTACHMENT_MAX) console.error(`[ws] ${this.#id}: v2 attachment over the cap (${attachmentSize(att)} bytes)`);
    try {
      ws.serializeAttachment(att);
    } catch (e) {
      console.error(`[ws] ${this.#id}: attachment:`, e);
    }
  }

  /** A long path's stand-in in attachments; the path goes to channel_paths once (one local write per distinct path). */
  #hashPath(path: string): string {
    const hash = "#" + sha256(path).slice(0, 16);
    if (this.#longPaths.get(hash) !== path) {
      this.#storage.exec("INSERT OR IGNORE INTO channel_paths (hash, path) VALUES (?, ?)", hash, path);
      this.#longPaths.set(hash, path);
    }
    return hash;
  }

  /** A v2 socket's state from its attachment, long paths looked up again; null when it isn't one. */
  #unfit(ws: WebSocket): MuxState | null {
    let s: MuxState | null;
    try {
      s = ws.deserializeAttachment() as MuxState | null;
    } catch {
      return null;
    }
    if (!s || s.v !== 2 || !Array.isArray(s.c) || !Array.isArray(s.aw)) return null;
    if (!s.c.some(([, p]) => isHashedPath(p))) return s;
    const c = s.c.map(([ch, p, g, f]): MuxState["c"][number] => [ch, isHashedPath(p) ? (this.#longPath(p) ?? p) : p, g, f]);
    return { ...s, c };
  }

  #longPath(hash: string): string | null {
    const known = this.#longPaths.get(hash);
    if (known) return known;
    const path = this.#storage.exec<{ path: string }>("SELECT path FROM channel_paths WHERE hash = ?", hash)[0]?.path ?? null;
    if (path) this.#longPaths.set(hash, path);
    return path;
  }

  /** channel_paths rows no attachment refers to any more (from the alarm). */
  #pruneLongPaths() {
    const rows = this.#storage.exec<{ hash: string }>("SELECT hash FROM channel_paths");
    if (!rows.length) return;
    const used = new Set<string>();
    for (const ws of this.ctx.getWebSockets(V2_TAG)) {
      try {
        for (const [, p] of (ws.deserializeAttachment() as MuxState | null)?.c ?? []) if (isHashedPath(p)) used.add(p);
      } catch {}
    }
    for (const { hash } of rows) {
      if (used.has(hash)) continue;
      this.#storage.exec("DELETE FROM channel_paths WHERE hash = ?", hash);
      this.#longPaths.delete(hash);
    }
  }

  /** The alarm by the rooms' needs: 60 s while one has work (dirty, or no connection left to close it), else the idle cadence. */
  #armForRooms() {
    const rooms = this.#rooms.inRepo(this.#id);
    this.#armAlarm(rooms.some((r) => r.dirty || !r.conns.size) ? alarmMs(this.env) : idleAlarmMs(this.env));
  }

  // ---- alarm ----

  /** Make sure the safety alarm runs within `ms` (no-op if it already does). */
  #armAlarm(ms = alarmMs(this.env)) {
    const at = Date.now() + ms;
    if (this.#alarmAt && this.#alarmAt <= at) return;
    void this.#alarmBy(at).catch((e) => console.error(`[workspace ${this.#id}] alarm:`, e));
  }

  /** Have the alarm run no later than `at`. */
  async #alarmBy(at: number) {
    if (this.#alarmAt === undefined) this.#alarmAt = await this.ctx.storage.getAlarm();
    if (this.#alarmAt && this.#alarmAt <= at) return;
    this.#alarmAt = at;
    await this.ctx.storage.setAlarm(at);
  }

  async alarm() {
    this.#alarmAt = null;
    let importAt: number | null = null;
    try {
      importAt = await runDueImport(
        { db: this.#db, store: this.#store, seenHead: (_id, head) => this.#runtime.seenHead(head) },
        {
          get: () => this.ctx.storage.get<ImportState>("import"),
          put: async (state) => void (state ? await this.ctx.storage.put("import", state) : await this.ctx.storage.delete("import")),
        },
      );
    } catch (e) {
      // the saved step runs again on the next alarm
      console.error(`[workspace ${this.#id}] import:`, e);
      importAt = Date.now() + alarmMs(this.env);
    }
    // v2 sockets: restored from their attachments and dead ones closed; their rooms stay asleep (no work for them)
    this.#table();
    if (this.#restored) this.#closeDead();
    for (const ws of this.#v1Sockets()) this.#socket(ws);
    await this.#recover();
    const rooms = this.#rooms.inRepo(this.#id);
    const branch = this.#getBranch();
    // Pushes from elsewhere arrive by webhook; this catches a missed one while people are editing. Only with
    // config.externalSync: otherwise the alarm reads no head (our own commits keep the head cache current, and a
    // commit that meets a moved head still merges it in on the conflict).
    let polled = false;
    if (config.externalSync && branch && (rooms.some((r) => r.conns.size) || this.#v2.size)) {
      try {
        await this.#store.head(this.#id, branch, { fresh: true });
        polled = true;
      } catch (e) {
        console.error(`[workspace ${this.#id}] head:`, e);
      }
    }
    await Promise.allSettled(
      rooms.map(async (room) => {
        room.sweepAwareness();
        room.ensureBlame();
        try {
          if (!room.conns.size) return void (await room.closeIfIdle());
          if (polled) await room.checkRemote();
          if (room.dirty && !room.closed) await room.flush();
        } catch (e) {
          console.error(`[workspace ${this.#id}] ${room.path}:`, e);
        }
      }),
    );
    this.#clearPresence();
    this.#pruneLongPaths();
    // 60 s while there is work: v1 sockets (30 s awareness), a room dirty or waiting to be closed, a crash log nobody
    // has open; while only idle v2 sockets (and their sleeping rooms) are left, the idle cadence
    const open = this.#rooms.inRepo(this.#id);
    const work = this.#v1Sockets().length > 0 || open.some((r) => r.dirty || !r.conns.size) || this.#orphanLogs();
    const idle = this.#v2.size > 0 || open.length > 0 || this.#storage.exec("SELECT 1 FROM room_meta LIMIT 1").length > 0;
    const next = Math.min(importAt ?? Infinity, work ? Date.now() + alarmMs(this.env) : idle ? Date.now() + idleAlarmMs(this.env) : Infinity);
    // strictly later than now: re-arming at the running alarm's own time (a step due "now" with the clock not moved
    // since the alarm started) is dropped when the handler returns, and the import would never run again
    if (next !== Infinity) await this.#alarmBy(Math.max(next, Date.now() + 1));
  }

  /** Hibernatable v1 sockets (and the demo's resident ones). */
  #v1Sockets(): WebSocket[] {
    const out = this.ctx.getWebSockets().filter((ws) => !this.#v2.has(ws));
    for (const ws of this.#sockets.keys()) if (!out.includes(ws)) out.push(ws);
    return out;
  }

  /** Crash logs of notes with no room in memory and nobody on them (recovery failed): work for the alarm. */
  #orphanLogs(): boolean {
    for (const { room } of this.#storage.exec<{ room: string }>("SELECT room FROM room_meta")) {
      const path = room.split("\u0000")[1] ?? "";
      if (this.#rooms.peek(this.#id, path) || this.#channels(path).length || this.ctx.getWebSockets(pathTag(path)).length) continue;
      return true;
    }
    return false;
  }

  /** A GitHub import of this workspace (repos.ts ImportState): saved, then run step by step from the alarm. */
  async startImport(state: ImportState) {
    await this.ctx.storage.put("import", state);
    await this.#alarmBy(state.at);
  }

  /**
   * Reopen notes whose crash logs have no room in memory (an eviction or a crash left them): they get committed.
   * Rooms with v2 channels on them are left asleep here (they wake on a frame); RPCs wake those first (#wakeChannelRooms).
   */
  #recover(): Promise<void> {
    return (this.#recovering ??= (async () => {
      const branch = this.#getBranch();
      const rows = this.#storage.exec<{ room: string }>("SELECT room FROM room_meta");
      let reopened = false;
      for (const { room } of rows) {
        const [repo, path] = room.split("\u0000") as [string, string];
        if (repo !== this.#id || !branch || this.#rooms.peek(repo, path)) continue;
        // v2 channels on it: the room wakes when one of them sends a frame
        if (this.#channels(path).length) continue;
        const ws = this.ctx.getWebSockets(pathTag(path))[0];
        if (ws && this.#socket(ws)) continue;
        try {
          await this.#rooms.get(repo, path, branch);
          reopened = true;
        } catch (e) {
          console.error(`[workspace ${this.#id}] recover ${path}:`, e);
        }
      }
      // only for rooms it reopened: arming on every call would keep the alarm going forever (alarm() calls this)
      if (reopened) this.#armAlarm();
    })().finally(() => (this.#recovering = null)));
  }

  /**
   * Wake, from their crash logs, the sleeping rooms that v2 channels hold open (synchronous: no store, no Db): an RPC
   * must see them (rename, delete, save, status, snapshot, tree), or it would miss their unsaved edits, never tell
   * their channels `closed`, and leave their logs behind to bring a deleted or renamed note back.
   */
  #wakeChannelRooms() {
    const branch = this.#getBranch();
    if (!branch || this.#demo) return;
    for (const { room } of this.#storage.exec<{ room: string }>("SELECT room FROM room_meta")) {
      const [repo, path] = room.split("\u0000") as [string, string];
      if (repo !== this.#id || this.#rooms.peek(repo, path) || !this.#channels(path).length) continue;
      this.#rooms.wake(repo, path, branch);
    }
  }

  // ---- events ----

  #forward(e: AppEvent) {
    if (e.type === "presence") {
      if (e.users.length) this.#storage.exec("INSERT OR IGNORE INTO presence_files (path) VALUES (?)", e.path);
      else this.#storage.exec("DELETE FROM presence_files WHERE path = ?", e.path);
    }
    this.#hub ??= this.env.HUB.getByName("hub", LOCATION);
    this.#hub.emit(e).catch((err: unknown) => console.error("[hub] emit:", err));
    // and to this workspace's own v2 sockets, on channel 0 (the head of `tree` from this instance's head cache)
    if (!this.#v2.size && (this.#restored || !this.ctx.getWebSockets(V2_TAG).length)) return;
    const table = this.#table();
    if (e.type === "tree") table.broadcast({ t: "tree", head: this.#head ?? "" });
    else void this.#runtime.socketEvent(e).catch((err: unknown) => console.error(`[ws] ${this.#id}: event:`, err));
  }

  /** Files shown as open (presence) that have no room and no socket any more (closed, evicted): empty their presence. */
  #clearPresence(closing?: WebSocket) {
    for (const { path } of this.#storage.exec<{ path: string }>("SELECT path FROM presence_files")) {
      if (this.#rooms.peek(this.#id, path) || this.ctx.getWebSockets(pathTag(path)).some((ws) => ws !== closing && ws.readyState === WebSocket.OPEN)) continue;
      if (this.#channels(path).some(([, c]) => !c.hidden)) continue;
      this.#forward({ type: "presence", repo: this.#id, path, users: [] });
    }
  }

  // ---- the branch (for crash-log recovery without a caller) ----

  #noteBranch(branch: string) {
    if (this.#getBranch() === branch) return;
    this.#branch = branch;
    this.#storage.exec("INSERT INTO workspace_meta (k, v) VALUES ('branch', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", branch);
  }

  #getBranch(): string | null {
    if (this.#branch === undefined) this.#branch = this.#storage.exec<{ v: string }>("SELECT v FROM workspace_meta WHERE k = 'branch'")[0]?.v ?? null;
    return this.#branch;
  }

  // ---- RPC: the WorkspaceApi ----

  /** Every call: remember the branch, wake the rooms v2 channels hold and reopen leftover crash logs first, and afterwards clear presence of closed notes. */
  async #call<T>(repo: RepoRow, fn: (rt: WorkspaceRuntime) => Promise<T>): Promise<T> {
    this.#noteBranch(repo.branch);
    this.#wakeChannelRooms();
    await this.#recover();
    try {
      return await fn(this.#runtime);
    } finally {
      this.#clearPresence();
      if (this.#rooms.inRepo(this.#id).length) this.#armAlarm();
    }
  }

  readFile(repo: RepoRow, path: string, ref?: string) {
    return this.#call(repo, (rt) => rt.readFile(repo, path, ref));
  }
  readRaw(repo: RepoRow, path: string, ref?: string) {
    return this.#call(repo, (rt) => rt.readRaw(repo, path, ref));
  }
  createFile(repo: RepoRow, path: string, content: string | undefined, actor: Participant) {
    return this.#call(repo, (rt) => rt.createFile(repo, path, content, actor));
  }
  patchFile(repo: RepoRow, path: string, base: string, next: string, actor: Participant) {
    return this.#call(repo, (rt) => rt.patchFile(repo, path, base, next, actor));
  }
  appendText(repo: RepoRow, path: string, text: string, actor: Participant) {
    return this.#call(repo, (rt) => rt.appendText(repo, path, text, actor));
  }
  restoreFile(repo: RepoRow, path: string, sha: string, actor: Participant) {
    return this.#call(repo, (rt) => rt.restoreFile(repo, path, sha, actor));
  }
  deleteFile(repo: RepoRow, path: string, actor: Participant) {
    return this.#call(repo, (rt) => rt.deleteFile(repo, path, actor));
  }
  renameFile(repo: RepoRow, from: string, to: string, actor: Participant, opts?: { ifUntitled?: boolean }) {
    return this.#call(repo, (rt) => rt.renameFile(repo, from, to, actor, opts));
  }
  renameFolder(repo: RepoRow, from: string, to: string, actor: Participant) {
    return this.#call(repo, (rt) => rt.renameFolder(repo, from, to, actor));
  }
  deleteFolder(repo: RepoRow, dir: string, actor: Participant) {
    return this.#call(repo, (rt) => rt.deleteFolder(repo, dir, actor));
  }
  uploadImage(repo: RepoRow, notePath: string, filename: string, bytes: Uint8Array, actor: Participant) {
    return this.#call(repo, (rt) => rt.uploadImage(repo, notePath, filename, bytes, actor));
  }
  tree(repo: RepoRow) {
    return this.#call(repo, (rt) => rt.tree(repo));
  }
  head(repo: RepoRow) {
    return this.#call(repo, (rt) => rt.head(repo));
  }
  history(repo: RepoRow, path: string | undefined, limit?: number, opts?: { anyPath?: boolean }) {
    return this.#call(repo, (rt) => rt.history(repo, path, limit, opts));
  }
  diff(repo: RepoRow, sha: string, path?: string, opts?: { anyPath?: boolean }) {
    return this.#call(repo, (rt) => rt.diff(repo, sha, path, opts));
  }
  snapshot(repo: RepoRow, since: string | null, want?: string[]) {
    return this.#call(repo, (rt) => rt.snapshot(repo, since, want));
  }
  applyWrites(repo: RepoRow, writes: ShellWrite[], actor: Participant) {
    return this.#call(repo, (rt) => rt.applyWrites(repo, writes, actor));
  }
  save(repo: RepoRow, paths: string[], dirs?: string[]) {
    return this.#call(repo, (rt) => rt.save(repo, paths, dirs));
  }
  who(repo: RepoRow, path: string) {
    return this.#call(repo, (rt) => rt.who(repo, path));
  }
  status(repo: RepoRow, dir: string) {
    return this.#call(repo, (rt) => rt.status(repo, dir));
  }
  liveDiff(repo: RepoRow, dir: string) {
    return this.#call(repo, (rt) => rt.liveDiff(repo, dir));
  }
  search(repo: RepoRow, q: string) {
    return this.#call(repo, (rt) => rt.search(repo, q));
  }
  async waitForChange(path: string | undefined, timeoutMs: number) {
    await this.#recover();
    return this.#runtime.waitForChange(path, timeoutMs);
  }
  onPush(repo: RepoRow, opts?: { fresh?: boolean; invalidate?: boolean }) {
    return this.#call(repo, (rt) => rt.onPush(repo, opts));
  }
  refresh(repo: RepoRow, minIntervalMs?: number) {
    return this.#call(repo, (rt) => rt.refresh(repo, minIntervalMs));
  }
  async seenHead(head: string | null) {
    return this.#runtime.seenHead(head);
  }
  /** The demo workspace only: back to its seed (the 6-hourly cron); clients get 1013 and reload. */
  async resetDemo() {
    if (this.#id !== DEMO_ID) throw new Error(`${this.#id} is not the demo workspace`);
    await this.ctx.blockConcurrencyWhile(async () => {
      await resetDemoWorkspace({ store: this.#store, rooms: this.#rooms, db: this.#db, sockets: [...this.#sockets.keys()] });
      this.#sockets.clear();
    });
    this.#clearPresence();
  }
  async remove() {
    this.#wakeChannelRooms();
    await this.#recover();
    // the runtime tells the v2 sockets (`workspace removed`, close 4404): the hibernated ones too
    this.#table();
    await this.#runtime.remove();
    this.#clearPresence();
  }
}

function attachment(ws: WebSocket): Attachment | null {
  try {
    const a = ws.deserializeAttachment() as Attachment | null;
    return a && typeof a.path === "string" ? a : null;
  } catch {
    return null;
  }
}

/** The attachment cut down to fit the 2 KiB cap: awareness states go first, then the avatar, then long names. */
function fit(att: Attachment): Attachment {
  const size = (a: Attachment) => new TextEncoder().encode(JSON.stringify(a)).length;
  let a = att;
  while (a.aw.length && size(a) > ATTACHMENT_MAX) a = { ...a, aw: a.aw.slice(0, -1) };
  if (size(a) > ATTACHMENT_MAX && a.user.avatar) a = { ...a, user: { ...a.user, avatar: undefined } };
  if (size(a) > ATTACHMENT_MAX) a = { ...a, user: { ...a.user, name: a.user.name.slice(0, 100), email: a.user.email.slice(0, 200) } };
  return a;
}

function alarmMs(env: Env): number {
  return Number((env as unknown as Record<string, unknown>).WORKSPACE_ALARM_MS) || ALARM_MS;
}

function idleAlarmMs(env: Env): number {
  return Number((env as unknown as Record<string, unknown>).WORKSPACE_IDLE_ALARM_MS) || IDLE_ALARM_MS;
}

function isV2(a: Admission | AdmittedSocket): a is AdmittedSocket {
  return (a as AdmittedSocket).v === 2;
}

const isHashedPath = (p: string) => /^#[0-9a-f]{16}$/.test(p);

const utf8 = new TextEncoder();

export function attachmentSize(a: unknown): number {
  return utf8.encode(JSON.stringify(a)).length;
}

/**
 * A v2 socket's state cut down to the attachment cap (§5.1), in this order: awareness states of hidden channels,
 * visible channels' states oldest first, the avatar, long names and emails, then paths over 64 bytes replaced by
 * `hashPath(path)`. The channel table itself is never cut.
 */
export function fitState(s: MuxState, hashPath: (path: string) => string): MuxState {
  if (attachmentSize(s) <= ATTACHMENT_MAX) return s;
  const hidden = new Set(s.c.filter(([, , , flags]) => flags & CH_HIDDEN).map(([ch]) => ch));
  let a: MuxState = { ...s, aw: s.aw.filter(([ch]) => !hidden.has(ch)) };
  while (a.aw.length && attachmentSize(a) > ATTACHMENT_MAX) a = { ...a, aw: a.aw.slice(1) };
  if (attachmentSize(a) > ATTACHMENT_MAX && a.u.avatar) {
    const { avatar: _, ...u } = a.u;
    a = { ...a, u };
  }
  if (attachmentSize(a) > ATTACHMENT_MAX) a = { ...a, u: { ...a.u, name: a.u.name.slice(0, 100), email: a.u.email.slice(0, 200) } };
  if (attachmentSize(a) > ATTACHMENT_MAX) a = { ...a, c: a.c.map(([ch, p, g, f]): MuxState["c"][number] => [ch, utf8.encode(p).length > LONG_PATH_BYTES ? hashPath(p) : p, g, f]) };
  return a;
}
