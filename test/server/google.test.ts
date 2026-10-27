// Google sign-in against a fake provider, the sign-in policy, /api/server, and app tokens (/connect, bearer auth).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fakeGoogle, googleSignIn, isolate, roomHello, type FakeGoogle } from "./helpers.ts";

process.env.QUIET_MS = "100";
process.env.POLL_MS = "60000";
const { config } = await import("../../src/server/config.ts");
const { db: earlyDb } = await import("../../src/server/db.ts");
const restore = isolate(config, earlyDb);
Object.assign(config, { storage: "local", allowDevLogin: true, allowedUsers: ["*"], quietMs: 100, pollMs: 60000, notesRepo: "gg-notes", signin: "open", allowedEmails: [] });
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
    expect(r.data).toEqual({ name: new URL(config.publicUrl).host, publicUrl: config.publicUrl, signin: "open", google: true, devLogin: true, version: expect.any(String) });
    config.signin = "emails";
    try {
      expect((await api({}, "GET", "/api/server")).data).toMatchObject({ signin: "emails", devLogin: false });
    } finally {
      config.signin = "open";
    }
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
    expect(typeof me.data.admin).toBe("boolean");
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

  test("SIGNIN=emails: only listed verified emails (addresses or *@domain); name-only and guest sign-in are off", async () => {
    config.signin = "emails";
    config.allowedEmails = ["boss@other.org", "*@corp.example"];
    try {
      const refused = await googleSignIn(base, fg, { sub: "g-outsider", email: "outsider@example.com" });
      expect(refused.res.status).toBe(403);
      expect(await refused.res.text()).toContain("ALLOWED_EMAILS");
      // A subdomain isn't the domain.
      expect((await googleSignIn(base, fg, { sub: "g-sub", email: "x@sub.corp.example" })).res.status).toBe(403);
      const ok = await googleSignIn(base, fg, { sub: "g-corp", email: "dev@corp.example" });
      expect(ok.res.status).toBe(303);
      expect((await api({ cookie: ok.cookie! }, "GET", "/api/me")).status).toBe(200);
      expect((await googleSignIn(base, fg, { sub: "g-boss", email: "BOSS@other.org" })).res.status).toBe(303);
      // Name-only and guest sign-in are gone; existing name-only sessions stop working (unless admin).
      expect((await fetch(`${base}/auth/dev`, { method: "POST", headers: { origin: base }, body: new URLSearchParams({ name: "Zed" }), redirect: "manual" })).status).toBe(404);
      expect((await fetch(`${base}/auth/guest`, { method: "POST", headers: { origin: base } })).status).toBe(404);
    } finally {
      config.signin = "open";
      config.allowedEmails = [];
    }
    const zed = await devLogin("Zed");
    db.query("UPDATE users SET is_admin = 0 WHERE login = 'zed'").run();
    config.signin = "emails";
    try {
      expect((await api({ cookie: zed }, "GET", "/api/me")).status).toBe(401);
    } finally {
      config.signin = "open";
    }
    expect((await api({ cookie: zed }, "GET", "/api/me")).status).toBe(200);
  });

  test("a Google account is linked to an existing account with the same verified email", async () => {
    const cookie = await devLogin("Linky");
    const id = (await api({ cookie }, "GET", "/api/me")).data.id;
    db.query("UPDATE users SET email = 'linky@example.com', email_verified = 1, is_admin = 0 WHERE id = ?").run(id);
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

    const list = (await api({ cookie }, "GET", "/api/tokens")).data;
    const item = list.find((t: any) => t.label === "Grimoire for Mac · Test Mac");
    expect(item).toEqual({ id: expect.any(String), label: "Grimoire for Mac · Test Mac", createdAt: expect.any(Number), lastUsedAt: expect.any(Number) });
    // Someone else can't revoke it.
    const other = await devLogin("Other Tok");
    expect((await api({ cookie: other }, "DELETE", `/api/tokens/${item.id}`)).status).toBe(404);
    expect((await api({ cookie }, "DELETE", `/api/tokens/${item.id}`)).data).toEqual({ ok: true });
    expect((await api({ token }, "GET", "/api/me")).status).toBe(401);
    expect((await roomHello(base, { repo: ws, path: "README.md", token }, {})).client.closeCode).toBe(4401);
    expect((await api({ cookie }, "GET", "/api/tokens")).data.some((t: any) => t.id === item.id)).toBe(false);
    expect((await api({ cookie }, "DELETE", `/api/tokens/${item.id}`)).status).toBe(404);
  });
});
