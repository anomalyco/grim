import { handleApi, json } from "./api.ts";
import { authenticate, bearerToken, handleAuthRoute, participantForUser, repoAccess, sameOrigin, userFromAppToken, userFromRequest, visitorUser } from "./auth.ts";
import { config } from "./config.ts";
import { recordJoin } from "./workspaces.ts";
import { guestFromHeaders, guestFromQuery, guestParticipant } from "./anon.ts";
import { DEFAULT_AGENT_NAME, type McpCaller, type McpServer } from "./mcp.ts";
import { handleOAuth, wwwAuthenticate } from "./oauth.ts";
import { MCP_AUDIENCE } from "./tokens.ts";
import type { Ctx } from "./ops.ts";
import { cleanPath, type RepoRow } from "./repos.ts";
import { cachedRepo } from "./repo-cache.ts";
import type { Db } from "./seams/db.ts";
import { clientIp } from "./proxy.ts";
import { DEMO_ROOM_FULL, demoGate, isDemoRoom } from "./demo-rooms.ts";
import { handleShareLink } from "./shares.ts";
import type { Participant } from "./rooms.ts";
import type { AdmittedWorkspace, WsDecision, WsReject } from "./seams/workspace-host.ts";
import type { AdmittedSocket } from "./wsmux.ts";
import type { ShellSessions } from "./shell/session.ts";

export type { WsDecision, WsReject } from "./seams/workspace-host.ts";
export { admitFile } from "./workspace.ts";

/** The outcome of the workspace-level step: everything known without opening the note's room. */
export type WorkspaceAdmission = { reject: WsReject } | AdmittedWorkspace;
/** The outcome of a protocol v2 admission (`/ws?repo=` without a path). */
export type SocketAdmission = { reject: WsReject } | AdmittedSocket;

/** How the platform entry upgrades a request. Each returns false when the request isn't a WebSocket upgrade. */
export interface Upgrader {
  /** /ws: upgrade even when rejecting, so the browser sees the close code. */
  note(req: Request, decision: WsDecision): boolean;
  /** /ws?repo= without a path: a protocol v2 workspace socket (hosts without it answer 426). */
  workspace?(req: Request, decision: SocketAdmission): boolean;
}

export interface AppDeps {
  ctx: Ctx;
  /** The global tables (users, sessions, workspaces, …): bun:sqlite on Bun, D1 on Workers. */
  db: Db;
  shells: ShellSessions;
  mcpServer: McpServer;
  /**
   * Everything else a GET/HEAD may ask for: old /r/… and /start links, the app's HTML (/, /app/…, /scratch), versioned
   * CSS/JS and /dist/ (Bun: assets.ts staticResponse, with gzip); 404 when unknown.
   */
  staticFile(req: Request, url: URL): Promise<Response>;
}

/**
 * WebSocket admission, workspace level: auth (cookie, app token or anonymous guest), cross-origin,
 * and whether the workspace exists and is ready. Records the join for signed-in people (in the background with `defer`).
 */
export async function admitWorkspace(db: Db, req: Request, url: URL, opts: { defer?: (work: Promise<unknown>) => void } = {}): Promise<WorkspaceAdmission> {
  const path = cleanPath(url.searchParams.get("path") ?? "");
  const a = await admit(db, req, url, opts, (repo) => (!path ? { code: 4404, reason: "not found" } : repo.status !== "ready" ? { code: 1013, reason: `repo ${repo.status}` } : null));
  if ("reject" in a) return a;
  return { repoId: a.repo.id, branch: a.repo.branch, path: path!, participant: a.participant, readOnly: a.readOnly };
}

/**
 * Protocol v2 admission (`/ws?repo=` without a path, docs/07-workspace-socket.md §1): admitWorkspace without the
 * path step. Workspaces that aren't ready are admitted (the socket says when they are); the join is recorded once.
 */
export async function admitSocket(db: Db, req: Request, url: URL, opts: { defer?: (work: Promise<unknown>) => void } = {}): Promise<SocketAdmission> {
  const a = await admit(db, req, url, opts, () => null);
  if ("reject" in a) return a;
  const { repo } = a;
  const status = repo.status === "importing" || repo.status === "error" ? repo.status : "ready";
  return { v: 2, repoId: repo.id, branch: repo.branch, status, ...(repo.error ? { error: repo.error } : {}), participant: a.participant, readOnly: a.readOnly };
}

