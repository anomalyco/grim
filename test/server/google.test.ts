// Google sign-in against a fake provider, /api/server, and app tokens (/connect, bearer auth).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fakeGoogle, googleSignIn, isolate, roomHello, type FakeGoogle } from "./helpers.ts";
import { seedNotebook } from "./helpers.ts";

process.env.QUIET_MS = "100";
process.env.POLL_MS = "60000";
const { config } = await import("../../src/server/config.ts");
const { db: earlyDb } = await import("../../src/server/db.ts");
const restore = isolate(config, earlyDb);
Object.assign(config, { storage: "local", allowDevLogin: true, signIn: true, quietMs: 100 });
config.github.clientId = "";
config.github.appSlug = "";
Object.assign(config.google, {
  clientId: "test-client.apps.googleusercontent.com",
  clientSecret: "test-secret",
  authUrl: "https://fake-google.test/auth",
  tokenUrl: "https://fake-google.test/token",
  jwksUrl: "https://fake-google.test/certs",
  issuers: ["https://accounts.google.com", "accounts.google.com"],
});
const { startServer } = await import("../../src/server/index.ts");
const { db } = await import("../../src/server/db.ts");
const { setGoogleFetch, pkceChallenge } = await import("../../src/server/google.ts");
const { forgetAppToken } = await import("../../src/server/auth.ts");

let app: Awaited<ReturnType<typeof startServer>>;
let base = "";
let fg: FakeGoogle;

async function devLogin(name: string): Promise<string> {
  const res = await fetch(`${base}/auth/dev`, { method: "POST", headers: { origin: base }, body: new URLSearchParams({ name }), redirect: "manual" });
  expect(res.status).toBe(303);
  return res.headers.getSetCookie().find((s) => s.startsWith("np_session="))!.split(";")[0]!;
}

async function api(auth: { cookie?: string; token?: string }, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth.cookie) headers.cookie = auth.cookie;
  if (auth.token) headers.authorization = `Bearer ${auth.token}`;
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

beforeAll(async () => {
  fg = await fakeGoogle({ clientId: config.google.clientId, tokenUrl: config.google.tokenUrl, jwksUrl: config.google.jwksUrl });
  setGoogleFetch(fg.fetch);
  app = await startServer({ port: 0, quiet: true });
  await seedNotebook(app.ctx, "gg-notes");
  base = `http://localhost:${app.server.port}`;
});

afterAll(async () => {
  await app?.stop();
  setGoogleFetch(null);
  restore();
});

describe("server info", () => {
  test("GET /api/server needs no auth and describes sign-in", async () => {
    const r = await api({}, "GET", "/api/server");
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ name: new URL(config.publicUrl).host, publicUrl: config.publicUrl, google: true, version: expect.any(String), ws: [1, 2] });
    config.google.clientId = "";
    try {
      expect((await api({}, "GET", "/api/server")).data.google).toBe(false);
      expect((await fetch(`${base}/auth/google`, { redirect: "manual" })).status).toBe(404);
    } finally {
      config.google.clientId = "test-client.apps.googleusercontent.com";
    }
  });
});

