import { validateWebhook } from "@pierre/storage";
import { canEditGitHub, config } from "./config.ts";
import {
  colorFor,
  githubLoginEnabled,
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
import { GitHubLookupError, lookupGitHub } from "./github.ts";
import { getRepo, listRepoRows, slugify, type RepoRow } from "./repos.ts";
import { db } from "./db.ts";
import { branchCandidates, parseGitHubRepo, validBranch } from "../shared/github.ts";
import { NotFoundError } from "./rooms.ts";
import { FileTooLargeError, RepoBusyError, StoreUnavailableError } from "./store/types.ts";
import type { Participant } from "./rooms.ts";
import type { AccessFn } from "./shell/fs.ts";
import { cleanLabel, closeRepoShares, createShare, getShare, listShares, revokeShare, shareUrl } from "./shares.ts";
import { parseShellRequest, ShellBusyError, type ShellSessions } from "./shell/session.ts";

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

function canRemove(user: User, r: RepoRow) {
  // Read-only GitHub copies may be removed by whoever added them, or by anyone once their import failed.
  // Everything else is admin only.
  return user.isAdmin || (r.kind === "github" && !!r.read_only && (r.created_by === user.id || r.status === "error"));
}

/** Writable notebooks need write access to share; read-only ones need read access. */
const canShare = (r: RepoRow, access: Access) => (r.read_only ? access !== "none" : access === "write");

function repoJson(r: RepoRow, access: Access, user: User) {
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
    canRemove: canRemove(user, r),
    canShare: canShare(r, access),
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

/** State-changing requests must be same-origin or JSON (which cross-origin forms can't send without CORS). */
export function csrfOk(req: Request): boolean {
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
    if (e instanceof FileTooLargeError) return fail(413, e.message);
    if (e instanceof StoreUnavailableError) return fail(503, e.message);
    if (e instanceof NotFoundError) return fail(404, e.message);
    console.error(`[api] ${req.method} ${url.pathname}:`, e);
    return fail(500, "internal error");
  }
}

async function route(req: Request, url: URL, ctx: Ctx, user: User | null): Promise<Response> {
  const p = url.pathname;
  const m = req.method;

  if (p === "/api/config" && m === "GET") {
    return json({ githubLogin: githubLoginEnabled(), devLogin: config.allowDevLogin, githubAppSlug: canEditGitHub() ? config.github.appSlug : null, storage: config.storage });
  }
  if (!user) return fail(401, "not signed in");
  if (!csrfOk(req)) return fail(403, "cross-origin request refused");

  if (p === "/api/me" && m === "PATCH") {
    const body = (await req.json().catch(() => ({}))) as { name?: unknown };
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
    if (!name) return fail(400, "name required");
    db.query("UPDATE users SET name = ? WHERE id = ?").run(name, user.id);
    return json({ ok: true, name });
  }
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
      return json(rows.map((r, i) => repoJson(r, access[i]!, user)).filter((r) => r.access !== "none"));
    }
    if (m === "POST") {
      const b = await body(req);
      if (b.github !== undefined) {
        const { repo, created } = await addGitHub(ctx, user, b);
        return json(repoJson(repo, await repoAccess(user, repo), user), created ? 201 : 200);
      }
      const title = str(typeof b.title === "string" ? b.title.trim() : b.title, "title").slice(0, 100);
      if (/^\.+$/.test(slugify(title))) throw new HttpError(400, "invalid title");
      const repo = await ctx.repos.createNotesRepo(title, user.id);
      return json(repoJson(repo, "write", user), 201);
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
      if (!canRemove(user, repo)) throw new HttpError(403, "only admins can remove this repo");
      // Its share links go with it: stop what agents are running through them first.
      closeRepoShares(repo.id);
      await ctx.repos.removeRepo(repo.id);
      return json({ ok: true });
    }
    if (!sub && m === "GET") return json(repoJson(repo, access, user));
    if (sub === "shares") {
      // A link gets the notebook's own access level, so only people who have that level may hand one out.
      if (!canShare(repo, access)) throw new HttpError(403, "you need write access to share this notebook with an agent");
      if (m === "GET") {
        // Your own links (admins see everyone's).
        return json(listShares(repo.id, user.isAdmin ? undefined : user.id).map((s) => ({
          id: s.id,
          url: shareUrl(s.id),
          label: s.label,
          createdAt: s.created_at,
          lastUsedAt: s.last_used_at,
          createdBy: s.creator_name,
          canRevoke: true,
        })));
      }
      if (m === "POST") {
        const b = await body(req);
        if (b.label !== undefined && b.label !== null && typeof b.label !== "string") throw new HttpError(400, "label must be a string");
        // {reuse: true}: hand back this person's existing link for the notebook instead of making another.
        if (b.reuse === true) {
          const [mine] = listShares(repo.id, user.id);
          if (mine) return json({ id: mine.id, url: shareUrl(mine.id) });
        }
        const share = createShare(repo.id, cleanLabel(b.label), user.id);
        return json({ id: share.id, url: shareUrl(share.id) }, 201);
      }
    }
    if (repo.status !== "ready") throw new HttpError(409, repo.status === "importing" ? `${repo.id} is still importing` : `${repo.id}: ${repo.error ?? repo.status}`);
    if (sub === "refresh" && m === "POST") {
      try {
        // Refreshes from GitHub at most every 10 s per repo, however often people click.
        await ctx.repos.refresh(repo, 10_000);
      } catch (e) {
        throw new HttpError(502, `couldn't refresh from GitHub: ${(e as Error).message}`);
      }
      return json({ head: await ctx.store.head(repo.id, repo.branch) });
    }
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

  const sm = /^\/api\/shares\/([^/]+)$/.exec(p);
  if (sm && m === "DELETE") {
    const share = getShare(decode(sm[1]!).toLowerCase());
    const repo = share ? getRepo(share.repo_id) : null;
    const access = repo ? await repoAccess(user, repo) : "none";
    // Unknown links and links to notebooks this user can't see look the same.
    if (!share || !repo || access === "none") throw new HttpError(404, "share link not found");
    if (share.created_by !== user.id && !user.isAdmin && access !== "write") {
      throw new HttpError(403, "only whoever created a link, an admin or someone who can edit the notebook can revoke it");
    }
    revokeShare(share.id);
    return json({ ok: true });
  }

  return fail(404, "not found");
}

