import { join, normalize, resolve } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { config } from "./config.ts";
import { csrfOk, handleApi, handleShell, handleWebhook, json } from "./api.ts";
import { githubLoginEnabled, handleAuthRoute, participantForUser, repoAccess, sameOrigin, userFromRequest } from "./auth.ts";
import { githubGitUrl } from "./github.ts";
import { McpServer } from "./mcp.ts";
import type { Ctx } from "./ops.ts";
import { cleanPath, getRepo, RepoService } from "./repos.ts";
import { HomeRoom, type HomeClient } from "./home.ts";
import { handleShareLink, onShareClosed, shareActorId } from "./shares.ts";
import { NotFoundError, RoomManager, type Conn, type Participant, type Room } from "./rooms.ts";
import type { AccessFn } from "./shell/fs.ts";
import { ShellSessions } from "./shell/session.ts";
import { CodeStorageStore } from "./store/codestorage.ts";
import { LocalGitStore } from "./store/localgit.ts";
import { FileTooLargeError, StoreUnavailableError, type GitStore } from "./store/types.ts";

const ROOT = resolve(import.meta.dir, "../..");
const MAX_BUFFERED = 8 * 1024 * 1024;

interface WsData {
  room?: Room;
  conn?: Conn;
  readOnly: boolean;
  participant?: ReturnType<typeof participantForUser>;
  reject?: { code: number; reason: string };
  /** a home page doodle connection (/ws/home) */
  homeIp?: string;
  home?: HomeClient | null;
}

const PRIVATE_IP = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|::ffff:127\.|fc|fd|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/i;

/** The caller's IP: the socket peer, or the proxy's X-Forwarded-For entry when the peer is a local/private proxy. */
function clientIp(req: Request, server: Server<WsData>): string {
  const peer = server.requestIP(req)?.address ?? "unknown";
  if (!PRIVATE_IP.test(peer)) return peer;
  const fwd = req.headers.get("x-forwarded-for")?.split(",").map((s) => s.trim()).filter(Boolean);
  return fwd?.length ? fwd[fwd.length - 1]! : peer;
}

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-cache",
  "content-security-policy":
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
};

async function staticFile(path: string, headers: Record<string, string> = {}): Promise<Response> {
  const file = Bun.file(path);
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  return new Response(file, { headers: { "x-content-type-options": "nosniff", "cache-control": "no-cache", ...headers } });
}

