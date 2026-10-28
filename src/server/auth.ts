import { timingSafeEqual } from "node:crypto";
import { config, devLoginEnabled } from "./config.ts";
import { newId, sha256 } from "./ids.ts";
import { isErr } from "./errors.ts";
import { exchangeCode, googleAuthUrl, googleLoginEnabled, verifyIdToken } from "./google.ts";
import { forwardedOrigin, requestProto } from "./proxy.ts";
import { slugify, type RepoRow } from "./repos.ts";
import type { Participant } from "./rooms.ts";
import type { Db } from "./seams/db.ts";
import { TtlCache } from "./ttl-cache.ts";

export interface User {
  id: string;
  login: string;
  name: string;
  email: string;
  avatar: string | null;
  githubToken: string | null;
  /** The email was verified by Google (or GitHub). */
  emailVerified: boolean;
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
  google_sub: string | null;
  email_verified: number;
}

const SESSION_COOKIE = "np_session";
const STATE_COOKIE = "np_oauth_state";
const GOOGLE_COOKIE = "np_google_state";
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
  return config.publicUrl.startsWith("https:") || requestProto(req) === "https:";
}

function cookie(req: Request, name: string, value: string, maxAgeSec: number, path = "/") {
  return `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${isSecure(req) ? "; Secure" : ""}`;
}

const clearState = (req: Request) => cookie(req, STATE_COOKIE, "", 0, STATE_PATH);
const clearGoogle = (req: Request) => cookie(req, GOOGLE_COOKIE, "", 0, STATE_PATH);

export function randomToken(bytes = 32) {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
}

export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function toUser(r: UserRow): User {
  return {
    id: r.id,
    login: r.login,
    name: r.name,
    email: r.email,
    avatar: r.avatar,
    githubToken: r.github_token,
    emailVerified: !!r.email_verified,
  };
}

let lastPrune = 0;

/** The bearer token of a request (an app token), if it sends one. */
export function bearerToken(req: Request): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "");
  return m ? m[1]! : null;
}

/**
 * The signed-in user: an app token (Authorization: Bearer, or `queryToken` for WebSockets) if the request carries
 * one (and then only that), else the session cookie.
 */
export async function authenticate(db: Db, req: Request, queryToken?: string | null): Promise<{ user: User; viaToken: boolean } | null> {
  const token = bearerToken(req) ?? (queryToken || null);
  if (token) {
    const user = await userFromAppToken(db, token);
    return user ? { user, viaToken: true } : null;
  }
  const user = await userFromCookie(db, req);
  return user ? { user, viaToken: false } : null;
}

export async function userFromRequest(db: Db, req: Request): Promise<User | null> {
  return (await authenticate(db, req))?.user ?? null;
}

// ---- auth cache ----
// With config.authCache (Workers), session and app-token lookups are cached per process/isolate: found users for
// AUTH_CACHE_MS, unknown tokens for AUTH_NEGATIVE_MS. Logout and revoke evict in this process only, so a revoked
// session or token may keep working for up to AUTH_CACHE_MS in another isolate (see cloudflare/performance.md).

export const AUTH_CACHE_MS = 60_000;
export const AUTH_NEGATIVE_MS = 10_000;

/** A cached lookup: the user (null = no such session/token), and for app tokens the token id. */
interface AuthEntry {
  user: User | null;
  tokenId?: string;
}

let authCache = new TtlCache<string, AuthEntry>({ max: 10_000 });

/** Drop every cached lookup (tests can pass a clock). */
export function resetAuthCache(now?: () => number) {
  authCache = new TtlCache<string, AuthEntry>({ max: 10_000, now });
}

const cacheOn = () => config.authCache;

function cached(key: string): { user: User | null } | undefined {
  if (!cacheOn()) return undefined;
  const e = authCache.get(key);
  return e && { user: e.user && { ...e.user } };
}

