// The per-process auth cache (CF-22): session and app-token lookups are cached for 60 s (unknown tokens for 10 s),
// logout and revoke evict, and the cache is off unless config.authCache is set (Workers sets it; Bun leaves it off).
import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TtlCache } from "../../src/server/ttl-cache.ts";

const { config } = await import("../../src/server/config.ts");
const { AUTH_CACHE_MS, AUTH_NEGATIVE_MS, authenticate, endSession, resetAuthCache } = await import("../../src/server/auth.ts");
const { createAppToken, revokeAppToken } = await import("../../src/server/tokens.ts");
const { sha256 } = await import("../../src/server/db.ts");
const { bunDb } = await import("../../src/server/bun/db-bun.ts");

const defaultOn = config.authCache;
afterAll(() => {
  config.authCache = defaultOn;
  resetAuthCache();
});

// A fresh database with the shared schema, behind a Db that counts its queries.
const sqlite = new Database(":memory:");
sqlite.exec(readFileSync(join(import.meta.dir, "../../migrations/0001_init.sql"), "utf8"));
const inner = bunDb(sqlite);
let queries: string[] = [];
const db = {
  get: (sql: string, ...p: unknown[]) => (queries.push(sql), inner.get(sql, ...p)),
  all: (sql: string, ...p: unknown[]) => (queries.push(sql), inner.all(sql, ...p)),
  run: (sql: string, ...p: unknown[]) => (queries.push(sql), inner.run(sql, ...p)),
  batch: (s: Array<[string, ...unknown[]]>) => (queries.push(...s.map((x) => x[0])), inner.batch(s)),
} as typeof inner;

let clock = 1_000_000;
const now = () => clock;

sqlite.query("INSERT INTO users (id, github_id, login, name, email, avatar, github_token, created_at) VALUES ('u1', NULL, 'ann', 'Ann', 'ann@x', NULL, NULL, 0)").run();
sqlite.query("INSERT INTO users (id, github_id, login, name, email, avatar, github_token, created_at) VALUES ('u2', NULL, 'bob', 'Bob', 'bob@x', NULL, NULL, 0)").run();