async function admit(
  db: Db,
  req: Request,
  url: URL,
  opts: { defer?: (work: Promise<unknown>) => void },
  check: (repo: RepoRow) => WsReject | null,
): Promise<{ reject: WsReject } | { repo: RepoRow; participant: Participant; readOnly: boolean }> {
  // Browsers use the session cookie (same origin only); apps an app token (Authorization header or ?token=).
  // Browsers that aren't signed in join as anonymous visitors with the name they send (`anon`, `name`, `color`).
  const queryToken = url.searchParams.get("token");
  if (!config.signIn) {
    // sign-in off: every visitor joins, shown under its guest identity (browsers' only from this origin); no lists to
    // keep, no demo rooms
    if (req.headers.get("origin") && !sameOrigin(req)) return { reject: { code: 4403, reason: "cross-origin" } };
    const [{ actor }, repo] = await Promise.all([visitorUser(db, guestFromQuery(url.searchParams)), cachedRepo(db, url.searchParams.get("repo") ?? "")]);
    if (!repo || repo.id === "demo" || isDemoRoom(repo.id)) return { reject: { code: 4404, reason: "not found" } };
    const reject = check(repo);
    if (reject) return { reject };
    return { repo, participant: actor, readOnly: repoAccess(repo) === "read" };
  }
  // The caller and the workspace row are independent lookups: both at once (each is a D1 round trip on Workers).
  const [auth, repo] = await Promise.all([authenticate(db, req, queryToken), cachedRepo(db, url.searchParams.get("repo") ?? "")]);
  const withToken = !!queryToken || !!bearerToken(req);
  const user = auth?.user ?? null;
  const guest = !user && !withToken && url.searchParams.has("anon") ? guestFromQuery(url.searchParams) : null;
  if (!withToken && !sameOrigin(req)) return { reject: { code: 4403, reason: "cross-origin" } };
  if (!user && !guest) return { reject: { code: 4401, reason: "unauthorized" } };
  if (!repo) return { reject: { code: 4404, reason: "not found" } };
  // (the demo is for people who aren't signed in: an account isn't let into a demo room)
  const reject = check(repo) ?? (user && isDemoRoom(repo.id) ? { code: 4403, reason: "the demo is for visitors" } : await demoReject(req, repo, guest!));
  if (reject) return { reject };
  let participant: Participant;
  if (user) {
    // `defer` (Workers): the join is bookkeeping for the workspace list, so it doesn't hold up the socket.
    const join = recordJoin(db, user.id, repo.id);
    if (opts.defer) opts.defer(join.catch((e: unknown) => console.error("[ws] record join:", e)));
    else await join;
    participant = participantForUser(user);
  } else {
    participant = guest!;
  }
  return { repo, participant, readOnly: repoAccess(repo) === "read" };
}

/** A demo room lets in only its people (demo-rooms.ts): 4409 when it's full (ask for a room again), 4404 when it's gone. */
async function demoReject(req: Request, repo: RepoRow, who: Participant): Promise<WsReject | null> {
  if (repo.id === "demo") return { code: 4404, reason: "not found" };
  if (!isDemoRoom(repo.id)) return null;
  const a = who.id === "guest:visitor" ? "full" : await demoGate().admit(repo.id, who.id, clientIp(req));
  if (a === "full") return { code: DEMO_ROOM_FULL, reason: "demo room full" };
  if (a === "gone") return { code: 4404, reason: "not found" };
  return null;
}

/** The 500 response for an uncaught error in a route. */
export function serverError(req: Request, path: string, e: unknown): Response {
  // Share link URLs are secrets: keep them out of logs.
  console.error(`[http] ${req.method} ${path.replace(/^\/a\/[^/]+/, "/a/<redacted>")}:`, e);
  return new Response("Internal error", { status: 500 });
}

/** /mcp on a server without sign-in: how its agents show (cursor, commits) when the client doesn't name itself. */
const MCP_VISITOR = guestParticipant("mcp-agent", DEFAULT_AGENT_NAME, null)!;