function remember(key: string, user: User | null, tokenId?: string, maxMs = AUTH_CACHE_MS) {
  if (!cacheOn()) return;
  authCache.set(key, { user: user && { ...user }, tokenId }, user ? Math.min(AUTH_CACHE_MS, maxMs) : AUTH_NEGATIVE_MS);
}

/** Forget an app token in this process's auth cache (after it is revoked). */
export function forgetAppToken(tokenId: string) {
  authCache.deleteWhere((e) => e.tokenId === tokenId);
}

/** Forget a user's cached sessions and tokens in this process (after their account row changes, e.g. a rename). */
export function forgetUser(userId: string) {
  authCache.deleteWhere((e) => e.user?.id === userId);
}

/** The user of an active app token (updates its last use about once a minute). */
export async function userFromAppToken(db: Db, token: string): Promise<User | null> {
  if (token.length > 200) return null;
  const key = `t:${sha256(token)}`;
  const hit = cached(key);
  if (hit) return hit.user;
  const row = await db.get<UserRow & { token_id: string; token_used: number | null }>(
    "SELECT u.*, t.id AS token_id, t.last_used_at AS token_used FROM app_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.revoked_at IS NULL",
    sha256(token),
  );
  if (!row) {
    remember(key, null);
    return null;
  }
  const now = Date.now();
  if (!row.token_used || now - row.token_used > 60_000) {
    await db.run("UPDATE app_tokens SET last_used_at = ? WHERE id = ?", now, row.token_id);
  }
  const user = toUser(row);
  remember(key, user, row.token_id);
  return user;
}

async function userFromCookie(db: Db, req: Request): Promise<User | null> {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  // Only the hash of the session token is stored.
  const hash = sha256(token);
  const key = `s:${hash}`;
  const hit = cached(key);
  if (hit) return hit.user;
  const now = Date.now();
  if (now - lastPrune > 3600_000) {
    lastPrune = now;
    await pruneSessions(db, now);
  }
  const row = await db.get<UserRow & { session_expires: number }>(
    "SELECT u.*, s.expires_at AS session_expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?",
    hash,
    now,
  );
  const user = row ? toUser(row) : null;
  remember(key, user, undefined, row ? row.session_expires - now : AUTH_CACHE_MS);
  return user;
}

/** Delete sessions that expired before `now` (Bun: at most hourly from sign-in checks; Workers: a cron). */
export async function pruneSessions(db: Db, now = Date.now()) {
  await db.run("DELETE FROM sessions WHERE expires_at < ?", now);
}

async function createSession(db: Db, userId: string): Promise<string> {
  const token = randomToken();
  await db.run("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)", sha256(token), userId, Date.now() + SESSION_MS);
  return token;
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 303, headers });
}

/** Where to go after signing in: a same-origin path under /app, /start or /connect (anything else falls back to /app). */
export function safeNext(raw: unknown): string {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//") || /[\\\s]/.test(raw)) return "/app";
  try {
    const u = new URL(raw, "http://grimoire.invalid");
    if (u.origin !== "http://grimoire.invalid" || !/^\/(app|start|connect)(\/|$)/.test(u.pathname)) return "/app";
    return u.pathname + u.search + u.hash;
  } catch {
    return "/app";
  }
}

async function loginWithSession(db: Db, req: Request, userId: string, next = "/app"): Promise<Response> {
  return redirect(safeNext(next), [cookie(req, SESSION_COOKIE, await createSession(db, userId), SESSION_MS / 1000), clearState(req), clearGoogle(req)]);
}

function errorPage(req: Request, status: number, message: string): Response {
  const res = htmlPage(status, "Sign-in failed", `<p>${escapeHtml(message)}</p><p><a href="/">Back</a></p>`);
  res.headers.append("set-cookie", clearState(req));
  return res;
}