/**
 * POST /api/repos {github: URL or owner/name, branch?, readOnly?}. Read-only copies of public repos are open to
 * everyone signed in (looked up anonymously: the user's GitHub token is never sent); editable links need access on
 * GitHub (or admin). An existing copy is returned as is; one whose import failed is imported again.
 */
async function addGitHub(ctx: Ctx, user: User, b: Record<string, unknown>): Promise<{ repo: RepoRow; created: boolean }> {
  const ref = typeof b.github === "string" ? parseGitHubRepo(b.github) : null;
  if (!ref) throw new HttpError(400, "Enter a GitHub repo as owner/name or a github.com URL");
  if (b.branch !== undefined && b.branch !== null && b.branch !== "" && (typeof b.branch !== "string" || !validBranch(b.branch))) throw new HttpError(400, "invalid branch name");
  const explicit = typeof b.branch === "string" && b.branch ? b.branch : undefined;
  // Read-only unless asked otherwise (publicReadOnly is the older name).
  const wantsEdit = b.readOnly === false || b.publicReadOnly === false;
  if (wantsEdit && !canEditGitHub()) throw new HttpError(400, "editing GitHub repos needs Code Storage and the GitHub App; add it read-only");
  const readOnly = !wantsEdit;
  // Branch candidates from a /tree/ or /blob/ URL, longest first (branch names may contain slashes).
  const candidates = explicit ? [explicit] : branchCandidates(ref.rest, ref.kind).map((c) => c.branch);
  if (ref.rest.length && !candidates.length) throw new HttpError(400, "invalid branch name in the URL");
  const label = `${ref.owner}/${ref.name}`;
  const existingOr = async (existing: RepoRow) => ({ repo: existing.status === "error" ? await ctx.repos.retryImport(existing, user.id) : existing, created: false });

  // With an explicit branch a known copy can be returned without asking GitHub.
  if (explicit) {
    const existing = ctx.repos.findGitHub(ref.owner, ref.name, { readOnly, branch: explicit });
    if (existing) return existingOr(existing);
  }
  if (!readOnly && !user.githubToken && !user.isAdmin) throw new HttpError(403, "only admins can link GitHub repos without a GitHub login");

  let found;
  try {
    found = await lookupGitHub(ref.owner, ref.name, { token: readOnly ? null : user.githubToken, candidates });
  } catch (e) {
    if (e instanceof GitHubLookupError) throw new HttpError(e.status, e.message);
    throw e;
  }
  if (readOnly) {
    if (!found) throw new HttpError(404, `${label} wasn't found on GitHub. Check the name; private repos can't be added read-only.`);
    if (found.private) throw new HttpError(403, `${label} is private. Only public repos can be added read-only.`);
  } else if (!user.isAdmin && (!found || found.access === "none")) {
    throw new HttpError(403, `you don't have access to ${label} on GitHub`);
  }
  const owner = found?.owner ?? ref.owner;
  const name = found?.name ?? ref.name;
  const branch = found ? found.branch : candidates[0];
  const existing = ctx.repos.findGitHub(owner, name, { readOnly, branch });
  if (existing) return existingOr(existing);

  if (readOnly) {
    const counts = ctx.repos.readOnlyCopies(user.id);
    if (counts.total >= config.githubCopies.max) throw new HttpError(503, `This Grimoire already has ${counts.total} GitHub repos, the most it keeps. Ask an admin to remove some.`);
    if (counts.mine >= config.githubCopies.perUser) throw new HttpError(403, `You've added ${counts.mine} GitHub repos, the most one person can. Remove one first.`);
  }
  return ctx.repos.linkGitHub(owner, name, { publicReadOnly: readOnly, userId: user.id, branch, defaultBranch: found?.defaultBranch ?? undefined });
}

/** POST /api/shell {command, session?, timeout_seconds?} → {stdout, stderr, exitCode, cwd, truncated?}. The caller authenticates. */
export async function handleShell(req: Request, shells: ShellSessions, actor: Participant, access: AccessFn): Promise<Response> {
  try {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405, { allow: "POST" });
    const r = parseShellRequest(await body(req), req.headers.get("x-shell-session"));
    if (typeof r === "string") throw new HttpError(400, r);
    const out = await shells.exec(actor, r.session ? `http:${r.session}` : "http", access, r.command, { timeoutMs: r.timeoutMs, signal: req.signal });
    return json({ stdout: out.stdout, stderr: out.stderr, exitCode: out.exitCode, cwd: out.cwd, ...(out.truncated ? { truncated: true } : {}) });
  } catch (e) {
    if (e instanceof HttpError) return fail(e.status, e.message);
    if (e instanceof ShellBusyError) return fail(429, e.message);
    console.error("[api] shell:", e);
    return fail(500, "internal error");
  }
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
