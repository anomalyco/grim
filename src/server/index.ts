import { join, normalize, resolve } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { config } from "./config.ts";
import { csrfOk, handleApi, handleShell, handleWebhook, json } from "./api.ts";
import { agentFromRequest, githubLoginEnabled, handleAuthRoute, participantForAgent, participantForUser, repoAccess, sameOrigin, userFromRequest } from "./auth.ts";
import { McpServer } from "./mcp.ts";
import type { Ctx } from "./ops.ts";
import { cleanPath, getRepo, RepoService } from "./repos.ts";
import { NotFoundError, RoomManager, type Conn, type Participant, type Room } from "./rooms.ts";
import type { AccessFn } from "./shell/fs.ts";
import { ShellSessions } from "./shell/session.ts";
import { CodeStorageStore } from "./store/codestorage.ts";
import { LocalGitStore } from "./store/localgit.ts";
import type { GitStore } from "./store/types.ts";

const ROOT = resolve(import.meta.dir, "../..");
const MAX_BUFFERED = 8 * 1024 * 1024;

interface WsData {
  room?: Room;
  conn?: Conn;
  readOnly: boolean;
  participant?: ReturnType<typeof participantForUser>;
  reject?: { code: number; reason: string };
}

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-cache",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
};

async function staticFile(path: string, headers: Record<string, string> = {}): Promise<Response> {
  const file = Bun.file(path);
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  return new Response(file, { headers: { "x-content-type-options": "nosniff", "cache-control": "no-cache", ...headers } });
}

export async function startServer(opts: { port?: number; quiet?: boolean } = {}) {
  const store: GitStore =
    config.storage === "codestorage"
      ? new CodeStorageStore({
          org: config.codeStorage.org,
          key: config.codeStorage.key,
          apiBaseUrl: config.codeStorage.apiBaseUrl,
          storageBaseUrl: config.codeStorage.storageBaseUrl,
        })
      : new LocalGitStore(join(config.dataDir, "git"));
  const rooms = new RoomManager(store);
  const repos = new RepoService(store, rooms);
  const ctx: Ctx = { store, rooms, repos };
  const shells = new ShellSessions(ctx);
  const mcpServer = new McpServer(shells);

  await repos.ensureNotesRepo();
  await rooms.recover((id) => getRepo(id)?.branch);
  const stopPolling = repos.startPolling();

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
        if (p === "/api/shell") return await shell(req);
        if (p.startsWith("/api/")) return await handleApi(req, url, ctx, userFromRequest(req));
        if (p.startsWith("/auth/")) return (await handleAuthRoute(req, url)) ?? new Response("Not found", { status: 404 });
        if (p === "/webhooks/codestorage") return await handleWebhook(req, ctx);
        if (p === "/mcp") return await mcp(req);
        if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
        if (p === "/" || p.startsWith("/r/") || p === "/start") return await staticFile(join(ROOT, "src/client/index.html"), HTML_HEADERS);
        if (p === "/app.css") return await staticFile(join(ROOT, "src/client/app.css"));
        if (p === "/editor.css") return await staticFile(join(ROOT, "src/client/editor/editor.css"));
        if (p.startsWith("/dist/")) {
          const dist = join(ROOT, "dist");
          const file = normalize(join(dist, decodeURIComponent(p.slice("/dist/".length))));
          if (!file.startsWith(dist + "/")) return new Response("Not found", { status: 404 });
          return await staticFile(file, file.startsWith(join(dist, "fonts") + "/") ? { "cache-control": "public, max-age=31536000, immutable" } : {});
        }
        return new Response("Not found", { status: 404 });
      } catch (e) {
        console.error(`[http] ${req.method} ${p}:`, e);
        return new Response("Internal error", { status: 500 });
      }
    },
    websocket: {
      maxPayloadLength: 16 * 1024 * 1024,
      open(ws: ServerWebSocket<WsData>) {
        const d = ws.data;
        if (d.reject) return ws.close(d.reject.code, d.reject.reason);
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
        const { room, conn } = ws.data;
        if (room && conn) room.removeConn(conn);
      },
    },
  });

  /** Agents (bearer token) or signed-in people (cookie, with the same CSRF rule as /api). */
  function caller(req: Request): { actor: Participant; access: AccessFn } | "unauthorized" | "cross-origin" {
    const agent = agentFromRequest(req);
    if (agent) return { actor: participantForAgent(agent), access: async (repo) => (repo.read_only ? "read" : "write") };
    const user = userFromRequest(req);
    if (!user) return "unauthorized";
    if (!csrfOk(req)) return "cross-origin";
    return { actor: participantForUser(user), access: (repo) => repoAccess(user, repo) };
  }

  const UNAUTHORIZED = "unauthorized: send Authorization: Bearer grim_...";
  const WWW_AUTH = { "www-authenticate": 'Bearer realm="grimoire"' };

  async function mcp(req: Request): Promise<Response> {
    const c = caller(req);
    if (c === "cross-origin") return json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "cross-origin request refused" } }, 403);
    if (c === "unauthorized") return json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: UNAUTHORIZED } }, 401, WWW_AUTH);
    return mcpServer.handle(req, c.actor, c.access);
  }

  async function shell(req: Request): Promise<Response> {
    const c = caller(req);
    if (c === "cross-origin") return json({ error: "cross-origin request refused" }, 403);
    if (c === "unauthorized") return json({ error: UNAUTHORIZED }, 401, WWW_AUTH);
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
    shells.stop();
    server.stop(true);
    await rooms.flushAll();
  }

  return { server, ctx, shells, stop };
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
