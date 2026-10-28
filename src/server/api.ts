import { createHash } from "node:crypto";
import { validateWebhook } from "@pierre/storage";
import { workspaceIdOf } from "./store/codestorage.ts";
import { canEditGitHub, config, devLoginEnabled } from "./config.ts";
import { bearerToken, colorFor, forgetUser, githubLoginEnabled, participantForUser, repoAccess, sameOrigin, type User } from "./auth.ts";
import { subscribe, type AppEvent } from "./events.ts";
import * as ops from "./ops.ts";
import type { Ctx } from "./ops.ts";
import { lookupGitHub } from "./github.ts";
import { slugify, type RepoRow } from "./repos.ts";
import { branchCandidates, parseGitHubRepo, validBranch } from "../shared/github.ts";
import { errStatus, isErr } from "./errors.ts";
import type { Participant } from "./rooms.ts";
import type { AccessFn } from "./shell/fs.ts";
import { cleanLabel, closeRepoShares, getShare, myShare, revokeShare, shareUrl } from "./shares.ts";
import { googleLoginEnabled } from "./google.ts";
import { appTokenInfo, revokeAppToken } from "./tokens.ts";
import { joinedRows, leave, recordJoin } from "./workspaces.ts";
import { guestFromHeaders } from "./anon.ts";
import { clientIp } from "./proxy.ts";
import { parseShellRequest, type ShellSessions } from "./shell/session.ts";

