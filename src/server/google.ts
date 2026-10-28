// Google sign-in (OpenID Connect, authorization code flow with PKCE): the provider side. Routes are in auth.ts.
import { config } from "./config.ts";

export const googleLoginEnabled = () => Boolean(config.google.clientId && config.google.clientSecret);

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
let googleFetch: Fetch = (url, init) => fetch(url, init);

/** Test hook: replace fetch for Google's token and key endpoints (null restores the real one). Also drops cached keys. */
export function setGoogleFetch(fn: Fetch | null) {
  googleFetch = fn ?? ((url, init) => fetch(url, init));
  keys = null;
}

export const googleRedirectUri = () => `${config.publicUrl}/auth/google/callback`;

const b64url = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url");

/** PKCE S256 challenge for a verifier. */
export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
}

export async function googleAuthUrl(state: string, nonce: string, verifier: string): Promise<string> {
  const u = new URL(config.google.authUrl);
  u.searchParams.set("client_id", config.google.clientId);
  u.searchParams.set("redirect_uri", googleRedirectUri());
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", state);
  u.searchParams.set("nonce", nonce);
  u.searchParams.set("code_challenge", await pkceChallenge(verifier));
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("prompt", "select_account");
  return u.toString();
}

export class GoogleError extends Error {
  override name = "GoogleError";
}

/** Trade the authorization code (with the PKCE verifier) for an id_token. */
export async function exchangeCode(code: string, verifier: string): Promise<string> {
  const res = await googleFetch(config.google.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: googleRedirectUri(),
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { id_token?: unknown; error?: unknown; error_description?: unknown };
  if (!res.ok || typeof body.id_token !== "string") throw new GoogleError(`Google refused the sign-in (${String(body.error_description ?? body.error ?? res.status)}).`);
  return body.id_token;
}

// ---- id_token verification ----

interface Jwk {
  kid?: string;
  kty: string;
  alg?: string;
  n?: string;
  e?: string;
}
let keys: { byKid: Map<string, Jwk>; until: number; fetchedAt: number } | null = null;
let keysInflight: Promise<void> | null = null;

/** Google's signing keys, cached for as long as its Cache-Control allows (an hour if it doesn't say). */
async function loadKeys(): Promise<void> {
  keysInflight ??= (async () => {
    try {
      const res = await googleFetch(config.google.jwksUrl);
      if (!res.ok) throw new GoogleError(`couldn't fetch Google's keys (${res.status})`);
      const body = (await res.json()) as { keys?: Jwk[] };
      const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1] ?? 3600);
      const byKid = new Map<string, Jwk>();
      for (const k of body.keys ?? []) if (k.kid && k.kty === "RSA") byKid.set(k.kid, k);
      keys = { byKid, until: Date.now() + Math.min(Math.max(maxAge, 60), 24 * 3600) * 1000, fetchedAt: Date.now() };
    } finally {
      keysInflight = null;
    }
  })();
  return keysInflight;
}

async function keyFor(kid: string): Promise<Jwk | null> {
  if (!keys || keys.until <= Date.now()) await loadKeys();
  let k = keys?.byKid.get(kid) ?? null;
  // An unknown key id: Google may have rotated its keys; look again (at most every 10 s).
  if (!k && keys && Date.now() - keys.fetchedAt > 10_000) {
    await loadKeys();
    k = keys?.byKid.get(kid) ?? null;
  }
  return k;
}

export interface GoogleClaims {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

function part(s: string): Record<string, unknown> {
  const v: unknown = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new GoogleError("malformed token");
  return v as Record<string, unknown>;
}

/**
 * Check an id_token: RS256 signature by one of Google's keys, issuer, audience (our client id), expiry, nonce. Returns
 * the identity claims; email_verified is reported, not enforced (the caller refuses unverified emails).
 */
export async function verifyIdToken(token: string, nonce: string): Promise<GoogleClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new GoogleError("malformed token");
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = part(parts[0]!);
    claims = part(parts[1]!);
  } catch {
    throw new GoogleError("malformed token");
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new GoogleError("unexpected token algorithm");
  const jwk = await keyFor(header.kid);
  if (!jwk) throw new GoogleError("token signed by an unknown key");
  const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, Buffer.from(parts[2]!, "base64url"), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new GoogleError("bad token signature");
  if (typeof claims.iss !== "string" || !config.google.issuers.includes(claims.iss)) throw new GoogleError("token from an unexpected issuer");
  const aud = claims.aud;
  if (!(aud === config.google.clientId || (Array.isArray(aud) && aud.includes(config.google.clientId)))) throw new GoogleError("token for another application");
  if (Array.isArray(aud) && aud.length > 1 && claims.azp !== config.google.clientId) throw new GoogleError("token for another application");
  const now = Date.now() / 1000;
  if (typeof claims.exp !== "number" || claims.exp < now - 60) throw new GoogleError("token expired");
  if (typeof claims.iat === "number" && claims.iat > now + 300) throw new GoogleError("token issued in the future");
  if (typeof claims.nonce !== "string" || claims.nonce !== nonce) throw new GoogleError("token nonce mismatch");
  if (typeof claims.sub !== "string" || !claims.sub || typeof claims.email !== "string" || !claims.email) throw new GoogleError("token without an identity");
  return {
    sub: claims.sub,
    email: claims.email.toLowerCase(),
    emailVerified: claims.email_verified === true || claims.email_verified === "true",
    name: typeof claims.name === "string" && claims.name.trim() ? claims.name.trim().slice(0, 60) : null,
    picture: typeof claims.picture === "string" && /^https:\/\//.test(claims.picture) ? claims.picture : null,
  };
}