export function htmlPage(status: number, title: string, body: string, formAction = "'self'"): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#222}input,button{font:inherit;padding:.4rem .6rem}input{width:100%;box-sizing:border-box;margin:.5rem 0}.muted{color:#666;font-size:.9em}.btn{display:inline-block;padding:.4rem .8rem;border:1px solid #bbb;border-radius:6px;text-decoration:none;color:inherit}button.link{border:0;background:none;padding:0;color:#06c;text-decoration:underline;cursor:pointer}.switch{margin-top:1.5rem}</style></head>
<body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'`,
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin",
    },
  });
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Same-origin check for state-changing requests: the Origin header (scheme, host and port) must equal PUBLIC_URL's
 * origin. When PUBLIC_URL is unset or points at localhost (local dev, the default), the request's own origin is
 * accepted too: as it reached us, or as a trusted proxy forwarded it (https://host behind exe.dev's proxy).
 */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    const o = new URL(origin).origin;
    const pub = new URL(config.publicUrl);
    if (o === pub.origin) return true;
    const dev = !process.env.PUBLIC_URL || pub.hostname === "localhost" || pub.hostname === "127.0.0.1" || pub.hostname === "[::1]";
    return dev && (o === new URL(req.url).origin || o === forwardedOrigin(req));
  } catch {
    return false;
  }
}

// ---- routes ----

