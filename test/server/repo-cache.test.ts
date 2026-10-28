// The per-process workspace-row cache (CF-27): rows read by id are cached for 10 s when config.repoCache is on
// (Workers), every write to repos empties it, and it is off unless REPO_CACHE=1 (Bun leaves it off).
import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { config } = await import("../../src/server/config.ts");
const { REPO_CACHE_MS, cachedRepo, forgetRepo, repoCacheDb, resetRepoCache, writesRepos } = await import("../../src/server/repo-cache.ts");
const { RepoService, getRepo } = await import("../../src/server/repos.ts");
const { admitWorkspace } = await import("../../src/server/app.ts");
const { bunDb } = await import("../../src/server/bun/db-bun.ts");
const { bunRoomStorage } = await import("../../src/server/bun/room-storage-bun.ts");
const { MemoryStore } = await import("../../src/server/store/memory.ts");
const { RoomManager } = await import("../../src/server/rooms.ts");
const { sha256 } = await import("../../src/server/ids.ts");
const { resetAuthCache } = await import("../../src/server/auth.ts");

const defaultOn = config.repoCache;
afterAll(() => {
  config.repoCache = defaultOn;
  resetRepoCache();
});

// A fresh database with the shared schema, behind a Db that records its statements.
const sqlite = new Database(":memory:");
sqlite.exec(readFileSync(join(import.meta.dir, "../../migrations/0001_init.sql"), "utf8"));
const inner = bunDb(sqlite);
let queries: string[] = [];
const spy = {
  get: (sql: string, ...p: unknown[]) => (queries.push(sql), inner.get(sql, ...p)),
  all: (sql: string, ...p: unknown[]) => (queries.push(sql), inner.all(sql, ...p)),
  run: (sql: string, ...p: unknown[]) => (queries.push(sql), inner.run(sql, ...p)),
  batch: (s: Array<[string, ...unknown[]]>) => (queries.push(...s.map((x) => x[0])), inner.batch(s)),
} as typeof inner;
const db = repoCacheDb(spy);

const store = new MemoryStore();
const repos = new RepoService(store as any, new RoomManager(store, { storage: bunRoomStorage(), db }), db);

let clock = 1_000_000;
sqlite.query("INSERT INTO users (id, github_id, login, name, email, avatar, github_token, created_at) VALUES ('u1', NULL, 'ann', 'Ann', 'ann@x', NULL, NULL, 0)").run();

function addRepo(id: string, status = "ready") {
  sqlite.query("INSERT INTO repos (id, title, kind, branch, status, created_at) VALUES (?, ?, 'notes', 'main', ?, 0)").run(id, id, status);
}

async function counted<T>(fn: () => Promise<T>): Promise<{ value: T; queries: string[] }> {
  queries = [];
  const value = await fn();
  return { value, queries };
}

beforeEach(() => {
  config.repoCache = true;
  clock = 1_000_000;
  resetRepoCache(() => clock);
  sqlite.exec("DELETE FROM repos");
});

