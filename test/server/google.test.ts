// Google sign-in against a fake provider, /api/server, and app tokens (/connect, bearer auth).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fakeGoogle, googleSignIn, isolate, roomHello, type FakeGoogle } from "./helpers.ts";

process.env.QUIET_MS = "100";
process.env.POLL_MS = "60000";
const { config } = await import("../../src/server/config.ts");
const { db: earlyDb } = await import("../../src/server/db.ts");
const restore = isolate(config, earlyDb);
Object.assign(config, { storage: "local", allowDevLogin: true, quietMs: 100, pollMs: 60000, notesRepo: "gg-notes" });
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
const { setGoogleFetch } = await import("../../src/server/google.ts");

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
    expect(r.data).toEqual({ name: new URL(config.publicUrl).host, publicUrl: config.publicUrl, google: true, devLogin: true, version: expect.any(String), ws: [1, 2] });
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

  test("next is only ever a same-origin path under /app, /start or /connect", async () => {
    const cases: Array<[string, string]> = [
      ["//evil.example/app", "/app"],
      ["https://evil.example/app", "/app"],
      ["/\\evil.example", "/app"],
      ["/api/me", "/app"],
      ["/start", "/start"],
      ["/connect?client=Mac&redirect=http%3A%2F%2F127.0.0.1%3A5000%2Fcb&state=s", "/connect?client=Mac&redirect=http%3A%2F%2F127.0.0.1%3A5000%2Fcb&state=s"],
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
      expect(await r.res.text()).toContain("already belongs to another Grimoire account");
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

describe("app tokens", () => {
  const redirect = "http://127.0.0.1:53111/callback";
  const connectUrl = (q: Record<string, string>) => `${base}/connect?${new URLSearchParams(q)}`;

  async function approve(cookie: string, fields: Record<string, string>, origin = base) {
    return fetch(`${base}/connect`, { method: "POST", headers: { cookie, origin }, body: new URLSearchParams(fields), redirect: "manual" });
  }

  test("/connect: signed out → sign-in links that come back; signed in → the approval page", async () => {
    const q = { client: "Grimoire for Mac · Test Mac", redirect, state: "st-1" };
    const out = await fetch(connectUrl(q));
    expect(out.status).toBe(200);
    const html = await out.text();
    const back = encodeURIComponent(`/connect?${new URLSearchParams(q)}`);
    expect(html).toContain(`/auth/google?next=${back}`);
    expect(html).toContain(`/auth/dev?next=${back}`);
    const cookie = await devLogin("Tokie");
    const page = await fetch(connectUrl(q), { headers: { cookie } });
    const body = await page.text();
    expect(body).toContain("Allow <b>Grimoire for Mac · Test Mac</b> to access your workspaces");
    // The form may redirect to the app's loopback address.
    expect(page.headers.get("content-security-policy")).toContain("form-action 'self' http://127.0.0.1:53111");
    // The dev login form carries next back to /connect.
    const dev = await (await fetch(`${base}/auth/dev?next=${back}`)).text();
    expect(dev).toContain('name="next"');
    const res = await fetch(`${base}/auth/dev`, { method: "POST", headers: { origin: base }, body: new URLSearchParams({ name: "Tokie", next: `/connect?${new URLSearchParams(q)}` }), redirect: "manual" });
    expect(res.headers.get("location")).toBe(`/connect?${new URLSearchParams(q)}`);
  });

  test("/connect names the approving account, offers 'Not you?', and tells the app the account", async () => {
    const q = { client: "Grimoire for Mac", redirect, state: "st-who" };
    // Signed out: sign-in options (never a silent guest account), the name sign-in says it makes a new account.
    const users = () => (db.query("SELECT count(*) AS n FROM users").get() as { n: number }).n;
    const before = users();
    const out = await (await fetch(connectUrl(q))).text();
    expect(out).toContain("Continue with Google");
    expect(out).toContain("creates a <b>new account</b>");
    expect(users()).toBe(before);
    const cookie = await devLogin("Noodle Who");
    const login = (await api({ cookie }, "GET", "/api/me")).data.login as string;
    const page = await (await fetch(connectUrl(q), { headers: { cookie } })).text();
    expect(page).toContain(`as <b class="who">Noodle Who</b>?`);
    expect(page).toContain(`(@${login})`);
    expect(page).toContain("Allow as Noodle Who");
    expect(page).toContain('value="switch"');
    // "Sign in as someone else": the session ends, back to the signed-out page of the same request.
    const sw = await approve(cookie, { ...q, decision: "switch" });
    expect(sw.status).toBe(303);
    expect(sw.headers.get("location")).toBe(`/connect?${new URLSearchParams(q)}`);
    expect(sw.headers.get("set-cookie")).toContain("np_session=;");
    expect((await api({ cookie }, "GET", "/api/me")).status).toBe(401);
    // Approving: the redirect carries the token, its id and the account.
    const c2 = await devLogin("Second Who");
    const res = await approve(c2, { ...q, decision: "allow" });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("account")).toBe("Second Who");
    expect(loc.searchParams.get("login")).toMatch(/^second-who-/);
    const token = loc.searchParams.get("token")!;
    const me = (await api({ token }, "GET", "/api/me")).data;
    expect(me.name).toBe("Second Who");
    expect(me.token).toEqual({ id: loc.searchParams.get("token_id"), label: "Grimoire for Mac" });
    // A cookie session has no token; the app can revoke its own token with it.
    expect((await api({ cookie: c2 }, "GET", "/api/me")).data.token).toBeUndefined();
    expect((await api({ token }, "DELETE", `/api/tokens/${me.token.id}`)).data).toEqual({ ok: true });
    expect((await api({ token }, "GET", "/api/me")).status).toBe(401);
  });

  test("only loopback redirects, a state is required, approval needs the same origin and a cookie session", async () => {
    const cookie = await devLogin("Tokie");
    for (const bad of ["http://evil.example/cb", "https://127.0.0.1:5000/cb", "http://127.0.0.1.evil.example/cb", "http://user:pw@127.0.0.1:5/cb", "javascript:alert(1)", ""]) {
      expect([bad, (await fetch(connectUrl({ client: "X", redirect: bad, state: "s" }), { headers: { cookie } })).status]).toEqual([bad, 400]);
      expect([bad, (await approve(cookie, { client: "X", redirect: bad, state: "s", decision: "allow" })).status]).toEqual([bad, 400]);
    }
    expect((await fetch(connectUrl({ client: "X", redirect }), { headers: { cookie } })).status).toBe(400);
    expect((await approve(cookie, { client: "X", redirect, state: "s", decision: "allow" }, "https://evil.example")).status).toBe(403);
    expect((await approve("np_session=nope", { client: "X", redirect, state: "s", decision: "allow" })).status).toBe(401);
    for (const ok of ["http://localhost:4000/cb", "http://[::1]:4000/cb"]) {
      expect((await fetch(connectUrl({ client: "X", redirect: ok, state: "s" }), { headers: { cookie } })).status).toBe(200);
    }
  });

  test("approve → token on the loopback redirect with the state; it works as a bearer token for the API and rooms; revoke ends it", async () => {
    const cookie = await devLogin("Tokie");
    const me = (await api({ cookie }, "GET", "/api/me")).data;
    const denied = await approve(cookie, { client: "Mac", redirect, state: "st-2", decision: "deny" });
    expect(denied.status).toBe(303);
    const d = new URL(denied.headers.get("location")!);
    expect(d.searchParams.get("error")).toBe("access_denied");
    expect(d.searchParams.get("state")).toBe("st-2");
    expect(d.searchParams.get("token")).toBeNull();

    const res = await approve(cookie, { client: "Grimoire for Mac · Test Mac", redirect, state: "st-3", decision: "allow" });
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(redirect);
    expect(loc.searchParams.get("state")).toBe("st-3");
    const token = loc.searchParams.get("token")!;
    expect(token).toMatch(/^gmt_/);
    // Stored hashed only.
    expect(db.query("SELECT 1 FROM app_tokens WHERE token_hash = ?").get(token)).toBeNull();

    expect((await api({ token }, "GET", "/api/me")).data.id).toBe(me.id);
    // Bearer requests need no Origin (no cookies involved).
    const created = await api({ token }, "POST", "/api/workspaces", { title: "GG Token Space" });
    expect(created.status).toBe(201);
    const ws = created.data.id;
    expect((await api({ token }, "GET", "/api/workspaces")).data.map((w: any) => w.id)).toContain(ws);
    // A bad token is not a session, even with a valid cookie.
    expect((await fetch(`${base}/api/me`, { headers: { authorization: "Bearer gmt_nope", cookie } })).status).toBe(401);
    // An app token can't approve more tokens.
    expect(await (await fetch(`${base}/connect?${new URLSearchParams({ client: "x", redirect, state: "s" })}`, { headers: { authorization: `Bearer ${token}` } })).text()).not.toContain("Allow <b>");

    // Rooms: token as a query param (no Origin) or an Authorization header.
    const q = await roomHello(base, { repo: ws, path: "README.md", token }, {});
    expect(q.hello?.readOnly).toBe(false);
    q.client.close();
    const h = await roomHello(base, { repo: ws, path: "README.md" }, { authorization: `Bearer ${token}` });
    expect(h.hello?.readOnly).toBe(false);
    h.client.close();
    // Cross-origin with a cookie is still refused; a bad token is unauthorized.
    expect((await roomHello(base, { repo: ws, path: "README.md" }, { cookie, origin: "https://evil.example" })).client.closeCode).toBe(4403);
    expect((await roomHello(base, { repo: ws, path: "README.md", token: "gmt_bad" }, {})).client.closeCode).toBe(4401);

    const item = (await api({ token }, "GET", "/api/me")).data.token;
    expect(item).toEqual({ id: loc.searchParams.get("token_id"), label: "Grimoire for Mac · Test Mac" });
    // Someone else can't revoke it.
    const other = await devLogin("Other Tok");
    expect((await api({ cookie: other }, "DELETE", `/api/tokens/${item.id}`)).status).toBe(404);
    expect((await api({ cookie }, "DELETE", `/api/tokens/${item.id}`)).data).toEqual({ ok: true });
    expect((await api({ token }, "GET", "/api/me")).status).toBe(401);
    expect((await roomHello(base, { repo: ws, path: "README.md", token }, {})).client.closeCode).toBe(4401);
    expect((await api({ cookie }, "DELETE", `/api/tokens/${item.id}`)).status).toBe(404);
  });
});