export async function handleAuthRoute(db: Db, req: Request, url: URL): Promise<Response | null> {
  const p = url.pathname;
  if (p === "/auth/github" && req.method === "GET") {
    if (!githubLoginEnabled()) return errorPage(req, 404, "GitHub login is not configured.");
    const state = randomToken(16);
    const gh = new URL("https://github.com/login/oauth/authorize");
    gh.searchParams.set("client_id", config.github.clientId);
    gh.searchParams.set("redirect_uri", `${config.publicUrl}/auth/github/callback`);
    gh.searchParams.set("scope", "read:user user:email");
    gh.searchParams.set("state", state);
    // The state cookie also carries where to land afterwards ("<state> <next>").
    return redirect(gh.toString(), [cookie(req, STATE_COOKIE, `${state} ${safeNext(url.searchParams.get("next"))}`, 600, STATE_PATH)]);
  }
  if (p === "/auth/github/callback" && req.method === "GET") {
    if (!githubLoginEnabled()) return errorPage(req, 404, "GitHub login is not configured.");
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const [expected, next] = (parseCookies(req)[STATE_COOKIE] ?? "").split(" ");
    if (!state || !code || !expected || !safeEqual(state, expected)) return errorPage(req, 400, "Invalid or expired sign-in attempt. Please try again.");
    try {
      return await githubCallback(db, req, code, safeNext(next));
    } catch (e) {
      console.error("[auth] github callback:", e);
      return errorPage(req, 502, "Could not complete sign-in with GitHub.");
    }
  }
  if (p === "/auth/google" && req.method === "GET") {
    if (!googleLoginEnabled()) return errorPage(req, 404, "Google sign-in is not configured.");
    const state = randomToken(16);
    const nonce = randomToken(16);
    const verifier = randomToken(48);
    // The state cookie carries the nonce, the PKCE verifier, where to land afterwards, and who was signed in (their
    // account gets this Google identity if it has none yet).
    const linking = (await userFromCookie(db, req))?.id ?? "";
    const value = [state, nonce, verifier, Buffer.from(safeNext(url.searchParams.get("next"))).toString("base64url"), Buffer.from(linking).toString("base64url")].join(".");
    return redirect(await googleAuthUrl(state, nonce, verifier), [cookie(req, GOOGLE_COOKIE, value, 600, STATE_PATH)]);
  }
  if (p === "/auth/google/callback" && req.method === "GET") {
    if (!googleLoginEnabled()) return errorPage(req, 404, "Google sign-in is not configured.");
    const fail = (status: number, message: string) => {
      const res = errorPage(req, status, message);
      res.headers.append("set-cookie", clearGoogle(req));
      return res;
    };
    const [expected, nonce, verifier, nextB64, linkB64] = (parseCookies(req)[GOOGLE_COOKIE] ?? "").split(".");
    const state = url.searchParams.get("state");
    if (!state || !expected || !nonce || !verifier || !safeEqual(state, expected)) return fail(400, "Invalid or expired sign-in attempt. Please try again.");
    if (url.searchParams.get("error")) return fail(400, "Sign-in with Google was cancelled.");
    const code = url.searchParams.get("code");
    if (!code) return fail(400, "Invalid or expired sign-in attempt. Please try again.");
    let next = "/app";
    try {
      next = safeNext(Buffer.from(nextB64 ?? "", "base64url").toString("utf8"));
    } catch {
      // keep /app
    }
    try {
      const claims = await verifyIdToken(await exchangeCode(code, verifier), nonce);
      if (!claims.emailVerified) return fail(403, "Your Google account's email address isn't verified.");
      // Signed in when this sign-in started (and still the same account): link Google to that account if it has no
      // Google identity yet, instead of choosing another account.
      const linkId = Buffer.from(linkB64 ?? "", "base64url").toString("utf8");
      const current = linkId ? await userFromCookie(db, req) : null;
      const res: { id: string } | { refusal: string; status?: number } =
        current && current.id === linkId && !(await googleSubOf(db, current.id)) ? await linkGoogle(db, current, claims) : await googleSignIn(db, claims);
      if ("refusal" in res) return fail(res.status ?? 403, res.refusal);
      forgetUser(res.id);
      return await loginWithSession(db, req, res.id, next);
    } catch (e) {
      if (isErr(e, "GoogleError")) return fail(400, `Could not sign in with Google: ${e.message}.`);
      console.error("[auth] google callback:", e);
      return fail(502, "Could not complete sign-in with Google.");
    }
  }
  if (p === "/auth/dev") {
    if (!devLoginEnabled()) return errorPage(req, 404, "Dev login is disabled.");
    if (req.method === "GET") {
      const next = escapeHtml(safeNext(url.searchParams.get("next")));
      return htmlPage(
        200,
        "Dev login",
        `<form method="post" action="/auth/dev"><input type="hidden" name="next" value="${next}"><label>Name<input name="name" required maxlength="60" autofocus></label><button type="submit">Sign in</button></form><p class="muted">This creates a new account with that name. It never signs you into an existing account, even one with the same name.</p>`,
      );
    }
    if (req.method === "POST") {
      if (!sameOrigin(req)) return errorPage(req, 403, "Cross-origin sign-in refused.");
      let name = "";
      let next: unknown = url.searchParams.get("next");
      const type = req.headers.get("content-type") ?? "";
      if (type.includes("application/json")) {
        const body = (await req.json().catch(() => ({}))) as { name?: unknown; next?: unknown };
        name = String(body.name ?? "");
        next = body.next ?? next;
      } else {
        const form = await req.formData().catch(() => null);
        name = String(form?.get("name") ?? "");
        next = form?.get("next") ?? next;
      }
      name = name.trim().slice(0, 60);
      const login = slugify(name);
      if (!login) return errorPage(req, 400, "Please enter a name.");
      return devLogin(db, req, login, name, safeNext(next));
    }
  }
  if (p === "/auth/logout" && req.method === "POST") {
    if (!sameOrigin(req)) return new Response("Cross-origin request refused", { status: 403 });
    return redirect("/", await endSession(db, req));
  }
  if (p.startsWith("/auth/")) return new Response("Not found", { status: 404 });
  return null;
}

/** Sign this browser out: deletes its session; returns the cookie to clear. */
export async function endSession(db: Db, req: Request): Promise<string[]> {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) {
    const hash = sha256(token);
    await db.run("DELETE FROM sessions WHERE token = ?", hash);
    authCache.delete(`s:${hash}`);
  }
  return [cookie(req, SESSION_COOKIE, "", 0)];
}