describe("Google sign-in", () => {
  test("the authorize redirect uses PKCE (S256), state and nonce; the state cookie is HttpOnly under /auth", async () => {
    const start = await fetch(`${base}/auth/google?next=/app/x`, { redirect: "manual" });
    expect(start.status).toBe(303);
    const u = new URL(start.headers.get("location")!);
    expect(u.origin + u.pathname).toBe("https://fake-google.test/auth");
    expect(u.searchParams.get("client_id")).toBe(config.google.clientId);
    expect(u.searchParams.get("redirect_uri")).toBe(`${config.publicUrl}/auth/google/callback`);
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("scope")).toBe("openid email profile");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    expect(u.searchParams.get("state")!.length).toBeGreaterThan(10);
    expect(u.searchParams.get("nonce")!.length).toBeGreaterThan(10);
    const c = start.headers.getSetCookie().find((s) => s.startsWith("np_google_state="))!;
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Path=/auth");
    // The verifier itself never leaves the server except in the cookie.
    expect(u.toString()).not.toContain(c.split("=")[1]!.split(".")[2]!);
  });

  test("good sign-in: verified identity → session → next; the user has Google's email, name and picture", async () => {
    const { res, cookie, location } = await googleSignIn(base, fg, { sub: "g-ann", email: "Ann@Example.com", name: "Ann Example" }, { next: "/app/notes/x.md" });
    expect(res.status).toBe(303);
    expect(location).toBe("/app/notes/x.md");
    expect(cookie).toBeTruthy();
    const me = await api({ cookie: cookie! }, "GET", "/api/me");
    expect(me.data).toMatchObject({ name: "Ann Example", email: "ann@example.com", avatar: "https://example.com/a.png", emailVerified: true });
    expect("admin" in me.data || "isAdmin" in me.data).toBe(false);
    // The keys were fetched once and are cached.
    const again = await googleSignIn(base, fg, { sub: "g-ann", email: "ann@example.com", name: "Ann E." });
    expect(again.cookie).toBeTruthy();
    expect(fg.calls.filter((u) => u === config.google.jwksUrl).length).toBe(1);
    // Same Google account → same user (updated name).
    const me2 = await api({ cookie: again.cookie! }, "GET", "/api/me");
    expect(me2.data.id).toBe(me.data.id);
    expect(me2.data.name).toBe("Ann E.");
    expect((db.query("SELECT COUNT(*) AS n FROM users WHERE google_sub = 'g-ann'").get() as { n: number }).n).toBe(1);
  });

  test("refused: bad signature, unknown key, wrong audience, wrong issuer, expired, nonce mismatch, unverified email", async () => {
    const now = Math.floor(Date.now() / 1000);
    const cases: Array<[string, Record<string, unknown>, Parameters<typeof googleSignIn>[3]]> = [
      ["bad signature", {}, { badKey: true }],
      ["unknown key", {}, { kid: "nope" }],
      ["wrong aud", { aud: "someone-else.apps.googleusercontent.com" }, {}],
      ["wrong iss", { iss: "https://evil.example" }, {}],
      ["expired", { exp: now - 3600, iat: now - 7200 }, {}],
      ["nonce", {}, { nonce: "not-the-nonce" }],
      ["state", {}, { tamperState: true }],
    ];
    for (const [name, claims, opts] of cases) {
      const { res, cookie } = await googleSignIn(base, fg, { sub: `g-bad-${name}`, email: "bad@example.com", ...claims }, opts);
      expect([name, res.status]).toEqual([name, 400]);
      expect(cookie).toBeNull();
      // The state cookie is cleared either way.
      expect(res.headers.getSetCookie().some((c) => c.startsWith("np_google_state=") && c.includes("Max-Age=0"))).toBe(true);
    }
    const unverified = await googleSignIn(base, fg, { sub: "g-unverified", email: "unv@example.com", email_verified: false });
    expect(unverified.res.status).toBe(403);
    expect(await unverified.res.text()).toContain("verified");
    expect(unverified.cookie).toBeNull();
    expect(db.query("SELECT 1 FROM users WHERE google_sub LIKE 'g-bad-%' OR google_sub = 'g-unverified'").get()).toBeNull();
    // A provider error at the token endpoint.
    const start = await fetch(`${base}/auth/google`, { redirect: "manual" });
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    const cookie = start.headers.getSetCookie()[0]!.split(";")[0]!;
    const res = await fetch(`${base}/auth/google/callback?state=${state}&code=unknown`, { headers: { cookie }, redirect: "manual" });
    expect(res.status).toBe(400);
    // No cookie at all.
    expect((await fetch(`${base}/auth/google/callback?state=x&code=y`, { redirect: "manual" })).status).toBe(400);
  });

  test("next is only ever a same-origin path under /app", async () => {
    const cases: Array<[string, string]> = [
      ["//evil.example/app", "/app"],
      ["https://evil.example/app", "/app"],
      ["/\\evil.example", "/app"],
      ["/api/me", "/app"],
      ["/start", "/app"],
      ["/connect?client=Mac", "/app"],
      ["/app/notes/x.md?y=1", "/app/notes/x.md?y=1"],
    ];
    for (const [next, want] of cases) {
      const { location } = await googleSignIn(base, fg, { sub: "g-next", email: "next@example.com" }, { next });
      expect([next, location]).toEqual([next, want]);
    }
  });

  test("a Google account is linked to an existing account with the same verified email", async () => {
    const cookie = await devLogin("Linky");
    const id = (await api({ cookie }, "GET", "/api/me")).data.id;
    db.query("UPDATE users SET email = 'linky@example.com', email_verified = 1 WHERE id = ?").run(id);
    const g = await googleSignIn(base, fg, { sub: "g-linky", email: "linky@example.com" });
    expect((await api({ cookie: g.cookie! }, "GET", "/api/me")).data.id).toBe(id);
    // An unverified address is never linked.
    const other = await devLogin("Unverif");
    const otherId = (await api({ cookie: other }, "GET", "/api/me")).data.id;
    db.query("UPDATE users SET email = 'unverif@example.com', email_verified = 0 WHERE id = ?").run(otherId);
    const g2 = await googleSignIn(base, fg, { sub: "g-unverif", email: "unverif@example.com" });
    expect((await api({ cookie: g2.cookie! }, "GET", "/api/me")).data.id).not.toBe(otherId);
  });
});

