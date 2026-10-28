// migrations/0001_init.sql (fresh databases, D1) and src/server/db.ts (self-hosted databases, upgraded in place)
// must build the same global tables.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../../src/server/db.ts";
import { bunDb } from "../../src/server/bun/db-bun.ts";

const ROOT = join(import.meta.dir, "../..");
const INIT = readFileSync(join(ROOT, "migrations/0001_init.sql"), "utf8");
const ROOM_TABLES = new Set(["room_meta", "room_updates"]);

function schema(d: Database) {
  const tables = (d.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>)
    .map((t) => t.name)
    .filter((t) => !ROOM_TABLES.has(t));
  const out: Record<string, unknown> = {};
  for (const t of tables) {
    const indexes = (d.query(`PRAGMA index_list(${t})`).all() as Array<{ name: string; unique: number; origin: string; partial: number }>)
      .map((i) => ({
        name: i.name,
        unique: i.unique,
        origin: i.origin,
        partial: i.partial,
        columns: (d.query(`PRAGMA index_info(${i.name})`).all() as Array<{ name: string }>).map((c) => c.name),
        where: (d.query("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(i.name) as { sql: string | null } | null)?.sql?.match(/WHERE .*/)?.[0] ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    out[t] = {
      columns: d.query(`PRAGMA table_xinfo(${t})`).all(),
      foreignKeys: (d.query(`PRAGMA foreign_key_list(${t})`).all() as Array<Record<string, unknown>>)
        .map(({ id: _id, seq: _seq, ...fk }) => fk)
        .sort((a, b) => String(a.from).localeCompare(String(b.from))),
      indexes,
    };
  }
  return out;
}

function fresh(): Database {
  const d = new Database(":memory:");
  d.exec("PRAGMA foreign_keys = ON;");
  d.exec(INIT);
  return d;
}

describe("schema", () => {
  test("0001_init.sql builds the same global tables as db.ts", () => {
    const want = schema(db);
    expect(Object.keys(want).sort()).toEqual(["app_tokens", "joined", "repos", "sessions", "share_links", "users"]);
    expect(schema(fresh())).toEqual(want);
  });

  test("0001_init.sql has no room tables and has repos.head", () => {
    const d = fresh();
    for (const t of ROOM_TABLES) expect(d.query("SELECT 1 FROM sqlite_master WHERE name = ?").get(t)).toBeNull();
    expect((d.query("PRAGMA table_info(repos)").all() as Array<{ name: string }>).map((c) => c.name)).toContain("head");
  });

  test("an old database gains repos.head (and the rest of today's shape) in place", async () => {
    const dir = join(process.env.DATA_DIR!, `schema-legacy-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const old = new Database(join(dir, "grimoire.sqlite"), { create: true });
    old.exec(`
CREATE TABLE users (id TEXT PRIMARY KEY, github_id INTEGER UNIQUE, login TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL,
  avatar TEXT, github_token TEXT, is_admin INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE TABLE repos (id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL, gh_owner TEXT, gh_name TEXT,
  read_only INTEGER NOT NULL DEFAULT 0, branch TEXT NOT NULL, status TEXT NOT NULL, error TEXT, created_by TEXT, created_at INTEGER NOT NULL);
CREATE TABLE share_links (id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE, label TEXT,
  created_by TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER);
CREATE TABLE room_meta (room TEXT PRIMARY KEY, generation TEXT NOT NULL, base_commit TEXT, base_content TEXT NOT NULL, base_snapshot BLOB NOT NULL);
CREATE TABLE room_updates (seq INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, data BLOB NOT NULL);
INSERT INTO users (id, login, name, email, created_at) VALUES ('u1', 'ada', 'Ada', 'ada@example.com', 1);
INSERT INTO repos (id, title, kind, branch, status, created_by, created_at) VALUES ('r1', 'Notes', 'notes', 'main', 'ready', 'u1', 1);
`);
    old.close();

    const proc = Bun.spawn([process.execPath, "--eval", `await import(${JSON.stringify(join(ROOT, "src/server/db.ts"))})`], {
      cwd: ROOT,
      env: { ...process.env, DATA_DIR: dir, STORAGE: "local" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    expect(await new Response(proc.stderr).text()).toBe("");
    expect(code).toBe(0);

    const upgraded = new Database(join(dir, "grimoire.sqlite"));
    try {
      expect(schema(upgraded)).toEqual(schema(fresh()));
      expect(upgraded.query("SELECT id, owner_id, head FROM repos").all()).toEqual([{ id: "r1", owner_id: "u1", head: null }]);
    } finally {
      upgraded.close();
    }
  });
});

describe("bun Db", () => {
  test("get, all, run and an atomic batch", async () => {
    const d = bunDb(fresh());
    await d.run("INSERT INTO users (id, login, name, email, created_at) VALUES (?, ?, ?, ?, ?)", "u1", "ada", "Ada", "a@x", 1);
    expect(await d.get<{ login: string }>("SELECT login FROM users WHERE id = ?", "u1")).toEqual({ login: "ada" });
    expect(await d.get("SELECT login FROM users WHERE id = ?", "nobody")).toBeNull();
    expect((await d.run("UPDATE users SET name = ? WHERE id = ?", "Ada L", "u1")).changes).toBe(1);

    await d.batch([
      ["INSERT INTO repos (id, title, kind, branch, status, created_at, owner_id) VALUES (?, ?, 'notes', 'main', 'ready', 1, ?)", "r1", "One", "u1"],
      ["UPDATE repos SET head = ? WHERE id = ?", "abc", "r1"],
    ]);
    expect(await d.all("SELECT id, head FROM repos")).toEqual([{ id: "r1", head: "abc" }]);

    // The second statement fails (duplicate key): the first must not apply.
    await expect(
      d.batch([
        ["INSERT INTO repos (id, title, kind, branch, status, created_at) VALUES ('r2', 'Two', 'notes', 'main', 'ready', 1)"],
        ["INSERT INTO repos (id, title, kind, branch, status, created_at) VALUES ('r1', 'Dup', 'notes', 'main', 'ready', 1)"],
      ]),
    ).rejects.toThrow();
    expect(await d.all<{ id: string }>("SELECT id FROM repos ORDER BY id")).toEqual([{ id: "r1" }]);
  });
});
