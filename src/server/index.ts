import { join, resolve } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { config } from "./config.ts";
import { githubLoginEnabled, signInProblem } from "./auth.ts";
import { devLoginEnabled } from "./config.ts";
import { googleLoginEnabled } from "./google.ts";
import { McpServer } from "./mcp.ts";
import type { Ctx } from "./ops.ts";
import { RepoService } from "./repos.ts";
import { notePeer } from "./proxy.ts";
import { RoomManager, type Conn, type Participant, type Room } from "./rooms.ts";
import { bunDb } from "./bun/db-bun.ts";
import { repoCacheDb } from "./repo-cache.ts";
import { bunRoomStorage } from "./bun/room-storage-bun.ts";
import { LocalWorkspaceHost } from "./bun/workspace-host-local.ts";
import { isDemoRoom } from "./demo-rooms.ts";
import { BunDemoRooms } from "./bun/demo-rooms-bun.ts";
import { NoteStore } from "./notes/store.ts";
import { FsBlobs } from "./bun/blobs-fs.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { staticResponse } from "./assets.ts";
import { createApp, type Upgrader } from "./app.ts";
import { setWsProtocols } from "./api.ts";
import { CLOSE, DEAD_SOCKET_MS, type AdmittedSocket, type WorkspaceSocket } from "./wsmux.ts";
import type { WorkspaceRuntime } from "./workspace.ts";

const ROOT = resolve(import.meta.dir, "../..");
const MAX_BUFFERED = 8 * 1024 * 1024;

interface WsData {
  room?: Room;
  conn?: Conn;
  readOnly: boolean;
  participant?: Participant;
  reject?: { code: number; reason: string };
  /** a protocol v2 workspace socket (/ws?repo= without a path) */
  admitted?: AdmittedSocket;
  runtime?: WorkspaceRuntime;
  mux?: WorkspaceSocket;
}

/** Static files from the checkout: the app's HTML, versioned CSS/JS and dist/, gzip when the build wrote a .gz. */
async function staticAsset(req: Request, url: URL): Promise<Response> {
  return (await staticResponse(req, ROOT, url.pathname)) ?? new Response("Not found", { status: 404 });
}

export async function startServer(opts: { port?: number; quiet?: boolean } = {}) {
  const problem = signInProblem();
  if (problem) throw new Error(problem);
  // Workspace rows are cached only with REPO_CACHE=1 (repo-cache.ts); otherwise every read goes to the Db.
  const db = repoCacheDb(bunDb());
  // every workspace's notes in grimoire.sqlite; the demo's rooms each in an in-memory database (bun/demo-rooms-bun.ts)
  const storage = bunRoomStorage();
  const demo = new BunDemoRooms(db);
  const stores = new Map<string, NoteStore>();
  const storeFor = (repo: string) => {
    if (isDemoRoom(repo)) return demo.storeFor(repo);
    let s = stores.get(repo);
    if (!s) stores.set(repo, (s = new NoteStore(storage, repo)));
    return s;
  };
  const rooms = new RoomManager({ store: storeFor });
  const blobs = new FsBlobs(join(config.dataDir, "blobs"));
  const host = new LocalWorkspaceHost(rooms, (id) => (isDemoRoom(id) ? demo.blobsFor(id) : blobs));
  const repos = new RepoService(db, host);
  const ctx: Ctx = { repos };
  const mcpServer = new McpServer(ctx);

  await demo.start(host);
  host.startSweeps(storage, () => [...demo.stores.keys()]);
  // a nightly export of every workspace to $DATA_DIR/backups (docs/storage-v2.md §11)
  const backups = setInterval(() => void backupAll(), 24 * 60 * 60_000);
  async function backupAll() {
    const day = new Date().toISOString().slice(0, 10);
    for (const r of await repos.list().catch(() => [])) {
      if (isDemoRoom(r.id) || r.status !== "ready") continue;
      try {
        const dir = join(config.dataDir, "backups", r.id);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, `${day}.zip`), await host.get(r.id).exportZip(r));
      } catch (e) {
        console.error(`[backup] ${r.id}:`, e);
      }
    }
  }
  const app = createApp({ ctx, db, mcpServer, staticFile: staticAsset });
  // protocol v2 (one socket per workspace) next to v1 (one per note)
  setWsProtocols([1, 2]);

  /** Bun's side of the WebSocket upgrade: the admission decision becomes the socket's data. */
  function upgrader(server: Server<WsData>): Upgrader {
    return {
      note: (req, decision) => {
        const data: WsData = "reject" in decision ? { readOnly: true, reject: decision.reject } : { ...decision };
        return server.upgrade(req, { data });
      },
      workspace: (req, decision) => {
        const data: WsData = "reject" in decision ? { readOnly: true, reject: decision.reject } : { readOnly: decision.readOnly, admitted: decision };
        return server.upgrade(req, { data });
      },
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
      maxPayloadLength: 16 * 1024 * 1024,
      // v2 clients ping every 30 s: a socket silent this long is dead (Bun's own pings keep the others alive)
      idleTimeout: DEAD_SOCKET_MS / 1000,
      open(ws: ServerWebSocket<WsData>) {
        const d = ws.data;
        if (d.reject) return ws.close(d.reject.code, d.reject.reason);
        if (d.admitted) {
          demo.connected(d.admitted.repoId, d.admitted.participant.id, 1);
          const runtime = host.get(d.admitted.repoId);
          d.runtime = runtime;
          d.mux = runtime.attachSocket(d.admitted, {
            send(data) {
              if (ws.readyState !== 1) return;
              // A client that can't keep up gets disconnected; it reconnects and resyncs every channel.
              if (ws.getBufferedAmount() > MAX_BUFFERED) return ws.close(CLOSE.retry, "too slow");
              ws.send(data);
            },
            close(code, reason) {
              if (ws.readyState === 1 || ws.readyState === 0) ws.close(code, reason);
            },
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
        demo.connected(room.repo, conn.user.id, 1);
      },
      message(ws: ServerWebSocket<WsData>, msg) {
        if (ws.data.mux) return ws.data.mux.onMessage(typeof msg === "string" ? msg : new Uint8Array(msg));
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
        if (ws.data.mux) {
          demo.connected(ws.data.admitted!.repoId, ws.data.admitted!.participant.id, -1);
          return ws.data.runtime!.detachSocket(ws.data.mux);
        }
        const { room, conn } = ws.data;
        if (room && conn) {
          room.removeConn(conn);
          demo.connected(room.repo, conn.user.id, -1);
        }
      },
    },
  });

  if (!opts.quiet) {
    console.log(
      `grimoire listening on ${config.publicUrl} (port ${server.port}) · sign-in: ${config.signIn ? "on" : "off (no accounts: everyone can do everything)"} · Google: ${googleLoginEnabled() ? "on" : "off"} · GitHub login: ${githubLoginEnabled() ? "on" : "off"} · test sign-in (/auth/dev): ${devLoginEnabled() ? "on" : "off"}`,
    );
  }

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(backups);
    demo.stop();
    host.closeSockets(CLOSE.restart, "server restarting");
    server.stop(true);
    await host.flushAll();
  }

  return { server, ctx, demo, host, stop };
}

if (import.meta.main) {
  const problem = signInProblem();
  if (problem) {
    console.error(`grimoire: refusing to start: ${problem}`);
    process.exit(1);
  }
  const { stop } = await startServer();
  const shutdown = async (sig: string) => {
    console.log(`${sig}: saving open notes…`);
    await stop().catch((e) => console.error("shutdown:", e));
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