describe("one verified email is one account", () => {
  const users = (email: string) => db.query("SELECT id, email, google_sub AS sub FROM users WHERE lower(email) = ? AND email_verified = 1").all(email) as Array<{ id: string; email: string; sub: string | null }>;

  test("stored lower-case; the same address in other case is the same account", async () => {
    const a = await googleSignIn(base, fg, { sub: "g-case", email: "Case.Person@Example.COM" });
    const b = await googleSignIn(base, fg, { sub: "g-case", email: "case.person@example.com" });
    expect((await api({ cookie: a.cookie! }, "GET", "/api/me")).data.id).toBe((await api({ cookie: b.cookie! }, "GET", "/api/me")).data.id);
    expect(users("case.person@example.com")).toEqual([{ id: expect.any(String), email: "case.person@example.com", sub: "g-case" }]);
  });

  test("another Google identity with an address an account already has is refused (409), not a second account", async () => {
    await googleSignIn(base, fg, { sub: "g-first", email: "shared@example.com" });
    const second = await googleSignIn(base, fg, { sub: "g-second", email: "Shared@example.com" });
    expect(second.res.status).toBe(409);
    expect(second.cookie).toBeFalsy();
    expect(users("shared@example.com").map((u) => u.sub)).toEqual(["g-first"]);
    expect(db.query("SELECT 1 FROM users WHERE google_sub = 'g-second'").get()).toBeNull();
  });

  test("a Google account whose address changes to one another account has keeps its old one", async () => {
    await googleSignIn(base, fg, { sub: "g-taken", email: "taken@example.com" });
    const mover = await googleSignIn(base, fg, { sub: "g-mover", email: "mover@example.com" });
    const again = await googleSignIn(base, fg, { sub: "g-mover", email: "taken@example.com" });
    expect(again.res.status).toBe(303);
    const me = (await api({ cookie: again.cookie! }, "GET", "/api/me")).data;
    expect(me.id).toBe((await api({ cookie: mover.cookie! }, "GET", "/api/me")).data.id);
    expect(me.email).toBe("mover@example.com");
    expect(users("taken@example.com").map((u) => u.sub)).toEqual(["g-taken"]);
  });

  test("the database refuses a second verified account for an address; name-only accounts are exempt", async () => {
    await googleSignIn(base, fg, { sub: "g-uniq", email: "uniq@example.com" });
    expect(() => db.query("INSERT INTO users (id, login, name, email, created_at, email_verified) VALUES ('dup', 'd', 'D', 'UNIQ@example.com', 1, 1)").run()).toThrow(/UNIQUE/);
    await devLogin("Same Name");
    await devLogin("Same Name");
    expect((db.query("SELECT COUNT(*) AS n FROM users WHERE name = 'Same Name' AND email_verified = 0").get() as { n: number }).n).toBe(2);
  });
});

