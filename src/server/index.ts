import { join, resolve } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { config } from "./config.ts";
import { githubLoginEnabled } from "./auth.ts";
import { assertTestStorage, devLoginEnabled } from "./config.ts";
import { googleLoginEnabled } from "./google.ts";
import { githubGitUrl } from "./github.ts";
import { McpServer } from "./mcp.ts";
import type { Ctx } from "./ops.ts";
import { RepoService } from "./repos.ts";
import { HomeRoom, type HomeClient } from "./home.ts";
import { notePeer } from "./proxy.ts";
import { onShareClosed, shareActorId } from "./shares.ts";
import { RoomManager, type Conn, type Participant, type Room } from "./rooms.ts";
import { ShellSessions } from "./shell/session.ts";
import { CodeStorageStore } from "./store/codestorage.ts";
import { LocalGitStore } from "./store/localgit.ts";
import { RoutedStore } from "./store/routed.ts";
import { CachedHeadStore } from "./store/cached-head.ts";
import { bunDb } from "./bun/db-bun.ts";
import { bunRoomStorage } from "./bun/room-storage-bun.ts";
import { DEMO_ID, newDemoStore, seedDemo, startDemoResets } from "./demo.ts";
import type { GitStore } from "./store/types.ts";
import { staticResponse } from "./assets.ts";
import { createApp, type Upgrader } from "./app.ts";

const ROOT = resolve(import.meta.dir, "../..");
const MAX_BUFFERED = 8 * 1024 * 1024;

interface WsData {
  room?: Room;
  conn?: Conn;
  readOnly: boolean;
  participant?: Participant;
  reject?: { code: number; reason: string };
  /** a home page doodle connection (/ws/home) */
  homeIp?: string;
  home?: HomeClient | null;
}

/** Static files from the checkout: the app's HTML, versioned CSS/JS and dist/, gzip when the build wrote a .gz. */
async function staticAsset(req: Request, url: URL): Promise<Response> {
  return (await staticResponse(req, ROOT, url.pathname)) ?? new Response("Not found", { status: 404 });
}

