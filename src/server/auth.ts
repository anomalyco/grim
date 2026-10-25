import { timingSafeEqual } from "node:crypto";
import { config } from "./config.ts";
import { db, newId, sha256 } from "./db.ts";
import { slugify, type RepoRow } from "./repos.ts";
import type { Participant } from "./rooms.ts";

export interface User {
  id: string;
  login: string;
  name: string;
  email: string;
  avatar: string | null;
  isAdmin: boolean;
  githubToken: string | null;
}

export type Access = "write" | "read" | "none";

interface UserRow {
  id: string;
  github_id: number | null;
  login: string;
  name: string;
  email: string;
  avatar: string | null;
  github_token: string | null;
  is_admin: number;
}

const SESSION_COOKIE = "np_session";
const STATE_COOKIE = "np_oauth_state";
const STATE_PATH = "/auth";
const SESSION_MS = 30 * 24 * 3600 * 1000;

export const githubLoginEnabled = () => Boolean(config.github.clientId && config.github.clientSecret);

// ---- cookies & sessions ----

export function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // ignore malformed cookie values
    }
  }
  return out;
}

function isSecure(req: Request) {
  return config.publicUrl.startsWith("https:") || req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https";
}

function cookie(req: Request, name: string, value: string, maxAgeSec: number, path = "/") {
  return `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${isSecure(req) ? "; Secure" : ""}`;
}

const clearState = (req: Request) => cookie(req, STATE_COOKIE, "", 0, STATE_PATH);

function randomToken(bytes = 32) {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function toUser(r: UserRow): User {
  return { id: r.id, login: r.login, name: r.name, email: r.email, avatar: r.avatar, isAdmin: !!r.is_admin, githubToken: r.github_token };
}

/** Whether the allowlist currently lets this (already registered) user in. Admins are never locked out. */
function allowedNow(r: { login: string; is_admin: number }) {
  if (r.is_admin) return true;
  const allowed = config.allowedUsers;
  return allowed.includes("*") || allowed.includes(r.login.toLowerCase());
}

let lastPrune = 0;

export function userFromRequest(req: Request): User | null {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const now = Date.now();
  if (now - lastPrune > 3600_000) {
    lastPrune = now;
    db.query("DELETE FROM sessions WHERE expires_at < ?").run(now);
  }
  // Only the hash of the session token is stored.
  const row = db
    .query("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?")
    .get(sha256(token), now) as UserRow | null;
  return row && allowedNow(row) ? toUser(row) : null;
}

function createSession(userId: string): string {
  const token = randomToken();
  db.query("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(token), userId, Date.now() + SESSION_MS);
  return token;
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 303, headers });
}

function loginWithSession(req: Request, userId: string): Response {
  return redirect("/", [cookie(req, SESSION_COOKIE, createSession(userId), SESSION_MS / 1000), clearState(req)]);
}

// ---- who may sign in ----

const PRIVATE_REFUSAL = "This Grimoire is private: only its owner may sign in. Ask them to add you to ALLOWED_GITHUB_USERS.";

/**
 * Sign a user in: find or create them, applying the allowlist and the first-user-is-admin rule atomically.
 * Returns the user id, or a refusal message.
 */