describe("adding Google to a signed-in account", () => {
  test("a signed-in name-only account that completes Google sign-in gets that Google identity", async () => {
    const nora = await devLogin("Nora");
    const before = (await api({ cookie: nora }, "GET", "/api/me")).data;
    const g = await googleSignIn(base, fg, { sub: "g-nora", email: "Nora@Example.com", name: "Nora Google" }, { session: nora, next: "/app/x" });
    expect(g.res.status).toBe(303);
    expect(g.location).toBe("/app/x");
    const me = (await api({ cookie: g.cookie! }, "GET", "/api/me")).data;
    expect(me).toMatchObject({ id: before.id, name: "Nora", email: "nora@example.com", emailVerified: true });
    // The old session keeps working.
    expect((await api({ cookie: nora }, "GET", "/api/me")).data.id).toBe(before.id);
    // From now on, Google sign-in (in any browser) lands in this account.
    const later = await googleSignIn(base, fg, { sub: "g-nora", email: "nora@example.com" });
    expect((await api({ cookie: later.cookie! }, "GET", "/api/me")).data.id).toBe(before.id);
    expect((db.query("SELECT COUNT(*) AS n FROM users WHERE google_sub = 'g-nora'").get() as { n: number }).n).toBe(1);
  });

  test("refused when that Google identity or its email already belongs to another account", async () => {
    const ann = await googleSignIn(base, fg, { sub: "g-taken", email: "taken@example.com", name: "Taken" });
    const annId = (await api({ cookie: ann.cookie! }, "GET", "/api/me")).data.id;
    const otto = await devLogin("Otto");
    const ottoId = (await api({ cookie: otto }, "GET", "/api/me")).data.id;
    for (const claims of [
      { sub: "g-taken", email: "taken@example.com" },
      // A different Google identity, but the email is another account's verified address.
      { sub: "g-taken-2", email: "Taken@example.com" },
    ]) {
      const r = await googleSignIn(base, fg, claims, { session: otto });
      expect(r.res.status).toBe(409);
      expect(await r.res.text()).toContain("already belongs to another Grim account");
      expect(r.cookie).toBeNull();
    }
    expect(db.query("SELECT google_sub, email_verified FROM users WHERE id = ?").get(ottoId)).toEqual({ google_sub: null, email_verified: 0 });
    expect(db.query("SELECT 1 FROM users WHERE google_sub = 'g-taken-2'").get()).toBeNull();
    // Otto is still Otto; Ann is still Ann.
    expect((await api({ cookie: otto }, "GET", "/api/me")).data.id).toBe(ottoId);
    expect((await api({ cookie: (await googleSignIn(base, fg, { sub: "g-taken", email: "taken@example.com" })).cookie! }, "GET", "/api/me")).data.id).toBe(annId);
  });

  test("only for the account that started the sign-in, and only once: otherwise it's an ordinary Google sign-in", async () => {
    // Signed in only when coming back (not when starting): no linking.
    const pia = await devLogin("Pia");
    const piaId = (await api({ cookie: pia }, "GET", "/api/me")).data.id;
    const late = await googleSignIn(base, fg, { sub: "g-pia", email: "pia@example.com" }, { callbackSession: pia });
    expect((await api({ cookie: late.cookie! }, "GET", "/api/me")).data.id).not.toBe(piaId);
    // Another account's session when coming back: no linking either.
    const quinn = await devLogin("Quinn");
    const quinnId = (await api({ cookie: quinn }, "GET", "/api/me")).data.id;
    const swapped = await googleSignIn(base, fg, { sub: "g-quinn", email: "quinn@example.com" }, { session: quinn, callbackSession: pia });
    const swappedId = (await api({ cookie: swapped.cookie! }, "GET", "/api/me")).data.id;
    expect([piaId, quinnId]).not.toContain(swappedId);
    // An account that already has Google: signing in with another Google account switches to that account.
    const rex = await devLogin("Rex");
    const rexId = (await api({ cookie: rex }, "GET", "/api/me")).data.id;
    await googleSignIn(base, fg, { sub: "g-rex", email: "rex@example.com" }, { session: rex });
    const other = await googleSignIn(base, fg, { sub: "g-rex-2", email: "rex2@example.com" }, { session: rex });
    expect((await api({ cookie: other.cookie! }, "GET", "/api/me")).data.id).not.toBe(rexId);
    expect((db.query("SELECT google_sub FROM users WHERE id = ?").get(rexId) as { google_sub: string }).google_sub).toBe("g-rex");
  });
});

