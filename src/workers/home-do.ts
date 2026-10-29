// The home page doodle room (/ws/home) as a Durable Object: one HomeRoom (src/server/home.ts, unchanged) per DO.
// Its strokes and bots live only in memory and the bots tick with setInterval while anyone is connected, so the
// sockets use the standard accept() rather than hibernation (nothing to rebuild from). With no clients, HomeRoom
// stops its bots and no timers are left, so the DO goes idle and is evicted; the doodle starts fresh next time.
// Each deploy has its own room (the router names it after the deployed version), so new code takes effect for whoever
// comes next. The old room would carry on for the people still in it (a deploy restarts Durable Objects only
// eventually, which took up to half an hour), so while anyone is here it asks the Worker as now deployed which version
// that is, and when it's not its own, closes everyone's socket: they reconnect, to the new room.
import { DurableObject } from "cloudflare:workers";
import { HomeRoom } from "../server/home.ts";
import type { Env } from "./index.ts";

/** Header the Worker sets on the forwarded upgrade with the caller's IP (per-IP caps). */
export const HOME_IP_HEADER = "CF-Connecting-IP";
/** Where the Worker says which version is deployed ({version}). */
export const HOME_VERSION_PATH = "/api/home-version";
/** How often a room with people in it checks it's still the deployed version's. */
const VERSION_CHECK_MS = 15_000;
/** Close code for "a new version is out: come back" (the client reconnects after a second). */
const NEW_VERSION = 1012;

/** The version of the code running here (without the binding, as in tests: "dev"). */
export const deployedVersion = (env: Env): string => env.CF_VERSION_METADATA?.id ?? "dev";

export class HomeDO extends DurableObject<Env> {
  private room: HomeRoom | null = null;
  private versionTimer: ReturnType<typeof setInterval> | null = null;

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket upgrade", { status: 426 });
    const ip = req.headers.get(HOME_IP_HEADER) ?? "";
    const pair = new WebSocketPair();
    const [client, ws] = [pair[0], pair[1]];
    // binary frames arrive as ArrayBuffer (not Blob), so HomeRoom rejects them without reading them
    ws.binaryType = "arraybuffer";
    ws.accept();
    const open = () => ws.readyState === WebSocket.OPEN;
    const conn = this.home().join(ip, {
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
    });
    if (conn) {
      const room = this.room!;
      ws.addEventListener("message", (e) => room.message(conn, e.data));
      const gone = () => {
        room.leave(conn);
        try {
          ws.close(1000, "bye");
        } catch {}
        // (nobody left: no timers, so the DO can go)
        if (!room.clients.size && this.versionTimer) {
          clearInterval(this.versionTimer);
          this.versionTimer = null;
        }
      };
      ws.addEventListener("close", gone);
      ws.addEventListener("error", gone);
    }
    if (conn && this.env.SELF && !this.versionTimer) this.versionTimer = setInterval(() => void this.checkVersion(), VERSION_CHECK_MS);
    // Rejected joins were already closed with their code (upgrade-then-close), as on Bun.
    return new Response(null, { status: 101, webSocket: client });
  }

  private home(): HomeRoom {
    return (this.room ??= new HomeRoom());
  }

  /** A newer version is deployed: send everyone here over to its room, and stop. */
  private async checkVersion() {
    let version: unknown;
    try {
      const res = await this.env.SELF!.fetch(`https://home${HOME_VERSION_PATH}`);
      version = ((await res.json()) as { version?: unknown }).version;
    } catch {
      return;
    }
    if (typeof version !== "string" || version === deployedVersion(this.env)) return;
    if (this.versionTimer) clearInterval(this.versionTimer);
    this.versionTimer = null;
    const room = this.room;
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