export async function startServer(opts: { port?: number; quiet?: boolean; home?: ConstructorParameters<typeof HomeRoom>[0] } = {}) {
  const store: GitStore =
    config.storage === "codestorage"
      ? new CodeStorageStore({
          org: config.codeStorage.org,
          key: config.codeStorage.key,
          apiBaseUrl: config.codeStorage.apiBaseUrl,
          storageBaseUrl: config.codeStorage.storageBaseUrl,
        })
      : new LocalGitStore(join(config.dataDir, "git"), githubGitUrl);
  const rooms = new RoomManager(store);
  const repos = new RepoService(store, rooms);
  const ctx: Ctx = { store, rooms, repos };
  const shells = new ShellSessions(ctx);
  const mcpServer = new McpServer(shells);
  const offShareClosed = onShareClosed((id) => shells.closeActor(shareActorId(id)));

  repos.enforceGitHubReadOnly();
  await repos.ensureNotesRepo();
  await rooms.recover((id) => getRepo(id)?.branch);
  const stopPolling = repos.startPolling();
  const home = new HomeRoom(opts.home);

  async function wsUpgrade(req: Request, url: URL, server: Server<WsData>): Promise<Response | undefined> {
    const data: WsData = { readOnly: true };
    const user = userFromRequest(req);
    const repo = getRepo(url.searchParams.get("repo") ?? "");
    const path = cleanPath(url.searchParams.get("path") ?? "");
    if (!sameOrigin(req)) data.reject = { code: 4403, reason: "cross-origin" };
    else if (!user) data.reject = { code: 4401, reason: "unauthorized" };
    else if (!repo || !path) data.reject = { code: 4404, reason: "not found" };
    else if (repo.status !== "ready") data.reject = { code: 1013, reason: `repo ${repo.status}` };
    else {
      const access = await repoAccess(user, repo);
      if (access === "none") data.reject = { code: 4403, reason: "no access" };
      else {
        data.participant = participantForUser(user);
        data.readOnly = access === "read" || !!repo.read_only;
        try {
          data.room = await rooms.get(repo.id, path, repo.branch);
        } catch (e) {
          if (e instanceof NotFoundError) data.reject = { code: 4404, reason: "file not found" };
          else if (e instanceof FileTooLargeError) data.reject = { code: 4413, reason: "file too large" };
          // Transient (e.g. GitHub unreachable): the client retries.
          else if (e instanceof StoreUnavailableError) data.reject = { code: 1013, reason: "try again later" };
          else {
            console.error(`[ws] open ${repo.id}:${path}:`, e);
            data.reject = { code: 1011, reason: "could not open file" };
          }
        }
      }
    }
    // Upgrade even when rejecting, so the browser sees the close code.
    if (server.upgrade(req, { data })) return undefined;
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }

  const server = Bun.serve<WsData>({
    port: opts.port ?? config.port,
    // HOST pins the listener to one interface (e.g. a Tailscale address); default is all interfaces.
    hostname: process.env.HOST || undefined,
    idleTimeout: 120,
    maxRequestBodySize: 16 * 1024 * 1024,
    async fetch(req, server) {
      const url = new URL(req.url);
      const p = url.pathname;
      try {
        if (p === "/ws") return await wsUpgrade(req, url, server);
        if (p === "/ws/home") {
          const data: WsData = { readOnly: true, homeIp: clientIp(req, server) };
          if (!sameOrigin(req)) data.reject = { code: 4403, reason: "cross-origin" };
          if (server.upgrade(req, { data })) return undefined;
          return new Response("Expected a WebSocket upgrade", { status: 426 });
        }
        if (p === "/api/shell") return await shell(req);
        if (p.startsWith("/api/")) return await handleApi(req, url, ctx, userFromRequest(req));
        if (p.startsWith("/auth/")) return (await handleAuthRoute(req, url)) ?? new Response("Not found", { status: 404 });
        if (p === "/webhooks/codestorage") return await handleWebhook(req, ctx);
        if (p === "/mcp") return await mcp(req);
        if (p.startsWith("/a/")) return await handleShareLink(req, url, ctx, shells);
        if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
        if (p === "/" || p.startsWith("/r/") || p === "/start") return await staticFile(join(ROOT, "src/client/index.html"), HTML_HEADERS);
        if (p === "/app.css") return await staticFile(join(ROOT, "src/client/app.css"));
        if (p === "/editor.css") return await staticFile(join(ROOT, "src/client/editor/editor.css"));
        if (p.startsWith("/dist/")) {
          const dist = join(ROOT, "dist");
          const file = normalize(join(dist, decodeURIComponent(p.slice("/dist/".length))));
          if (!file.startsWith(dist + "/")) return new Response("Not found", { status: 404 });
          // fonts and the content-hashed wasm engine (dist/editor-rs/<hash>/, with build-time .gz copies) never change
          const immutable = file.startsWith(join(dist, "fonts") + "/") || /^\/dist\/editor-rs\/[0-9a-f]{16}\//.test(p);
          const headers: Record<string, string> = immutable ? { "cache-control": "public, max-age=31536000, immutable" } : {};
          if (immutable && /\bgzip\b/.test(req.headers.get("accept-encoding") ?? "") && (await Bun.file(file + ".gz").exists()))
            return await staticFile(file + ".gz", { ...headers, "content-encoding": "gzip", "content-type": Bun.file(file).type, vary: "accept-encoding" });
          return await staticFile(file, headers);
        }
        return new Response("Not found", { status: 404 });
      } catch (e) {
        // Share link URLs are secrets: keep them out of logs.
        console.error(`[http] ${req.method} ${p.replace(/^\/a\/[^/]+/, "/a/<redacted>")}:`, e);
        return new Response("Internal error", { status: 500 });
      }
    },
    websocket: {
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
        if (ws.data.home) return home.message(ws.data.home, typeof msg === "string" ? msg : new Uint8Array(msg));
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

  /** Signed-in people (cookie, with the same CSRF rule as /api). Agents use share links (/a/<id>) instead. */
  function caller(req: Request): { actor: Participant; access: AccessFn } | "unauthorized" | "cross-origin" {
    const user = userFromRequest(req);
    if (!user) return "unauthorized";
    if (!csrfOk(req)) return "cross-origin";
    return { actor: participantForUser(user), access: (repo) => repoAccess(user, repo) };
  }

  const UNAUTHORIZED = "not signed in; agents connect through a notebook's \"Share with agent\" link";

  async function mcp(req: Request): Promise<Response> {
    const c = caller(req);
    if (c === "cross-origin") return json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "cross-origin request refused" } }, 403);
    if (c === "unauthorized") return json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: UNAUTHORIZED } }, 401);
    return mcpServer.handle(req, c.actor, c.access);
  }

  async function shell(req: Request): Promise<Response> {
    const c = caller(req);
    if (c === "cross-origin") return json({ error: "cross-origin request refused" }, 403);
    if (c === "unauthorized") return json({ error: UNAUTHORIZED }, 401);
    return handleShell(req, shells, c.actor, c.access);
  }

  if (!opts.quiet) {
    console.log(
      `grimoire listening on ${config.publicUrl} (port ${server.port}) · storage: ${store.kind} · GitHub login: ${githubLoginEnabled() ? "on" : "off"} · dev login: ${config.allowDevLogin ? "on" : "off"}`,
    );
  }

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    stopPolling();
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
