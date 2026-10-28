// WebSocket admission (app.ts admitWorkspace) on a remote database: the caller and the workspace row are looked up
// at once, and with `defer` the join is recorded after the socket goes through (Workers: each is a D1 round trip).
import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { config } = await import("../../src/server/config.ts");
const { admitWorkspace } = await import("../../src/server/app.ts");
const { bunDb } = await import("../../src/server/bun/db-bun.ts");
const { sha256 } = await import("../../src/server/ids.ts");
const { resetAuthCache } = await import("../../src/server/auth.ts");
const { resetRepoCache } = await import("../../src/server/repo-cache.ts");
const { clearJoinCache } = await import("../../src/server/workspaces.ts");

const sqlite = new Database(":memory:");
sqlite.exec(readFileSync(join(import.meta.dir, "../../migrations/0001_init.sql"), "utf8"));
sqlite.query("INSERT INTO users (id, github_id, login, name, email, avatar, github_token, created_at) VALUES ('u1', NULL, 'ann', 'Ann', 'ann@x', NULL, NULL, 0)").run();
sqlite.query("INSERT INTO repos (id, title, kind, branch, status, created_at) VALUES ('a', 'a', 'notes', 'main', 'ready', 0)").run();
sqlite.query("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, 'u1', ?)").run(sha256("tok"), Date.now() + 3600_000);
const inner = bunDb(sqlite);

/** A Db whose statements wait until released, so the test sees which ones are in flight together. */
function gatedDb() {
  const waiting: Array<{ sql: string; go: () => void }> = [];
  let changed: () => void = () => {};
  const gate = <T>(sql: string, fn: () => Promise<T>) =>
    new Promise<void>((go) => {
      waiting.push({ sql, go });
      changed();
    }).then(fn);
  const db = {
    get: (sql: string, ...p: unknown[]) => gate(sql, () => inner.get(sql, ...p)),
    all: (sql: string, ...p: unknown[]) => gate(sql, () => inner.all(sql, ...p)),
    run: (sql: string, ...p: unknown[]) => gate(sql, () => inner.run(sql, ...p)),
    batch: (s: Array<[string, ...unknown[]]>) => gate("batch", () => inner.batch(s)),
  } as typeof inner;
  /** Resolves once `n` statements are waiting. */
  const pending = (n: number) =>
    new Promise<string[]>((resolve) => {
      const check = () => waiting.length >= n && resolve(waiting.map((w) => w.sql));
      changed = check;
      check();
    });
  const releaseAll = () => waiting.splice(0).forEach((w) => w.go());
  return { db, pending, releaseAll };
}

const req = () => new Request(`${config.publicUrl}/ws?repo=a&path=x.md`, { headers: { origin: config.publicUrl, cookie: "np_session=tok" } });

beforeEach(() => {
  resetAuthCache();
  resetRepoCache();
  clearJoinCache();
  sqlite.query("DELETE FROM joined").run();
});

test("the session and the workspace row are read at the same time", async () => {
  const g = gatedDb();
  const r = req();
  const admitted = admitWorkspace(g.db, r, new URL(r.url));
  const both = await g.pending(2);
  expect(both.some((s) => /FROM sessions/.test(s))).toBe(true);
  expect(both.some((s) => /FROM repos/.test(s))).toBe(true);
  g.releaseAll();
  // the join's statements come next (no defer: awaited before admitting)
  let done = false;
  void admitted.then(() => (done = true));
  while (!done) {
    await Promise.race([g.pending(1), admitted]);
    g.releaseAll();
  }
  expect(await admitted).toMatchObject({ repoId: "a", path: "x.md" });
  expect(sqlite.query("SELECT 1 FROM joined WHERE workspace_id = 'a' AND user_id = 'u1'").get()).not.toBeNull();
});

test("with defer, the socket is admitted before the join is written, and the join still lands", async () => {
  const g = gatedDb();
  const deferred: Promise<unknown>[] = [];
  const r = req();
  const admitted = admitWorkspace(g.db, r, new URL(r.url), { defer: (p) => deferred.push(p) });
  await g.pending(2);
  g.releaseAll();
  expect(await admitted).toMatchObject({ repoId: "a", participant: { id: "u1" } });
  expect(deferred.length).toBe(1);
  // the join's read is still waiting: nothing written yet
  expect(await g.pending(1)).toEqual([expect.stringMatching(/FROM joined/)]);
  expect(sqlite.query("SELECT 1 FROM joined").get()).toBeNull();
  while (!sqlite.query("SELECT 1 FROM joined").get()) {
    g.releaseAll();
    await Promise.race([g.pending(1), deferred[0]]);
  }
  await deferred[0];
  expect(sqlite.query("SELECT 1 FROM joined WHERE workspace_id = 'a' AND user_id = 'u1'").get()).not.toBeNull();
});