const signIn = db.transaction(
  (
    find: () => UserRow | null,
    login: string,
    create: (isAdmin: boolean) => string,
    update: (row: UserRow) => void,
  ): { id: string } | { refusal: string } => {
    const existing = find();
    const count = (db.query("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
    const first = count === 0;
    if (existing) {
      if (!allowedNow(existing)) return { refusal: config.allowedUsers.length ? `${login} is not in ALLOWED_GITHUB_USERS.` : PRIVATE_REFUSAL };
      update(existing);
      return { id: existing.id };
    }
    if (!first && !allowedNow({ login, is_admin: 0 })) {
      return { refusal: config.allowedUsers.length ? `${login} is not in ALLOWED_GITHUB_USERS.` : PRIVATE_REFUSAL };
    }
    return { id: create(first) };
  },
);

function errorPage(req: Request, status: number, message: string): Response {
  const res = htmlPage(status, "Sign-in failed", `<p>${escapeHtml(message)}</p><p><a href="/">Back</a></p>`);
  res.headers.append("set-cookie", clearState(req));
  return res;
}

function htmlPage(status: number, title: string, body: string): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#222}input,button{font:inherit;padding:.4rem .6rem}input{width:100%;box-sizing:border-box;margin:.5rem 0}</style></head>
<body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin",
    },
  });
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Same-origin check for state-changing requests: the Origin header (scheme, host and port) must equal PUBLIC_URL's
 * origin. When PUBLIC_URL points at localhost (local dev, the default), the request's own origin is accepted too.
 */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    const o = new URL(origin).origin;
    const pub = new URL(config.publicUrl);
    if (o === pub.origin) return true;
    const dev = !process.env.PUBLIC_URL || pub.hostname === "localhost" || pub.hostname === "127.0.0.1" || pub.hostname === "[::1]";
    return dev && o === new URL(req.url).origin;
  } catch {
    return false;
  }
}

// ---- routes ----

export async function handleAuthRoute(req: Request, url: URL): Promise<Response | null> {
  const p = url.pathname;
  if (p === "/auth/github" && req.method === "GET") {
    if (!githubLoginEnabled()) return errorPage(req, 404, "GitHub login is not configured.");
    const state = randomToken(16);
    const gh = new URL("https://github.com/login/oauth/authorize");
    gh.searchParams.set("client_id", config.github.clientId);
    gh.searchParams.set("redirect_uri", `${config.publicUrl}/auth/github/callback`);
    gh.searchParams.set("scope", "read:user user:email");
    gh.searchParams.set("state", state);
    return redirect(gh.toString(), [cookie(req, STATE_COOKIE, state, 600, STATE_PATH)]);
  }
  if (p === "/auth/github/callback" && req.method === "GET") {
    if (!githubLoginEnabled()) return errorPage(req, 404, "GitHub login is not configured.");
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const expected = parseCookies(req)[STATE_COOKIE];
    if (!state || !code || !expected || !safeEqual(state, expected)) return errorPage(req, 400, "Invalid or expired sign-in attempt. Please try again.");
    try {
      return await githubCallback(req, code);
    } catch (e) {
      console.error("[auth] github callback:", e);
      return errorPage(req, 502, "Could not complete sign-in with GitHub.");
    }
  }
  if (p === "/auth/dev") {
    if (!config.allowDevLogin) return errorPage(req, 404, "Dev login is disabled.");
    if (req.method === "GET") {
      return htmlPage(
        200,
        "Dev login",
        `<form method="post" action="/auth/dev"><label>Name<input name="name" required maxlength="60" autofocus></label><button type="submit">Sign in</button></form>`,
      );
    }
    if (req.method === "POST") {
      if (!sameOrigin(req)) return errorPage(req, 403, "Cross-origin sign-in refused.");
      let name = "";
      const type = req.headers.get("content-type") ?? "";
      if (type.includes("application/json")) name = String(((await req.json().catch(() => ({}))) as { name?: unknown }).name ?? "");
      else name = String((await req.formData().catch(() => null))?.get("name") ?? "");
      name = name.trim().slice(0, 60);
      const login = slugify(name);
      if (!login) return errorPage(req, 400, "Please enter a name.");
      return devLogin(req, login, name);
    }
  }
  if (p === "/auth/logout" && req.method === "POST") {
    if (!sameOrigin(req)) return new Response("Cross-origin request refused", { status: 403 });
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) db.query("DELETE FROM sessions WHERE token = ?").run(sha256(token));
    return redirect("/", [cookie(req, SESSION_COOKIE, "", 0)]);
  }
  if (p.startsWith("/auth/")) return new Response("Not found", { status: 404 });
  return null;
}