/** CORS for /mcp (sign-in on only: a bearer token, never a cookie, so any origin may call it). */
const MCP_CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id",
  "access-control-expose-headers": "mcp-session-id, www-authenticate",
  "access-control-max-age": "86400",
};

export function createApp(deps: AppDeps) {
  const { ctx, db, shells, mcpServer } = deps;

  async function admitWs(req: Request, url: URL): Promise<WsDecision> {
    const a = await admitWorkspace(db, req, url);
    if ("reject" in a) return a;
    // The file-level step runs in the workspace's runtime (on Workers the Worker forwards the upgrade to the WorkspaceDO instead).
    if (!ctx.repos.host.admitFile) return { reject: { code: 1011, reason: "could not open file" } };
    return ctx.repos.host.admitFile(a);
  }

  /**
   * Who calls /mcp, or the refusal: an account by its app token (Authorization: Bearer, from the OAuth flow or made
   * for an app); with sign-in off, the shared MCP visitor (browsers only from this origin: no CORS, no rebinding).
   * Cookies never count. `headers`: what the answer carries (CORS).
   */
  async function mcpCaller(req: Request): Promise<{ caller: McpCaller; headers: Record<string, string> } | Response> {
    const rpcFail = (status: number, message: string, headers: Record<string, string> = {}) => json({ jsonrpc: "2.0", id: null, error: { code: -32001, message } }, status, headers);
    if (!config.signIn) {
      if (req.method === "OPTIONS" || (req.headers.get("origin") && !sameOrigin(req))) return rpcFail(403, "cross-origin request refused");
      const { user } = await visitorUser(db, MCP_VISITOR);
      return { caller: { userId: user.id }, headers: {} };
    }
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: MCP_CORS });
    const token = bearerToken(req);
    // an MCP client's token (audience "mcp"), or an app's (any)
    const user = token ? await userFromAppToken(db, token, MCP_AUDIENCE) : null;
    if (!user) {
      return rpcFail(401, token ? "invalid or expired token: sign in again" : "sign in to Grim: this MCP server uses OAuth (see WWW-Authenticate)", {
        ...MCP_CORS,
        "www-authenticate": wwwAuthenticate(token ? "invalid_token" : undefined),
      });
    }
    return { caller: { userId: user.id }, headers: MCP_CORS };
  }

  async function mcp(req: Request): Promise<Response> {
    const c = await mcpCaller(req);
    if (c instanceof Response) return c;
    return mcpServer.handle(req, c.caller, c.headers);
  }

  async function fetch(req: Request, upgrader: Upgrader): Promise<Response | undefined> {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p === "/ws") {
        if (!url.searchParams.has("path") && upgrader.workspace) {
          if (upgrader.workspace(req, await admitSocket(db, req, url))) return undefined;
          return new Response("Expected a WebSocket upgrade", { status: 426 });
        }
        if (upgrader.note(req, await admitWs(req, url))) return undefined;
        return new Response("Expected a WebSocket upgrade", { status: 426 });
      }
      // (no other sockets: an old landing page's /ws/home gets a plain 404, not the app's page)
      if (p.startsWith("/ws/")) return new Response("Not found", { status: 404 });
      if (p.startsWith("/api/")) {
        if (config.signIn || p === "/api/server") return await handleApi(req, url, ctx, await userFromRequest(db, req));
        // sign-in off: every visitor may do what an account may, as its guest identity
        const { user, actor } = await visitorUser(db, guestFromHeaders(req));
        return await handleApi(req, url, ctx, user, actor);
      }
      if (p.startsWith("/auth/")) return (await handleAuthRoute(db, req, url)) ?? new Response("Not found", { status: 404 });
      if (p === "/mcp") return await mcp(req);
      if (p.startsWith("/.well-known/oauth-") || p.startsWith("/oauth/")) return (await handleOAuth(db, req, url)) ?? new Response("Not found", { status: 404 });
      if (p.startsWith("/a/")) return await handleShareLink(req, url, ctx, shells);
      if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
      // no landing page here (MARKETING_SITE off: self-hosted): "/" is the app
      if (p === "/" && !config.marketingSite) return new Response(null, { status: 302, headers: { location: "/app" + url.search } });
      return await deps.staticFile(req, url);
    } catch (e) {
      return serverError(req, p, e);
    }
  }

  return { fetch, admitWs, mcpCaller, mcp };
}