describe("app sign-in (RFC 8252: straight to Google, a one-time code on the loopback, PKCE)", () => {
  const redirect = "http://127.0.0.1:53111/callback";
  const verifier = "v".repeat(20) + "-verifier-of-the-mac-app-0123456789";
  let challenge = "";
  beforeAll(async () => {
    challenge = await pkceChallenge(verifier);
  });
  const appState = "app-state-0123456789abcdef";
  const startPath = (q: Record<string, string> = {}) =>
    `/auth/google/start?${new URLSearchParams({ client: "mac", redirect_uri: redirect, state: appState, code_challenge: challenge, code_challenge_method: "S256", ...q })}`;

  async function exchange(code: string, v = verifier) {
    const res = await fetch(`${base}/auth/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, code_verifier: v }) });
    return { status: res.status, cache: res.headers.get("cache-control"), data: (await res.json()) as any };
  }

  /** The app's sign-in as `claims` (the fake Google): the loopback redirect. */
  async function appSignIn(claims: Record<string, unknown>, q: Record<string, string> = {}, opts: { session?: string } = {}) {
    const g = await googleSignIn(base, fg, claims, { start: startPath(q), ...opts });
    return { ...g, loc: g.location ? new URL(g.location) : null };
  }

  /** Sign in and exchange the code: the token and the rest of what the app gets. */
  async function appToken(claims: Record<string, unknown>) {
    const { loc } = await appSignIn(claims);
    expect(loc!.origin + loc!.pathname).toBe(redirect);
    const got = await exchange(loc!.searchParams.get("code")!);
    expect(got.status).toBe(200);
    return got.data as { token: string; token_id: string; account: string; login: string; email: string | null };
  }

  test("/auth/google/start goes straight to Google (no page of ours) with our own state, nonce and PKCE", async () => {
    const res = await fetch(`${base}${startPath()}`, { redirect: "manual" });
    expect(res.status).toBe(303);
    const g = new URL(res.headers.get("location")!);
    expect(g.origin + g.pathname).toBe(config.google.authUrl);
    expect(g.searchParams.get("redirect_uri")).toBe(`${config.publicUrl}/auth/google/callback`);
    expect(g.searchParams.get("code_challenge_method")).toBe("S256");
    // the server's own state and challenge, never the app's
    expect(g.searchParams.get("state")).not.toBe(appState);
    expect(g.searchParams.get("code_challenge")).not.toBe(challenge);
    expect(res.headers.getSetCookie()[0]).toContain("HttpOnly");
  });

  test("after Google: a one-time code and the app's state on the loopback, never the token; the browser isn't signed in", async () => {
    const { res, loc, cookie } = await appSignIn({ sub: "g-app", email: "App.User@example.com", name: "App User" });
    expect(res.status).toBe(303);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(loc!.origin + loc!.pathname).toBe(redirect);
    expect([...loc!.searchParams.keys()].sort()).toEqual(["code", "state"]);
    expect(loc!.searchParams.get("state")).toBe(appState);
    expect(cookie).toBeNull();
    const got = await exchange(loc!.searchParams.get("code")!);
    expect(got.status).toBe(200);
    expect(got.cache).toContain("no-store");
    expect(got.data).toMatchObject({ account: "App User", email: "app.user@example.com" });
    expect(got.data.token).toMatch(/^gmt_/);
    // stored hashed only
    expect(db.query("SELECT 1 FROM app_tokens WHERE token_hash = ?").get(got.data.token)).toBeNull();
    const me = (await api({ token: got.data.token }, "GET", "/api/me")).data;
    expect(me).toMatchObject({ email: "app.user@example.com", token: { id: got.data.token_id, label: "Grim for Mac" } });
  });

  test("the code works once, with the verifier, within 60 s", async () => {
    const code = async () => (await appSignIn({ sub: "g-codie", email: "codie@example.com" })).loc!.searchParams.get("code")!;
    const c1 = await code();
    expect((await exchange(c1, "w".repeat(43))).status).toBe(400);
    expect((await exchange(c1)).status).toBe(400);
    const c2 = await code();
    expect((await exchange(c2)).status).toBe(200);
    expect((await exchange(c2)).status).toBe(400);
    const c3 = await code();
    expect(db.query("SELECT 1 FROM connect_codes WHERE code_hash = ?").get(c3)).toBeNull();
    const row = db.query("SELECT expires_at FROM connect_codes").get() as { expires_at: number };
    expect(row.expires_at - Date.now()).toBeLessThanOrEqual(60_000);
    db.query("UPDATE connect_codes SET expires_at = ?").run(Date.now() - 1);
    expect((await exchange(c3)).status).toBe(400);
    expect((await exchange("nope")).data).toEqual({ error: "invalid_grant" });
    expect((await fetch(`${base}/auth/token`)).status).toBe(405);
  });

  test("only a loopback /callback redirect (127.0.0.1 or [::1], a port), a state and an S256 challenge", async () => {
    const bad: Array<Record<string, string>> = [
      { redirect_uri: "http://evil.example/callback" },
      { redirect_uri: "https://127.0.0.1:5000/callback" },
      { redirect_uri: "http://localhost:5000/callback" },
      { redirect_uri: "http://127.0.0.1.evil.example:5/callback" },
      { redirect_uri: "http://user:pw@127.0.0.1:5/callback" },
      { redirect_uri: "http://127.0.0.1/callback" },
      { redirect_uri: "http://127.0.0.1:5000/other" },
      { redirect_uri: "javascript:alert(1)" },
      { state: "" },
      { state: "short" },
      { code_challenge: "short" },
      { code_challenge_method: "plain" },
    ];
    for (const q of bad) expect([q, (await fetch(`${base}${startPath(q)}`, { redirect: "manual" })).status]).toEqual([q, 400]);
    expect((await fetch(`${base}${startPath({ redirect_uri: "http://[::1]:4000/callback" })}`, { redirect: "manual" })).status).toBe(303);
    // the old approval pages are gone
    expect(await (await fetch(`${base}/connect?${new URLSearchParams({ client: "X", redirect: "http://127.0.0.1:5/callback", state: "s" })}`)).text()).not.toContain("Allow");
  });

  test("Google cancelled or refused: the app hears it on its loopback (error, its state)", async () => {
    const unverified = await appSignIn({ sub: "g-unv-app", email: "unv-app@example.com", email_verified: false });
    expect(unverified.loc!.searchParams.get("error")).toBe("access_denied");
    expect(unverified.loc!.searchParams.get("error_description")).toContain("isn't verified");
    expect(unverified.loc!.searchParams.get("state")).toBe(appState);
    expect(unverified.loc!.searchParams.get("code")).toBeNull();
  });

  test("an app sign-in in a signed-in browser leaves that browser's session alone", async () => {
    const web = await googleSignIn(base, fg, { sub: "g-web", email: "web@example.com" });
    const got = await appToken({ sub: "g-other-app", email: "other-app@example.com" });
    expect(got.email).toBe("other-app@example.com");
    expect((await api({ cookie: web.cookie! }, "GET", "/api/me")).data.email).toBe("web@example.com");
  });

  test("web: signing in ends the session the browser had (another account's) on the server", async () => {
    const a = await googleSignIn(base, fg, { sub: "g-first", email: "first@example.com" });
    const b = await googleSignIn(base, fg, { sub: "g-second", email: "second@example.com" }, { session: a.cookie! });
    expect((await api({ cookie: b.cookie! }, "GET", "/api/me")).data.email).toBe("second@example.com");
    expect((await api({ cookie: a.cookie! }, "GET", "/api/me")).status).toBe(401);
  });

  test("an app token unused for 90 days stops working", async () => {
    const { token, token_id } = await appToken({ sub: "g-idle", email: "idle@example.com" });
    expect((await api({ token }, "GET", "/api/me")).status).toBe(200);
    const old = Date.now() - 91 * 24 * 3600_000;
    db.query("UPDATE app_tokens SET created_at = ?, last_used_at = ? WHERE id = ?").run(old, old, token_id);
    forgetAppToken(token_id);
    expect((await api({ token }, "GET", "/api/me")).status).toBe(401);
  });

  test("the token is a bearer token for the API and rooms (header only matters); revoke ends it", async () => {
    const { token, token_id } = await appToken({ sub: "g-bearer", email: "bearer@example.com" });
    const me = (await api({ token }, "GET", "/api/me")).data;
    const created = await api({ token }, "POST", "/api/workspaces", { title: "GG Token Space" });
    expect(created.status).toBe(201);
    const ws = created.data.id;
    expect((await api({ token }, "GET", "/api/workspaces")).data.map((w: any) => w.id)).toContain(ws);
    expect((await fetch(`${base}/api/me`, { headers: { authorization: "Bearer gmt_nope" } })).status).toBe(401);
    const h = await roomHello(base, { repo: ws, path: "README.md" }, { authorization: `Bearer ${token}` });
    expect(h.hello?.readOnly).toBe(false);
    h.client.close();
    expect((await roomHello(base, { repo: ws, path: "README.md" }, { authorization: "Bearer gmt_bad" })).client.closeCode).toBe(4401);
    // someone else can't revoke it; the app can
    const other = await devLogin("Other Tok");
    expect((await api({ cookie: other }, "DELETE", `/api/tokens/${token_id}`)).status).toBe(404);
    expect(me.token.id).toBe(token_id);
    expect((await api({ token }, "DELETE", `/api/tokens/${token_id}`)).data).toEqual({ ok: true });
    expect((await api({ token }, "GET", "/api/me")).status).toBe(401);
    expect((await roomHello(base, { repo: ws, path: "README.md" }, { authorization: `Bearer ${token}` })).client.closeCode).toBe(4401);
  });
});
