// App tokens (the Mac app), OAuth for native apps (RFC 8252): the app opens the browser at
// /auth/google/start?client=mac&redirect_uri=http://127.0.0.1:<port>/callback&state=&code_challenge= (auth.ts), which
// goes straight to Google; after Google the server redirects to the app's loopback with a one-time code (never the
// token), which the app exchanges with its PKCE verifier at POST /auth/token. Tokens are stored hashed; an app revokes
// its own with DELETE /api/tokens/:id (api.ts).
import { forgetAppToken, randomToken } from "./auth.ts";
import { newId, sha256 } from "./ids.ts";
import type { Db } from "./seams/db.ts";
import { pkceChallenge } from "./google.ts";
import { cleanLabel } from "./shares.ts";

/** How long the code on the loopback redirect can be exchanged (once). */
export const CONNECT_CODE_MS = 60_000;

/** Where an MCP client's token works (RFC 8707 audience): /mcp only. App tokens (no audience) work everywhere. */
export const MCP_AUDIENCE = "mcp";

/** A new token for `userId` (for `audience` only, if given). The secret is returned once; only its hash is kept. */
export async function createAppToken(db: Db, userId: string, label: string, audience: string | null = null): Promise<{ id: string; token: string }> {
  const id = newId("t_");
  const token = `gmt_${randomToken(32)}`;
  await db.run("INSERT INTO app_tokens (id, user_id, token_hash, label, created_at, audience) VALUES (?, ?, ?, ?, ?, ?)", id, userId, sha256(token), label, Date.now(), audience);
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

// ---- the app's sign-in ----

/** A native app's redirect: http://127.0.0.1 or http://[::1] (any port, RFC 8252 §7.3), path /callback. */
export function loopbackRedirect(raw: string | null | undefined): URL | null {
  if (!raw || raw.length > 2000) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" || u.username || u.password || u.hash || u.search) return null;
    if (!["127.0.0.1", "[::1]"].includes(u.hostname) || !u.port || u.pathname !== "/callback") return null;
    return u;
  } catch {
    return null;
  }
}

/** What an app's sign-in asked for (kept in the Google state cookie meanwhile). */
export interface AppSignIn {
  /** the token's label */
  client: string;
  redirect: string;
  state: string;
  /** PKCE S256 challenge: the app proves it started this sign-in when it exchanges the code */
  challenge: string;
}

const CLIENTS: Record<string, string> = { mac: "Grim for Mac" };

/** The app's parameters (`client`, `redirect_uri`, `state`, `code_challenge`, `code_challenge_method=S256`), or why not. */
export function appSignIn(get: (k: string) => string | null | undefined): AppSignIn | string {
  const redirect = loopbackRedirect(get("redirect_uri"));
  if (!redirect) return "The app's redirect address must be on this computer (http://127.0.0.1:<port>/callback).";
  const state = get("state") ?? "";
  if (!/^[\x21-\x7e]{16,200}$/.test(state)) return "The request is missing its state.";
  const challenge = get("code_challenge") ?? "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge) || (get("code_challenge_method") ?? "S256") !== "S256") return "The request is missing its PKCE challenge (S256).";
  const raw = get("client") ?? "";
  return { client: CLIENTS[raw] ?? cleanLabel(raw, 80) ?? "An app", redirect: redirect.toString(), state, challenge };
}

/** Back to the app's loopback with `values` and its state (never cached, never a referrer). */
export function appRedirect(app: AppSignIn, values: Record<string, string>, cookies: string[] = []): Response {
  const u = new URL(app.redirect);
  for (const [k, v] of Object.entries(values)) u.searchParams.set(k, v);
  u.searchParams.set("state", app.state);
  const headers = new Headers({ location: u.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 303, headers });
}

/**
 * A one-time code for `userId` (only its hash is kept), exchangeable once within CONNECT_CODE_MS with the verifier, for
 * a token for `audience` (null: an app token).
 */
export async function issueAppCode(db: Db, userId: string, app: AppSignIn, audience: string | null = null): Promise<string> {
  const code = randomToken(32);
  const now = Date.now();
  await db.run("DELETE FROM connect_codes WHERE expires_at < ?", now);
  await db.run("INSERT INTO connect_codes (code_hash, user_id, label, challenge, expires_at, audience) VALUES (?, ?, ?, ?, ?, ?)", sha256(code), userId, app.client, app.challenge, now + CONNECT_CODE_MS, audience);
  return code;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache" } });

/** What redeeming a one-time code gives: a new app token and whose it is. */
export interface Redeemed {
  token: string;
  tokenId: string;
  /** null: an app token; "mcp": good only at /mcp */
  audience: string | null;
  user: { login: string; name: string | null; email: string | null; email_verified: number };
}

/**
 * A one-time code (from the app's loopback redirect, or an MCP client's OAuth redirect: oauth.ts), once, within
 * CONNECT_CODE_MS, with the verifier of its code_challenge → a new app token. null when any of that fails.
 */
export async function redeemAppCode(db: Db, code: unknown, verifier: unknown, audience: string | null): Promise<Redeemed | null> {
  if (typeof code !== "string" || code.length > 200 || typeof verifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return null;
  const hash = sha256(code);
  const row = await db.get<{ user_id: string; label: string; challenge: string; expires_at: number; audience: string | null }>("SELECT user_id, label, challenge, expires_at, audience FROM connect_codes WHERE code_hash = ?", hash);
  if (!row) return null;
  // Single use: whoever deletes the row has it (a second exchange, even a concurrent one, fails).
  const { changes } = await db.run("DELETE FROM connect_codes WHERE code_hash = ?", hash);
  // (and only where it was made for: the Mac app's codes at /auth/token, MCP clients' at /oauth/token)
  if (changes !== 1 || row.expires_at < Date.now() || (row.audience ?? null) !== audience || (await pkceChallenge(verifier)) !== row.challenge) return null;
  const user = await db.get<Redeemed["user"]>("SELECT login, name, email, email_verified FROM users WHERE id = ?", row.user_id);
  if (!user) return null;
  const { id, token } = await createAppToken(db, row.user_id, row.label, row.audience);
  return { token, tokenId: id, user, audience: row.audience };
}

/** A token request's fields: JSON or form-encoded. */
export async function tokenRequestFields(req: Request): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const body = (await req.json().catch(() => null)) as unknown;
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  }
  const form = await req.formData().catch(() => null);
  return form ? Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === "string" ? v : null])) : {};
}

/**
 * POST /auth/token {code, code_verifier} (JSON or form): the code from the loopback redirect, once, within
 * CONNECT_CODE_MS, with the verifier of the sign-in's code_challenge → {token, token_id, account, login, email}.
 */
export async function exchangeAppCode(db: Db, req: Request): Promise<Response> {
  const f = await tokenRequestFields(req);
  const r = await redeemAppCode(db, f.code, f.code_verifier, null);
  if (!r) return json(400, { error: "invalid_grant" });
  const { user } = r;
  // The app shows which account it's signed in as; the email (the stable identity) tells it another account signed
  // in (its previous account's workspaces then leave the app: docs/accounts.md).
  return json(200, { token: r.token, token_id: r.tokenId, account: user.name || user.login, login: user.login, email: user.email_verified ? user.email : null });
}
