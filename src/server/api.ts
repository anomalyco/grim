import { validateWebhook } from "@pierre/storage";
import { canEditGitHub, config, devLoginEnabled } from "./config.ts";
import {
  bearerToken,
  colorFor,
  githubLoginEnabled,
  participantForUser,
  repoAccess,
  repoAccessSync,
  sameOrigin,
  type Access,
  type User,
} from "./auth.ts";
import { emit, subscribe, type AppEvent } from "./events.ts";
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
import { cleanLabel, closeRepoShares, createShare, embeddedImages, getShare, linkAccess, linkUrl, listShares, noteLinkFor, revokeShare, type ShareRow } from "./shares.ts";
import { googleLoginEnabled } from "./google.ts";
import { appTokenInfo, listAppTokens, revokeAppToken } from "./tokens.ts";
import {
  joinedRows,
  ownerCount,
  leave,
  LINK_ACCESS,
  listMembers,
  parseDomainRule,
  recordJoin,
  removeMember,
  ROLES,
  setMember,
  WorkspaceError,
  workspaceRole,
  type LinkAccess,
  type Role,
} from "./workspaces.ts";
import { parseShellRequest, ShellBusyError, type ShellSessions } from "./shell/session.ts";

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Seconds, for 429s. */
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
}

const fail = (status: number, error: string) => json({ error }, status);

