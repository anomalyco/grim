// App tokens (the Mac app) and the /connect page that hands one to an app on this machine: the loopback redirect
// carries a one-time code (never the token), which the app exchanges with its PKCE verifier at POST /connect/token.
// Tokens are stored hashed; an app revokes its own with DELETE /api/tokens/:id (api.ts).
import { endSession, escapeHtml, forgetAppToken, githubLoginEnabled, htmlPage, randomToken, sameOrigin, userFromRequest, type User } from "./auth.ts";
import { newId, sha256 } from "./ids.ts";
import type { Db } from "./seams/db.ts";
import { googleLoginEnabled, pkceChallenge } from "./google.ts";
import { cleanLabel } from "./shares.ts";
import { config } from "./config.ts";

/** How long the code on the loopback redirect can be exchanged (once). */
export const CONNECT_CODE_MS = 120_000;

/** A new token for `userId`. The secret is returned once; only its hash is kept. */
export async function createAppToken(db: Db, userId: string, label: string): Promise<{ id: string; token: string }> {
  const id = newId("t_");
  const token = `gmt_${randomToken(32)}`;
  await db.run("INSERT INTO app_tokens (id, user_id, token_hash, label, created_at) VALUES (?, ?, ?, ?, ?)", id, userId, sha256(token), label, Date.now());
  return { id, token };
}

/** The id and label of the active token `token` (the secret). */
export async function appTokenInfo(db: Db, token: string): Promise<{ id: string; label: string } | null> {
  if (token.length > 200) return null;
  return db.get<{ id: string; label: string }>("SELECT id, label FROM app_tokens WHERE token_hash = ? AND revoked_at IS NULL", sha256(token));
}

/** Revoke one of the user's tokens. Returns false if they have no such active token. */
export async function revokeAppToken(db: Db, userId: string, id: string): Promise<boolean> {
  const { changes } = await db.run("UPDATE app_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL", Date.now(), id, userId);
  if (changes > 0) forgetAppToken(id);
  return changes > 0;
}

// ---- /connect ----

/** Only redirects to this machine: http://127.0.0.1, localhost or [::1], any port. */
export function loopbackRedirect(raw: string | null): URL | null {
  if (!raw || raw.length > 2000) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" || u.username || u.password) return null;
    if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) return null;
    return u;
  } catch {
    return null;
  }
}

interface ConnectParams {
  client: string;
  redirect: URL;
  state: string;
  /** PKCE (S256): the app proves it started this request when it exchanges the code. */
  challenge: string;
}

function params(get: (k: string) => string | null): ConnectParams | string {
  const redirect = loopbackRedirect(get("redirect"));
  if (!redirect) return "The app's redirect address must be on this computer (http://127.0.0.1:<port>/…).";
  const state = get("state") ?? "";
  if (!state || state.length > 200 || /[\x00-\x1f\x7f]/.test(state)) return "The request is missing its state.";
  const challenge = get("code_challenge") ?? "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge) || (get("code_challenge_method") ?? "S256") !== "S256") {
    return "This version of the app can't sign in any more. Update it and try again.";
  }
  return { client: cleanLabel(get("client"), 80) ?? "An app", redirect, state, challenge };
}

function query(p: ConnectParams): URLSearchParams {
  return new URLSearchParams({ client: p.client, redirect: p.redirect.toString(), state: p.state, code_challenge: p.challenge, code_challenge_method: "S256" });
}

