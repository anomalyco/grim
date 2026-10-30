import { createHash } from "node:crypto";
import { MAX_FILE_BYTES } from "./store/types.ts";
import { canEditGitHub, config, guestCreate } from "./config.ts";
import { bearerToken, colorFor, endSession, forgetUser, githubLoginEnabled, participantForUser, repoAccess, sameOrigin, type User } from "./auth.ts";
import * as ops from "./ops.ts";
import type { Ctx } from "./ops.ts";
import { lookupGitHub } from "./github.ts";
import { slugify, type RepoRow } from "./repos.ts";
import { branchCandidates, parseGitHubRepo, validBranch } from "../shared/github.ts";
import { errStatus, isErr } from "./errors.ts";
import type { Participant } from "./rooms.ts";
import { closeRepoShares, getShare, myShare, revokeShare, shareUrl } from "./shares.ts";
import { googleLoginEnabled } from "./google.ts";
import { appTokenInfo, revokeAppToken } from "./tokens.ts";
import { joinedRows, leave, listedRows, recordJoin } from "./workspaces.ts";
import { DEMO_ID } from "./demo.ts";
import { deleteAccount } from "./account.ts";
import { guestFromHeaders } from "./anon.ts";
import { clientIp } from "./proxy.ts";
import { demoGate, isDemoRoom } from "./demo-rooms.ts";

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

/** Who takes a place in a demo room: the browser's guest id (a sign-in-off visitor's too); null for an account (the
 *  demo is for people who aren't signed in) or no id at all (no shared fallback). */
function demoPerson(req: Request, user: User | null, visitor?: Participant): string | null {
  const guest = visitor ?? (user ? null : guestFromHeaders(req));
  return guest && guest.id !== "guest:visitor" ? guest.id : null;
}

/** Anyone may open and edit any folder; only whoever made it (or added the GitHub copy) may remove it (anyone, with sign-in off: nothing is anyone's). */
const canRemove = (user: User | null, r: RepoRow) => !!user && (!config.signIn || (!!r.owner_id && r.owner_id === user.id));