function devLogin(req: Request, login: string, name: string): Response {
  const res = signIn(
    () => db.query("SELECT * FROM users WHERE login = ? AND github_id IS NULL").get(login) as UserRow | null,
    login,
    (isAdmin) => {
      const id = newId("dev_");
      db.query("INSERT INTO users (id, github_id, login, name, email, avatar, github_token, is_admin, created_at) VALUES (?, NULL, ?, ?, ?, NULL, NULL, ?, ?)").run(
        id,
        login,
        name,
        `${login}@dev.grimoire`,
        isAdmin ? 1 : 0,
        Date.now(),
      );
      return id;
    },
    (row) => db.query("UPDATE users SET name = ? WHERE id = ?").run(name, row.id),
  );
  if ("refusal" in res) return errorPage(req, 403, res.refusal);
  return loginWithSession(req, res.id);
}

const gh = (path: string, token: string | null) =>
  fetch(`https://api.github.com${path}`, {
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), accept: "application/vnd.github+json", "user-agent": "grimoire" },
  });

async function githubCallback(req: Request, code: string): Promise<Response> {
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: config.github.clientId,
      client_secret: config.github.clientSecret,
      code,
      redirect_uri: `${config.publicUrl}/auth/github/callback`,
    }),
  });
  const tok = (await tokenRes.json()) as { access_token?: string; error_description?: string };
  if (!tok.access_token) return errorPage(req, 400, tok.error_description ?? "GitHub did not return an access token.");
  const token = tok.access_token;
  const meRes = await gh("/user", token);
  if (!meRes.ok) throw new Error(`GET /user: ${meRes.status}`);
  const me = (await meRes.json()) as { id: number; login: string; name: string | null; avatar_url: string | null };
  let email = `${me.id}+${me.login}@users.noreply.github.com`;
  const emailsRes = await gh("/user/emails", token).catch(() => null);
  if (emailsRes?.ok) {
    const emails = (await emailsRes.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
    const primary = emails.find((e) => e.primary && e.verified);
    if (primary) email = primary.email;
  }
  const name = me.name || me.login;
  const res = signIn(
    () => db.query("SELECT * FROM users WHERE github_id = ?").get(me.id) as UserRow | null,
    me.login,
    (isAdmin) => {
      const id = newId("u_");
      db.query("INSERT INTO users (id, github_id, login, name, email, avatar, github_token, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        id,
        me.id,
        me.login,
        name,
        email,
        me.avatar_url,
        token,
        isAdmin ? 1 : 0,
        Date.now(),
      );
      return id;
    },
    (row) => db.query("UPDATE users SET login = ?, name = ?, email = ?, avatar = ?, github_token = ? WHERE id = ?").run(me.login, name, email, me.avatar_url, token, row.id),
  );
  if ("refusal" in res) return errorPage(req, 403, res.refusal);
  for (const k of accessCache.keys()) if (k.startsWith(`${res.id}\u0000`)) accessCache.delete(k);
  return loginWithSession(req, res.id);
}

// ---- agent tokens ----

export function createAgentToken(name: string, createdBy: string | null): { id: string; token: string } {
  const id = newId("agt_");
  const token = `grim_${randomToken()}`;
  db.query("INSERT INTO agent_tokens (id, name, token_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?)").run(id, name, sha256(token), createdBy, Date.now());
  return { id, token };
}

export function listAgentTokens(): Array<{ id: string; name: string; createdAt: number; lastUsedAt: number | null }> {
  return db.query("SELECT id, name, created_at AS createdAt, last_used_at AS lastUsedAt FROM agent_tokens ORDER BY created_at").all() as Array<{
    id: string;
    name: string;
    createdAt: number;
    lastUsedAt: number | null;
  }>;
}

export function deleteAgentToken(id: string): void {
  db.query("DELETE FROM agent_tokens WHERE id = ?").run(id);
}

export function agentFromRequest(req: Request): { id: string; name: string } | null {
  const m = /^Bearer\s+((?:grim|np_agent)_[A-Za-z0-9_-]+)\s*$/.exec(req.headers.get("authorization") ?? "");
  if (!m) return null;
  const row = db.query("SELECT id, name FROM agent_tokens WHERE token_hash = ?").get(sha256(m[1]!)) as { id: string; name: string } | null;
  if (!row) return null;
  db.query("UPDATE agent_tokens SET last_used_at = ? WHERE id = ?").run(Date.now(), row.id);
  return row;
}

