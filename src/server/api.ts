import { validateWebhook } from "@pierre/storage";
import { config } from "./config.ts";
import {
  colorFor,
  createAgentToken,
  deleteAgentToken,
  githubLoginEnabled,
  githubRepoInfo,
  listAgentTokens,
  participantForUser,
  repoAccess,
  repoAccessSync,
  sameOrigin,
  type Access,
  type User,
} from "./auth.ts";
import { subscribe, type AppEvent } from "./events.ts";
import * as ops from "./ops.ts";
import { OpError, type Ctx } from "./ops.ts";
import { getRepo, listRepoRows, slugify, type RepoRow } from "./repos.ts";
import { NotFoundError } from "./rooms.ts";
import { RepoBusyError } from "./store/types.ts";

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
}

const fail = (status: number, error: string) => json({ error }, status);

function repoJson(r: RepoRow, access: Access) {
  return {
    id: r.id,
    title: r.title,
    kind: r.kind,
    ghOwner: r.gh_owner,
    ghName: r.gh_name,
    branch: r.branch,
    status: r.status,
    error: r.error,
    readOnly: !!r.read_only,
    access,
  };
}

async function body(req: Request): Promise<Record<string, unknown>> {
  const b = await req.json().catch(() => null);
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "expected a JSON object body");
  return b as Record<string, unknown>;
}

function str(v: unknown, name: string): string {
  if (typeof v !== "string" || !v) throw new HttpError(400, `${name} is required`);
  return v;
}

function query(url: URL, name: string): string {
  return str(url.searchParams.get(name) ?? "", name);
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new HttpError(400, "malformed URL encoding");
  }
}

function requireAdmin(user: User) {
  if (!user.isAdmin) throw new HttpError(403, "admin only");
}

/** State-changing requests must be same-origin or JSON (which cross-origin forms can't send without CORS). */
function csrfOk(req: Request): boolean {
  if (req.method === "GET" || req.method === "HEAD") return true;
  if (sameOrigin(req)) return true;
  if (req.headers.get("origin")) return false;
  return (req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json");
}

export async function handleApi(req: Request, url: URL, ctx: Ctx, user: User | null): Promise<Response> {
  try {
    return await route(req, url, ctx, user);
  } catch (e) {
    if (e instanceof HttpError || e instanceof OpError) return fail(e.status, e.message);
    if (e instanceof RepoBusyError) return fail(409, e.message);
    if (e instanceof NotFoundError) return fail(404, e.message);
    console.error(`[api] ${req.method} ${url.pathname}:`, e);
    return fail(500, "internal error");
  }
}

async function route(req: Request, url: URL, ctx: Ctx, user: User | null): Promise<Response> {
  const p = url.pathname;
  const m = req.method;

  if (p === "/api/config" && m === "GET") {
    return json({ githubLogin: githubLoginEnabled(), devLogin: config.allowDevLogin, githubAppSlug: config.github.appSlug || null, storage: config.storage });
  }
  if (!user) return fail(401, "not signed in");
  if (!csrfOk(req)) return fail(403, "cross-origin request refused");

  if (p === "/api/me" && m === "GET") {
    const { githubToken: _, ...me } = user;
    return json({ ...me, color: colorFor(user.id) });
  }

  if (p === "/api/events" && m === "GET") {
    // Warm the access cache so most events can be decided without waiting.
    await Promise.all(listRepoRows().map((r) => repoAccess(user, r)));
    // Current presence for open rooms, so sidebars show who is where before anything changes.
    const initial = ctx.rooms.list().map((r) => ({ type: "presence" as const, repo: r.repo, path: r.path, users: r.participants() }));
    return eventStream(user, initial);
  }

  if (p === "/api/repos") {
    if (m === "GET") {
      const rows = listRepoRows();
      const access = await Promise.all(rows.map((r) => repoAccess(user, r)));
      return json(rows.map((r, i) => repoJson(r, access[i]!)).filter((r) => r.access !== "none"));
    }
    if (m === "POST") {
      const b = await body(req);
      if (typeof b.github === "string") {
        const gm = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/.exec(b.github.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, ""));
        if (!gm || gm[2] === "." || gm[2] === "..") throw new HttpError(400, "github must be owner/name");
        const [owner, name] = [gm[1]!, gm[2]!];
        const publicReadOnly = b.publicReadOnly === true;
        // Only people who can see the repo on GitHub (or admins) may link it. Dev-login users have no token.
        if (!user.githubToken && !user.isAdmin) throw new HttpError(403, "only admins can link GitHub repos without a GitHub login");
        let info;
        try {
          info = await githubRepoInfo(owner, name, user.githubToken);
        } catch (e) {
          throw new HttpError(502, `could not reach GitHub: ${(e as Error).message}`);
        }
        if (!user.isAdmin && (!info || info.access === "none")) throw new HttpError(403, `you don't have access to ${owner}/${name} on GitHub`);
        if (publicReadOnly && !(info && !info.private)) throw new HttpError(400, "publicReadOnly needs a public GitHub repo");
        const repo = await ctx.repos.linkGitHub(owner, name, { publicReadOnly, userId: user.id, branch: info?.defaultBranch ?? undefined });
        return json(repoJson(repo, await repoAccess(user, repo)), 201);
      }
      const title = str(typeof b.title === "string" ? b.title.trim() : b.title, "title").slice(0, 100);
      if (/^\.+$/.test(slugify(title))) throw new HttpError(400, "invalid title");
      const repo = await ctx.repos.createNotesRepo(title, user.id);
      return json(repoJson(repo, "write"), 201);
    }
  }

  const rm = /^\/api\/repos\/([^/]+)(?:\/([a-z]+))?$/.exec(p);
  if (rm) {
    const id = decode(rm[1]!);
    if (id === "." || id === "..") throw new HttpError(400, "invalid repo id");
    const repo = getRepo(id);
    const access = repo ? await repoAccess(user, repo) : "none";
    if (!repo || access === "none") throw new HttpError(404, "repo not found");
    const write = () => {
      if (access !== "write") throw new HttpError(403, "you have read-only access to this repo");
    };
    const actor = participantForUser(user);
    const sub = rm[2];

    if (!sub && m === "DELETE") {
      requireAdmin(user);
      await ctx.repos.removeRepo(repo.id);
      return json({ ok: true });
    }
    if (repo.status !== "ready") throw new HttpError(409, repo.status === "importing" ? `${repo.id} is still importing` : `${repo.id}: ${repo.error ?? repo.status}`);
    if (sub === "tree" && m === "GET") {
      const files = await ctx.repos.tree(repo);
      const head = await ctx.store.head(repo.id, repo.branch);
      return json({ head, files });
    }
    if (sub === "files" && m === "POST") {
      write();
      const b = await body(req);
      const content = b.content === undefined || b.content === null ? undefined : String(b.content);
      return json(await ops.createFile(ctx, repo, str(b.path, "path"), content, actor), 201);
    }
    if (sub === "files" && m === "DELETE") {
      write();
      return json(await ops.deleteFile(ctx, repo, query(url, "path"), actor));
    }
    if (sub === "rename" && m === "POST") {
      write();
      const b = await body(req);
      return json(await ops.renameFile(ctx, repo, str(b.from, "from"), str(b.to, "to"), actor));
    }
    if (sub === "history" && m === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 50) || 50;
      return json(await ops.history(ctx, repo, url.searchParams.get("path") || undefined, limit));
    }
    if (sub === "diff" && m === "GET") {
      return json({ diff: await ops.diff(ctx, repo, query(url, "sha"), url.searchParams.get("path") || undefined) });
    }
    if (sub === "file" && m === "GET") {
      const r = await ops.readFile(ctx, repo, query(url, "path"), url.searchParams.get("ref") || undefined);
      return json({ content: r.content, version: r.version, live: r.live });
    }
    if (sub === "restore" && m === "POST") {
      write();
      const b = await body(req);
      await ops.restoreFile(ctx, repo, str(b.path, "path"), str(b.sha, "sha"), actor);
      return json({ ok: true });
    }
    if (sub === "search" && m === "GET") {
      return json(await ops.search(ctx, repo, url.searchParams.get("q") ?? ""));
    }
  }

  if (p === "/api/agent-tokens") {
    requireAdmin(user);
    if (m === "GET") return json(listAgentTokens());
    if (m === "POST") {
      const b = await body(req);
      const name = str(typeof b.name === "string" ? b.name.trim() : b.name, "name").slice(0, 60);
      return json(createAgentToken(name, user.id), 201);
    }
  }
  const tm = /^\/api\/agent-tokens\/([^/]+)$/.exec(p);
  if (tm && m === "DELETE") {
    requireAdmin(user);
    deleteAgentToken(decode(tm[1]!));
    return json({ ok: true });
  }

  return fail(404, "not found");
}