/** The one workspace shape every route returns (GET /api/workspaces, GET /api/workspace/:id, creating one, …). */
export function workspaceJson(r: RepoRow, user: User | null) {
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
    guestCreate: guestCreate(r.id),
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

/**
 * `visitor`: sign-in is off (SIGN_IN), so this request's visitor acts as `user` would, under its guest identity.
 */
export async function handleApi(req: Request, url: URL, ctx: Ctx, user: User | null, visitor?: Participant): Promise<Response> {
  try {
    return await route(req, url, ctx, user, visitor);
  } catch (e) {
    const res = errorResponse(e);
    if (res) return res;
    console.error(`[api] ${req.method} ${url.pathname}:`, e);
    return fail(500, "internal error");
  }
}

async function route(req: Request, url: URL, ctx: Ctx, user: User | null, visitor?: Participant): Promise<Response> {
  const p = url.pathname;
  const m = req.method;
  const db = ctx.repos.db;

  if (p === "/api/server" && m === "GET") {
    return json(
      {
        // shown in apps' server lists
        name: config.serverName || new URL(config.publicUrl).host,
        // false: no accounts at all (SIGN_IN off), every visitor may do everything
        signIn: config.signIn,
        // the landing page at "/" (our hosted site only: MARKETING_SITE)
        marketing: config.marketingSite,
        googleLogin: config.signIn && googleLoginEnabled(),
        githubLogin: config.signIn && githubLoginEnabled(),
        // editable GitHub links (the GitHub App to install); null: GitHub repos are read-only copies
        githubAppSlug: config.githubCopiesEnabled && canEditGitHub() ? config.github.appSlug : null,
        // false: adding GitHub repos is turned off (GITHUB_COPIES), so clients don't offer it
        githubCopies: config.githubCopiesEnabled,
        demoResetMinutes: config.demoResetMinutes,
        // WebSocket protocol versions (2: one socket per workspace, docs/07-workspace-socket.md)
        ws: wsProtocols,
      },
      200,
      { "access-control-allow-origin": "*" },
    );
  }
  // The demo's rooms (demo-rooms.ts): which one is mine, and only its people get in (raw image reads excepted: an
  // <img> sends no guest headers, and reading isn't taking a place).
  const person = demoPerson(req, user, visitor);
  if (p === "/api/demo/room" && m === "POST") {
    // the demo is for hosted servers (sign-in on): a server without sign-in has none
    if (!config.signIn) return fail(404, "this server has no demo");
    if (!csrfOk(req)) return fail(403, "cross-origin request refused");
    if (!person) return fail(400, "the demo needs a guest identity (X-Grimoire-Guest)");
    const room = await demoGate().assign(person, clientIp(req));
    if (!room) return json({ error: "The demo is busy. Try again in a minute." }, 503, { "retry-after": "30" });
    return json({ workspace: room, resetMinutes: config.demoResetMinutes });
  }
  const dm = /^\/api\/workspace\/([^/]+)(?:\/([a-z-]+))?/.exec(p);
  // ("demo" itself is only an alias: never a workspace)
  if (dm && decode(dm[1]!) === "demo") return json({ error: "The demo is opened through POST /api/demo/room", demoRoom: "gone" }, 404);
  if (dm && isDemoRoom(decode(dm[1]!)) && !(m === "GET" && dm[2] === "raw")) {
    const a = person ? await demoGate().admit(decode(dm[1]!), person, clientIp(req)) : "full";
    if (a === "full") return json({ error: "This demo room is full", demoRoom: "full" }, 409);
    if (a === "gone") return json({ error: "This demo room is gone", demoRoom: "gone" }, 404);
  }
  if (!user) {
    // Every folder is public: anyone may read, and guests (the X-Grimoire-Guest headers) edit notes and images too.
    // Creating, listing and removing workspaces, agent links and the account need an account.
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

  // sign-in off: no account to show, rename (a visitor's name is its guest name) or hold app tokens
  if (visitor && (p === "/api/me" || p.startsWith("/api/tokens/"))) return fail(404, "sign-in is off on this server");

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

  if (p === "/api/me" && m === "DELETE") {
    // Deleting my account: sign-ins, agent links, my list, the workspaces I made, me (account.ts). Clears the cookie.
    const { workspaces, failed } = await deleteAccount(ctx, user.id);
    return json({ ok: true, deletedWorkspaces: workspaces.length - failed.length, failedWorkspaces: failed }, 200, { "set-cookie": (await endSession(db, req))[0]! });
  }

  const tm = /^\/api\/tokens\/([^/]+)$/.exec(p);
  if (tm && m === "DELETE") {
    if (!(await revokeAppToken(db, user.id, decode(tm[1]!)))) throw new HttpError(404, "token not found");
    return json({ ok: true });
  }

  if (p === "/api/workspaces" || p.startsWith("/api/workspaces/")) return workspaces(req, url, ctx, user);

  const read = await reads(req, url, ctx, user);
  if (read) return read;

  const w = await noteWrites(req, url, ctx, user, visitor ?? participantForUser(user));
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
 * Changing notes and images: anyone signed in. Guests (`user` null, `actor` the guest) may restore a version of a note
 * (typing goes through the room); creating, renaming and deleting notes and folders and uploading images answer 401
 * "Sign in to …" for them unless the workspace is open to guests (`guestCreate`: the demo). Removing or leaving a
 * workspace and agent links always need an account. null for any other request.
 */
async function noteWrites(req: Request, url: URL, ctx: Ctx, user: User | null, actor: Participant): Promise<Response | null> {
  const p = url.pathname;
  const m = req.method;
  const rm = WORKSPACE_PATH.exec(p);
  if (rm) {
    const id = decode(rm[1]!);
    if (id === "." || id === "..") throw new HttpError(400, "invalid workspace id");
    const repo = await ctx.repos.get(id);
    if (!repo) throw new HttpError(404, "workspace not found");
    const sub = rm[2];
    const write = () => {
      if (repoAccess(repo) !== "write") throw new HttpError(403, "this workspace is read-only");
    };
    // account only: removing a workspace (its maker), leaving it, agent links
    const account = () => {
      if (!user) throw new HttpError(401, "not signed in");
      return user;
    };
    // Guests edit existing notes; creating, renaming and deleting files and uploading images need an account, except
    // in workspaces open to guests (GUEST_CREATE_WORKSPACES: the demo).
    const create = (what: string) => {
      if (!user && !guestCreate(repo.id)) throw new HttpError(401, `Sign in to ${what}`);
    };

    if (!sub && m === "DELETE") {
      if (!canRemove(account(), repo)) throw new HttpError(403, "only whoever made this workspace can remove it");
      // Its share links go with it: stop what agents are running through them first.
      await closeRepoShares(ctx.repos.db, repo.id);
      await ctx.repos.removeRepo(repo.id);
      return json({ ok: true });
    }
    if (sub === "join" && m === "DELETE") {
      // Leave: off my list (opening it again joins it again)
      await leave(ctx.repos.db, account().id, repo.id);
      return json({ ok: true });
    }
    if (sub === "agent-link" && m === "POST") {
      // My agent link for this workspace (one per person per workspace), made on first use.
      const { share, created } = await myShare(ctx.repos.db, repo.id, account().id, null);
      return json({ url: shareUrl(share.id) }, created ? 201 : 200);
    }
    if (repo.status !== "ready") throw new HttpError(409, repo.status === "importing" ? `${repo.id} is still importing` : `${repo.id}: ${repo.error ?? repo.status}`);
    if (sub === "refresh" && m === "POST") {
      if (repo.kind === "github" && !config.githubCopiesEnabled) throw new HttpError(403, "Refreshing GitHub repos is turned off on this server");
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
      create("create notes");
      // a body no note could come from isn't read (JSON escapes a byte in at most 6); the content is checked again
      if (Number(req.headers.get("content-length")) > 6 * MAX_FILE_BYTES + 64 * 1024) throw new HttpError(413, `notes can be at most ${MAX_FILE_BYTES / 1024 / 1024} MB`);
      const b = await body(req);
      const content = b.content === undefined || b.content === null ? undefined : String(b.content);
      return json(await ops.createFile(ctx, repo, str(b.path, "path"), content, actor), 201);
    }
    if (sub === "files" && m === "DELETE") {
      write();
      const folder = url.searchParams.get("folder");
      create(folder ? "delete folders" : "delete notes");
      return json(folder ? await ops.deleteFolder(ctx, repo, folder, actor) : await ops.deleteFile(ctx, repo, query(url, "path"), actor));
    }
    if (sub === "rename" && m === "POST") {
      write();
      const b = await body(req);
      create(b.folder === true ? "rename folders" : "rename notes");
      if (b.folder === true) return json(await ops.renameFolder(ctx, repo, str(b.from, "from"), str(b.to, "to"), actor));
      return json(await ops.renameFile(ctx, repo, str(b.from, "from"), str(b.to, "to"), actor, { ifUntitled: b.ifUntitled === true }));
    }
    if (sub === "images" && m === "POST") {
      const note = query(url, "note");
      write();
      create("upload images");
      // one rate limit per account, or per IP address for guests and visitors (whose ids are their own to pick)
      return json(await upload(req, url, ctx, user && actor.kind !== "guest" ? user.id : `ip:${clientIp(req)}`, actor, repo, note), 201);
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

/** /api/workspace/:id[/<sub>] */
const WORKSPACE_PATH = /^\/api\/workspace\/([^/]+)(?:\/([a-z-]+))?$/;

/**
 * What anyone may read, signed in or not (`user` null): GET /api/workspace/:id and its tree, file, raw, history,
 * diff and search. null for any other request.
 */
async function reads(req: Request, url: URL, ctx: Ctx, user: User | null): Promise<Response | null> {
  const p = url.pathname;
  if (req.method !== "GET") return null;
  const rm = WORKSPACE_PATH.exec(p);
  if (!rm || (rm[2] && !READS.has(rm[2]))) return null;
  const id = decode(rm[1]!);
  if (id === "." || id === "..") throw new HttpError(400, "invalid workspace id");
  const repo = await ctx.repos.get(id);
  if (!repo) throw new HttpError(404, "workspace not found");
  const sub = rm[2];
  if (!sub) return json(workspaceJson(repo, user));
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

const READS = new Set(["tree", "file", "raw", "history", "diff", "search"]);

/** The WebSocket protocol versions this host serves (GET /api/server `ws`): v1 everywhere, 2 where the host wires it. */
let wsProtocols: number[] = [1];

/** The platform entry says which WebSocket protocols it serves (Bun: [1, 2]; Workers once its WorkspaceDO has v2). */
export function setWsProtocols(versions: number[]) {
  wsProtocols = [...versions];
}

/** Personal workspaces being made, per account (one at a time per process). */
const makingPersonal = new Map<string, Promise<{ repo: RepoRow; created: boolean }>>();

/**
 * Where an account lands: its first joined workspace (never the demo), else the first one it made (joined again),
 * else a new "<First name>'s notes" ("My notes" without a name) with a short welcome note.
 */
function personalWorkspace(ctx: Ctx, user: User): Promise<{ repo: RepoRow; created: boolean }> {
  const busy = makingPersonal.get(user.id);
  // a call that waits on another one's making didn't make it
  if (busy) return busy.then(({ repo }) => ({ repo, created: false }));
  const run = (async () => {
    const db = ctx.repos.db;
    const joined = await joinedRows(db, user.id);
    if (joined.length) return { repo: joined[0]!, created: false };
    const owned = await db.get<RepoRow>("SELECT * FROM repos WHERE owner_id = ? AND id != ? ORDER BY created_at LIMIT 1", user.id, DEMO_ID);
    if (owned) {
      await recordJoin(db, user.id, owned.id);
      return { repo: owned, created: false };
    }
    const first = (user.name || "").trim().split(/\s+/)[0]?.slice(0, 40) ?? "";
    const title = first ? `${first}'s notes` : "My notes";
    return { repo: await ctx.repos.createNotesRepo(title, user.id, PERSONAL_README), created: true };
  })().finally(() => makingPersonal.delete(user.id));
  makingPersonal.set(user.id, run);
  return run;
}

const PERSONAL_README = `# Notes

This is your workspace. You aren't thinking of writing yourself are you? Why would you do that?

Share these files with your agent by clicking "Share" at the bottom-left of the page. Your agent gets access to a full filesystem that it can edit with any bash command. It will write files like it normally does, and you can see them here.
`;

/** A new notes folder from `{title}`: its maker owns it and has joined it. */
async function createFolder(ctx: Ctx, user: User, b: Record<string, unknown>) {
  const title = str(typeof b.title === "string" ? b.title.trim() : b.title, "title").slice(0, 100);
  if (/^\.+$/.test(slugify(title))) throw new HttpError(400, "invalid title");
  return ctx.repos.createNotesRepo(title, user.id);
}

export function rawResponse(r: { type: string; bytes: Uint8Array<ArrayBuffer> }): Response {
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
 * POST /api/workspace/:id/images?note=<note path>: one image, as the raw body (its name in `?name=` or X-Filename,
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

/** POST /api/workspaces/join-many: ids per call. */
const MAX_JOIN_MANY = 200;

async function workspaces(req: Request, url: URL, ctx: Ctx, user: User): Promise<Response> {
  const p = url.pathname;
  const m = req.method;
  if (p === "/api/workspaces") {
    // mine (with sign-in off: every workspace, everyone's)
    if (m === "GET") return json((await listedRows(ctx.repos.db, user.id)).map((r) => workspaceJson(r, user)));
    if (m === "POST") {
      const b = await body(req);
      if (b.github !== undefined) {
        // a copy of a GitHub repo (read-only unless asked otherwise), importing in the background
        const { repo, created } = await addGitHub(ctx, user, b);
        await recordJoin(ctx.repos.db, user.id, repo.id);
        return json(workspaceJson(repo, user), created ? 201 : 200);
      }
      return json(workspaceJson(await createFolder(ctx, user, b), user), 201);
    }
    return fail(405, "method not allowed");
  }
  if (p === "/api/workspaces/personal" && m === "POST") {
    // An account's own workspace to land in: its first joined one, else one it made, else a new "<First name>'s notes".
    // `created` is true only on the call that made it (the clients' one-time welcome).
    if (!config.signIn) throw new HttpError(404, "sign-in is off on this server");
    const { repo, created } = await personalWorkspace(ctx, user);
    return json({ ...workspaceJson(repo, user), created }, created ? 201 : 200);
  }
  if (p === "/api/workspaces/join-many" && m === "POST") {
    // Merge a list kept elsewhere into the account (what a browser opened before signing in, the Mac app's saved list
    // for this server): each workspace that still exists is joined; unknown ids are reported, not errors.
    const b = await body(req);
    if (!Array.isArray(b.ids) || b.ids.length > MAX_JOIN_MANY || !b.ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 200)) {
      throw new HttpError(400, `ids must be a list of up to ${MAX_JOIN_MANY} workspace ids`);
    }
    const ids = [...new Set(b.ids as string[])];
    const rows = await Promise.all(ids.map((id) => ctx.repos.get(id)));
    const joined: string[] = [];
    const missing: string[] = [];
    for (const [i, row] of rows.entries()) {
      if (!row) missing.push(ids[i]!);
      // the demo is for people who aren't signed in: never an account's
      else if (row.id === DEMO_ID) continue;
      else {
        await recordJoin(ctx.repos.db, user.id, row.id);
        joined.push(row.id);
      }
    }
    return json({ joined, missing });
  }
  return fail(404, "not found");
}

const GITHUB_COPIES_OFF = "Adding GitHub repos is turned off on this server";

/**
 * POST /api/workspaces {github: URL or owner/name, branch?, readOnly?}. Read-only copies of public repos are open to
 * everyone signed in (looked up anonymously: the user's GitHub token is never sent); editable links need access on
 * GitHub. An existing copy is returned as is; one whose import failed is imported again.
 */
async function addGitHub(ctx: Ctx, user: User, b: Record<string, unknown>): Promise<{ repo: RepoRow; created: boolean }> {
  if (!config.githubCopiesEnabled) throw new HttpError(403, GITHUB_COPIES_OFF);
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
    if (counts.total >= config.githubCopies.max) throw new HttpError(503, `This Grim server already has ${counts.total} GitHub repos, the most it keeps. Ask whoever runs it to remove some.`);
    if (counts.mine >= config.githubCopies.perUser) throw new HttpError(403, `You've added ${counts.mine} GitHub repos, the most one person can. Remove one first.`);
  }
  return ctx.repos.linkGitHub(owner, name, { publicReadOnly: readOnly, userId: user.id, branch, defaultBranch: found?.defaultBranch ?? undefined });
}
