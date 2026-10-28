// The Worker's request router: what runs in the stateless Worker before (or instead of) a Durable Object.
//
// - Everything the shared app handles (/api/*, /auth/*, /connect, /webhooks/*) goes through createApp with Workers
//   deps: a D1 `Db` per request, the caller's IP from CF-Connecting-IP, `caches.default` for immutable raw images.
// - /ws: auth, cross-origin and workspace checks run here (admitWorkspace); a rejection is an upgrade-then-close
//   with the code, an accepted upgrade is forwarded to the workspace's Durable Object with the admission data.
// - /api/events → HubDO, /ws/home → HomeDO.
// - Share links (/a/<id>), /api/shell and /mcp run in the actor's ShellDO: the Worker checks that the link exists (or
//   who the signed-in caller is) and forwards; a revoked link's ShellDO is told to close its sessions.
// Static files never reach the Worker except through the run_worker_first paths (wrangler.jsonc).
import { AsyncLocalStorage } from "node:async_hooks";
import { admitWorkspace, createApp, type Upgrader, type WorkspaceAdmission } from "../server/app.ts";
import { sameOrigin } from "../server/auth.ts";
import { config } from "../server/config.ts";
import { bus } from "../server/events.ts";
import type { McpServer } from "../server/mcp.ts";
import type { Ctx } from "../server/ops.ts";
import { clientIp, notePeer } from "../server/proxy.ts";
import { RepoService, type ImportScheduler } from "../server/repos.ts";
import { RoomManager } from "../server/rooms.ts";
import type { Db } from "../server/seams/db.ts";
import type { AppEvent } from "../server/seams/events.ts";
import type { RoomStorage } from "../server/seams/room-storage.ts";
import type { WorkspaceApi, WorkspaceHost } from "../server/seams/workspace-host.ts";
import type { ShellSessions } from "../server/shell/session.ts";
import { CachedHeadStore } from "../server/store/cached-head.ts";
import { CodeStorageStore } from "../server/store/codestorage.ts";
import { MemoryStore } from "../server/store/memory.ts";
import type { GitStore } from "../server/store/types.ts";
import { d1Db } from "./db-d1.ts";
import { repoCacheDb } from "../server/repo-cache.ts";
import { HOME_IP_HEADER } from "./home-do.ts";
import { getShare, onShareClosed, shareActorId } from "../server/shares.ts";
import { SHELL_CALLER_HEADER, userShellName, type ShellCaller } from "./shell-do.ts";
import type { Env } from "./index.ts";

/**
 * Header on the upgrade the Worker forwards to WorkspaceDO: the accepted admission (`Admission`) as
 * encodeURIComponent(JSON). The Worker always overwrites it, and Durable Objects are reachable only through the
 * Worker, so the DO can trust it. Read it with `readAdmission(req)`.
 */
export const ADMISSION_HEADER = "X-Grim-Admission";

/** What the Worker decided about a /ws upgrade it forwards: plain data (no Room, no Repo). */
export type Admission = Exclude<WorkspaceAdmission, { reject: unknown }>;

export function readAdmission(req: Request): Admission | null {
  const v = req.headers.get(ADMISSION_HEADER);
  if (!v) return null;
  try {
    return JSON.parse(decodeURIComponent(v)) as Admission;
  } catch {
    return null;
  }
}

/** Raw images by commit (`?ref=<sha>`) never change: kept in the colo's cache this long. */
const RAW_CACHE_SECONDS = 86_400;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const RAW_PATH = /^\/api\/repos\/[^/]+\/raw$/;

/** Durable Objects first created by server code are placed in eastern North America, near D1's primary and Code Storage. */
export const LOCATION = { locationHint: "enam" } as const;

interface Scope {
  db: Db;
  waitUntil(p: Promise<unknown>): void;
}

const scope = new AsyncLocalStorage<Scope>();

/** Whether the code running now handles a Worker request (its emits are forwarded to HubDO by the router). */
export function inRequestScope(): boolean {
  return scope.getStore() !== undefined;
}

function current(): Scope {
  const s = scope.getStore();
  if (!s) throw new Error("no request scope (D1 is only reachable inside a request)");
  return s;
}

/** The `Db` the shared app holds for the isolate's lifetime; each call goes to the current request's D1 session. */
const requestDb: Db = repoCacheDb({
  get: (sql, ...params) => current().db.get(sql, ...params),
  all: (sql, ...params) => current().db.all(sql, ...params),
  run: (sql, ...params) => current().db.run(sql, ...params),
  batch: (stmts) => current().db.batch(stmts),
});

/** Rooms live in WorkspaceDO (CF-24); a room opened in the Worker itself has nowhere to keep its crash log. */
const noRoomStorage: RoomStorage = {
  exec() {
    throw new Error("rooms are not hosted in the Worker");
  },
  transaction() {
    throw new Error("rooms are not hosted in the Worker");
  },
  putBlob() {
    throw new Error("rooms are not hosted in the Worker");
  },
  getBlob() {
    return null;
  },
};

