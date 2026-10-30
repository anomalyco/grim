// The home page doodle (/ws/home) as Durable Objects, one class in two roles, all named after the deployed version:
// - `home:<version>:lobby` hands out rooms (HomeLobby, src/server/home/home-lobby.ts): the Worker asks it, over RPC, which
//   room a new socket goes to;
// - `home:<version>:<room>` is one room: one HomeRoom (src/server/home/home.ts, shared with Bun), at most ROOM_HUMANS
//   people and its own three bots. It tells the lobby how many it holds when that changes and every 15 s (so a room
//   that's gone is forgotten), and turns away a fifth person itself.
// A room's strokes and bots live only in memory and the bots tick with setInterval while anyone is connected, so the
// sockets use the standard accept() rather than hibernation (nothing to rebuild from). Once nobody is in it (or coming
// back to a held place), the room stops and no timers are left, so the DO goes idle and is evicted. Pages ping their
// room every HOME_PING_MS ("ping", answered "pong" by HomeRoom: no hibernation auto-response, since the object is
// awake anyway while anyone's in it); a socket not heard from for HOME_DEAD_MS is dropped.
// A third role, unrelated to the home page: `demo-lobby` is the demo's lobby (DemoLobby, src/server/demo-rooms.ts):
// it hands out demo rooms, admits every REST call and socket on one (the Worker asks it, cached briefly), hears from
// each room's WorkspaceDO who is connected, makes a room's workspace row when it makes the room and deletes it when
// the room goes. Not per version: demo rooms outlive deploys while people are in them.
// Each deploy has its own lobby and rooms, so new code takes effect for whoever comes next. An old room would carry on
// for the people still in it (a deploy restarts Durable Objects only eventually, which took up to half an hour), so
// while anyone is in it, it asks the Worker as now deployed which version that is, and when it's not its own, closes
// everyone's socket: they reconnect, to the new version's rooms.
import { DurableObject } from "cloudflare:workers";
import { HomeRoom } from "../server/home/home.ts";
import { HomeLobby } from "../server/home/home-lobby.ts";
import { HOME_DEAD_MS } from "../shared/doodle.ts";
import { createDemoRoomRow, deleteDemoRoomRow } from "../server/demo.ts";
import { DemoLobby, type Admit } from "../server/demo-rooms.ts";
import { d1Db } from "./db-d1.ts";
import type { Env } from "./index.ts";

/** Header the Worker sets on the forwarded upgrade with the caller's IP (per-IP caps). */
export const HOME_IP_HEADER = "CF-Connecting-IP";
/** Headers the Worker sets on the forwarded upgrade: the room the lobby gave it, and the place it's coming back to. */
export const HOME_ROOM_HEADER = "X-Home-Room";
export const HOME_SLOT_HEADER = "X-Home-Slot";
/** …and the pencil colour the client picked (it keeps it; the room takes it if it's one of the palette's) */
export const HOME_COLOR_HEADER = "X-Home-Color";
/** …and its page's (tab's) and person's ids */
export const HOME_TAB_HEADER = "X-Home-Tab";
export const HOME_VISITOR_HEADER = "X-Home-Visitor";
/** Where the Worker says which version is deployed ({version}). */
export const HOME_VERSION_PATH = "/api/home-version";
/** How often a room with people in it tells the lobby it's there, and checks it's still the deployed version's. */
const HEARTBEAT_MS = 15_000;
/** Close code for "a new version is out: come back" (the client reconnects after a second). */
const NEW_VERSION = 1012;

/** The version of the code running here (without the binding, as in tests: "dev"). */
export const deployedVersion = (env: Env): string => env.CF_VERSION_METADATA?.id ?? "dev";
/** The name of this version's lobby, and of one of its rooms. */
export const lobbyName = (env: Env) => `home:${deployedVersion(env)}:lobby`;
export const roomName = (env: Env, room: string) => `home:${deployedVersion(env)}:${room}`;

/** The demo's lobby (one, whatever the version). */
export const DEMO_LOBBY = "demo-lobby";

export class HomeDO extends DurableObject<Env> {
  // ---------- as the demo's lobby ----------
  private demoState: DemoLobby | null = null;

  private demo(): DemoLobby {
    const db = d1Db(this.env.DB);
    return (this.demoState ??= new DemoLobby({
      onCreate: (id) => createDemoRoomRow(db, id),
      onDrop: (id) => deleteDemoRoomRow(db, id),
    }));
  }

  /** The demo room for `person` (see DemoLobby.assign), or null: try later. */
  demoAssign(person: string, ip: string): Promise<string | null> {
    return this.demo().assign(person, ip);
  }

  /** May `person` use this demo room now? */
  demoAdmit(workspace: string, person: string, ip: string): Admit {
    return this.demo().admit(workspace, person, ip);
  }

  /** A demo room's WorkspaceDO says whose sockets it holds. */
  demoReport(workspace: string, people: string[]): void {
    this.demo().report(workspace, people);
  }