function back(p: ConnectParams, values: Record<string, string>): Response {
  const u = new URL(p.redirect);
  for (const [k, v] of Object.entries(values)) u.searchParams.set(k, v);
  u.searchParams.set("state", p.state);
  return new Response(null, { status: 303, headers: { location: u.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

const serverName = () => config.serverName || new URL(config.publicUrl).host;

/**
 * GET /connect?client=&redirect=&state=&code_challenge=&code_challenge_method=S256 (approval page, or sign-in
 * first), POST /connect (approve or deny), POST /connect/token (the app exchanges the code).
 */
export async function handleConnect(db: Db, req: Request, url: URL): Promise<Response> {
  if (url.pathname === "/connect/token") {
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    return exchangeCode(db, req);
  }
  if (req.method === "GET" || req.method === "HEAD") {
    const p = params((k) => url.searchParams.get(k));
    if (typeof p === "string") return htmlPage(400, "Can't connect", `<p>${escapeHtml(p)}</p>`);
    // Cookie sessions only: an app token can't mint more tokens.
    const user = req.headers.get("authorization") ? null : await userFromRequest(db, req);
    if (!user) return signInPage(url, p);
    return approvePage(p, user);
  }
  if (req.method === "POST") {
    if (!sameOrigin(req)) return htmlPage(403, "Can't connect", "<p>Cross-origin request refused.</p>");
    const form = await req.formData().catch(() => null);
    const p = params((k) => {
      const v = form?.get(k);
      return typeof v === "string" ? v : null;
    });
    if (typeof p === "string") return htmlPage(400, "Can't connect", `<p>${escapeHtml(p)}</p>`);
    const user = req.headers.get("authorization") ? null : await userFromRequest(db, req);
    if (form?.get("decision") === "switch") {
      // "Not you?": sign this browser out and show the sign-in options again (same app request).
      const headers = new Headers({ location: `/connect?${query(p)}`, "cache-control": "no-store" });
      for (const c of await endSession(db, req)) headers.append("set-cookie", c);
      return new Response(null, { status: 303, headers });
    }
    if (!user) return htmlPage(401, "Can't connect", "<p>Your session ended. Go back to the app and try again.</p>");
    if (form?.get("decision") !== "allow") return back(p, { error: "access_denied" });
    // Only a short-lived, single-use code goes through the browser (history, logs); the app trades it for the token
    // over a direct request with the verifier only it has.
    const code = randomToken(32);
    const now = Date.now();
    await db.run("DELETE FROM connect_codes WHERE expires_at < ?", now);
    await db.run("INSERT INTO connect_codes (code_hash, user_id, label, challenge, expires_at) VALUES (?, ?, ?, ?, ?)", sha256(code), user.id, p.client, p.challenge, now + CONNECT_CODE_MS);
    return back(p, { code });
  }
  return new Response("Method not allowed", { status: 405 });
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache" } });

/**
 * POST /connect/token {code, code_verifier} (JSON or form): the code from the loopback redirect, once, within
 * CONNECT_CODE_MS, with the verifier of the request's code_challenge → {token, token_id, account, login}.
 */
async function exchangeCode(db: Db, req: Request): Promise<Response> {
  const type = req.headers.get("content-type") ?? "";
  let code: unknown;
  let verifier: unknown;
  if (type.includes("application/json")) {
    const body = (await req.json().catch(() => ({}))) as { code?: unknown; code_verifier?: unknown };
    ({ code, code_verifier: verifier } = body);
  } else {
    const form = await req.formData().catch(() => null);
    code = form?.get("code");
    verifier = form?.get("code_verifier");
  }
  const invalid = () => json(400, { error: "invalid_grant" });
  if (typeof code !== "string" || code.length > 200 || typeof verifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return invalid();
  const hash = sha256(code);
  const row = await db.get<{ user_id: string; label: string; challenge: string; expires_at: number }>("SELECT user_id, label, challenge, expires_at FROM connect_codes WHERE code_hash = ?", hash);
  if (!row) return invalid();
  // Single use: whoever deletes the row has it (a second exchange, even a concurrent one, fails).
  const { changes } = await db.run("DELETE FROM connect_codes WHERE code_hash = ?", hash);
  if (changes !== 1 || row.expires_at < Date.now() || (await pkceChallenge(verifier)) !== row.challenge) return invalid();
  const user = await db.get<{ login: string; name: string | null }>("SELECT login, name FROM users WHERE id = ?", row.user_id);
  if (!user) return invalid();
  const { id, token } = await createAppToken(db, row.user_id, row.label);
  // The app shows which account it's connected as.
  return json(200, { token, token_id: id, account: user.name || user.login, login: user.login });
}

function signInPage(url: URL, p: ConnectParams): Response {
  const next = encodeURIComponent(url.pathname + url.search);
  const options: string[] = [];
  if (googleLoginEnabled()) options.push(`<p><a class="btn" href="/auth/google?next=${next}">Continue with Google</a></p>`);
  if (githubLoginEnabled()) options.push(`<p><a class="btn" href="/auth/github?next=${next}">Continue with GitHub</a></p>`);
  if (!options.length) options.push("<p>Sign-in isn't set up on this server (it needs Google sign-in).</p>");
  return htmlPage(
    200,
    `Sign in to ${serverName()}`,
    `<p><b>${escapeHtml(p.client)}</b> wants to access your workspaces on <b>${escapeHtml(serverName())}</b>. Sign in with the account that has them.</p>${options.join("")}`,
  );
}

function approvePage(p: ConnectParams, user: User): Response {
  const hidden = (k: string, v: string) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`;
  const fields = [...query(p)].map(([k, v]) => hidden(k, v)).join("");
  const who = user.name || user.login;
  const detail = user.emailVerified ? user.email : `@${user.login}`;
  const body = `<p>Allow <b>${escapeHtml(p.client)}</b> to access your workspaces on <b>${escapeHtml(serverName())}</b> as <b class="who">${escapeHtml(who)}</b>?</p>
<p class="account">Signed in as <b>${escapeHtml(who)}</b> <span class="muted">(${escapeHtml(detail)})</span>. The app can open and edit workspaces on this server as this account until you disconnect it in the app.</p>
<form method="post" action="/connect">${fields}
<button type="submit" name="decision" value="allow">Allow as ${escapeHtml(who)}</button> <button type="submit" name="decision" value="deny">Cancel</button></form>
<form method="post" action="/connect" class="switch">${fields}<p>Not you? <button type="submit" name="decision" value="switch" class="link">Sign in as someone else</button></p></form>`;
  // The form's redirect goes to the app's loopback address: allow it in form-action (browsers apply it to redirects).
  return htmlPage(200, "Connect an app", body, `'self' ${p.redirect.origin}`);
}