export interface RouterOptions {
  /** The Git store; default Code Storage when configured, else an in-memory store (wrangler dev without secrets). */
  store?: () => GitStore;
}

type App = ReturnType<typeof createApp>;

let sharedStore: GitStore | null = null;

/**
 * The isolate's Git store, shared by the Worker and the Durable Objects in it: Code Storage when configured, else an
 * in-memory store (wrangler dev without secrets, where the Worker and its Durable Objects share one isolate).
 */
export function gitStore(): GitStore {
  return (sharedStore ??=
    config.storage === "codestorage"
      ? new CodeStorageStore({
          org: config.codeStorage.org,
          key: config.codeStorage.key,
          apiBaseUrl: config.codeStorage.apiBaseUrl,
          storageBaseUrl: config.codeStorage.storageBaseUrl,
          repoPrefix: config.codeStorage.repoPrefix,
        })
      : new MemoryStore());
}

/** Builds the Worker's fetch handler. The shared app (store, caches) is made on the first request and kept per isolate. */
export function createRouter(opts: RouterOptions = {}) {
  let app: { app: App; ctx: Ctx } | null = null;

  function setup(env: Env): { app: App; ctx: Ctx } {
    if (app) return app;
    // Commits happen in the WorkspaceDOs, whose head caches are the ones kept up to date; API answers read heads from
    // there (host.head). This cache only serves the Worker's own store calls (imports, workspace creation), briefly.
    const store = new CachedHeadStore(opts.store?.() ?? gitStore(), { maxAgeMs: WORKER_HEAD_MAX_AGE_MS });
    // Rooms live in the workspaces' Durable Objects: ops, tree, pushes and refreshes go to WorkspaceDO by RPC (a stub
    // per call: stubs belong to the request that made them). This RoomManager stays empty.
    const rooms = new RoomManager(store, { storage: noRoomStorage, db: requestDb });
    const host: WorkspaceHost = { get: (id) => env.WORKSPACE.getByName(id, LOCATION) as unknown as WorkspaceApi };
    // GitHub imports run in the new workspace's Durable Object, step by step from its alarm.
    const imports: ImportScheduler = { start: (s) => env.WORKSPACE.getByName(s.id, LOCATION).startImport(s) };
    const repos = new RepoService(store, rooms, requestDb, host, imports);
    const ctx: Ctx = { store, rooms, repos };
    // Events the shared code emits while handling a Worker request (new notebooks, renames, …) go to HubDO's
    // streams. Only inside a request scope: Durable Objects sharing this isolate emit to the hub themselves.
    bus.subscribe((e: AppEvent) => {
      const s = scope.getStore();
      if (!s) return;
      s.waitUntil(env.HUB.getByName("hub", LOCATION).emit(e).catch((err: unknown) => console.error("[hub] emit:", err)));
    });
    // A revoked link (or one of a notebook being removed): its ShellDO stops what it runs and drops its sessions.
    onShareClosed((id) => {
      const closing = env.SHELL.getByName(shareActorId(id), LOCATION)
        .close()
        .catch((err: unknown) => console.error("[shell] close:", err));
      scope.getStore()?.waitUntil(closing);
    });
    // Shell, MCP and share links (/api/shell, /mcp, /a/*) run in ShellDOs: routed before createApp, which only
    // answers their refusals (unknown link, not signed in, cross-origin) and so never touches these.
    const shells = null as unknown as ShellSessions;
    const mcpServer = null as unknown as McpServer;
    app = { app: createApp({ ctx, db: requestDb, shells, mcpServer, staticFile: (req) => env.ASSETS.fetch(req) }), ctx };
    return app;
  }

  async function fetch(req: Request, env: Env, ec: ExecutionContext): Promise<Response> {
    const started = performance.now();
    // Cloudflare sets CF-Connecting-IP on every request; with TRUSTED_PROXIES=none (wrangler.jsonc), it is the
    // caller's IP for clientIp() and nothing a client sends in X-Forwarded-For is believed.
    notePeer(req, req.headers.get("cf-connecting-ip") ?? undefined);
    const url = new URL(req.url);
    const p = url.pathname;
    const s: Scope = { db: d1Db(env.DB), waitUntil: (promise) => ec.waitUntil(promise) };
    return scope.run(s, async () => {
      try {
        if (p === "/ws") return await note(req, url, env);
        if (p === "/ws/home") return home(req, env);
        if (p === "/api/events" && req.method === "GET") return await env.HUB.getByName("hub", LOCATION).fetch(req);
        if (p.startsWith("/a/")) return await shareLink(req, url, env);
        if (p === "/api/shell" || p === "/mcp") return await shell(req, env);
        if (p.startsWith("/api/")) return timed(await api(req, url, env, ec), started);
        const res = await setup(env).app.fetch(req, noUpgrade);
        return res ?? new Response("Not found", { status: 404 });
      } catch (e) {
        console.error(`[worker] ${req.method} ${p.replace(/^\/a\/[^/]+/, "/a/<redacted>")}:`, e);
        return new Response("Internal error", { status: 500 });
      }
    });
  }

  /** /api/*: the shared app, with GET …/raw?ref=<sha> answered from the cache when it can be. */
  async function api(req: Request, url: URL, env: Env, ec: ExecutionContext): Promise<Response> {
    const { app } = setup(env);
    const ref = url.searchParams.get("ref");
    const cacheable = req.method === "GET" && RAW_PATH.test(url.pathname) && !!ref && SHA.test(ref);
    if (!cacheable) return (await app.fetch(req, noUpgrade))!;
    // Raw reads are public (anyone may read), so the key is only what selects the bytes: repo, path and commit.
    const key = new Request(`${url.origin}${url.pathname}?path=${encodeURIComponent(url.searchParams.get("path") ?? "")}&ref=${ref}`);
    const cache = (caches as unknown as { default: Cache }).default;
    const hit = await cache.match(key);
    if (hit) return withTiming(hit, "cache;desc=hit");
    const res = (await app.fetch(req, noUpgrade))!;
    if (res.status !== 200) return res;
    const out = new Response(res.body, res);
    out.headers.set("cache-control", `public, max-age=${RAW_CACHE_SECONDS}, immutable`);
    ec.waitUntil(cache.put(key, out.clone()));
    return withTiming(out, "cache;desc=miss");
  }

  /** /a/<id>: a link that exists continues in its ShellDO (which checks it again, rate-limits it and runs the shell). */
  async function shareLink(req: Request, url: URL, env: Env): Promise<Response> {
    const m = /^\/a\/([^/]+)\/?$/.exec(url.pathname);
    const share = m ? await getShare(current().db, m[1]!.toLowerCase()) : null;
    // Unknown or revoked: refused here, in the link's usual format, without waking a Durable Object.
    if (!share) return (await setup(env).app.fetch(req, noUpgrade))!;
    return env.SHELL.getByName(shareActorId(share.id), LOCATION).fetch(req);
  }

  /** /api/shell, /mcp: signed-in callers continue in their own ShellDO, with who they are in a header. */
  async function shell(req: Request, env: Env): Promise<Response> {
    const { app } = setup(env);
    const c = await app.caller(req);
    // Not signed in, or cross-origin: the app's own refusal (it stops before reaching a shell).
    if (typeof c === "string") return (await app.fetch(req, noUpgrade))!;
    const headers = new Headers(req.headers);
    headers.set(SHELL_CALLER_HEADER, encodeURIComponent(JSON.stringify({ actor: c.actor } satisfies ShellCaller)));
    return env.SHELL.getByName(userShellName(c.actor.id), LOCATION).fetch(new Request(req, { headers }));
  }

  return { fetch };
}

