// App tokens (the Mac app) and the /connect page that hands one to an app on this machine through a loopback
// redirect. Tokens are stored hashed; an app revokes its own with DELETE /api/tokens/:id (api.ts).
import { devLoginEnabled } from "./config.ts";
import { endSession, escapeHtml, forgetAppToken, githubLoginEnabled, htmlPage, randomToken, sameOrigin, userFromRequest, type User } from "./auth.ts";
import { newId, sha256 } from "./ids.ts";
import type { Db } from "./seams/db.ts";
import { googleLoginEnabled } from "./google.ts";
import { cleanLabel } from "./shares.ts";
import { config } from "./config.ts";

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
export async function handleConnect(db: Db, req: Request, url: URL): Promise<Response> {
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
      const u = new URL("/connect", config.publicUrl);
      u.searchParams.set("client", p.client);
      u.searchParams.set("redirect", p.redirect.toString());
      u.searchParams.set("state", p.state);
      const headers = new Headers({ location: u.pathname + u.search, "cache-control": "no-store" });
      for (const c of await endSession(db, req)) headers.append("set-cookie", c);
      return new Response(null, { status: 303, headers });
    }
    if (!user) return htmlPage(401, "Can't connect", "<p>Your session ended. Go back to the app and try again.</p>");
    if (form?.get("decision") !== "allow") return back(p, { error: "access_denied" });
    const { id, token } = await createAppToken(db, user.id, p.client);
    // The app shows which account it's connected as.
    return back(p, { token, token_id: id, account: user.name || user.login, login: user.login });
  }
  return new Response("Method not allowed", { status: 405 });
}

function signInPage(url: URL, p: ConnectParams): Response {
  const next = encodeURIComponent(url.pathname + url.search);
  const options: string[] = [];
  if (googleLoginEnabled()) options.push(`<p><a class="btn" href="/auth/google?next=${next}">Continue with Google</a></p>`);
  if (githubLoginEnabled()) options.push(`<p><a class="btn" href="/auth/github?next=${next}">Continue with GitHub</a></p>`);
  if (devLoginEnabled()) {
    options.push(
      `<p><a class="btn" href="/auth/dev?next=${next}">Sign in with a name</a></p><p class="muted">Signing in with a name creates a <b>new account</b>: it can't get you back into an account you already have${googleLoginEnabled() ? " (use Google for that)" : ""}.</p>`,
    );
  }
  if (!options.length) options.push("<p>This server has no sign-in configured.</p>");
  return htmlPage(
    200,
    `Sign in to ${serverName()}`,
    `<p><b>${escapeHtml(p.client)}</b> wants to access your workspaces on <b>${escapeHtml(serverName())}</b>. Sign in with the account that has them.</p>${options.join("")}`,
  );
}

function approvePage(p: ConnectParams, user: User): Response {
  const hidden = (k: string, v: string) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`;
  const fields = `${hidden("client", p.client)}${hidden("redirect", p.redirect.toString())}${hidden("state", p.state)}`;
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
