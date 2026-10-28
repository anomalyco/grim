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
import { d1Db } from "./db-d1.ts";
import { DEMO_ID, newDemoStore, openDemo, resetDemoWorkspace } from "./demo.ts";
import type { Env } from "./index.ts";
import { DoRoomStorage } from "./room-storage-do.ts";
import { gitStore, inRequestScope, LOCATION, readAdmission } from "./router.ts";

/** How often the safety alarm runs while rooms, sockets or crash logs exist (WORKSPACE_ALARM_MS overrides). */
export const ALARM_MS = 60_000;
/** Attachments are capped at 2 KiB serialized; the JSON is kept under this to leave room for the encoding. */
const ATTACHMENT_MAX = 1800;

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
  #rooms: RoomManager;
  #runtime: WorkspaceRuntime;
  #sockets = new Map<WebSocket, { room: Room; conn: SocketConn }>();
  #watched = new WeakSet<Room>();
  #hub: ReturnType<Env["HUB"]["getByName"]> | null = null;
  #recovering: Promise<void> | null = null;
  #alarmAt: number | null | undefined = undefined;
  #branch: string | null | undefined = undefined;
  /** The demo workspace: in memory, not hibernatable. */
  #demo: boolean;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#id = ctx.id.name ?? "";
    this.#storage = new DoRoomStorage(ctx.storage);
    ensureRoomTables(this.#storage);
    this.#storage.exec("CREATE TABLE IF NOT EXISTS workspace_meta (k TEXT PRIMARY KEY, v TEXT)");
    this.#storage.exec("CREATE TABLE IF NOT EXISTS presence_files (path TEXT PRIMARY KEY)");
    // its repos writes (head, import status) empty this isolate's workspace-row cache
    const db = (this.#db = repoCacheDb(d1Db(env.DB)));
    const demo = (this.#demo = this.#id === DEMO_ID);
    this.#store = new CachedHeadStore(demo ? newDemoStore() : storeFor(env, this.#id), { onHeadChange: repoHeadWriter(db) });
    this.#rooms = new RoomManager(this.#store, { storage: this.#storage, db, ephemeral: () => demo, room: { closeTimer: false, sweepTimer: false } });
    this.#runtime = new WorkspaceRuntime(this.#id, this.#store, this.#rooms);
    live.set(this.#id, this);
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
    const a = readAdmission(req);
    if (!a || a.repoId !== this.#id) return new Response("Bad admission", { status: 400 });
    this.#noteBranch(a.branch);
    const d = await this.#runtime.admitFile(a);
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    if ("reject" in d || d.room.closed) {
      const { code, reason } = "reject" in d ? d.reject : { code: 1013, reason: "room closed, retry" };
      server.accept();
      server.close(code, reason);
      return new Response(null, { status: 101, webSocket: client });
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
    return new Response(null, { status: 101, webSocket: client });
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
    this.#gone(ws);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {}
  }

  webSocketError(ws: WebSocket) {
    this.#gone(ws);
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
    this.#watch(room);
    const others = this.ctx.getWebSockets(pathTag(att.path));
    for (const other of others.includes(ws) ? others : [...others, ws]) {
      if (this.#sockets.has(other)) continue;
      const a = other === ws ? att : attachment(other);
      if (!a || a.path !== att.path || a.generation !== room.generation) continue;
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
    this.#armAlarm();
    return this.#sockets.get(ws) ?? null;
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

  // ---- alarm ----

  /** Make sure the safety alarm is set while anything is open (no-op if it already is). */
  #armAlarm() {
    if (this.#alarmAt) return;
    void this.#alarmBy(Date.now() + alarmMs(this.env)).catch((e) => console.error(`[workspace ${this.#id}] alarm:`, e));
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
    for (const ws of this.ctx.getWebSockets()) this.#socket(ws);
    await this.#recover();
    const rooms = this.#rooms.inRepo(this.#id);
    const branch = this.#getBranch();
    // Pushes from elsewhere arrive by webhook; this catches a missed one while people are editing.
    let polled = false;
    if (branch && rooms.some((r) => r.conns.size)) {
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
    const busy = this.#rooms.inRepo(this.#id).length > 0 || this.ctx.getWebSockets().length > 0 || this.#storage.exec("SELECT 1 FROM room_meta LIMIT 1").length > 0;
    const next = Math.min(importAt ?? Infinity, busy ? Date.now() + alarmMs(this.env) : Infinity);
    if (next !== Infinity) await this.#alarmBy(next);
  }

  /** A GitHub import of this workspace (repos.ts ImportState): saved, then run step by step from the alarm. */
  async startImport(state: ImportState) {
    await this.ctx.storage.put("import", state);
    await this.#alarmBy(state.at);
  }

  /** Reopen notes whose crash logs have no room in memory (an eviction or a crash left them): they get committed. */
  #recover(): Promise<void> {
    return (this.#recovering ??= (async () => {
      const branch = this.#getBranch();
      const rows = this.#storage.exec<{ room: string }>("SELECT room FROM room_meta");
      let reopened = false;
      for (const { room } of rows) {
        const [repo, path] = room.split("\u0000") as [string, string];
        if (repo !== this.#id || !branch || this.#rooms.peek(repo, path)) continue;
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

  // ---- events ----

  #forward(e: AppEvent) {
    if (e.type === "presence") {
      if (e.users.length) this.#storage.exec("INSERT OR IGNORE INTO presence_files (path) VALUES (?)", e.path);
      else this.#storage.exec("DELETE FROM presence_files WHERE path = ?", e.path);
    }
    this.#hub ??= this.env.HUB.getByName("hub", LOCATION);
    this.#hub.emit(e).catch((err: unknown) => console.error("[hub] emit:", err));
  }

  /** Files shown as open (presence) that have no room and no socket any more (closed, evicted): empty their presence. */
  #clearPresence(closing?: WebSocket) {
    for (const { path } of this.#storage.exec<{ path: string }>("SELECT path FROM presence_files")) {
      if (this.#rooms.peek(this.#id, path) || this.ctx.getWebSockets(pathTag(path)).some((ws) => ws !== closing && ws.readyState === WebSocket.OPEN)) continue;
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

  /** Every call: remember the branch, reopen leftover crash logs first, and afterwards clear presence of closed notes. */
  async #call<T>(repo: RepoRow, fn: (rt: WorkspaceRuntime) => Promise<T>): Promise<T> {
    this.#noteBranch(repo.branch);
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
    await this.#recover();
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
