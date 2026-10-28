// Folders (workspaces) are public: anyone signed in opens and edits any of them (and anyone reads them); the joined list; only
// the maker removes a folder; agent links (one per person per folder); and the migration of older databases.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { isolate, roomHello } from "./helpers.ts";

const dir = process.env.DATA_DIR!;
process.env.QUIET_MS = "100";
process.env.POLL_MS = "60000";
const { config } = await import("../../src/server/config.ts");
const { db: earlyDb } = await import("../../src/server/db.ts");
const restore = isolate(config, earlyDb);
Object.assign(config, { storage: "local", allowDevLogin: true, quietMs: 100, pollMs: 60000, notesRepo: "wst-notes" });
config.github.clientId = "";
config.github.appSlug = "";
const { startServer } = await import("../../src/server/index.ts");

let app: Awaited<ReturnType<typeof startServer>>;
let base = "";

interface Person {
  cookie: string;
  id: string;
  name: string;
}

async function person(name: string): Promise<Person> {
  const res = await fetch(`${base}/auth/dev`, { method: "POST", headers: { origin: base }, body: new URLSearchParams({ name }), redirect: "manual" });
  expect(res.status).toBe(303);
  const cookie = res.headers.getSetCookie().find((s) => s.startsWith("np_session="))!.split(";")[0]!;
  const id = (await api(cookie, "GET", "/api/me")).data.id;
  return { cookie, id, name };
}

