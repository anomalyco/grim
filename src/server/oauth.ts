// OAuth 2.1 for MCP clients (the MCP authorization spec): /mcp (mcp.ts) is the protected resource, this server its
// own authorization server.
//
// - GET /.well-known/oauth-protected-resource[/mcp]: the resource's metadata (RFC 9728), named by the 401's
//   WWW-Authenticate header; GET /.well-known/oauth-authorization-server: the server's (RFC 8414).
// - POST /oauth/register: dynamic client registration (RFC 7591). Clients are public (PKCE, no secret) and nothing is
//   stored: the client id carries its name and redirect URIs (anyone may register any client, as with any open
//   registration; what protects people is the exact redirect match, PKCE and the consent page).
// - GET /oauth/authorize: the person signs in through the usual sign-in (Google) if they aren't, then sees a consent
//   page; POST /oauth/authorize (same origin only) sends the client back with a one-time code (tokens.ts, as for the
//   Mac app).
// - POST /oauth/token: the code and the PKCE verifier → an app token (hashed, 90 days idle, revocable) as the bearer
//   access token, for the audience "mcp" (RFC 8707: the `resource` named, if any, must be this server's /mcp): it works
//   at /mcp and is refused everywhere else (the API, sockets). No refresh tokens: a client signs in again when its
//   token expires.
// Sign-in off (no accounts): none of this exists; /mcp needs no authorization.
import { escapeHtml, githubLoginEnabled, htmlPage, sameOrigin, userFromRequest, type User } from "./auth.ts";
import { config, devLoginEnabled } from "./config.ts";
import { googleLoginEnabled } from "./google.ts";
import type { Db } from "./seams/db.ts";
import { cleanLabel } from "./shares.ts";
import { issueAppCode, MCP_AUDIENCE, redeemAppCode, tokenRequestFields } from "./tokens.ts";

export const MCP_PATH = "/mcp";
export const SCOPE = "workspaces";
const RESOURCE_METADATA = "/.well-known/oauth-protected-resource";

/** The MCP endpoint's URL: the resource tokens are for. */
export const mcpResource = () => `${config.publicUrl}${MCP_PATH}`;

/** The WWW-Authenticate header of a 401 from /mcp: where the resource metadata is (and so how to sign in). */
export function wwwAuthenticate(error?: "invalid_token"): string {
  return `Bearer resource_metadata="${config.publicUrl}${RESOURCE_METADATA}", scope="${SCOPE}"${error ? `, error="${error}"` : ""}`;
}

/** RFC 8707: a `resource` a client names must be this server's /mcp (or the server itself); none is fine too. */
function validResource(raw: unknown): boolean {
  if (raw === undefined || raw === null || raw === "") return true;
  if (typeof raw !== "string") return false;
  const r = raw.replace(/\/+$/, "");
  return r === mcpResource() || r === config.publicUrl;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
  "access-control-max-age": "86400",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", pragma: "no-cache", ...CORS } });
}

const oauthError = (error: string, description: string, status = 400) => json({ error, error_description: description }, status);

// ---- clients ----

interface Client {
  name: string;
  redirects: string[];
}

const CLIENT_PREFIX = "gmc_";
const MAX_REDIRECTS = 10;
const MAX_REDIRECT_LEN = 1000;
/** Schemes a redirect may never use (private-use schemes like cursor:// or vscode:// are fine: RFC 8252 §7.1). */
const BAD_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "about:", "blob:", "ftp:", "ws:", "wss:"]);
const isLoopback = (host: string) => host === "127.0.0.1" || host === "[::1]" || host === "localhost";

/** A redirect URI a client may register: https, http on this computer (loopback), or a private-use scheme. */
function validRedirect(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw || raw.length > MAX_REDIRECT_LEN) return null;
  try {
    const u = new URL(raw);
    if (u.hash || u.username || u.password || BAD_SCHEMES.has(u.protocol)) return null;
    if (u.protocol === "http:" && !isLoopback(u.hostname)) return null;
    return raw;
  } catch {
    return null;
  }
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

function encodeClient(c: Client): string {
  return CLIENT_PREFIX + b64(JSON.stringify({ n: c.name, r: c.redirects }));
}

