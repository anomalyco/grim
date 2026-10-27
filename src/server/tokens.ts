// App tokens (the Mac app) and the /connect page that hands one to an app on this machine through a loopback
// redirect. Tokens are stored hashed; GET/DELETE /api/tokens list and revoke them (api.ts).
import { devLoginEnabled } from "./config.ts";
import { escapeHtml, githubLoginEnabled, htmlPage, randomToken, sameOrigin, userFromRequest, type User } from "./auth.ts";
import { db, newId, sha256 } from "./db.ts";
import { googleLoginEnabled } from "./google.ts";
import { cleanLabel } from "./shares.ts";
import { config } from "./config.ts";

export interface AppTokenInfo {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
}

/** A new token for `userId`. The secret is returned once; only its hash is kept. */
export function createAppToken(userId: string, label: string): { id: string; token: string } {
  const id = newId("t_");
  const token = `gmt_${randomToken(32)}`;
  db.query("INSERT INTO app_tokens (id, user_id, token_hash, label, created_at) VALUES (?, ?, ?, ?, ?)").run(id, userId, sha256(token), label, Date.now());
  return { id, token };
}

export function listAppTokens(userId: string): AppTokenInfo[] {
  const rows = db
    .query("SELECT id, label, created_at, last_used_at FROM app_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC")
    .all(userId) as Array<{ id: string; label: string; created_at: number; last_used_at: number | null }>;
  return rows.map((r) => ({ id: r.id, label: r.label, createdAt: r.created_at, lastUsedAt: r.last_used_at }));
}

/** Revoke one of the user's tokens. Returns false if they have no such active token. */
export function revokeAppToken(userId: string, id: string): boolean {
  return db.query("UPDATE app_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL").run(Date.now(), id, userId).changes > 0;
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
}

function params(get: (k: string) => string | null): ConnectParams | string {
  const redirect = loopbackRedirect(get("redirect"));
  if (!redirect) return "The app's redirect address must be on this computer (http://127.0.0.1:<port>/…).";
  const state = get("state") ?? "";
  if (!state || state.length > 200 || /[\x00-\x1f\x7f]/.test(state)) return "The request is missing its state.";
  return { client: cleanLabel(get("client"), 80) ?? "An app", redirect, state };
}

function back(p: ConnectParams, values: Record<string, string>): Response {
  const u = new URL(p.redirect);
  for (const [k, v] of Object.entries(values)) u.searchParams.set(k, v);
  u.searchParams.set("state", p.state);
  return new Response(null, { status: 303, headers: { location: u.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

const serverName = () => config.serverName || new URL(config.publicUrl).host;

/** GET /connect?client=&redirect=&state= (approval page, or sign-in first), POST /connect (approve or deny). */
export async function handleConnect(req: Request, url: URL): Promise<Response> {
  if (req.method === "GET" || req.method === "HEAD") {
    const p = params((k) => url.searchParams.get(k));
    if (typeof p === "string") return htmlPage(400, "Can't connect", `<p>${escapeHtml(p)}</p>`);
    // Cookie sessions only: an app token can't mint more tokens.
    const user = req.headers.get("authorization") ? null : userFromRequest(req);
    if (!user) return signInPage(url);
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
    const user = req.headers.get("authorization") ? null : userFromRequest(req);
    if (!user) return htmlPage(401, "Can't connect", "<p>Your session ended. Go back to the app and try again.</p>");
    if (form?.get("decision") !== "allow") return back(p, { error: "access_denied" });
    const { token } = createAppToken(user.id, p.client);
    return back(p, { token });
  }
  return new Response("Method not allowed", { status: 405 });
}

function signInPage(url: URL): Response {
  const next = encodeURIComponent(url.pathname + url.search);
  const options: string[] = [];
  if (googleLoginEnabled()) options.push(`<p><a href="/auth/google?next=${next}">Continue with Google</a></p>`);
  if (githubLoginEnabled()) options.push(`<p><a href="/auth/github?next=${next}">Continue with GitHub</a></p>`);
  if (devLoginEnabled()) options.push(`<p><a href="/auth/dev?next=${next}">Sign in with a name</a></p>`);
  if (!options.length) options.push("<p>This server has no sign-in configured.</p>");
  return htmlPage(200, `Sign in to ${serverName()}`, `<p>Sign in to connect an app to your workspaces.</p>${options.join("")}`);
}

function approvePage(p: ConnectParams, user: User): Response {
  const hidden = (k: string, v: string) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`;
  const body = `<p>Allow <b>${escapeHtml(p.client)}</b> to access your workspaces on <b>${escapeHtml(serverName())}</b>?</p>
<p>Signed in as ${escapeHtml(user.name)}${user.emailVerified ? ` (${escapeHtml(user.email)})` : ""}. It will be able to do anything you can in your workspaces until you revoke it in Settings.</p>
<form method="post" action="/connect">${hidden("client", p.client)}${hidden("redirect", p.redirect.toString())}${hidden("state", p.state)}
<button type="submit" name="decision" value="allow">Allow</button> <button type="submit" name="decision" value="deny">Cancel</button></form>`;
  // The form's redirect goes to the app's loopback address: allow it in form-action (browsers apply it to redirects).
  return htmlPage(200, "Connect an app", body, `'self' ${p.redirect.origin}`);
}