async function api(cookie: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { cookie, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

/** A workspace made by `owner` with notes committed. */
async function workspace(owner: Person, title: string, files: Record<string, string> = {}) {
  const r = await api(owner.cookie, "POST", "/api/workspaces", { title });
  expect(r.status).toBe(201);
  const id = r.data.id as string;
  if (Object.keys(files).length) {
    await app.ctx.store.commit({
      repo: id,
      branch: "main",
      expectedHead: await app.ctx.store.head(id, "main"),
      changes: Object.entries(files).map(([path, content]) => ({ path, content })),
      message: "seed",
      author: { name: "x", email: "x@example.com" },
    });
  }
  return id;
}

const roomFor = (p: Person, repo: string, path: string) => roomHello(base, { repo, path }, { cookie: p.cookie, origin: base });

beforeAll(async () => {
  app = await startServer({ port: 0, quiet: true });
  base = `http://localhost:${app.server.port}`;
});

afterAll(async () => {
  await app?.stop();
  restore();
});

describe("public folders", () => {
  test("anyone signed in opens and edits any folder; opening it joins it; leaving takes it off the list", async () => {
    const owner = await person("Pub Owner");
    const ws = await workspace(owner, "WST Public", { "p.md": "p\n" });
    const item = { id: ws, title: "WST Public", kind: "notes", readOnly: false, status: "ready", head: expect.any(String) };
    expect((await api(owner.cookie, "GET", "/api/workspaces")).data.find((w: any) => w.id === ws)).toEqual({ ...item, canRemove: true });
    expect((await api(owner.cookie, "GET", `/api/workspaces/${ws}`)).data).toEqual({ ...item, canRemove: true, ownerId: owner.id });

    for (const p of [await person("Pub Other"), await person("moist-noodle")]) {
      expect((await api(p.cookie, "GET", "/api/workspaces")).data.some((w: any) => w.id === ws)).toBe(false);
      expect((await api(p.cookie, "GET", `/api/workspaces/${ws}`)).data).toMatchObject({ ...item, canRemove: false });
      expect((await api(p.cookie, "GET", `/api/repos/${ws}/tree`)).data.files).toContain("p.md");
      expect((await api(p.cookie, "GET", "/api/workspaces")).data.find((w: any) => w.id === ws)).toEqual({ ...item, canRemove: false });
      expect((await api(p.cookie, "GET", "/api/repos")).data.find((r: any) => r.id === ws)).toMatchObject({ readOnly: false, canRemove: false });
      expect((await api(p.cookie, "POST", `/api/repos/${ws}/files`, { path: `${p.id}.md` })).status).toBe(201);
      expect((await roomFor(p, ws, "p.md")).hello?.readOnly).toBe(false);
      // Leave: off the list (always allowed); opening it again rejoins.
      expect((await api(p.cookie, "DELETE", `/api/workspaces/${ws}/join`)).data).toEqual({ ok: true });
      expect((await api(p.cookie, "GET", "/api/workspaces")).data.some((w: any) => w.id === ws)).toBe(false);
      // Opening the room alone also records the join.
      await roomFor(p, ws, "p.md");
      expect((await api(p.cookie, "GET", "/api/workspaces")).data.some((w: any) => w.id === ws)).toBe(true);
    }
    // The maker may leave too.
    expect((await api(owner.cookie, "DELETE", `/api/workspaces/${ws}/join`)).status).toBe(200);
    expect((await api(owner.cookie, "GET", "/api/workspaces")).data.some((w: any) => w.id === ws)).toBe(false);
    expect((await api(owner.cookie, "GET", `/api/workspaces/no-such-ws`)).status).toBe(404);
    // Signed out: reading is open (no joined list, no folder details), writing isn't.
    expect((await fetch(`${base}/api/workspaces/${ws}`)).status).toBe(401);
    expect((await fetch(`${base}/api/workspaces`)).status).toBe(401);
    expect(((await (await fetch(`${base}/api/repos/${ws}/tree`)).json()) as { files: string[] }).files).toContain("p.md");
    expect((await fetch(`${base}/api/repos/${ws}/files`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ path: "x.md" }) })).status).toBe(401);
  });

  test("the access settings are gone", async () => {
    const owner = await person("Gone Owner");
    const ws = await workspace(owner, "WST Gone");
    expect((await api(owner.cookie, "PATCH", `/api/workspaces/${ws}`, { linkAccess: "none" })).status).toBe(405);
    expect((await api(owner.cookie, "GET", `/api/workspaces/${ws}/members`)).status).toBe(404);
    expect((await api(owner.cookie, "POST", `/api/workspaces/${ws}/members`, { email: "x@example.com" })).status).toBe(404);
    expect((await fetch(`${base}/api/workspaces/${ws}/public`)).status).toBe(401);
    expect((await api(owner.cookie, "GET", "/api/tokens")).status).toBe(404);
    expect((await api(owner.cookie, "GET", "/api/note-links/x")).status).toBe(404);
    // A `linkAccess` in the body is ignored: folders are public.
    const r = await api(owner.cookie, "POST", "/api/workspaces", { title: "WST Private?", linkAccess: "none" });
    expect(r.status).toBe(201);
    expect((await api((await person("Gone Other")).cookie, "GET", `/api/repos/${r.data.id}/tree`)).status).toBe(200);
  });

  test("only whoever made a folder may remove it", async () => {
    const owner = await person("Rm Owner");
    const other = await person("Rm Other");
    const ws = await workspace(owner, "WST Remove");
    expect((await api(other.cookie, "GET", `/api/repos/${ws}`)).data.canRemove).toBe(false);
    expect((await api(other.cookie, "DELETE", `/api/repos/${ws}`)).status).toBe(403);
    expect((await api(owner.cookie, "GET", `/api/repos/${ws}`)).data.canRemove).toBe(true);
    expect((await api(owner.cookie, "DELETE", `/api/repos/${ws}`)).status).toBe(200);
    expect((await api(other.cookie, "GET", `/api/repos/${ws}`)).status).toBe(404);
    // Nobody may remove the default notebook.
    expect((await api(owner.cookie, "DELETE", `/api/repos/${config.notesRepo}`)).status).toBe(403);
  });

  test("agent links: one per person per folder, revoked only by whoever made it", async () => {
    const owner = await person("Agent Owner");
    const other = await person("Agent Other");
    const ws = await workspace(owner, "WST Agent", { "t.md": "t\n" });
    const first = await api(other.cookie, "POST", `/api/repos/${ws}/shares`, { label: "Bot" });
    expect(first.status).toBe(201);
    expect(first.data).toEqual({ id: expect.any(String), url: `${config.publicUrl}/a/${first.data.id}` });
    const again = await api(other.cookie, "POST", `/api/repos/${ws}/shares`, {});
    expect(again.status).toBe(200);
    expect(again.data.id).toBe(first.data.id);
    const mine = (await api(owner.cookie, "POST", `/api/repos/${ws}/shares`, {})).data;
    expect(mine.id).not.toBe(first.data.id);
    const run = async (id: string, cmd: string) => (await fetch(`${base}/a/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: cmd }) })).json() as Promise<any>;
    expect((await run(first.data.id, "echo x >> t.md")).exitCode).toBe(0);
    // Only this folder is visible.
    expect((await run(first.data.id, "ls /workspace")).stdout.trim()).toBe(ws);
    expect((await api(owner.cookie, "DELETE", `/api/shares/${first.data.id}`)).status).toBe(404);
    expect((await api(other.cookie, "DELETE", `/api/shares/${first.data.id}`)).data).toEqual({ ok: true });
    expect((await fetch(`${base}/a/${first.data.id}`)).status).toBe(404);
    expect((await fetch(`${base}/a/${mine.id}`)).status).toBe(200);
    // A new one after revoking.
    expect((await api(other.cookie, "POST", `/api/repos/${ws}/shares`, {})).status).toBe(201);
  });
});

describe("migration", () => {
  const USERS = `CREATE TABLE users (id TEXT PRIMARY KEY, github_id INTEGER UNIQUE, login TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, avatar TEXT, github_token TEXT, is_admin INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
    INSERT INTO users (id, login, name, email, is_admin, created_at) VALUES ('admin', 'a', 'A', 'a@x', 1, 1), ('u2', 'b', 'B', 'b@x', 0, 2), ('u3', 'c', 'C', 'c@x', 0, 3);`;
  const SHARES = "CREATE TABLE share_links (id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE, label TEXT, created_by TEXT REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER";

  /** Open an older database `sql` with the current code (twice: the second run must change nothing). */
  async function migrate(sql: string) {
    const tmp = mkdtempSync(join(dir, "migrate-ws-"));
    const { Database } = await import("bun:sqlite");
    const old = new Database(join(tmp, "grimoire.sqlite"));
    old.exec(sql);
    old.close();
    const script = `const { db } = await import(${JSON.stringify(join(import.meta.dir, "../../src/server/db.ts"))});
      const q = (s) => db.query(s).all();
      console.log(JSON.stringify({
        owners: q("SELECT id, owner_id FROM repos ORDER BY id"),
        joined: q("SELECT workspace_id || ':' || user_id AS k FROM joined ORDER BY k").map((r) => r.k),
        users: q("SELECT id, email_verified, google_sub FROM users ORDER BY id"),
        live: q("SELECT id FROM share_links WHERE revoked_at IS NULL ORDER BY id").map((r) => r.id),
        tables: q("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('members', 'joined', 'app_tokens') ORDER BY name").map((r) => r.name),
      }));`;
    const run = async () => {
      const p = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, DATA_DIR: tmp }, stdout: "pipe", stderr: "pipe" });
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      expect(err).toBe("");
      return JSON.parse(out);
    };
    const r = await run();
    expect(await run()).toEqual(r);
    return r;
  }

  test("a database from before folders: owned by whoever made them (never by the old admin); everyone has joined everything", async () => {
    const r = await migrate(`${USERS}
      CREATE TABLE repos (id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL, gh_owner TEXT, gh_name TEXT, read_only INTEGER NOT NULL DEFAULT 0, branch TEXT NOT NULL, status TEXT NOT NULL, error TEXT, created_by TEXT, created_at INTEGER NOT NULL);
      ${SHARES});
      INSERT INTO repos (id, title, kind, branch, status, created_by, created_at) VALUES ('notes', 'Notes', 'notes', 'main', 'ready', NULL, 1), ('team', 'Team', 'notes', 'main', 'ready', 'u2', 2);
      INSERT INTO repos (id, title, kind, gh_owner, gh_name, read_only, branch, status, created_by, created_at) VALUES ('gh-o-r', 'o/r', 'github', 'o', 'r', 1, 'main', 'ready', 'u3', 3), ('gh-gone', 'o/g', 'github', 'o', 'g', 1, 'main', 'ready', 'deleted-user', 4);
      INSERT INTO share_links (id, repo_id, label, created_by, created_at) VALUES ('l1', 'team', 'Kept', 'u2', 5);`);
    expect(r.owners).toEqual([
      { id: "gh-gone", owner_id: null },
      { id: "gh-o-r", owner_id: "u3" },
      { id: "notes", owner_id: null },
      { id: "team", owner_id: "u2" },
    ]);
    expect(r.joined).toEqual(["gh-gone", "gh-o-r", "notes", "team"].flatMap((w) => ["admin", "u2", "u3"].map((u) => `${w}:${u}`)));
    expect(r.users).toEqual([
      { id: "admin", email_verified: 0, google_sub: null },
      { id: "u2", email_verified: 0, google_sub: null },
      { id: "u3", email_verified: 0, google_sub: null },
    ]);
    expect(r.live).toEqual(["l1"]);
    expect(r.tables).toEqual(["app_tokens", "joined"]);
  });

  test("a database with private folders: everything is public, members join their folders, note links and read-only agent links are revoked", async () => {
    const r = await migrate(`${USERS}
      ALTER TABLE users ADD COLUMN google_sub TEXT;
      ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE repos (id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL, gh_owner TEXT, gh_name TEXT, read_only INTEGER NOT NULL DEFAULT 0, branch TEXT NOT NULL, status TEXT NOT NULL, error TEXT, created_by TEXT, created_at INTEGER NOT NULL,
        link_access TEXT NOT NULL DEFAULT 'edit', domain_rule TEXT, owner_id TEXT REFERENCES users(id) ON DELETE SET NULL);
      ${SHARES}, kind TEXT NOT NULL DEFAULT 'agent', path TEXT, role TEXT);
      CREATE TABLE members (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, email TEXT, role TEXT NOT NULL, invited_by TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE joined (workspace_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, via TEXT NOT NULL, joined_at INTEGER NOT NULL, PRIMARY KEY (workspace_id, user_id));
      INSERT INTO repos (id, title, kind, branch, status, created_by, created_at, link_access, owner_id) VALUES ('secret', 'Secret', 'notes', 'main', 'ready', 'u2', 1, 'none', 'u2'), ('open', 'Open', 'notes', 'main', 'ready', 'u2', 2, 'edit', 'u2');
      INSERT INTO members (id, workspace_id, user_id, email, role, created_at) VALUES ('m1', 'secret', 'u2', NULL, 'owner', 1), ('m2', 'secret', 'u3', NULL, 'viewer', 1), ('m3', 'secret', NULL, 'x@y.z', 'editor', 1);
      INSERT INTO joined (workspace_id, user_id, via, joined_at) VALUES ('open', 'admin', 'link', 1), ('open', 'u3', 'link', 1);
      INSERT INTO share_links (id, repo_id, label, created_by, created_at, kind, path, role) VALUES
        ('agent', 'secret', NULL, 'u2', 1, 'agent', NULL, NULL), ('agent-editor', 'open', NULL, 'u3', 1, 'agent', NULL, 'editor'),
        ('agent-viewer', 'open', NULL, 'u2', 1, 'agent', NULL, 'viewer'), ('note', 'open', NULL, 'u2', 1, 'note', 'a.md', 'editor');`);
    expect(r.owners).toEqual([
      { id: "open", owner_id: "u2" },
      { id: "secret", owner_id: "u2" },
    ]);
    expect(r.joined).toEqual(["open:admin", "open:u3", "secret:u2", "secret:u3"]);
    expect(r.live).toEqual(["agent", "agent-editor"]);
    expect(r.tables).toEqual(["app_tokens", "joined"]);
  });
});