function decodeClient(id: unknown): Client | null {
  if (typeof id !== "string" || !id.startsWith(CLIENT_PREFIX) || id.length > 16_000) return null;
  try {
    const v = JSON.parse(Buffer.from(id.slice(CLIENT_PREFIX.length), "base64url").toString("utf8")) as { n?: unknown; r?: unknown };
    if (typeof v.n !== "string" || !Array.isArray(v.r) || !v.r.length || v.r.length > MAX_REDIRECTS) return null;
    const redirects = v.r.map(validRedirect);
    if (redirects.some((r) => !r)) return null;
    return { name: cleanLabel(v.n, 80) ?? "An MCP client", redirects: redirects as string[] };
  } catch {
    return null;
  }
}

/** The registered redirect `raw` matches: exactly, or for a loopback address with any port (RFC 8252 §7.3). */
function matchRedirect(c: Client, raw: string | null): string | null {
  if (!raw) return c.redirects.length === 1 ? c.redirects[0]! : null;
  if (c.redirects.includes(raw)) return raw;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" || !isLoopback(u.hostname)) return null;
  for (const r of c.redirects) {
    const v = new URL(r);
    if (v.protocol === "http:" && v.hostname === u.hostname && v.pathname === u.pathname && v.search === u.search) return raw;
  }
  return null;
}

async function register(req: Request): Promise<Response> {
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b || typeof b !== "object" || Array.isArray(b)) return oauthError("invalid_client_metadata", "expected a JSON object");
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > MAX_REDIRECTS) return oauthError("invalid_redirect_uri", `redirect_uris must list 1 to ${MAX_REDIRECTS} URIs`);
  const redirects = uris.map(validRedirect);
  if (redirects.some((r) => !r)) return oauthError("invalid_redirect_uri", "redirect URIs must be https, http on a loopback address, or a private-use scheme");
  const grants = Array.isArray(b.grant_types) ? b.grant_types : ["authorization_code"];
  if (!grants.includes("authorization_code")) return oauthError("invalid_client_metadata", "only the authorization_code grant is supported");
  const client: Client = { name: cleanLabel(b.client_name, 80) ?? "An MCP client", redirects: redirects as string[] };
  return json(
    {
      client_id: encodeClient(client),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: client.name,
      redirect_uris: client.redirects,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      // public clients: PKCE instead of a secret
      token_endpoint_auth_method: "none",
      scope: SCOPE,
    },
    201,
  );
}

// ---- authorize ----

interface AuthRequest {
  client: Client;
  clientId: string;
  redirect: string;
  state: string | null;
  challenge: string;
}

/** The authorization request's parameters: valid, an error to send back to the client, or one to show (no safe redirect). */
function parseAuthRequest(get: (k: string) => string | null): AuthRequest | { show: string } | { back: Response } {
  const clientId = get("client_id");
  const client = decodeClient(clientId);
  if (!client) return { show: "This app isn't registered with this Grim server (unknown client_id). Try connecting again from the app." };
  const redirect = matchRedirect(client, get("redirect_uri"));
  if (!redirect) return { show: "This app asked to be sent back to an address it didn't register (redirect_uri). Try connecting again from the app." };
  const state = get("state");
  const back = (error: string, description: string) => ({ back: backTo(redirect, state, { error, error_description: description }) });
  if (state !== null && state.length > 2000) return back("invalid_request", "state is too long");
  if (get("response_type") !== "code") return back("unsupported_response_type", "only response_type=code is supported");
  const challenge = get("code_challenge") ?? "";
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge) || get("code_challenge_method") !== "S256") return back("invalid_request", "PKCE is required: code_challenge with code_challenge_method=S256");
  if (!validResource(get("resource"))) return back("invalid_target", `this server only issues tokens for ${mcpResource()}`);
  return { client, clientId: clientId!, redirect, state, challenge };
}