function canRemove(user: User, r: RepoRow) {
  // Only a workspace's owners remove it (whoever added a read-only GitHub copy owns it).
  return workspaceRole(user, r).role === "owner";
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
  // App tokens are sent explicitly, never ambiently like cookies.
  if (bearerToken(req)) return true;
  if (sameOrigin(req)) return true;
  if (req.headers.get("origin")) return false;
  return (req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json");
}

export async function handleApi(req: Request, url: URL, ctx: Ctx, user: User | null): Promise<Response> {
  try {
    return await route(req, url, ctx, user);
  } catch (e) {
    if (e instanceof HttpError && e.retryAfter) return json({ error: e.message }, e.status, { "retry-after": String(e.retryAfter) });
    if (e instanceof HttpError || e instanceof OpError || e instanceof WorkspaceError) return fail(e.status, e.message);
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
    return json({
      githubLogin: githubLoginEnabled(),
      googleLogin: googleLoginEnabled(),
      devLogin: devLoginEnabled(),
      signin: config.signin,
      githubAppSlug: canEditGitHub() ? config.github.appSlug : null,
      storage: config.storage,
    });
  }
  if (p === "/api/server" && m === "GET") {
    return json(
      {
        name: config.serverName || new URL(config.publicUrl).host,
        publicUrl: config.publicUrl,
        signin: config.signin,
        google: googleLoginEnabled(),
        devLogin: devLoginEnabled(),
        version: SERVER_VERSION,
      },
      200,
      { "access-control-allow-origin": "*" },
    );
  }
  // Signed out: may this workspace be opened by anyone with its URL? (decides guest sign-in vs "Sign in to view")
  const pub = /^\/api\/workspaces\/([^/]+)\/public$/.exec(p);
  if (pub && m === "GET") {
    const repo = getRepo(decode(pub[1]!));
    return json({ linkAccess: repo?.link_access ?? "none" });
  }
  // What a note link opens, for the page it lands on (the link itself is the capability).
  const nl = /^\/api\/note-links\/([^/]+)$/.exec(p);
  if (nl && m === "GET") {
    const share = getShare(decode(nl[1]!).toLowerCase());
    const repo = share?.kind === "note" ? getRepo(share.repo_id) : null;
    const access = share && repo ? await linkAccess(share, repo) : "none";
    if (!share || !repo || !share.path || access === "none") return fail(404, "this link doesn't exist or was revoked");
    return json({
      id: share.id,
      workspace: { id: repo.id, title: repo.title },
      ...noteScope({ share, path: share.path, access }),
      server: config.serverName || new URL(config.publicUrl).host,
    });
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
    // Apps learn which of the user's tokens they hold (to revoke it on "Disconnect").
    const bearer = bearerToken(req);
    const token = bearer ? appTokenInfo(bearer) : null;
    return json({ ...me, color: colorFor(user.id), ...(token ? { token } : {}) });
  }

  if (p === "/api/tokens" && m === "GET") return json(listAppTokens(user.id));
  const tm = /^\/api\/tokens\/([^/]+)$/.exec(p);
  if (tm && m === "DELETE") {
    if (!revokeAppToken(user.id, decode(tm[1]!))) throw new HttpError(404, "token not found");
    return json({ ok: true });
  }

  if (p === "/api/workspaces" || p.startsWith("/api/workspaces/")) return workspaces(req, url, ctx, user);

  if (p === "/api/events" && m === "GET") {
    // Warm the access cache so most events can be decided without waiting.
    await Promise.all(listRepoRows().map((r) => repoAccess(user, r)));
    // Current presence for open rooms, so sidebars show who is where before anything changes.
    const initial = ctx.rooms.list().map((r) => ({ type: "presence" as const, repo: r.repo, path: r.path, users: r.participants() }));
    return eventStream(user, initial);
  }

  if (p === "/api/repos") {
    if (m === "GET") {
      // The workspaces this user has joined (plus the default notebook if they may open it).
      const joined = new Set(joinedRows(user).map((j) => j.repo.id));
      const rows = listRepoRows().filter((r) => joined.has(r.id) || r.id === config.notesRepo);
      const access = await Promise.all(rows.map((r) => repoAccess(user, r)));
      return json(rows.map((r, i) => repoJson(r, access[i]!, user)).filter((r) => r.access !== "none"));
    }
    if (m === "POST") {
      const b = await body(req);
      if (b.github !== undefined) {
        const { repo, created } = await addGitHub(ctx, user, b);
        recordJoin(user, repo);
        return json(repoJson(repo, await repoAccess(user, repo), user), created ? 201 : 200);
      }
      const title = str(typeof b.title === "string" ? b.title.trim() : b.title, "title").slice(0, 100);
      if (/^\.+$/.test(slugify(title))) throw new HttpError(400, "invalid title");
      const repo = await ctx.repos.createNotesRepo(title, user.id, linkAccessParam(b.linkAccess));
      return json(repoJson(repo, "write", user), 201);
    }
  }

  const rm = /^\/api\/repos\/([^/]+)(?:\/([a-z]+))?$/.exec(p);
  if (rm) {
    const id = decode(rm[1]!);
    if (id === "." || id === "..") throw new HttpError(400, "invalid repo id");
    const repo = getRepo(id);
    const wsAccess = repo ? await repoAccess(user, repo) : "none";
    // A note link the request carries: that note (plus the images it shows and its history), nothing else.
    const link = repo ? await noteLinkFor(req, url, repo) : null;
    if (!repo || (wsAccess === "none" && !link)) throw new HttpError(404, "repo not found");
    const sub = rm[2];
    if (wsAccess === "none") return noteLinkRoute(req, url, ctx, user, repo, sub, link!);
    const access = wsAccess;
    /** Write access to the workspace (or, for `notePath`, through an editor link to that note). */
    const write = (notePath?: string) => {
      if (access === "write" || (notePath && link?.access === "write" && link.path === ops.path(notePath))) return;
      throw new HttpError(403, "you have read-only access to this repo");
    };
    const actor = participantForUser(user);

    if (!sub && m === "DELETE") {
      if (!canRemove(user, repo)) throw new HttpError(403, "only its owners can remove this folder");
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
        // Your own links (the workspace's owners see everyone's).
        const kind = url.searchParams.get("kind");
        const path = url.searchParams.get("path");
        const wanted = (s: ShareRow) => (!kind || s.kind === kind) && (!path || s.path === ops.path(path));
        const owner = workspaceRole(user, repo).role === "owner";
        return json(listShares(repo.id, owner ? undefined : user.id).filter(wanted).map((s) => ({
          id: s.id,
          url: linkUrl(s),
          label: s.label,
          kind: s.kind,
          path: s.path,
          role: s.role ?? "editor",
          createdAt: s.created_at,
          lastUsedAt: s.last_used_at,
          createdBy: s.creator_name,
          canRevoke: true,
        })));
      }
      if (m === "POST") {
        const b = await body(req);
        if (b.label !== undefined && b.label !== null && typeof b.label !== "string") throw new HttpError(400, "label must be a string");
        // {kind: "note", path, role?}: a link to one note; otherwise an agent link (a shell over the workspace).
        const kind = b.kind === undefined || b.kind === "agent" ? "agent" : b.kind === "note" ? "note" : null;
        if (!kind) throw new HttpError(400, 'kind must be "agent" or "note"');
        if (b.role !== undefined && b.role !== "viewer" && b.role !== "editor") throw new HttpError(400, 'role must be "viewer" or "editor"');
        const role: ShareRow["role"] = b.role === "viewer" ? "viewer" : kind === "note" ? (repo.read_only ? "viewer" : "editor") : null;
        if (role === "editor" && kind === "note" && access !== "write") throw new HttpError(403, "you can only share this note read-only");
        let path: string | null = null;
        if (kind === "note") {
          path = ops.path(str(b.path, "path"));
          if (!(await ctx.repos.tree(repo)).includes(path)) throw new HttpError(404, `${path} not found`);
        }
        const same = (s: ShareRow) => s.kind === kind && s.path === path && (s.role ?? "editor") === (role ?? "editor");
        // {reuse: true}: hand back this person's existing matching link instead of making another.
        if (b.reuse === true) {
          const mine = listShares(repo.id, user.id).find(same);
          if (mine) return json({ id: mine.id, url: linkUrl(mine), kind: mine.kind, path: mine.path, role: mine.role ?? "editor" });
        }
        const share = createShare(repo.id, cleanLabel(b.label), user.id, { kind, path, role });
        return json({ id: share.id, url: linkUrl(share), kind, path, role: role ?? "editor" }, 201);
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
      // Opening a workspace through link access or a domain rule adds it to the user's joined list.
      recordJoin(user, repo);
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
    if (sub === "raw" && m === "GET") {
      // An image from the repo, for notes that show it. Served with its type from the extension, never sniffed;
      // SVGs can't run scripts or load anything.
      return rawResponse(await ops.readRaw(ctx, repo, query(url, "path"), url.searchParams.get("ref") || undefined));
    }
    if (sub === "images" && m === "POST") {
      const note = query(url, "note");
      write(note);
      return json(await upload(req, url, ctx, user, repo, note), 201);
    }
    if (sub === "restore" && m === "POST") {
      const b = await body(req);
      write(str(b.path, "path"));
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
    if (share.created_by !== user.id && workspaceRole(user, repo).role !== "owner") {
      throw new HttpError(403, "only whoever created a link or the folder's owners can revoke it");
    }
    revokeShare(share.id);
    void recheckRooms(ctx, repo.id);
    return json({ ok: true });
  }

  return fail(404, "not found");
}

/**
 * After a workspace's access settings change (link access, domain rule, members, links): close room connections
 * that may no longer do what they could (they reconnect and get what they may do now, or 4403).
 */
async function recheckRooms(ctx: Ctx, repoId: string) {
  for (const room of ctx.rooms.inRepo(repoId)) {
    for (const conn of [...room.conns]) {
      const a = await conn.access?.().catch(() => "none" as const);
      if (a === "none") conn.close(4403, "no access");
      else if (a === "read" && !conn.readOnly) conn.close(1013, "access changed, reconnect");
    }
  }
}

/** Bumped when the API contract changes (GET /api/server). */
const SERVER_VERSION = "2026-10-27.workspaces";

function linkAccessParam(v: unknown): LinkAccess {
  if (v === undefined || v === null) return "none";
  if (typeof v !== "string" || !LINK_ACCESS.includes(v as LinkAccess)) throw new HttpError(400, 'linkAccess must be "none", "view" or "edit"');
  return v as LinkAccess;
}

/**
 * Requests that only a note link lets in: the note itself (details, a one-file tree, its text, history and diffs,
 * restore with an editor link) and the images it shows. Everything else is 403.
 */
async function noteLinkRoute(
  req: Request,
  url: URL,
  ctx: Ctx,
  user: User,
  repo: RepoRow,
  sub: string | undefined,
  link: { share: ShareRow; path: string; access: Access },
): Promise<Response> {
  const m = req.method;
  const outside = () => new HttpError(403, "this link only opens one note");
  const isNote = (p: string | null | undefined) => {
    if (!p || ops.path(p) !== link.path) throw outside();
  };
  if (!sub && m === "GET") return json({ ...repoJson(repo, link.access, user), canRemove: false, canShare: false, scope: noteScope(link) });
  if (repo.status !== "ready") throw new HttpError(409, `${repo.id} is ${repo.status}`);
  if (sub === "tree" && m === "GET") {
    const files = (await ctx.repos.tree(repo)).filter((f) => f === link.path);
    return json({ head: await ctx.store.head(repo.id, repo.branch), files });
  }
  if (sub === "file" && m === "GET") {
    isNote(url.searchParams.get("path"));
    const r = await ops.readFile(ctx, repo, link.path, url.searchParams.get("ref") || undefined);
    return json({ content: r.content, version: r.version, live: r.live });
  }
  if (sub === "history" && m === "GET") {
    isNote(url.searchParams.get("path"));
    const limit = Number(url.searchParams.get("limit") ?? 50) || 50;
    return json(await ops.history(ctx, repo, link.path, limit));
  }
  if (sub === "diff" && m === "GET") {
    isNote(url.searchParams.get("path"));
    return json({ diff: await ops.diff(ctx, repo, query(url, "sha"), link.path) });
  }
  if (sub === "restore" && m === "POST") {
    const b = await body(req);
    isNote(str(b.path, "path"));
    if (link.access !== "write") throw new HttpError(403, "this link is read-only");
    await ops.restoreFile(ctx, repo, link.path, str(b.sha, "sha"), participantForUser(user));
    return json({ ok: true });
  }
  if (sub === "images" && m === "POST") {
    // an editor link adds images next to its note only
    isNote(url.searchParams.get("note"));
    if (link.access !== "write") throw new HttpError(403, "this link is read-only");
    return json(await upload(req, url, ctx, user, repo, link.path), 201);
  }
  if (sub === "raw" && m === "GET") {
    const { path } = ops.imagePath(query(url, "path"));
    const ref = url.searchParams.get("ref") || undefined;
    // Images the note shows now, or at the version being looked at.
    const shown = embeddedImages((await ops.readFile(ctx, repo, link.path).catch(() => ({ content: "" }))).content, link.path);
    if (!shown.has(path) && ref) for (const p of embeddedImages((await ops.readFile(ctx, repo, link.path, ref).catch(() => ({ content: "" }))).content, link.path)) shown.add(p);
    if (!shown.has(path)) throw outside();
    return rawResponse(await ops.readRaw(ctx, repo, path, ref));
  }
  throw outside();
}

function noteScope(link: { share: ShareRow; path: string; access: Access }) {
  const by = link.share.created_by ? (db.query("SELECT name FROM users WHERE id = ?").get(link.share.created_by) as { name: string } | null) : null;
  return { path: link.path, role: link.access === "write" ? "editor" : "viewer", sharedBy: by?.name ?? null };
}

function rawResponse(r: { type: string; bytes: Uint8Array<ArrayBuffer> }): Response {
  // Served with its type from the extension, never sniffed; SVGs can't run scripts or load anything.
  const headers: Record<string, string> = {
    "content-type": r.type,
    "cache-control": "private, max-age=60",
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
  };
  if (r.type === "image/svg+xml") headers["content-security-policy"] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
  return new Response(r.bytes, { headers });
}

/** Image uploads per person (fixed one-minute windows). */
export const uploadLimits = { perMinute: 30 };
const uploadWindows = new Map<string, { start: number; n: number }>();

function uploadAllowed(userId: string): number {
  const now = Date.now();
  for (const [k, w] of uploadWindows) if (now - w.start >= 60_000) uploadWindows.delete(k);
  const w = uploadWindows.get(userId) ?? { start: now, n: 0 };
  uploadWindows.set(userId, w);
  if (w.n >= uploadLimits.perMinute) return Math.max(1, Math.ceil((w.start + 60_000 - now) / 1000));
  w.n++;
  return 0;
}

/** The request body as bytes, refusing more than `max` (413) before or while reading it. */
async function bodyBytes(req: Request, max: number): Promise<Uint8Array<ArrayBuffer>> {
  const length = Number(req.headers.get("content-length") ?? NaN);
  const tooLarge = () => new HttpError(413, `images can be at most ${ops.MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
  if (length > max) throw tooLarge();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (req.body) {
    for await (const chunk of req.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > max) throw tooLarge();
      chunks.push(chunk);
    }
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * POST /api/repos/:id/images?note=<note path>: one image, as the raw body (its name in `?name=` or X-Filename,
 * URL-encoded) or multipart form data (the first file). Stored next to the note and committed at once.
 */
async function upload(req: Request, url: URL, ctx: Ctx, user: User, repo: RepoRow, note: string) {
  const wait = uploadAllowed(user.id);
  if (wait) throw new HttpError(429, `too many uploads; try again in ${wait} s`, wait);
  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  // room for the multipart framing around a file at the limit
  const raw = await bodyBytes(req, ops.MAX_UPLOAD_BYTES + (type.startsWith("multipart/") ? 64 * 1024 : 0));
  let name = url.searchParams.get("name") ?? decode(req.headers.get("x-filename") ?? "");
  let bytes = raw;
  if (type.startsWith("multipart/form-data")) {
    const form = await new Response(raw, { headers: { "content-type": req.headers.get("content-type")! } }).formData().catch(() => null);
    const file = form ? ([...form.values()] as unknown as Array<string | File>).find((v): v is File => typeof v !== "string") : undefined;
    if (!file) throw new HttpError(400, "no file in the form");
    name = file.name || name;
    bytes = new Uint8Array(await file.arrayBuffer());
  }
  return ops.uploadImage(ctx, repo, note, name || "image", bytes, participantForUser(user));
}

async function headOf(ctx: Ctx, repo: RepoRow): Promise<string | null> {
  if (repo.status !== "ready") return null;
  return ctx.store.head(repo.id, repo.branch).catch(() => null);
}

function workspaceItem(repo: RepoRow, user: User, head: string | null, joinedVia?: "member" | "domain" | "link") {
  const role = workspaceRole(user, repo).role;
  return {
    id: repo.id,
    title: repo.title,
    kind: repo.kind,
    role,
    linkAccess: repo.link_access,
    readOnly: !!repo.read_only,
    status: repo.status,
    head,
    ...(joinedVia ? { joinedVia } : {}),
    // The last owner can't leave.
    canLeave: role !== "owner" || ownerCount(repo.id) > 1,
  };
}

/** /api/workspaces…: the joined list, create, details, settings, members, leave. */
async function workspaces(req: Request, url: URL, ctx: Ctx, user: User): Promise<Response> {
  const p = url.pathname;
  const m = req.method;
  if (p === "/api/workspaces") {
    if (m === "GET") {
      const rows = joinedRows(user);
      const heads = await Promise.all(rows.map((r) => headOf(ctx, r.repo)));
      return json(rows.map((r, i) => workspaceItem(r.repo, user, heads[i]!, r.via)).filter((w) => w.role));
    }
    if (m === "POST") {
      const b = await body(req);
      const title = str(typeof b.title === "string" ? b.title.trim() : b.title, "title").slice(0, 100);
      if (/^\.+$/.test(slugify(title))) throw new HttpError(400, "invalid title");
      const repo = await ctx.repos.createNotesRepo(title, user.id, linkAccessParam(b.linkAccess));
      return json({ ...workspaceItem(repo, user, await headOf(ctx, repo), "member"), domainRule: null }, 201);
    }
    return fail(405, "method not allowed");
  }
  const wm = /^\/api\/workspaces\/([^/]+)(?:\/(members|join)(?:\/([^/]+))?)?$/.exec(p);
  if (!wm) return fail(404, "not found");
  const repo = getRepo(decode(wm[1]!));
  const role = repo ? workspaceRole(user, repo).role : null;
  if (!repo || !role || (await repoAccess(user, repo)) === "none") throw new HttpError(404, "folder not found");
  const owner = role === "owner";
  const mustOwn = () => {
    if (!owner) throw new HttpError(403, "only the folder's owners can do this");
  };
  const sub = wm[2];
  if (!sub && m === "GET") {
    return json({
      ...workspaceItem(repo, user, await headOf(ctx, repo)),
      domainRule: repo.domain_rule,
      ownerId: repo.owner_id,
      canRemove: canRemove(user, repo),
      ...(owner ? { members: listMembers(repo.id) } : {}),
    });
  }
  if (!sub && m === "PATCH") {
    mustOwn();
    const b = await body(req);
    const sets: string[] = [];
    const vals: Array<string | null> = [];
    if (b.title !== undefined) {
      const title = str(typeof b.title === "string" ? b.title.trim() : b.title, "title").slice(0, 100);
      sets.push("title = ?");
      vals.push(title);
    }
    if (b.linkAccess !== undefined) {
      sets.push("link_access = ?");
      vals.push(linkAccessParam(b.linkAccess));
    }
    if (b.domainRule !== undefined) {
      let rule: string | null = null;
      if (b.domainRule !== null && b.domainRule !== "") {
        const parsed = typeof b.domainRule === "string" ? parseDomainRule(b.domainRule) : null;
        if (!parsed) throw new HttpError(400, 'domainRule must look like "*@company.com=editor" (roles: editor, viewer)');
        rule = parsed.rule;
      }
      sets.push("domain_rule = ?");
      vals.push(rule);
    }
    if (sets.length) db.query(`UPDATE repos SET ${sets.join(", ")} WHERE id = ?`).run(...vals, repo.id);
    void recheckRooms(ctx, repo.id);
    // Rooms re-check access on their next join; clients refresh their lists.
    emit({ type: "repos" });
    const now = getRepo(repo.id)!;
    return json({ ...workspaceItem(now, user, await headOf(ctx, now)), domainRule: now.domain_rule, ownerId: now.owner_id, members: listMembers(now.id) });
  }
  if (sub === "join" && m === "DELETE" && !wm[3]) {
    leave(user, repo.id);
    void recheckRooms(ctx, repo.id);
    return json({ ok: true });
  }
  if (sub === "members") {
    mustOwn();
    if (!wm[3] && m === "GET") return json(listMembers(repo.id));
    if (!wm[3] && m === "POST") {
      const b = await body(req);
      const role = b.role === undefined ? "editor" : b.role;
      if (typeof role !== "string" || !ROLES.includes(role as Role)) throw new HttpError(400, 'role must be "owner", "editor" or "viewer"');
      const row = setMember(repo.id, str(b.email, "email"), role as Role, user.id);
      void recheckRooms(ctx, repo.id);
      return json(listMembers(repo.id).find((x) => x.id === row.id), 200);
    }
    if (wm[3] && m === "DELETE") {
      removeMember(repo.id, decode(wm[3]));
      void recheckRooms(ctx, repo.id);
      return json({ ok: true });
    }
  }
  return fail(405, "method not allowed");
}

/**
 * POST /api/repos {github: URL or owner/name, branch?, readOnly?}. Read-only copies of public repos are open to
 * everyone signed in (looked up anonymously: the user's GitHub token is never sent); editable links need access on
 * GitHub. An existing copy is returned as is; one whose import failed is imported again.
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
  if (!readOnly && !user.githubToken) throw new HttpError(403, "linking a GitHub repo you can edit needs a GitHub sign-in; add it read-only");

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
  } else if (!found || found.access === "none") {
    throw new HttpError(403, `you don't have access to ${label} on GitHub`);
  }
  const owner = found?.owner ?? ref.owner;
  const name = found?.name ?? ref.name;
  const branch = found ? found.branch : candidates[0];
  const existing = ctx.repos.findGitHub(owner, name, { readOnly, branch });
  if (existing) return existingOr(existing);

  if (readOnly) {
    const counts = ctx.repos.readOnlyCopies(user.id);
    if (counts.total >= config.githubCopies.max) throw new HttpError(503, `This Grimoire already has ${counts.total} GitHub repos, the most it keeps. Ask whoever runs it to remove some.`);
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