// ---- participants ----

const COLORS = ["#296d9a", "#1a4d65", "#2b6a54", "#826465", "#5c6b57", "#7c4d3a", "#4a5568", "#3d5a80", "#6a5a8c", "#8a5a2b", "#2f6f6f", "#5b5b5b"];

export function colorFor(id: string): string {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return COLORS[(h >>> 0) % COLORS.length]!;
}

export function participantForUser(u: User): Participant {
  return {
    id: u.id,
    name: u.name || u.login,
    email: u.email || `${u.login}@users.noreply.github.com`,
    kind: "human",
    color: colorFor(u.id),
    ...(u.avatar ? { avatar: u.avatar } : {}),
  };
}

export function participantForAgent(a: { id: string; name: string }): Participant {
  return { id: a.id, name: a.name, email: `${slugify(a.name) || "agent"}@agents.grimoire`, kind: "agent", color: colorFor(a.id) };
}

// ---- GitHub repo access ----

export interface GitHubRepoInfo {
  access: Access;
  private: boolean;
  defaultBranch: string | null;
}

/** Look a repo up on GitHub (with the user's token if given). null: not found / not visible. Throws on other failures. */
export async function githubRepoInfo(owner: string, name: string, token: string | null): Promise<GitHubRepoInfo | null> {
  const res = await gh(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, token);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  const r = (await res.json()) as { private?: boolean; default_branch?: string; permissions?: { push?: boolean; pull?: boolean } };
  return {
    access: r.permissions?.push ? "write" : r.permissions?.pull ? "read" : "none",
    private: r.private !== false,
    defaultBranch: r.default_branch ?? null,
  };
}

const accessCache = new Map<string, { access: Access; until: number }>();
const inflight = new Map<string, Promise<Access>>();
const ACCESS_TTL = 5 * 60_000;
const RETRY_TTL = 30_000;

const cacheKey = (u: User, repo: RepoRow) => `${u.id}\u0000${repo.id}`;

function staticAccess(u: User, repo: RepoRow): Access | undefined {
  if (repo.kind === "notes") return "write";
  if (repo.read_only) return "read";
  if (!u.githubToken) return "write";
  return undefined;
}

function refresh(u: User, repo: RepoRow): Promise<Access> {
  const key = cacheKey(u, repo);
  let p = inflight.get(key);
  if (p) return p;
  p = (async () => {
    let access: Access = "none";
    let ttl = ACCESS_TTL;
    try {
      access = (await githubRepoInfo(repo.gh_owner ?? "", repo.gh_name ?? "", u.githubToken))?.access ?? "none";
    } catch {
      // Transient failure or expired token: keep a previous answer if we have one, else deny; retry soon.
      access = accessCache.get(key)?.access ?? "none";
      ttl = RETRY_TTL;
    }
    accessCache.set(key, { access, until: Date.now() + ttl });
    return access;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/**
 * Access without waiting: static rules, or the cached answer (stale answers are returned while a refresh runs in
 * the background). undefined if never checked.
 */
export function repoAccessSync(u: User, repo: RepoRow): Access | undefined {
  const known = staticAccess(u, repo);
  if (known) return known;
  const c = accessCache.get(cacheKey(u, repo));
  if (c && c.until <= Date.now()) void refresh(u, repo);
  return c?.access;
}

export async function repoAccess(u: User, repo: RepoRow): Promise<Access> {
  const known = staticAccess(u, repo);
  if (known) return known;
  const c = accessCache.get(cacheKey(u, repo));
  if (c && c.until > Date.now()) return c.access;
  return refresh(u, repo);
}

/** Test hook: seed the access cache. */
export function setCachedAccess(userId: string, repoId: string, access: Access, ttlMs = ACCESS_TTL) {
  accessCache.set(`${userId}\u0000${repoId}`, { access, until: Date.now() + ttlMs });
}