  demoRoomOf(person: string): string | null {
    return this.demo().roomOf(person);
  }

  /** The demo rooms there are (the cron resets each). */
  demoRooms(): string[] {
    return this.demo().list();
  }

  demoStats(): { rooms: number; people: number } {
    return this.demo().stats();
  }

  // ---------- as the lobby ----------
  private lobbyState: HomeLobby | null = null;

  private lobby(): HomeLobby {
    // (rooms report every HEARTBEAT_MS: one not heard from for three of those is gone)
    return (this.lobbyState ??= new HomeLobby({ staleMs: HEARTBEAT_MS * 3 }));
  }

  /** The room for a new socket from `ip` (see HomeLobby.assign), or null: try later. */
  assign(ip: string, prev: string | null, slot: boolean): string | null {
    return this.lobby().assign(ip, prev ?? undefined, slot);
  }

  /** A room says how many it holds, and its people per IP. */
  report(room: string, humans: number, ips: Record<string, number>): void {
    this.lobby().report(room, humans, ips);
  }

  /** For tests and monitoring. */
  lobbyStats(): { rooms: number; humans: number } {
    return this.lobby().stats();
  }

  // ---------- as a room ----------
  private room: HomeRoom | null = null;
  private roomId = "";
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket upgrade", { status: 426 });
    const ip = req.headers.get(HOME_IP_HEADER) ?? "";
    this.roomId ||= req.headers.get(HOME_ROOM_HEADER) ?? "";
    const pair = new WebSocketPair();
    const [client, ws] = [pair[0], pair[1]];
    // binary frames arrive as ArrayBuffer (not Blob), so HomeRoom rejects them without reading them
    ws.binaryType = "arraybuffer";
    ws.accept();
    const open = () => ws.readyState === WebSocket.OPEN;
    const room = this.home();
    const conn = room.join(
      ip,
      {
        send: (m) => {
          if (!open()) return;
          try {
            ws.send(m);
          } catch {}
        },
        close: (code, reason) => {
          if (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING) return;
          try {
            ws.close(code, reason);
          } catch {}
        },
        // Workers sockets don't report queued bytes; a failed send closes the socket instead.
        buffered: () => 0,
      },
      {
        slot: req.headers.get(HOME_SLOT_HEADER) ?? undefined,
        color: req.headers.get(HOME_COLOR_HEADER) ?? undefined,
        tab: req.headers.get(HOME_TAB_HEADER) ?? undefined,
        visitor: req.headers.get(HOME_VISITOR_HEADER) ?? undefined,
      },
    );
    if (conn) {
      ws.addEventListener("message", (e) => room.message(conn, e.data));
      const gone = () => {
        room.leave(conn);
        try {
          ws.close(1000, "bye");
        } catch {}
      };
      ws.addEventListener("close", gone);
      ws.addEventListener("error", gone);
      this.heartbeat ??= setInterval(() => void this.beat(), HEARTBEAT_MS);
    }
    // Rejected joins (a full room: ROOM_FULL, and the client asks again) were already closed with their code
    // (upgrade-then-close), as on Bun.
    return new Response(null, { status: 101, webSocket: client });
  }

  private home(): HomeRoom {
    if (this.room) return this.room;
    const room = new HomeRoom({ room: this.roomId, deadMs: HOME_DEAD_MS, onOccupancy: (n, ips) => this.occupancy(room, n, ips) });
    return (this.room = room);
  }

  /** The room's count changed: tell the lobby; nobody left (or coming back): stop, so the DO can go. */
  private occupancy(room: HomeRoom, n: number, ips: Record<string, number>) {
    this.tellLobby(n, ips);
    if (n > 0 || this.room !== room) return;
    this.room = null;
    room.stop();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private tellLobby(n: number, ips: Record<string, number>) {
    if (!this.roomId) return;
    this.env.HOME.getByName(lobbyName(this.env))
      .report(this.roomId, n, ips)
      .catch(() => {});
  }

  /** Every HEARTBEAT_MS while anyone is here: still here (to the lobby), and still the deployed version? */
  private async beat() {
    const room = this.room;
    if (room) this.tellLobby(room.occupancy(), room.peopleByIp());
    if (!this.env.SELF) return;
    let version: unknown;
    try {
      const res = await this.env.SELF.fetch(`https://home${HOME_VERSION_PATH}`);
      version = ((await res.json()) as { version?: unknown }).version;
    } catch {
      return;
    }
    if (typeof version !== "string" || version === deployedVersion(this.env)) return;
    // a newer version is out: send everyone here over to its rooms, and stop
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.room = null;
    if (!room) return;
    for (const c of [...room.clients]) c.sock.close(NEW_VERSION, "new version");
    room.stop();
  }

  /** For tests and monitoring. */
  stats(): { clients: number; strokes: number; botsRunning: boolean } {
    const r = this.room;
    return { clients: r?.clients.size ?? 0, strokes: r?.strokes.length ?? 0, botsRunning: r?.botsRunning ?? false };
  }
}