let n = 0;
function session(userId = "u1"): string {
  const token = `sess-${++n}`;
  sqlite.query("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(token), userId, Date.now() + 3600_000);
  return token;
}
const withCookie = (token: string) => new Request("http://x/api/me", { headers: { cookie: `np_session=${encodeURIComponent(token)}` } });
const withBearer = (token: string) => new Request("http://x/api/me", { headers: { authorization: `Bearer ${token}` } });

async function counted<T>(fn: () => Promise<T>): Promise<{ value: T; queries: number }> {
  queries = [];
  const value = await fn();
  return { value, queries: queries.length };
}

describe("TtlCache", () => {
  test("expires entries by the injected clock", () => {
    let t = 0;
    const c = new TtlCache<string, number>({ now: () => t });
    c.set("a", 1, 100);
    t = 99;
    expect(c.get("a")).toBe(1);
    t = 100;
    expect(c.get("a")).toBeUndefined();
    expect(c.size).toBe(0);
  });

  test("drops the least recently used entry at the cap", () => {
    const c = new TtlCache<string, number>({ max: 2 });
    c.set("a", 1, 1000);
    c.set("b", 2, 1000);
    c.get("a");
    c.set("c", 3, 1000);
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBe(1);
    expect(c.get("c")).toBe(3);
  });

  test("caches null values and deletes by value", () => {
    const c = new TtlCache<string, { id: string } | null>();
    c.set("x", null, 1000);
    expect(c.lookup("x")).toEqual({ value: null });
    c.set("y", { id: "1" }, 1000);
    c.set("z", { id: "2" }, 1000);
    expect(c.deleteWhere((v) => v?.id === "1")).toBe(1);
    expect(c.get("y")).toBeUndefined();
    expect(c.get("z")).toEqual({ id: "2" });
  });
});

describe("auth cache off (Bun default)", () => {
  test("AUTH_CACHE unset: off, every lookup queries the Db", async () => {
    expect(process.env.AUTH_CACHE).toBeUndefined();
    expect(defaultOn).toBe(false);
    config.authCache = false;
    resetAuthCache(now);
    const req = withCookie(session());
    expect((await counted(() => authenticate(db, req))).queries).toBeGreaterThan(0);
    const again = await counted(() => authenticate(db, req));
    expect(again.value?.user.id).toBe("u1");
    expect(again.queries).toBe(1);
  });
});

describe("auth cache on (Workers)", () => {
  beforeEach(() => {
    config.authCache = true;
    clock = 1_000_000;
    resetAuthCache(now);
  });

  test("a session hit makes no Db query, and expires after 60 s", async () => {
    const req = withCookie(session());
    const first = await counted(() => authenticate(db, req));
    expect(first.value).toMatchObject({ user: { id: "u1", name: "Ann" }, viaToken: false });
    expect(first.queries).toBeGreaterThan(0);

    clock += AUTH_CACHE_MS - 1;
    const hit = await counted(() => authenticate(db, req));
    expect(hit.value).toMatchObject({ user: { id: "u1" }, viaToken: false });
    expect(hit.queries).toBe(0);

    clock += 1;
    const miss = await counted(() => authenticate(db, req));
    expect(miss.value?.user.id).toBe("u1");
    expect(miss.queries).toBe(1);
  });

  test("cached users are copies", async () => {
    const req = withCookie(session());
    (await authenticate(db, req))!.user.name = "Mallory";
    expect((await authenticate(db, req))!.user.name).toBe("Ann");
  });

  test("an app-token hit makes no Db query, and expires after 60 s", async () => {
    const { token } = await createAppToken(db, "u2", "Mac");
    const first = await counted(() => authenticate(db, withBearer(token)));
    expect(first.value).toMatchObject({ user: { id: "u2" }, viaToken: true });
    expect(first.queries).toBeGreaterThan(0);

    clock += AUTH_CACHE_MS - 1;
    const hit = await counted(() => authenticate(db, withBearer(token), null));
    expect(hit.value).toMatchObject({ user: { id: "u2" }, viaToken: true });
    expect(hit.queries).toBe(0);
    // The WebSocket query token shares the entry.
    expect((await counted(() => authenticate(db, new Request("http://x/ws"), token))).queries).toBe(0);

    clock += 1;
    expect((await counted(() => authenticate(db, withBearer(token)))).queries).toBeGreaterThan(0);
  });

  test("logout evicts the session", async () => {
    const req = withCookie(session());
    expect((await authenticate(db, req))?.user.id).toBe("u1");
    expect((await counted(() => authenticate(db, req))).queries).toBe(0);
    await endSession(db, req);
    const after = await counted(() => authenticate(db, req));
    expect(after.value).toBeNull();
    expect(after.queries).toBe(1);
  });

  test("revoke evicts the app token", async () => {
    const { id, token } = await createAppToken(db, "u2", "Mac");
    const other = await createAppToken(db, "u2", "Other");
    expect((await authenticate(db, withBearer(token)))?.user.id).toBe("u2");
    expect((await authenticate(db, withBearer(other.token)))?.user.id).toBe("u2");
    expect(await revokeAppToken(db, "u1", id)).toBe(false); // not Ann's token: still cached
    expect((await counted(() => authenticate(db, withBearer(token)))).queries).toBe(0);
    expect(await revokeAppToken(db, "u2", id)).toBe(true);
    const after = await counted(() => authenticate(db, withBearer(token)));
    expect(after.value).toBeNull();
    expect(after.queries).toBe(1);
    // Other tokens stay cached.
    expect((await counted(() => authenticate(db, withBearer(other.token)))).queries).toBe(0);
  });

  test("unknown tokens are cached for 10 s", async () => {
    for (const req of [withCookie("no-such-session"), withBearer("gmt_nope")]) {
      expect((await counted(() => authenticate(db, req))).value).toBeNull();
      clock += AUTH_NEGATIVE_MS - 1;
      const hit = await counted(() => authenticate(db, req));
      expect(hit.value).toBeNull();
      expect(hit.queries).toBe(0);
      clock += 1;
      const miss = await counted(() => authenticate(db, req));
      expect(miss.value).toBeNull();
      expect(miss.queries).toBe(1);
    }
  });

  test("a session is not cached past its expiry", async () => {
    const token = `sess-${++n}`;
    sqlite.query("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(token), "u1", Date.now() + 5_000);
    expect((await authenticate(db, withCookie(token)))?.user.id).toBe("u1");
    clock += 5_000;
    expect((await counted(() => authenticate(db, withCookie(token)))).queries).toBe(1);
  });

  test("the cache is per process: another process's revoke is seen after at most 60 s", async () => {
    const { id, token } = await createAppToken(db, "u1", "Mac");
    expect((await authenticate(db, withBearer(token)))?.user.id).toBe("u1");
    sqlite.query("UPDATE app_tokens SET revoked_at = 1 WHERE id = ?").run(id);
    expect((await authenticate(db, withBearer(token)))?.user.id).toBe("u1");
    clock += AUTH_CACHE_MS;
    expect(await authenticate(db, withBearer(token))).toBeNull();
  });
});