export async function handleWebhook(req: Request, ctx: Ctx): Promise<Response> {
  if (req.method !== "POST") return fail(405, "method not allowed");
  const secret = config.codeStorage.webhookSecret.trim();
  if (!secret) return fail(503, "webhook secret not configured");
  const raw = await req.text();
  const result = await validateWebhook(raw, Object.fromEntries(req.headers), secret).catch((e) => ({ valid: false, error: String(e), payload: undefined }));
  if (!result.valid) return fail(401, result.error ?? "invalid signature");
  const payload = result.payload;
  if (payload && payload.type === "push" && "repository" in payload) {
    const id = payload.repository.id;
    if (getRepo(id)) void ctx.repos.onPush(id).catch((e) => console.error(`[webhook] onPush ${id}:`, e));
  }
  return json({ ok: true });
}

/**
 * SSE stream of app events for one user, limited to repos they can access. Events whose access isn't known yet
 * wait for the check instead of being dropped; a promise chain keeps them in order.
 */
function eventStream(user: User, initial: AppEvent[]): Response {
  let stop = () => {};
  const stream = new ReadableStream<string>({
    start(controller) {
      let chain: Promise<void> = Promise.resolve();
      let closed = false;
      const write = (s: string) => {
        if (closed) return;
        try {
          controller.enqueue(s);
        } catch {
          stop();
        }
      };
      const allowed = (e: AppEvent): boolean | Promise<boolean> => {
        if (e.type === "repos") return true;
        const repo = getRepo(e.repo);
        if (!repo) return false;
        const a = repoAccessSync(user, repo);
        return a === undefined ? repoAccess(user, repo).then((x) => x !== "none") : a !== "none";
      };
      const send = (e: AppEvent) => {
        chain = chain.then(async () => {
          if (await allowed(e)) write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
        }).catch(() => {});
      };
      write(": connected\n\n");
      for (const e of initial) send(e);
      const unsubscribe = subscribe(send);
      const ping = setInterval(() => write(": ping\n\n"), 25_000);
      stop = () => {
        closed = true;
        unsubscribe();
        clearInterval(ping);
      };
    },
    cancel() {
      stop();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
}