/** An unused login: `base` plus a short random suffix (name-only accounts never share a login). */
async function freshLogin(db: Db, base: string): Promise<string> {
  const taken = async (login: string) => !!(await db.get("SELECT 1 FROM users WHERE login = ?", login));
  let login = "";
  do login = `${base.slice(0, 40)}-${randomSuffix()}`;
  while (await taken(login));
  return login;
}

const SUFFIX = "abcdefghjkmnpqrstuvwxyz23456789";
function randomSuffix(n = 4): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => SUFFIX[b % SUFFIX.length]).join("");
}

/**
 * A new name-only account: name-only sign-in never signs into an existing account (typing someone's name gives a
 * fresh account with that display name). Returns the user id.
 */
async function createNameOnly(db: Db, name: string, base: string): Promise<string> {
  const login = await freshLogin(db, base);
  const id = newId("dev_");
  await db.run("INSERT INTO users (id, github_id, login, name, email, avatar, github_token, created_at) VALUES (?, NULL, ?, ?, ?, NULL, NULL, ?)", id, login, name, `${login}@dev.grimoire`, Date.now());
  return id;
}

async function devLogin(db: Db, req: Request, login: string, name: string, next: string): Promise<Response> {
  return loginWithSession(db, req, await createNameOnly(db, name, login), next);
}

let githubFetch: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init);

/** Test hook: replace fetch for GitHub API calls (null restores the real one). */
export function setGitHubFetch(fn: ((url: string, init: RequestInit) => Promise<Response>) | null) {
  githubFetch = fn ?? ((url, init) => fetch(url, init));
}

const gh = (path: string, token: string | null) =>
  githubFetch(`https://api.github.com${path}`, {
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), accept: "application/vnd.github+json", "user-agent": "grimoire" },
  });

