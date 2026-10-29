import { csrfOk, handleApi, handleShell, handleWebhook, json } from "./api.ts";
import { authenticate, bearerToken, handleAuthRoute, participantForUser, repoAccess, sameOrigin, userFromRequest } from "./auth.ts";
import { handleConnect } from "./tokens.ts";
import { recordJoin } from "./workspaces.ts";
import { guestFromQuery } from "./anon.ts";
import type { McpServer } from "./mcp.ts";
import type { Ctx } from "./ops.ts";
import { cleanPath, type RepoRow } from "./repos.ts";
import { cachedRepo } from "./repo-cache.ts";
import type { Db } from "./seams/db.ts";
import { clientIp } from "./proxy.ts";
import { handleShareLink } from "./shares.ts";
import type { Participant } from "./rooms.ts";
import type { AdmittedWorkspace, WsDecision, WsReject } from "./seams/workspace-host.ts";
import type { AdmittedSocket } from "./wsmux.ts";
import type { AccessFn } from "./shell/fs.ts";
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
  /** /ws/home: the home page doodle. */
  home(req: Request, ip: string, reject?: WsReject): boolean;
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
  // The caller and the workspace row are independent lookups: both at once (each is a D1 round trip on Workers).
  const [auth, repo] = await Promise.all([authenticate(db, req, queryToken), cachedRepo(db, url.searchParams.get("repo") ?? "")]);
  const withToken = !!queryToken || !!bearerToken(req);
  const user = auth?.user ?? null;
  const guest = !user && !withToken && url.searchParams.has("anon") ? guestFromQuery(url.searchParams) : null;
  if (!withToken && !sameOrigin(req)) return { reject: { code: 4403, reason: "cross-origin" } };
  if (!user && !guest) return { reject: { code: 4401, reason: "unauthorized" } };
  if (!repo) return { reject: { code: 4404, reason: "not found" } };
  const reject = check(repo);
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
    // The file-level step runs in the workspace's runtime (on Workers the Worker forwards the upgrade to the WorkspaceDO instead).
    if (!ctx.repos.host.admitFile) return { reject: { code: 1011, reason: "could not open file" } };
    return ctx.repos.host.admitFile(a);
  }

  /** Signed-in people (cookie, with the same CSRF rule as /api). Agents use share links (/a/<id>) instead. */
  async function caller(req: Request): Promise<{ actor: Participant; access: AccessFn } | "unauthorized" | "cross-origin"> {
    const user = await userFromRequest(db, req);
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
        if (!url.searchParams.has("path") && upgrader.workspace) {
          if (upgrader.workspace(req, await admitSocket(db, req, url))) return undefined;
          return new Response("Expected a WebSocket upgrade", { status: 426 });
        }
        if (upgrader.note(req, await admitWs(req, url))) return undefined;
        return new Response("Expected a WebSocket upgrade", { status: 426 });
      }
      if (p === "/ws/home") {
        const reject = sameOrigin(req) ? undefined : { code: 4403, reason: "cross-origin" };
        if (upgrader.home(req, clientIp(req), reject)) return undefined;
        return new Response("Expected a WebSocket upgrade", { status: 426 });
      }
      if (p === "/api/shell") return await shell(req);
      if (p.startsWith("/api/")) return await handleApi(req, url, ctx, await userFromRequest(db, req));
      if (p.startsWith("/auth/")) return (await handleAuthRoute(db, req, url)) ?? new Response("Not found", { status: 404 });
      if (p === "/webhooks/codestorage") return await handleWebhook(req, ctx);
      if (p === "/mcp") return await mcp(req);
      if (p.startsWith("/a/")) return await handleShareLink(req, url, ctx, shells);
      if (p === "/connect" || p === "/connect/token") return await handleConnect(db, req, url);
      if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
      return await deps.staticFile(req, url);
    } catch (e) {
      return serverError(req, p, e);
    }
  }

  return { fetch, admitWs, caller, mcp, shell };
}