/** Back to the client's redirect URI with `values` (and its state), never cached, never a referrer. */
function backTo(redirect: string, state: string | null, values: Record<string, string>): Response {
  const u = new URL(redirect);
  for (const [k, v] of Object.entries(values)) u.searchParams.set(k, v);
  if (state !== null) u.searchParams.set("state", state);
  u.searchParams.set("iss", config.publicUrl);
  return new Response(null, { status: 303, headers: { location: u.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

/** Where to sign in first, coming back to `next` (this authorize URL). */
function signInUrl(next: string): string {
  const q = `next=${encodeURIComponent(next)}`;
  if (googleLoginEnabled()) return `/auth/google?${q}`;
  if (githubLoginEnabled()) return `/auth/github?${q}`;
  return devLoginEnabled() ? `/auth/dev?${q}` : `/auth/google?${q}`;
}

const FIELDS = ["response_type", "client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope", "resource"];

/** form-action for the consent page: this origin and the client's redirect (browsers apply it to the redirect too). */
function formAction(redirect: string): string {
  const u = new URL(redirect);
  const target = u.protocol === "http:" || u.protocol === "https:" ? u.origin : u.protocol;
  return `'self' ${target}`;
}

async function authorizeGet(db: Db, req: Request, url: URL): Promise<Response> {
  const a = parseAuthRequest((k) => url.searchParams.get(k));
  if ("show" in a) return htmlPage(400, "Can't connect", `<p>${escapeHtml(a.show)}</p>`);
  if ("back" in a) return a.back;
  const user = await userFromRequest(db, req);
  if (!user) return new Response(null, { status: 303, headers: { location: signInUrl(url.pathname + url.search), "cache-control": "no-store" } });
  const hidden = FIELDS.map((k) => {
    const v = url.searchParams.get(k);
    return v === null ? "" : `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`;
  }).join("");
  return consentPage(a, user, hidden);
}

/** "Allow <client> to access your Grim workspaces?", in the app's look; only Allow issues a code. */
function consentPage(a: AuthRequest, user: User, hidden: string): Response {
  const target = new URL(a.redirect);
  const where = target.protocol === "http:" || target.protocol === "https:" ? target.host : `${target.protocol}//${target.host}`;
  const host = new URL(config.publicUrl).host;
  const who = user.email && !user.email.endsWith(".invalid") ? user.email : user.name || user.login;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Allow ${escapeHtml(a.client.name)}? · Grim</title><meta name="color-scheme" content="light">
<style>
:root{--paper:#fcfcfb;--ink:#1d1e22;--ink-2:#3f3f46;--muted:#62626a;--line:rgba(24,24,27,.12);--tint:#f4f4f5;--font:-apple-system,BlinkMacSystemFont,"Inter",system-ui,"Segoe UI",Roboto,Arial,sans-serif}
*{box-sizing:border-box}html,body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.5 var(--font);-webkit-font-smoothing:antialiased}
main{max-width:420px;margin:12vh auto 0;padding:0 20px}
.mark{font:600 11px/1 var(--font);letter-spacing:.32em;color:#a3a3aa;margin-bottom:28px}
h1{font-size:20px;line-height:1.3;font-weight:650;margin:0 0 12px;letter-spacing:-.01em}
p{margin:0 0 12px;color:var(--ink-2)}.muted{color:var(--muted);font-size:13px}
.card{border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:18px 0;background:#fff;font-size:13px}
.card div{display:flex;justify-content:space-between;gap:12px;padding:3px 0}.card span{color:var(--muted)}.card b{font-weight:550;text-align:right;word-break:break-all}
.actions{display:flex;gap:8px;justify-content:flex-end;margin-top:22px}
button{display:inline-flex;align-items:center;justify-content:center;height:32px;padding:0 14px;border:1px solid var(--line);border-radius:6px;background:var(--paper);color:var(--ink);font:550 13px/1 var(--font);cursor:pointer}
button:hover{background:var(--tint)}button.primary{background:var(--ink);border-color:var(--ink);color:var(--paper)}button.primary:hover{background:#000;border-color:#000}
button:focus-visible{outline:2px solid #296d9a;outline-offset:2px}
</style></head><body><main>
<div class="mark">GRIM</div>
<h1>Allow ${escapeHtml(a.client.name)} to access your Grim workspaces?</h1>
<p>It will be able to list your workspaces on ${escapeHtml(host)}, and read and edit the notes of any workspace you can open. Its edits show live, with its own cursor.</p>
<div class="card"><div><span>App</span><b>${escapeHtml(a.client.name)}</b></div><div><span>Sends you back to</span><b>${escapeHtml(where)}</b></div></div>
<p class="muted">Signed in as ${escapeHtml(who)}. Only allow apps you trust; the name is what the app says it is.</p>
<form method="post" action="/oauth/authorize">${hidden}<div class="actions"><button type="submit" name="decision" value="deny">Cancel</button><button type="submit" name="decision" value="allow" class="primary" autofocus>Allow</button></div></form>
</main></body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction(a.redirect)}; frame-ancestors 'none'`,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

async function authorizePost(db: Db, req: Request): Promise<Response> {
  if (!sameOrigin(req)) return htmlPage(403, "Can't connect", "<p>This request didn't come from this server's consent page.</p>");
  const form = await req.formData().catch(() => null);
  const get = (k: string) => {
    const v = form?.get(k);
    return typeof v === "string" ? v : null;
  };
  const a = parseAuthRequest(get);
  if ("show" in a) return htmlPage(400, "Can't connect", `<p>${escapeHtml(a.show)}</p>`);
  if ("back" in a) return a.back;
  if (get("decision") !== "allow") return backTo(a.redirect, a.state, { error: "access_denied", error_description: "the person declined" });
  const user = await userFromRequest(db, req);
  if (!user) return htmlPage(401, "Can't connect", "<p>You're not signed in any more. Try connecting again from the app.</p>");
  const code = await issueAppCode(db, user.id, { client: cleanLabel(`${a.client.name} (MCP)`, 80) ?? "MCP client", redirect: a.redirect, state: a.state ?? "", challenge: a.challenge }, MCP_AUDIENCE);
  return backTo(a.redirect, a.state, { code });
}

async function token(db: Db, req: Request): Promise<Response> {
  const f = await tokenRequestFields(req);
  if (f.grant_type !== "authorization_code") return oauthError("unsupported_grant_type", "only authorization_code is supported (no refresh tokens: sign in again)");
  if (!validResource(f.resource)) return oauthError("invalid_target", `this server only issues tokens for ${mcpResource()}`);
  // (the client id isn't checked against the code: PKCE binds the code to whoever started the flow)
  const r = await redeemAppCode(db, f.code, f.code_verifier, MCP_AUDIENCE);
  if (!r) return oauthError("invalid_grant", "the code is unknown, used, expired, or doesn't match the code_verifier");
  return json({ access_token: r.token, token_type: "Bearer", scope: SCOPE });
}

// ---- routes ----

/** /.well-known/oauth-*, /oauth/*: null for other paths. */
export async function handleOAuth(db: Db, req: Request, url: URL): Promise<Response | null> {
  const p = url.pathname;
  if (!p.startsWith("/.well-known/oauth-") && !p.startsWith("/oauth/")) return null;
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!config.signIn) return oauthError("not_found", "this Grim server has no accounts (sign-in is off): /mcp needs no authorization", 404);
  const pub = config.publicUrl;
  if ((p === RESOURCE_METADATA || p === RESOURCE_METADATA + MCP_PATH) && req.method === "GET") {
    return json({ resource: mcpResource(), authorization_servers: [pub], scopes_supported: [SCOPE], bearer_methods_supported: ["header"], resource_name: "Grim" });
  }
  if ((p === "/.well-known/oauth-authorization-server" || p === "/.well-known/oauth-authorization-server" + MCP_PATH) && req.method === "GET") {
    return json({
      issuer: pub,
      authorization_endpoint: `${pub}/oauth/authorize`,
      token_endpoint: `${pub}/oauth/token`,
      registration_endpoint: `${pub}/oauth/register`,
      scopes_supported: [SCOPE],
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
    });
  }
  if (p === "/oauth/register" && req.method === "POST") return register(req);
  if (p === "/oauth/authorize" && req.method === "GET") return authorizeGet(db, req, url);
  if (p === "/oauth/authorize" && req.method === "POST") return authorizePost(db, req);
  if (p === "/oauth/token" && req.method === "POST") return token(db, req);
  return oauthError("not_found", "not found", 404);
}