async function githubCallback(db: Db, req: Request, code: string, next: string): Promise<Response> {
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
  let verified = 0;
  const emailsRes = await gh("/user/emails", token).catch(() => null);
  if (emailsRes?.ok) {
    const emails = (await emailsRes.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
    const primary = emails.find((e) => e.primary && e.verified);
    if (primary) {
      email = primary.email.toLowerCase();
      verified = 1;
    }
  }
  const name = me.name || me.login;
  // Find (and update) or create the account in one statement: github_id is unique.
  const row = await db.get<{ id: string }>(
    `INSERT INTO users (id, github_id, login, name, email, avatar, github_token, created_at, email_verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (github_id) DO UPDATE SET login = excluded.login, name = excluded.name, email = excluded.email, avatar = excluded.avatar,
       github_token = excluded.github_token, email_verified = excluded.email_verified
     RETURNING id`,
    newId("u_"),
    me.id,
    me.login,
    name,
    email,
    me.avatar_url,
    token,
    Date.now(),
    verified,
  );
  forgetUser(row!.id);
  return loginWithSession(db, req, row!.id, next);
}

/**
 * Find or create the user for a Google identity: by Google subject, else an existing account with the same verified
 * email (which gets linked).
 */
async function googleSignIn(db: Db, c: { sub: string; email: string; name: string | null; picture: string | null }): Promise<{ id: string }> {
  const local = c.email.split("@")[0]!;
  const name = c.name ?? local;
  // Each step is one statement; google_sub is unique, so concurrent sign-ins of one identity can't make two
  // accounts (the loser of a race finds the winner's account on the next round).
  for (let attempt = 0; ; attempt++) {
    const bySub = await db.get<{ id: string }>(
      "UPDATE users SET name = ?, email = ?, avatar = COALESCE(?, avatar), email_verified = 1 WHERE google_sub = ? RETURNING id",
      name,
      c.email,
      c.picture,
      c.sub,
    );
    if (bySub) return bySub;
    try {
      // An account with the same verified email and no Google identity gets linked (its name is kept).
      const byEmail = await db.get<{ id: string }>(
        `UPDATE users SET email = ?, avatar = COALESCE(?, avatar), google_sub = ?, email_verified = 1
         WHERE id = (SELECT id FROM users WHERE lower(email) = ? AND email_verified = 1 AND google_sub IS NULL ORDER BY created_at LIMIT 1) AND google_sub IS NULL
         RETURNING id`,
        c.email,
        c.picture,
        c.sub,
        c.email,
      );
      if (byEmail) return byEmail;
      const id = newId("g_");
      await db.run(
        "INSERT INTO users (id, github_id, login, name, email, avatar, github_token, created_at, google_sub, email_verified) VALUES (?, NULL, ?, ?, ?, ?, NULL, ?, ?, 1)",
        id,
        slugify(local) || "user",
        name,
        c.email,
        c.picture,
        Date.now(),
        c.sub,
      );
      return { id };
    } catch (e) {
      if (attempt > 0 || !/UNIQUE/i.test(String((e as Error).message))) throw e;
    }
  }
}

const googleSubOf = async (db: Db, userId: string) => (await db.get<{ google_sub: string | null }>("SELECT google_sub FROM users WHERE id = ?", userId))?.google_sub ?? null;

/**
 * Attach a Google identity to the signed-in account (one without one yet, e.g. a name-only account), unless that
 * Google identity or its email already belongs to another account.
 */
async function linkGoogle(db: Db, u: User, c: { sub: string; email: string; picture: string | null }): Promise<{ id: string } | { refusal: string; status: number }> {
  const email = c.email.trim().toLowerCase();
  // One statement: checks that nobody else has this identity or email, and links it.
  const { changes } = await db.run(
    `UPDATE users SET google_sub = ?2, email = ?3, email_verified = 1, avatar = COALESCE(avatar, ?4) WHERE id = ?1 AND google_sub IS NULL
     AND NOT EXISTS (SELECT 1 FROM users WHERE id != ?1 AND (google_sub = ?2 OR (lower(email) = ?3 AND email_verified = 1)))`,
    u.id,
    c.sub,
    email,
    c.picture,
  );
  if (!changes && (await db.get("SELECT 1 FROM users WHERE id != ?1 AND (google_sub = ?2 OR (lower(email) = ?3 AND email_verified = 1))", u.id, c.sub, email))) {
    return {
      status: 409,
      refusal: `${c.email} already belongs to another Grimoire account, so it can't be added to ${u.name || u.login}. Sign out first to use that account.`,
    };
  }
  return { id: u.id };
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
  /** "owner/name" as GitHub spells it. */
  fullName: string | null;
}

export class GitHubRateLimitError extends Error {
  constructor(readonly resetAt: number | null) {
    const mins = resetAt ? Math.max(1, Math.ceil((resetAt - Date.now()) / 60_000)) : null;
    super(`GitHub's API rate limit was reached${mins ? `; it resets in about ${mins} minute${mins === 1 ? "" : "s"}` : ""}`);
  }
}

/** Look a repo up on GitHub (with the user's token if given). null: not found / not visible. Throws on other failures. */
export async function githubRepoInfo(owner: string, name: string, token: string | null): Promise<GitHubRepoInfo | null> {
  const res = await gh(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, token);
  if (res.status === 404) return null;
  if ((res.status === 403 || res.status === 429) && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after"))) {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const retry = Number(res.headers.get("retry-after"));
    throw new GitHubRateLimitError(reset ? reset * 1000 : retry ? Date.now() + retry * 1000 : null);
  }
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  const r = (await res.json()) as { private?: boolean; default_branch?: string; full_name?: string; permissions?: { push?: boolean; pull?: boolean } };
  return {
    access: r.permissions?.push ? "write" : r.permissions?.pull ? "read" : r.private === false ? "read" : "none",
    private: r.private !== false,
    defaultBranch: r.default_branch ?? null,
    fullName: r.full_name ?? null,
  };
}

/** What anyone signed in may do in a folder: everything, unless it's a read-only copy. */
export const repoAccess = (repo: RepoRow): Access => (repo.read_only ? "read" : "write");
