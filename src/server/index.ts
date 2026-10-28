import { join, normalize, resolve } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { config } from "./config.ts";
import { csrfOk, handleApi, handleShell, handleWebhook, json } from "./api.ts";
import { authenticate, bearerToken, githubLoginEnabled, handleAuthRoute, participantForUser, repoAccess, sameOrigin, userFromRequest } from "./auth.ts";
import { assertTestStorage, devLoginEnabled } from "./config.ts";
import { googleLoginEnabled } from "./google.ts";
import { handleConnect } from "./tokens.ts";
import { recordJoin } from "./workspaces.ts";
import { guestFromQuery } from "./anon.ts";
import { githubGitUrl } from "./github.ts";
import { McpServer } from "./mcp.ts";
import type { Ctx } from "./ops.ts";
import { cleanPath, getRepo, RepoService } from "./repos.ts";
import { HomeRoom, type HomeClient } from "./home.ts";
import { clientIp, notePeer } from "./proxy.ts";
import { handleShareLink, onShareClosed, shareActorId } from "./shares.ts";
import { NotFoundError, RoomManager, type Conn, type Participant, type Room } from "./rooms.ts";
import type { AccessFn } from "./shell/fs.ts";
import { ShellSessions } from "./shell/session.ts";
import { CodeStorageStore } from "./store/codestorage.ts";
import { LocalGitStore } from "./store/localgit.ts";
import { RoutedStore } from "./store/routed.ts";
import { DEMO_ID, newDemoStore, seedDemo, startDemoResets } from "./demo.ts";
import { FileTooLargeError, StoreUnavailableError, type GitStore } from "./store/types.ts";
import { IMMUTABLE, immutableDist, indexHtml, VERSIONED, versionedCache } from "./assets.ts";

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
  // the demo folder lives in memory; every other folder in the configured store
  const store = new RoutedStore(base, new Map([[DEMO_ID, newDemoStore()]]));
  const rooms = new RoomManager(store, { ephemeral: (repo) => repo === DEMO_ID });
  const repos = new RepoService(store, rooms);
  const ctx: Ctx = { store, rooms, repos };
  const shells = new ShellSessions(ctx);
  const mcpServer = new McpServer(shells);
  const offShareClosed = onShareClosed((id) => shells.closeActor(shareActorId(id)));

  repos.enforceGitHubReadOnly();
  if (config.notesRepo === DEMO_ID) throw new Error(`NOTES_REPO can't be "${DEMO_ID}": that id is the demo folder's`);
  await repos.ensureNotesRepo();
  await seedDemo(ctx);
  const stopDemo = startDemoResets(ctx);
  await rooms.recover((id) => getRepo(id)?.branch);
  const stopPolling = repos.startPolling();
  const home = new HomeRoom(opts.home);

  async function wsUpgrade(req: Request, url: URL, server: Server<WsData>): Promise<Response | undefined> {
    const data: WsData = { readOnly: true };
    // Browsers use the session cookie (same origin only); apps an app token (Authorization header or ?token=).
    // Browsers that aren't signed in join as anonymous visitors with the name they send (`anon`, `name`, `color`).
    const queryToken = url.searchParams.get("token");
    const auth = authenticate(req, queryToken);
    const withToken = !!queryToken || !!bearerToken(req);
    const user = auth?.user ?? null;
    const guest = !user && !withToken && url.searchParams.has("anon") ? guestFromQuery(url.searchParams) : null;
    const repo = getRepo(url.searchParams.get("repo") ?? "");
    const path = cleanPath(url.searchParams.get("path") ?? "");
    if (!withToken && !sameOrigin(req)) data.reject = { code: 4403, reason: "cross-origin" };
    else if (!user && !guest) data.reject = { code: 4401, reason: "unauthorized" };
    else if (!repo || !path) data.reject = { code: 4404, reason: "not found" };
    else if (repo.status !== "ready") data.reject = { code: 1013, reason: `repo ${repo.status}` };
    else {
      if (user) {
        recordJoin(user.id, repo.id);
        data.participant = participantForUser(user);
      } else {
        data.participant = guest!;
      }
      data.readOnly = repoAccess(repo) === "read";
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
      notePeer(req, server.requestIP(req)?.address);
      const url = new URL(req.url);
      const p = url.pathname;
      try {
        if (p === "/ws") return await wsUpgrade(req, url, server);
        if (p === "/ws/home") {
          const data: WsData = { readOnly: true, homeIp: clientIp(req) };
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
        if (p === "/connect") return await handleConnect(req, url);
        if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
        // Old note links (/r/<notebook>/<path>) moved under /app.
        if (p === "/r" || p.startsWith("/r/")) return new Response(null, { status: 308, headers: { location: "/app" + p.slice(2) + url.search } });
        if (p === "/" || p === "/app" || p.startsWith("/app/") || p === "/start" || p === "/scratch") return new Response(await indexHtml(ROOT), { headers: HTML_HEADERS });
        // app.css, editor.css, dist/main.js: linked with ?v=<content hash>, cached forever under that URL
        if (VERSIONED[p]) return await staticFile(join(ROOT, VERSIONED[p]), { "cache-control": await versionedCache(ROOT, p, url) });
        if (p.startsWith("/dist/")) {
          const dist = join(ROOT, "dist");
          const file = normalize(join(dist, decodeURIComponent(p.slice("/dist/".length))));
          if (!file.startsWith(dist + "/")) return new Response("Not found", { status: 404 });
          // fonts, the content-hashed wasm (the engine in dist/editor-rs/<hash>/, the code highlighter in
          // dist/highlights/<hash>/, with build-time .gz copies) and Bun's hashed chunks never change
          const immutable = immutableDist(p);
          const headers: Record<string, string> = immutable ? { "cache-control": IMMUTABLE } : {};
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

  /** Signed-in people (cookie, with the same CSRF rule as /api). Agents use share links (/a/<id>) instead. */
  function caller(req: Request): { actor: Participant; access: AccessFn } | "unauthorized" | "cross-origin" {
    const user = userFromRequest(req);
    if (!user) return "unauthorized";
    if (!csrfOk(req)) return "cross-origin";
    return { actor: participantForUser(user), access: async (repo) => repoAccess(repo) };
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
