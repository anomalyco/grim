import { timingSafeEqual } from "node:crypto";
import { sillyName } from "../shared/names.ts";
import { config, devLoginEnabled } from "./config.ts";
import { db, newId, sha256 } from "./db.ts";
import { exchangeCode, GoogleError, googleAuthUrl, googleLoginEnabled, verifyIdToken } from "./google.ts";
import { forwardedOrigin, requestProto } from "./proxy.ts";
import { slugify, type RepoRow } from "./repos.ts";
import type { Participant } from "./rooms.ts";
import { claimInvites, emailListed, normEmail, roleAccess, workspaceRole } from "./workspaces.ts";

export interface User {
  id: string;
  login: string;
  name: string;
  email: string;
  avatar: string | null;
  githubToken: string | null;
  /** The email was verified by Google (or GitHub): domain rules and invites apply. */
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

type Candidate = { login: string; email: string; email_verified: number; google_sub: string | null };

/**
 * Whether the sign-in policy lets this user in: the server's configuration only, the same for every account.
 * SIGNIN=emails: only verified emails on ALLOWED_EMAILS. SIGNIN=open: anyone with Google; GitHub and name-only
 * accounts go by ALLOWED_GITHUB_USERS ("*" = anyone; empty = nobody).
 */
function mayEnter(r: Candidate): boolean {
  if (config.signin === "emails") return !!r.email_verified && emailListed(r.email);
  if (r.google_sub) return true;
  const allowed = config.allowedUsers;
  return allowed.includes("*") || allowed.includes(r.login.toLowerCase());
}

/** Whether the policy currently lets this (already registered) user in. */
const allowedNow = (r: Candidate) => mayEnter(r);

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
export function authenticate(req: Request, queryToken?: string | null): { user: User; viaToken: boolean } | null {
  const token = bearerToken(req) ?? (queryToken || null);
  if (token) {
    const user = userFromAppToken(token);
    return user ? { user, viaToken: true } : null;
  }
  const user = userFromCookie(req);
  return user ? { user, viaToken: false } : null;
}

export function userFromRequest(req: Request): User | null {
  return authenticate(req)?.user ?? null;
}

/** The user of an active app token (updates its last use about once a minute). */
export function userFromAppToken(token: string): User | null {
  if (token.length > 200) return null;
  const row = db
    .query("SELECT u.*, t.id AS token_id, t.last_used_at AS token_used FROM app_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.revoked_at IS NULL")
    .get(sha256(token)) as (UserRow & { token_id: string; token_used: number | null }) | null;
  if (!row || !allowedNow(row)) return null;
  const now = Date.now();
  if (!row.token_used || now - row.token_used > 60_000) {
    db.query("UPDATE app_tokens SET last_used_at = ? WHERE id = ?").run(now, row.token_id);
  }
  return toUser(row);
}

function userFromCookie(req: Request): User | null {
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

/** A user by id, if they may still sign in (the allowlist can change). */
export function userById(id: string): User | null {
  const row = db.query("SELECT * FROM users WHERE id = ?").get(id) as UserRow | null;
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

function loginWithSession(req: Request, userId: string, next = "/app"): Response {
  return redirect(safeNext(next), [cookie(req, SESSION_COOKIE, createSession(userId), SESSION_MS / 1000), clearState(req), clearGoogle(req)]);
}

// ---- who may sign in ----

const PRIVATE_REFUSAL = "This Grimoire is private. Ask whoever runs it to add you to ALLOWED_GITHUB_USERS, or sign in with Google.";

function refusal(c: Candidate): string {
  if (config.signin === "emails") {
    return c.email_verified ? `${c.email} may not sign in to this Grimoire. Ask its owner to add it to ALLOWED_EMAILS.` : "This Grimoire only accepts verified email addresses.";
  }
  return config.allowedUsers.length ? `${c.login} is not in ALLOWED_GITHUB_USERS.` : PRIVATE_REFUSAL;
}

/**
 * Sign a user in: find or create them, applying the sign-in policy atomically. `who` describes the account as it
 * will be after this sign-in. Returns the user id, or a refusal message.
 */
const signIn = db.transaction(
  (find: () => UserRow | null, who: Candidate, create: () => string, update: (row: UserRow) => void): { id: string } | { refusal: string } => {
    const existing = find();
    if (existing) {
      if (!mayEnter({ ...existing, ...who, google_sub: who.google_sub ?? existing.google_sub })) return { refusal: refusal(who) };
      update(existing);
      return { id: existing.id };
    }
    if (!mayEnter(who)) return { refusal: refusal(who) };
    return { id: create() };
  },
);

function errorPage(req: Request, status: number, message: string): Response {
  const res = htmlPage(status, "Sign-in failed", `<p>${escapeHtml(message)}</p><p><a href="/">Back</a></p>`);
  res.headers.append("set-cookie", clearState(req));
  return res;
}

export function htmlPage(status: number, title: string, body: string, formAction = "'self'"): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#222}input,button{font:inherit;padding:.4rem .6rem}input{width:100%;box-sizing:border-box;margin:.5rem 0}</style></head>
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
      return await githubCallback(req, code, safeNext(next));
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
    const linking = userFromCookie(req)?.id ?? "";
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
      const current = linkId ? userFromCookie(req) : null;
      const res: { id: string } | { refusal: string; status?: number } =
        current && current.id === linkId && !googleSubOf(current.id) ? linkGoogle(current, claims) : googleSignIn(claims);
      if ("refusal" in res) return fail(res.status ?? 403, res.refusal);
      return loginWithSession(req, res.id, next);
    } catch (e) {
      if (e instanceof GoogleError) return fail(400, `Could not sign in with Google: ${e.message}.`);
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
        `<form method="post" action="/auth/dev"><input type="hidden" name="next" value="${next}"><label>Name<input name="name" required maxlength="60" autofocus></label><button type="submit">Sign in</button></form>`,
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
      return devLogin(req, login, name, safeNext(next));
    }
  }
  if (p === "/auth/guest" && req.method === "POST") {
    // Someone opened a shared link signed out: give them a fresh account with a generated name.
    if (!devLoginEnabled()) return Response.json({ error: "guest sign-in is disabled" }, { status: 404 });
    if (!sameOrigin(req)) return Response.json({ error: "cross-origin sign-in refused" }, { status: 403 });
    return guestLogin(req);
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

/** An unused login: `base` plus a short random suffix (name-only accounts never share a login). */
function freshLogin(base: string): string {
  const taken = (login: string) => !!db.query("SELECT 1 FROM users WHERE login = ?").get(login);
  let login = "";
  do login = `${base.slice(0, 40)}-${randomSuffix()}`;
  while (taken(login));
  return login;
}

const SUFFIX = "abcdefghjkmnpqrstuvwxyz23456789";
function randomSuffix(n = 4): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => SUFFIX[b % SUFFIX.length]).join("");
}