/** How long the Worker trusts a cached head (the WorkspaceDOs commit; the Worker never hears of it). */
export const WORKER_HEAD_MAX_AGE_MS = 2000;

/** /ws: workspace-level admission here; accepted upgrades continue in the workspace's Durable Object. */
async function note(req: Request, url: URL, env: Env): Promise<Response> {
  if (!isUpgrade(req)) return new Response("Expected a WebSocket upgrade", { status: 426 });
  const a = await admitWorkspace(current().db, req, url);
  if ("reject" in a) return closeWith(a.reject.code, a.reject.reason);
  const headers = new Headers(req.headers);
  headers.set(ADMISSION_HEADER, encodeURIComponent(JSON.stringify(a satisfies Admission)));
  return env.WORKSPACE.getByName(a.repoId, LOCATION).fetch(new Request(req, { headers }));
}

/** /ws/home: the cross-origin check here, the room (and its per-IP caps) in HomeDO. */
function home(req: Request, env: Env): Response | Promise<Response> {
  if (!isUpgrade(req)) return new Response("Expected a WebSocket upgrade", { status: 426 });
  if (!sameOrigin(req)) return closeWith(4403, "cross-origin");
  const headers = new Headers(req.headers);
  headers.set(HOME_IP_HEADER, clientIp(req));
  return env.HOME.getByName("home", LOCATION).fetch(new Request(req, { headers }));
}

/** /ws and /ws/home are answered before createApp, so its upgrader is never asked to upgrade. */
const noUpgrade: Upgrader = { note: () => false, home: () => false };

function isUpgrade(req: Request): boolean {
  return req.headers.get("upgrade")?.toLowerCase() === "websocket";
}

/** Upgrade, then close at once with `code`: browsers only see a close code on an open socket. */
function closeWith(code: number, reason: string): Response {
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.accept();
  server.close(code, reason);
  return new Response(null, { status: 101, webSocket: client });
}

/** Server-Timing on API responses: the Worker's wall time (I/O included; CPU time alone doesn't advance the clock). */
function timed(res: Response, started: number): Response {
  return withTiming(res, `app;dur=${(performance.now() - started).toFixed(1)}`);
}

function withTiming(res: Response, entry: string): Response {
  if (res.status === 101 || res.webSocket) return res;
  const out = new Response(res.body, res);
  const prev = out.headers.get("server-timing");
  out.headers.set("server-timing", prev ? `${prev}, ${entry}` : entry);
  return out;
}
