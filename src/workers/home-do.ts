// The home page doodle room (/ws/home) as a Durable Object: one HomeRoom (src/server/home.ts, unchanged) per DO.
// Its strokes and bots live only in memory and the bots tick with setInterval while anyone is connected, so the
// sockets use the standard accept() rather than hibernation (nothing to rebuild from). With no clients, HomeRoom
// stops its bots and no timers are left, so the DO goes idle and is evicted; the doodle starts fresh next time.
import { DurableObject } from "cloudflare:workers";
import { HomeRoom } from "../server/home.ts";
import type { Env } from "./index.ts";

/** Header the Worker sets on the forwarded upgrade with the caller's IP (per-IP caps). */
export const HOME_IP_HEADER = "CF-Connecting-IP";

export class HomeDO extends DurableObject<Env> {
  private room: HomeRoom | null = null;

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
      };
      ws.addEventListener("close", gone);
      ws.addEventListener("error", gone);
    }
    // Rejected joins were already closed with their code (upgrade-then-close), as on Bun.
    return new Response(null, { status: 101, webSocket: client });
  }

  private home(): HomeRoom {
    return (this.room ??= new HomeRoom());
  }

  /** For tests and monitoring. */
  stats(): { clients: number; strokes: number; botsRunning: boolean } {
    const r = this.room;
    return { clients: r?.clients.size ?? 0, strokes: r?.strokes.length ?? 0, botsRunning: r?.botsRunning ?? false };
  }
}