/**
 * A new name-only account: name-only sign-in never signs into an existing account (typing someone's name gives a
 * fresh account with that display name). Returns the user id, or a refusal message.
 */
function createNameOnly(name: string, base: string): { id: string } | { refusal: string } {
  const login = freshLogin(base);
  const email = `${login}@dev.grimoire`;
  return signIn(
    () => null,
    { login, email, email_verified: 0, google_sub: null },
    () => {
      const id = newId("dev_");
      db.query("INSERT INTO users (id, github_id, login, name, email, avatar, github_token, created_at) VALUES (?, NULL, ?, ?, ?, NULL, NULL, ?)").run(id, login, name, email, Date.now());
      return id;
    },
    () => {},
  );
}

function devLogin(req: Request, login: string, name: string, next: string): Response {
  const res = createNameOnly(name, login);
  if ("refusal" in res) return errorPage(req, 403, res.refusal);
  return loginWithSession(req, res.id, next);
}

/** A new account with a generated name, so a guest never lands in someone else's account. */
function guestLogin(req: Request): Response {
  const name = sillyName();
  const res = createNameOnly(name, name);
  if ("refusal" in res) return Response.json({ error: res.refusal }, { status: 403 });
  const headers = new Headers({ "content-type": "application/json" });
  headers.append("set-cookie", cookie(req, SESSION_COOKIE, createSession(res.id), SESSION_MS / 1000));
  return new Response(JSON.stringify({ name }), { status: 200, headers });
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

async function githubCallback(req: Request, code: string, next: string): Promise<Response> {
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
  const res = signIn(
    () => db.query("SELECT * FROM users WHERE github_id = ?").get(me.id) as UserRow | null,
    { login: me.login, email, email_verified: verified, google_sub: null },
    () => {
      const id = newId("u_");
      db.query("INSERT INTO users (id, github_id, login, name, email, avatar, github_token, created_at, email_verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        id,
        me.id,
        me.login,
        name,
        email,
        me.avatar_url,
        token,
        Date.now(),
        verified,
      );
      return id;
    },
    (row) =>
      db.query("UPDATE users SET login = ?, name = ?, email = ?, avatar = ?, github_token = ?, email_verified = ? WHERE id = ?").run(me.login, name, email, me.avatar_url, token, verified, row.id),
  );
  if ("refusal" in res) return errorPage(req, 403, res.refusal);
  if (verified) claimInvites(res.id, email);
  for (const k of accessCache.keys()) if (k.startsWith(`${res.id}\u0000`)) accessCache.delete(k);
  return loginWithSession(req, res.id, next);
}

/**
 * Find or create the user for a Google identity: by Google subject, else an existing account with the same verified
 * email (which gets linked). Pending invites for the email become memberships.
 */
function googleSignIn(c: { sub: string; email: string; name: string | null; picture: string | null }): { id: string } | { refusal: string } {
  const local = c.email.split("@")[0]!;
  const name = c.name ?? local;
  const res = signIn(
    () =>
      (db.query("SELECT * FROM users WHERE google_sub = ?").get(c.sub) as UserRow | null) ??
      (db.query("SELECT * FROM users WHERE lower(email) = ? AND email_verified = 1 AND google_sub IS NULL ORDER BY created_at LIMIT 1").get(c.email) as UserRow | null),
    { login: slugify(local) || "user", email: c.email, email_verified: 1, google_sub: c.sub },
    () => {
      const id = newId("g_");
      db.query(
        "INSERT INTO users (id, github_id, login, name, email, avatar, github_token, created_at, google_sub, email_verified) VALUES (?, NULL, ?, ?, ?, ?, NULL, ?, ?, 1)",
      ).run(id, slugify(local) || "user", name, c.email, c.picture, Date.now(), c.sub);
      return id;
    },
    (row) =>
      db.query("UPDATE users SET name = CASE WHEN google_sub IS NULL THEN name ELSE ? END, email = ?, avatar = COALESCE(?, avatar), google_sub = ?, email_verified = 1 WHERE id = ?").run(
        name,
        c.email,
        c.picture,
        c.sub,
        row.id,
      ),
  );
  if ("id" in res) claimInvites(res.id, c.email);
  return res;
}

const googleSubOf = (userId: string) => (db.query("SELECT google_sub FROM users WHERE id = ?").get(userId) as { google_sub: string | null } | null)?.google_sub ?? null;

/**
 * Attach a Google identity to the signed-in account (one without one yet, e.g. a name-only account), unless that
 * Google identity or its email already belongs to another account.
 */
const linkGoogle = db.transaction(
  (u: User, c: { sub: string; email: string; picture: string | null }): { id: string } | { refusal: string; status: number } => {
    const taken = db.query("SELECT 1 FROM users WHERE id != ?1 AND (google_sub = ?2 OR (lower(email) = ?3 AND email_verified = 1))").get(u.id, c.sub, normEmail(c.email));
    if (taken) {
      return {
        status: 409,
        refusal: `${c.email} already belongs to another Grimoire account, so it can't be added to ${u.name || u.login}. Sign out first to use that account.`,
      };
    }
    if (!mayEnter({ login: u.login, email: c.email, email_verified: 1, google_sub: c.sub })) return { status: 403, refusal: refusal({ login: u.login, email: c.email, email_verified: 1, google_sub: c.sub }) };
    db.query("UPDATE users SET google_sub = ?, email = ?, email_verified = 1, avatar = COALESCE(avatar, ?) WHERE id = ? AND google_sub IS NULL").run(c.sub, normEmail(c.email), c.picture, u.id);
    claimInvites(u.id, c.email);
    return { id: u.id };
  },
);

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

const accessCache = new Map<string, { access: Access; until: number }>();
const inflight = new Map<string, Promise<Access>>();
const ACCESS_TTL = 5 * 60_000;
const RETRY_TTL = 30_000;

const cacheKey = (u: User, repo: RepoRow) => `${u.id}\u0000${repo.id}`;

/**
 * Access from the workspace role (see workspaces.ts). Editable GitHub repos are also capped by what the user may do
 * on GitHub when they signed in with GitHub (undefined: that isn't known yet).
 */
function staticAccess(u: User, repo: RepoRow): Access | undefined {
  const access = roleAccess(workspaceRole(u, repo).role, repo);
  if (access === "none" || repo.kind !== "github" || repo.read_only || !u.githubToken) return access;
  return undefined;
}

const minAccess = (a: Access, b: Access): Access => (a === "none" || b === "none" ? "none" : a === "read" || b === "read" ? "read" : "write");

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
  return c ? minAccess(c.access, roleAccess(workspaceRole(u, repo).role, repo)) : undefined;
}

export async function repoAccess(u: User, repo: RepoRow): Promise<Access> {
  const known = staticAccess(u, repo);
  if (known) return known;
  const c = accessCache.get(cacheKey(u, repo));
  const gh = c && c.until > Date.now() ? c.access : await refresh(u, repo);
  return minAccess(gh, roleAccess(workspaceRole(u, repo).role, repo));
}

/** Test hook: seed the access cache. */
export function setCachedAccess(userId: string, repoId: string, access: Access, ttlMs = ACCESS_TTL) {
  accessCache.set(`${userId}\u0000${repoId}`, { access, until: Date.now() + ttlMs });
}