describe("workspace-row cache", () => {
  test("a hit makes no Db query (repos.get, getRepo, cachedRepo)", async () => {
    addRepo("a");
    const first = await counted(() => repos.get("a"));
    expect(first.value?.title).toBe("a");
    expect(first.queries).toEqual(["SELECT * FROM repos WHERE id = ?"]);
    for (const read of [() => repos.get("a"), () => getRepo(db, "a"), () => cachedRepo(spy, "a")]) {
      const hit = await counted(read);
      expect(hit.value?.id).toBe("a");
      expect(hit.queries).toEqual([]);
    }
  });

  test("WebSocket admission reads the row from the cache", async () => {
    addRepo("a");
    sqlite.query("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, 'u1', ?)").run(sha256("tok"), Date.now() + 3600_000);
    resetAuthCache();
    const req = () =>
      new Request(`${config.publicUrl}/ws?repo=a&path=x.md`, { headers: { origin: config.publicUrl, cookie: "np_session=tok" } });
    const url = (r: Request) => new URL(r.url);
    await repos.get("a");
    const { value, queries: q } = await counted(() => {
      const r = req();
      return admitWorkspace(db, r, url(r));
    });
    expect(value).toMatchObject({ repoId: "a", path: "x.md" });
    expect(q).not.toContain("SELECT * FROM repos WHERE id = ?");
  });

  test("callers get copies", async () => {
    addRepo("a");
    (await repos.get("a"))!.title = "changed";
    expect((await repos.get("a"))!.title).toBe("a");
  });

  test("missing and not-ready workspaces are not cached", async () => {
    expect(await repos.get("nope")).toBeNull();
    addRepo("nope");
    expect((await repos.get("nope"))?.id).toBe("nope");
    addRepo("imp", "importing");
    await repos.get("imp");
    sqlite.query("UPDATE repos SET status = 'ready' WHERE id = 'imp'").run();
    expect((await counted(() => repos.get("imp"))).value?.status).toBe("ready");
  });

  test("expires after REPO_CACHE_MS (injected clock)", async () => {
    addRepo("a");
    await repos.get("a");
    sqlite.query("UPDATE repos SET title = 'renamed' WHERE id = 'a'").run(); // behind the cache's back
    clock += REPO_CACHE_MS - 1;
    expect((await counted(() => repos.get("a"))).queries).toEqual([]);
    expect((await repos.get("a"))!.title).toBe("a");
    clock += 1;
    const after = await counted(() => repos.get("a"));
    expect(after.queries).toHaveLength(1);
    expect(after.value!.title).toBe("renamed");
  });

  test("writes evict: delete, create, status, branch, read-only, owner, head", async () => {
    const writes: Array<[string, ...unknown[]]> = [
      ["UPDATE repos SET status = 'error', error = 'x' WHERE id = ?", "a"],
      ["UPDATE repos SET status = 'importing', error = NULL, created_by = ? WHERE id = ? AND status = 'error'", "u", "a"],
      ["UPDATE repos SET status = 'ready', error = NULL WHERE id = ?", "a"],
      ["UPDATE repos SET branch = ? WHERE id = ?", "dev", "a"],
      ["UPDATE repos SET read_only = 1 WHERE kind = 'github' AND read_only = 0"],
      ["UPDATE repos SET owner_id = NULL WHERE id = ?", "a"],
      ["UPDATE repos SET head = ? WHERE id = ? AND branch = ? AND head IS NOT ?", "abc", "a", "dev", "abc"],
      ["DELETE FROM repos WHERE id = ?", "a"],
    ];
    addRepo("a");
    for (const [sql, ...params] of writes) {
      sqlite.query("UPDATE repos SET status = 'ready' WHERE id = 'a'").run(); // behind the cache's back
      await repos.get("a");
      expect((await counted(() => repos.get("a"))).queries).toEqual([]);
      await db.run(sql, ...params);
      const after = await counted(() => repos.get("a"));
      expect(after.queries).toHaveLength(1);
      expect(after.value).toEqual(await inner.get("SELECT * FROM repos WHERE id = ?", "a"));
    }
    // create: a row inserted through the Db replaces nothing stale (missing rows aren't cached), and a batch evicts
    await db.run("INSERT INTO repos (id, title, kind, branch, status, created_at) VALUES (?, 'A', 'notes', 'main', 'ready', 0) ON CONFLICT (id) DO NOTHING", "a");
    expect((await repos.get("a"))!.title).toBe("A");
    await db.batch([["UPDATE repos SET title = 'B' WHERE id = ?", "a"]]);
    expect((await repos.get("a"))!.title).toBe("B");
  });

  test("RepoService writes evict: removeRepo, createNotesRepo, retryImport", async () => {
    addRepo("a");
    await repos.get("a");
    await repos.removeRepo("a");
    expect(await repos.get("a")).toBeNull();

    const row = (await repos.get((await repos.createNotesRepo("Plans", "u1")).id))!;
    expect(row.status).toBe("ready");
    expect((await counted(() => repos.get(row.id))).queries).toEqual([]);
    await repos.removeRepo(row.id);
    expect(await repos.get(row.id)).toBeNull();
  });

  test("a read that started before a write doesn't store the old row", async () => {
    addRepo("a");
    const read = repos.get("a");
    await db.run("UPDATE repos SET title = 'new' WHERE id = ?", "a");
    expect((await read)!.title).toBe("a");
    expect((await repos.get("a"))!.title).toBe("new");
  });

  test("forgetRepo drops one row", async () => {
    addRepo("a");
    addRepo("b");
    await repos.get("a");
    await repos.get("b");
    forgetRepo("a");
    expect((await counted(() => repos.get("a"))).queries).toHaveLength(1);
    expect((await counted(() => repos.get("b"))).queries).toEqual([]);
  });

  test("off by default on Bun: every read queries", async () => {
    expect(defaultOn).toBe(false);
    config.repoCache = defaultOn;
    addRepo("a");
    await repos.get("a");
    expect((await counted(() => repos.get("a"))).queries).toHaveLength(1);
    expect((await counted(() => cachedRepo(spy, "a"))).queries).toHaveLength(1);
  });

  test("recognises writes to repos only", () => {
    expect(writesRepos("UPDATE repos SET x = 1")).toBe(true);
    expect(writesRepos("  delete from repos where id = ?")).toBe(true);
    expect(writesRepos("INSERT INTO repos (id) SELECT ?")).toBe(true);
    expect(writesRepos("INSERT OR IGNORE INTO repos (id) VALUES (?)")).toBe(true);
    expect(writesRepos("UPDATE repos_other SET x = 1")).toBe(false);
    expect(writesRepos("INSERT INTO joined (user_id, repo_id) VALUES (?, ?)")).toBe(false);
    expect(writesRepos("DELETE FROM share_links WHERE repo_id = ?")).toBe(false);
    expect(writesRepos("SELECT * FROM repos WHERE id = ?")).toBe(false);
  });
});