class HttpError extends Error {
  override name = "HttpError";
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

/** Anyone may open and edit any folder; only whoever made it (or added the GitHub copy) may remove it. */
const canRemove = (user: User | null, r: RepoRow) => !!user && !!r.owner_id && r.owner_id === user.id;

function repoJson(r: RepoRow, user: User | null) {
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
    canRemove: canRemove(user, r),
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

/** The response for a domain error (by name, so errors that crossed Durable Object RPC map the same), or null for a 500. */
export function errorResponse(e: unknown): Response | null {
  const status = errStatus(e);
  if (status === undefined || !(e instanceof Error)) return null;
  if (isErr(e, "HttpError") && typeof e.retryAfter === "number" && e.retryAfter) return json({ error: e.message }, status, { "retry-after": String(e.retryAfter) });
  return fail(status, e.message);
}

export async function handleApi(req: Request, url: URL, ctx: Ctx, user: User | null): Promise<Response> {
  try {
    return await route(req, url, ctx, user);
  } catch (e) {
    const res = errorResponse(e);
    if (res) return res;
    console.error(`[api] ${req.method} ${url.pathname}:`, e);
    return fail(500, "internal error");
  }
}

async function route(req: Request, url: URL, ctx: Ctx, user: User | null): Promise<Response> {
  const p = url.pathname;
  const m = req.method;
  const db = ctx.repos.db;

  if (p === "/api/config" && m === "GET") {
    return json({
      githubLogin: githubLoginEnabled(),
      googleLogin: googleLoginEnabled(),
      devLogin: devLoginEnabled(),
      githubAppSlug: canEditGitHub() ? config.github.appSlug : null,
      storage: config.storage,
    });
  }
  if (p === "/api/server" && m === "GET") {
    return json(
      {
        name: config.serverName || new URL(config.publicUrl).host,
        publicUrl: config.publicUrl,
        google: googleLoginEnabled(),
        devLogin: devLoginEnabled(),
        version: SERVER_VERSION,
      },
      200,
      { "access-control-allow-origin": "*" },
    );
  }
  if (!user) {
    // Every folder is public: anyone may read, and guests (the X-Grimoire-Guest headers) edit notes and images too.
    // Creating and opening folders, agent links and the account need an account.
    const read = await reads(req, url, ctx, null);
    if (read) return read;
    const guest = guestFromHeaders(req);
    if (guest) {
      if (!csrfOk(req)) return fail(403, "cross-origin request refused");
      const w = await noteWrites(req, url, ctx, null, guest);
      if (w) return w;
    }
    return fail(401, "not signed in");
  }
  if (!csrfOk(req)) return fail(403, "cross-origin request refused");

  if (p === "/api/me" && m === "PATCH") {
    const body = (await req.json().catch(() => ({}))) as { name?: unknown };
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
    if (!name) return fail(400, "name required");
    await db.run("UPDATE users SET name = ? WHERE id = ?", name, user.id);
    // The auth cache (AUTH_CACHE=1) would serve the old name until it expires.
    forgetUser(user.id);
    return json({ ok: true, name });
  }
  if (p === "/api/me" && m === "GET") {
    const { githubToken: _, ...me } = user;
    // Apps learn which of the user's tokens they hold (to revoke it on "Disconnect").
    const bearer = bearerToken(req);
    const token = bearer ? await appTokenInfo(db, bearer) : null;
    return json({ ...me, color: colorFor(user.id), ...(token ? { token } : {}) });
  }

  const tm = /^\/api\/tokens\/([^/]+)$/.exec(p);
  if (tm && m === "DELETE") {
    if (!(await revokeAppToken(db, user.id, decode(tm[1]!)))) throw new HttpError(404, "token not found");
    return json({ ok: true });
  }

  if (p === "/api/workspaces" || p.startsWith("/api/workspaces/")) return workspaces(req, url, ctx, user);

  const read = await reads(req, url, ctx, user);
  if (read) return read;

  if (p === "/api/repos") {
    if (m === "POST") {
      const b = await body(req);
      if (b.github !== undefined) {
        const { repo, created } = await addGitHub(ctx, user, b);
        await recordJoin(db, user.id, repo.id);
        return json(repoJson(repo, user), created ? 201 : 200);
      }
      return json(repoJson(await createFolder(ctx, user, b), user), 201);
    }
  }

  const w = await noteWrites(req, url, ctx, user, participantForUser(user));
  if (w) return w;

  const sm = /^\/api\/shares\/([^/]+)$/.exec(p);
  if (sm && m === "DELETE") {
    const share = await getShare(db, decode(sm[1]!).toLowerCase());
    // Other people's links look like unknown ones.
    if (!share || share.created_by !== user.id) throw new HttpError(404, "share link not found");
    await revokeShare(db, share.id);
    return json({ ok: true });
  }

  return fail(404, "not found");
}

/**
 * Changing notes and images: anyone signed in, and guests (`user` null, `actor` the guest). Removing a folder and
 * agent links need an account (401). null for any other request.
 */
async function noteWrites(req: Request, url: URL, ctx: Ctx, user: User | null, actor: Participant): Promise<Response | null> {
  const p = url.pathname;
  const m = req.method;
  const rm = /^\/api\/repos\/([^/]+)(?:\/([a-z]+))?$/.exec(p);
  if (rm) {
    const id = decode(rm[1]!);
    if (id === "." || id === "..") throw new HttpError(400, "invalid repo id");
    const repo = await ctx.repos.get(id);
    if (!repo) throw new HttpError(404, "repo not found");
    const sub = rm[2];
    const write = () => {
      if (repoAccess(repo) !== "write") throw new HttpError(403, "this workspace is read-only");
    };
    // account only: removing a folder (its maker), agent links
    const account = () => {
      if (!user) throw new HttpError(401, "not signed in");
      return user;
    };

    if (!sub && m === "DELETE") {
      if (!canRemove(account(), repo)) throw new HttpError(403, "only whoever made this workspace can remove it");
      // Its share links go with it: stop what agents are running through them first.
      await closeRepoShares(ctx.repos.db, repo.id);
      await ctx.repos.removeRepo(repo.id);
      return json({ ok: true });
    }
    if (sub === "shares" && m === "POST") {
      // My agent link for this folder (one per person per folder), made on first use.
      const me = account();
      const b = await body(req);
      if (b.label !== undefined && b.label !== null && typeof b.label !== "string") throw new HttpError(400, "label must be a string");
      const { share, created } = await myShare(ctx.repos.db, repo.id, me.id, cleanLabel(b.label));
      return json({ id: share.id, url: shareUrl(share.id) }, created ? 201 : 200);
    }
    if (repo.status !== "ready") throw new HttpError(409, repo.status === "importing" ? `${repo.id} is still importing` : `${repo.id}: ${repo.error ?? repo.status}`);
    if (sub === "refresh" && m === "POST") {
      try {
        // Refreshes from GitHub at most every 10 s per repo, however often people click.
        await ctx.repos.refresh(repo, 10_000);
      } catch (e) {
        throw new HttpError(502, `couldn't refresh from GitHub: ${(e as Error).message}`);
      }
      return json({ head: await ctx.repos.host.get(repo.id).head(repo) });
    }
    if (sub === "files" && m === "POST") {
      write();
      const b = await body(req);
      const content = b.content === undefined || b.content === null ? undefined : String(b.content);
      return json(await ops.createFile(ctx, repo, str(b.path, "path"), content, actor), 201);
    }
    if (sub === "files" && m === "DELETE") {
      write();
      const folder = url.searchParams.get("folder");
      return json(folder ? await ops.deleteFolder(ctx, repo, folder, actor) : await ops.deleteFile(ctx, repo, query(url, "path"), actor));
    }
    if (sub === "rename" && m === "POST") {
      write();
      const b = await body(req);
      if (b.folder === true) return json(await ops.renameFolder(ctx, repo, str(b.from, "from"), str(b.to, "to"), actor));
      return json(await ops.renameFile(ctx, repo, str(b.from, "from"), str(b.to, "to"), actor, { ifUntitled: b.ifUntitled === true }));
    }
    if (sub === "images" && m === "POST") {
      const note = query(url, "note");
      write();
      // one rate limit per account, or per IP address for guests
      return json(await upload(req, url, ctx, user ? user.id : `ip:${clientIp(req)}`, actor, repo, note), 201);
    }
    if (sub === "restore" && m === "POST") {
      write();
      const b = await body(req);
      await ops.restoreFile(ctx, repo, str(b.path, "path"), str(b.sha, "sha"), actor);
      return json({ ok: true });
    }
  }

  return null;
}

/**
 * What anyone may read, signed in or not (`user` null): GET /api/events, /api/repos (signed out: just the default
 * notebook), /api/repos/:id and its tree, file, raw, history, diff and search. null for any other request.
 */
async function reads(req: Request, url: URL, ctx: Ctx, user: User | null): Promise<Response | null> {
  const p = url.pathname;
  if (req.method !== "GET") return null;
  if (p === "/api/events") {
    // Current presence for open rooms, so sidebars show who is where before anything changes.
    const initial = ctx.rooms.list().map((r) => ({ type: "presence" as const, repo: r.repo, path: r.path, users: r.participants() }));
    return eventStream(initial);
  }
  if (p === "/api/repos") {
    // The folders this user has joined, plus the default notebook.
    const [rows, mine] = await Promise.all([ctx.repos.list(), user ? joinedRows(ctx.repos.db, user.id) : []]);
    const joined = new Set(mine.map((r) => r.id));
    return json(rows.filter((r) => joined.has(r.id) || r.id === config.notesRepo).map((r) => repoJson(r, user)));
  }
  const rm = /^\/api\/repos\/([^/]+)(?:\/(tree|file|raw|history|diff|search))?$/.exec(p);
  if (!rm) return null;
  const id = decode(rm[1]!);
  if (id === "." || id === "..") throw new HttpError(400, "invalid repo id");
  const repo = await ctx.repos.get(id);
  if (!repo) throw new HttpError(404, "repo not found");
  const sub = rm[2];
  if (!sub) return json(repoJson(repo, user));
  if (repo.status !== "ready") throw new HttpError(409, repo.status === "importing" ? `${repo.id} is still importing` : `${repo.id}: ${repo.error ?? repo.status}`);
  switch (sub) {
    case "tree": {
      // Opening a folder adds it to the user's joined list.
      if (user) await recordJoin(ctx.repos.db, user.id, repo.id);
      // The head from the workspace's runtime, which makes the commits (on Workers the Worker's own cache never hears of them).
      const [files, head] = await Promise.all([ctx.repos.tree(repo), ctx.repos.host.get(repo.id).head(repo)]);
      // The tree is the committed files at the head plus the notes not saved yet, so a hash of the body is its version.
      const text = JSON.stringify({ head, files });
      const etag = `"${createHash("sha1").update(text).digest("base64url")}"`;
      // private, no-cache: browsers keep it and revalidate every time (a 304 when nothing changed).
      const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-cache", etag };
      if (etagMatches(req.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });
      return new Response(text, { headers });
    }
    case "history": {
      const limit = Number(url.searchParams.get("limit") ?? 50) || 50;
      return json(await ops.history(ctx, repo, url.searchParams.get("path") || undefined, limit));
    }
    case "diff":
      return json({ diff: await ops.diff(ctx, repo, query(url, "sha"), url.searchParams.get("path") || undefined) });
    case "file": {
      const r = await ops.readFile(ctx, repo, query(url, "path"), url.searchParams.get("ref") || undefined);
      return json({ content: r.content, version: r.version, live: r.live });
    }
    case "raw":
      // An image from the repo, for notes that show it. Served with its type from the extension, never sniffed;
      // SVGs can't run scripts or load anything.
      return rawResponse(await ops.readRaw(ctx, repo, query(url, "path"), url.searchParams.get("ref") || undefined));
    case "search":
      return json(await ops.search(ctx, repo, url.searchParams.get("q") ?? ""));
  }
  return null;
}

/** Bumped when the API contract changes (GET /api/server). */
const SERVER_VERSION = "2026-10-28.anon";

/** A new notes folder from `{title}`: its maker owns it and has joined it. */
async function createFolder(ctx: Ctx, user: User, b: Record<string, unknown>) {
  const title = str(typeof b.title === "string" ? b.title.trim() : b.title, "title").slice(0, 100);
  if (/^\.+$/.test(slugify(title))) throw new HttpError(400, "invalid title");
  return ctx.repos.createNotesRepo(title, user.id);
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
async function upload(req: Request, url: URL, ctx: Ctx, limitKey: string, actor: Participant, repo: RepoRow, note: string) {
  const wait = uploadAllowed(limitKey);
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
  return ops.uploadImage(ctx, repo, note, name || "image", bytes, actor);
}

/** If-None-Match (a list of tags, or *) names `etag`; weak tags compare equal to strong ones (RFC 9110 §13.1.2). */
function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((t) => {
    const tag = t.trim();
    return tag === "*" || tag.replace(/^W\//, "") === etag;
  });
}

/** The recorded head (repos.head, kept by the head cache's writer) when there is one, else the store's. */
async function headOf(ctx: Ctx, repo: RepoRow & { head?: string | null }): Promise<string | null> {
  if (repo.status !== "ready") return null;
  if (repo.head) return repo.head;
  return ctx.store.head(repo.id, repo.branch).catch(() => null);
}

function workspaceItem(repo: RepoRow, user: User, head: string | null) {
  return { id: repo.id, title: repo.title, kind: repo.kind, readOnly: !!repo.read_only, status: repo.status, head, canRemove: canRemove(user, repo) };
}

/** /api/workspaces…: the joined list, create, details, leave. */
async function workspaces(req: Request, url: URL, ctx: Ctx, user: User): Promise<Response> {
  const p = url.pathname;
  const m = req.method;
  if (p === "/api/workspaces") {
    if (m === "GET") {
      const rows = await joinedRows(ctx.repos.db, user.id);
      const heads = await Promise.all(rows.map((r) => headOf(ctx, r)));
      return json(rows.map((r, i) => workspaceItem(r, user, heads[i]!)));
    }
    if (m === "POST") {
      const repo = await createFolder(ctx, user, await body(req));
      return json(workspaceItem(repo, user, await headOf(ctx, repo)), 201);
    }
    return fail(405, "method not allowed");
  }
  const wm = /^\/api\/workspaces\/([^/]+)(\/join)?$/.exec(p);
  if (!wm) return fail(404, "not found");
  const repo = await ctx.repos.get(decode(wm[1]!));
  if (!repo) throw new HttpError(404, "workspace not found");
  if (!wm[2] && m === "GET") return json({ ...workspaceItem(repo, user, await headOf(ctx, repo)), ownerId: repo.owner_id });
  if (wm[2] && m === "DELETE") {
    await leave(ctx.repos.db, user.id, repo.id);
    return json({ ok: true });
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
    const existing = await ctx.repos.findGitHub(ref.owner, ref.name, { readOnly, branch: explicit });
    if (existing) return existingOr(existing);
  }
  if (!readOnly && !user.githubToken) throw new HttpError(403, "linking a GitHub repo you can edit needs a GitHub sign-in; add it read-only");

  let found;
  try {
    found = await lookupGitHub(ref.owner, ref.name, { token: readOnly ? null : user.githubToken, candidates });
  } catch (e) {
    if (isErr(e, "GitHubLookupError")) throw new HttpError(e.status as number, e.message);
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
  const existing = await ctx.repos.findGitHub(owner, name, { readOnly, branch });
  if (existing) return existingOr(existing);

  if (readOnly) {
    const counts = await ctx.repos.readOnlyCopies(user.id);
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
    if (isErr(e, "HttpError")) return fail(e.status as number, e.message);
    if (isErr(e, "ShellBusyError")) return fail(429, e.message);
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
    // another deployment's repo in the same org (outside our CODE_STORAGE_REPO_PREFIX) is ignored
    const id = workspaceIdOf(payload.repository.id, config.codeStorage.repoPrefix);
    if (id && (await ctx.repos.get(id))) void ctx.repos.pushed(id).catch((e) => console.error(`[webhook] onPush ${id}:`, e));
  }
  return json({ ok: true });
}

/** SSE stream of app events. */
function eventStream(initial: AppEvent[]): Response {
  let stop = () => {};
  const stream = new ReadableStream<string>({
    start(controller) {
      let closed = false;
      const write = (s: string) => {
        if (closed) return;
        try {
          controller.enqueue(s);
        } catch {
          stop();
        }
      };
      const send = (e: AppEvent) => write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
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
