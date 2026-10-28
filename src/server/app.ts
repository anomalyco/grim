import { csrfOk, handleApi, handleShell, handleWebhook, json } from "./api.ts";
import { authenticate, bearerToken, handleAuthRoute, participantForUser, repoAccess, sameOrigin, userFromRequest } from "./auth.ts";
import { handleConnect } from "./tokens.ts";
import { recordJoin } from "./workspaces.ts";
import { guestFromQuery } from "./anon.ts";
import type { McpServer } from "./mcp.ts";
import type { Ctx } from "./ops.ts";
import { cleanPath, getRepo } from "./repos.ts";
import type { Db } from "./seams/db.ts";
import { clientIp } from "./proxy.ts";
import { handleShareLink } from "./shares.ts";
import { NotFoundError, type Participant, type Room, type RoomManager } from "./rooms.ts";
import type { AccessFn } from "./shell/fs.ts";
import type { ShellSessions } from "./shell/session.ts";
import { FileTooLargeError, StoreUnavailableError } from "./store/types.ts";

export const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-cache",
  "content-security-policy":
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
};

export interface WsReject {
  code: number;
  reason: string;
}

/** The outcome of the workspace-level step: everything known without opening the note's room. */
export type WorkspaceAdmission = { reject: WsReject } | { repoId: string; branch: string; path: string; participant: Participant; readOnly: boolean };

/** The outcome of WebSocket admission: close at once with a code, or join the room. */
export type WsDecision = { reject: WsReject } | { room: Room; participant: Participant; readOnly: boolean };

/** How the platform entry upgrades a request. Each returns false when the request isn't a WebSocket upgrade. */
export interface Upgrader {
  /** /ws: upgrade even when rejecting, so the browser sees the close code. */
  note(req: Request, decision: WsDecision): boolean;
  /** /ws/home: the home page doodle. */
  home(req: Request, ip: string, reject?: WsReject): boolean;
}

export interface AppDeps {
  ctx: Ctx;
  /** The global tables (users, sessions, workspaces, …): bun:sqlite on Bun, D1 on Workers. */
  db: Db;
  shells: ShellSessions;
  mcpServer: McpServer;
  /** The app's HTML (with ?v= hashes). */
  html(): Promise<string>;
  /** Everything else a GET/HEAD may ask for (versioned CSS/JS, /dist/), 404 when unknown. */
  staticFile(req: Request, url: URL): Promise<Response>;
}

/**
 * WebSocket admission, workspace level: auth (cookie, app token or anonymous guest), cross-origin,
 * and whether the workspace exists and is ready. Records the join for signed-in people.
 */
export async function admitWorkspace(db: Db, req: Request, url: URL): Promise<WorkspaceAdmission> {
  // Browsers use the session cookie (same origin only); apps an app token (Authorization header or ?token=).
  // Browsers that aren't signed in join as anonymous visitors with the name they send (`anon`, `name`, `color`).
  const queryToken = url.searchParams.get("token");
  const auth = authenticate(req, queryToken);
  const withToken = !!queryToken || !!bearerToken(req);
  const user = auth?.user ?? null;
  const guest = !user && !withToken && url.searchParams.has("anon") ? guestFromQuery(url.searchParams) : null;
  const repo = await getRepo(db, url.searchParams.get("repo") ?? "");
  const path = cleanPath(url.searchParams.get("path") ?? "");
  if (!withToken && !sameOrigin(req)) return { reject: { code: 4403, reason: "cross-origin" } };
  if (!user && !guest) return { reject: { code: 4401, reason: "unauthorized" } };
  if (!repo || !path) return { reject: { code: 4404, reason: "not found" } };
  if (repo.status !== "ready") return { reject: { code: 1013, reason: `repo ${repo.status}` } };
  let participant: Participant;
  if (user) {
    await recordJoin(db, user.id, repo.id);
    participant = participantForUser(user);
  } else {
    participant = guest!;
  }
  return { repoId: repo.id, branch: repo.branch, path, participant, readOnly: repoAccess(repo) === "read" };
}

/** WebSocket admission, file level: open the note's room (4404 missing, 4413 too large, 1013 transient, 1011 other). */
export async function admitFile(rooms: RoomManager, a: Exclude<WorkspaceAdmission, { reject: WsReject }>): Promise<WsDecision> {
  try {
    const room = await rooms.get(a.repoId, a.path, a.branch);
    return { room, participant: a.participant, readOnly: a.readOnly };
  } catch (e) {
    if (e instanceof NotFoundError) return { reject: { code: 4404, reason: "file not found" } };
    if (e instanceof FileTooLargeError) return { reject: { code: 4413, reason: "file too large" } };
    // Transient (e.g. GitHub unreachable): the client retries.
    if (e instanceof StoreUnavailableError) return { reject: { code: 1013, reason: "try again later" } };
    console.error(`[ws] open ${a.repoId}:${a.path}:`, e);
    return { reject: { code: 1011, reason: "could not open file" } };
  }
}

/** The 500 response for an uncaught error in a route. */
export function serverError(req: Request, path: string, e: unknown): Response {
  // Share link URLs are secrets: keep them out of logs.
  console.error(`[http] ${req.method} ${path.replace(/^\/a\/[^/]+/, "/a/<redacted>")}:`, e);
  return new Response("Internal error", { status: 500 });
}

const UNAUTHORIZED = "not signed in; agents connect through a notebook's \"Share with agent\" link";

export function createApp(deps: AppDeps) {
  const { ctx, db, shells, mcpServer } = deps;

  async function admitWs(req: Request, url: URL): Promise<WsDecision> {
    const a = await admitWorkspace(db, req, url);
    if ("reject" in a) return a;
    return admitFile(ctx.rooms, a);
  }

  /** Signed-in people (cookie, with the same CSRF rule as /api). Agents use share links (/a/<id>) instead. */
  async function caller(req: Request): Promise<{ actor: Participant; access: AccessFn } | "unauthorized" | "cross-origin"> {
    const user = userFromRequest(req);
    if (!user) return "unauthorized";
    if (!csrfOk(req)) return "cross-origin";
    return { actor: participantForUser(user), access: async (repo) => repoAccess(repo) };
  }

  async function mcp(req: Request): Promise<Response> {
    const c = await caller(req);
    if (c === "cross-origin") return json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "cross-origin request refused" } }, 403);
    if (c === "unauthorized") return json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: UNAUTHORIZED } }, 401);
    return mcpServer.handle(req, c.actor, c.access);
  }

  async function shell(req: Request): Promise<Response> {
    const c = await caller(req);
    if (c === "cross-origin") return json({ error: "cross-origin request refused" }, 403);
    if (c === "unauthorized") return json({ error: UNAUTHORIZED }, 401);
    return handleShell(req, shells, c.actor, c.access);
  }

  async function fetch(req: Request, upgrader: Upgrader): Promise<Response | undefined> {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p === "/ws") {
        if (upgrader.note(req, await admitWs(req, url))) return undefined;
        return new Response("Expected a WebSocket upgrade", { status: 426 });
      }
      if (p === "/ws/home") {
        const reject = sameOrigin(req) ? undefined : { code: 4403, reason: "cross-origin" };
        if (upgrader.home(req, clientIp(req), reject)) return undefined;
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
      if (p === "/" || p === "/app" || p.startsWith("/app/") || p === "/start" || p === "/scratch") return new Response(await deps.html(), { headers: HTML_HEADERS });
      return await deps.staticFile(req, url);
    } catch (e) {
      return serverError(req, p, e);
    }
  }

  return { fetch, admitWs, caller, mcp, shell };
}