export async function startServer(opts: { port?: number; quiet?: boolean; home?: ConstructorParameters<typeof HomeRoom>[0] } = {}) {
  assertTestStorage();
  const base: GitStore =
    config.storage === "codestorage"
      ? new CodeStorageStore({
          org: config.codeStorage.org,
          key: config.codeStorage.key,
          apiBaseUrl: config.codeStorage.apiBaseUrl,
          storageBaseUrl: config.codeStorage.storageBaseUrl,
        })
      : new LocalGitStore(join(config.dataDir, "git"), githubGitUrl);
  // the demo folder lives in memory; every other folder in the configured store. Branch heads are cached in front
  // of both (everything reads and commits through this one store; webhooks invalidate it, pollers read fresh).
  const store = new CachedHeadStore(new RoutedStore(base, new Map([[DEMO_ID, newDemoStore()]])));
  const db = bunDb();
  const rooms = new RoomManager(store, { ephemeral: (repo) => repo === DEMO_ID, storage: bunRoomStorage() });
  const repos = new RepoService(store, rooms, db);
  const ctx: Ctx = { store, rooms, repos };
  const shells = new ShellSessions(ctx);
  const mcpServer = new McpServer(shells);
  const offShareClosed = onShareClosed((id) => shells.closeActor(shareActorId(id)));

  await repos.enforceGitHubReadOnly();
  if (config.notesRepo === DEMO_ID) throw new Error(`NOTES_REPO can't be "${DEMO_ID}": that id is the demo workspace's`);
  await repos.ensureNotesRepo();
  await seedDemo(ctx);
  const stopDemo = startDemoResets(ctx);
  const branches = new Map((await repos.list()).map((r) => [r.id, r.branch]));
  await rooms.recover((id) => branches.get(id));
  const stopPolling = repos.startPolling();
  const home = new HomeRoom(opts.home);

  const app = createApp({ ctx, db, shells, mcpServer, staticFile: staticAsset });

  /** Bun's side of the WebSocket upgrade: the admission decision becomes the socket's data. */
  function upgrader(server: Server<WsData>): Upgrader {
    return {
      note: (req, decision) => {
        const data: WsData = "reject" in decision ? { readOnly: true, reject: decision.reject } : { ...decision };
        return server.upgrade(req, { data });
      },
      home: (req, ip, reject) => server.upgrade(req, { data: { readOnly: true, homeIp: ip, reject } }),
    };
  }

  const server = Bun.serve<WsData>({
    port: opts.port ?? config.port,
    // HOST pins the listener to one interface (e.g. a Tailscale address); default is all interfaces.
    hostname: process.env.HOST || undefined,
    idleTimeout: 120,
    maxRequestBodySize: 16 * 1024 * 1024,
    async fetch(req, server) {
      notePeer(req, server.requestIP(req)?.address);
      return app.fetch(req, upgrader(server));
    },
    websocket: {
      // Per server, not per route (Bun has no per-route limit): /ws/home checks type and size before anything else.
      maxPayloadLength: 16 * 1024 * 1024,
      open(ws: ServerWebSocket<WsData>) {
        const d = ws.data;
        if (d.reject) return ws.close(d.reject.code, d.reject.reason);
        if (d.homeIp) {
          d.home = home.join(d.homeIp, {
            send: (m) => ws.readyState === 1 && ws.send(m),
            close: (code, reason) => (ws.readyState === 1 || ws.readyState === 0) && ws.close(code, reason),
            buffered: () => ws.getBufferedAmount(),
          });
          return;
        }
        const room = d.room!;
        // The room closed between upgrade and open: let the client retry (it reopens a fresh room).
        if (room.closed) return ws.close(1013, "room closed, retry");
        const conn: Conn = {
          user: d.participant!,
          readOnly: d.readOnly,
          awarenessIds: new Set(),
          send(msg) {
            if (ws.readyState !== 1) return;
            // A client that can't keep up gets disconnected; it resyncs on reconnect.
            if (ws.getBufferedAmount() > MAX_BUFFERED) {
              room.removeConn(conn);
              return ws.close(1013, "too slow");
            }
            ws.send(msg);
          },
          close(code, reason) {
            if (ws.readyState === 1 || ws.readyState === 0) ws.close(code, reason);
          },
        };
        d.conn = conn;
        room.addConn(conn);
      },
      message(ws: ServerWebSocket<WsData>, msg) {
        if (ws.data.homeIp) return void (ws.data.home && home.message(ws.data.home, msg));
        const { room, conn } = ws.data;
        if (!room || !conn || room.closed) return;
        if (typeof msg === "string") return;
        try {
          room.onMessage(conn, new Uint8Array(msg));
        } catch (e) {
          console.error(`[ws] ${room.key}: bad message:`, e);
        }
      },
      close(ws: ServerWebSocket<WsData>) {
        if (ws.data.home) return home.leave(ws.data.home);
        const { room, conn } = ws.data;
        if (room && conn) room.removeConn(conn);
      },
    },
  });

  if (!opts.quiet) {
    console.log(
      `grimoire listening on ${config.publicUrl} (port ${server.port}) · storage: ${store.kind} · Google: ${googleLoginEnabled() ? "on" : "off"} · GitHub login: ${githubLoginEnabled() ? "on" : "off"} · dev login: ${devLoginEnabled() ? "on" : "off"}`,
    );
  }

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    stopPolling();
    stopDemo();
    offShareClosed();
    shells.stop();
    home.stop();
    server.stop(true);
    await rooms.flushAll();
  }

  return { server, ctx, shells, home, stop };
}

if (import.meta.main) {
  const { stop } = await startServer();
  const shutdown = async (sig: string) => {
    console.log(`${sig}: saving open files…`);
    await stop().catch((e) => console.error("shutdown:", e));
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
