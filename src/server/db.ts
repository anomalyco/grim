import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";

mkdirSync(config.dataDir, { recursive: true });

// Older installs used notepad.sqlite; carry the database (and its WAL) over to the new name.
if (existsSync(join(config.dataDir, "notepad.sqlite")) && !existsSync(join(config.dataDir, "grimoire.sqlite"))) {
  for (const ext of ["", "-wal", "-shm"]) {
    const old = join(config.dataDir, `notepad.sqlite${ext}`);
    if (existsSync(old)) renameSync(old, join(config.dataDir, `grimoire.sqlite${ext}`));
  }
}
export const db = new Database(join(config.dataDir, "grimoire.sqlite"), { create: true });
db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  github_id INTEGER UNIQUE,
  login TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  avatar TEXT,
  github_token TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,  -- unused (there are no admins); kept so older databases need no migration
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,              -- 'notes' (hosted in Code Storage only) | 'github' (synced with GitHub)
  gh_owner TEXT,
  gh_name TEXT,
  read_only INTEGER NOT NULL DEFAULT 0,
  branch TEXT NOT NULL,
  status TEXT NOT NULL,            -- 'ready' | 'importing' | 'error'
  error TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
-- Crash-safe log of live edits that are not committed yet. Cleared when a room closes cleanly.
CREATE TABLE IF NOT EXISTS room_meta (
  room TEXT PRIMARY KEY,
  generation TEXT NOT NULL,
  base_commit TEXT,
  base_content TEXT NOT NULL,
  base_snapshot BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS room_updates (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT NOT NULL,
  data BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS room_updates_room ON room_updates(room, seq);
-- Agent tokens were replaced by share links.
DROP TABLE IF EXISTS agent_tokens;
`);

// "Share with agent" links: /a/<id> gives whoever has the URL a shell over one notebook, never more than its
// creator can do (a link dies with its notebook or its creator).
const SHARE_LINKS = (name: string) => `CREATE TABLE ${name} (
  id TEXT PRIMARY KEY,             -- a random UUID; the capability itself
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  label TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
)`;
db.transaction(() => {
  const exists = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'share_links'").get();
  if (!exists) db.exec(SHARE_LINKS("share_links"));
  else {
    // Older tables had no foreign key on created_by: rebuild, keeping the rows (unknown creators become NULL: dead links).
    const fks = db.query("PRAGMA foreign_key_list(share_links)").all() as Array<{ table: string; from: string }>;
    if (!fks.some((f) => f.table === "users" && f.from === "created_by")) {
      db.exec(SHARE_LINKS("share_links_new"));
      db.exec(`INSERT INTO share_links_new (id, repo_id, label, created_by, created_at, last_used_at, revoked_at)
        SELECT id, repo_id, label, CASE WHEN created_by IN (SELECT id FROM users) THEN created_by END, COALESCE(created_at, 0), last_used_at, revoked_at
        FROM share_links WHERE repo_id IN (SELECT id FROM repos)`);
      db.exec("DROP TABLE share_links");
      db.exec("ALTER TABLE share_links_new RENAME TO share_links");
    }
  }
  db.exec("CREATE INDEX IF NOT EXISTS share_links_repo ON share_links(repo_id)");
})();

// Folders (workspaces), Google users and app tokens (see docs/workspaces/SPEC.md). Every folder is public: anyone
// signed in may open and edit it; only its owner (whoever made it) may remove it. Older databases are migrated in
// place: memberships become joined entries, note links and viewer-only agent links are revoked, and the old access
// columns (repos.link_access, repos.domain_rule; share_links.kind, path, role) are left unread.
const columns = (table: string) => (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
const tableExists = (name: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
db.transaction(() => {
  const users = columns("users");
  if (!users.includes("google_sub")) db.exec("ALTER TABLE users ADD COLUMN google_sub TEXT");
  if (!users.includes("email_verified")) db.exec("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0");
  db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL;
-- The folders someone opened while signed in: their switcher lists them.
CREATE TABLE IF NOT EXISTS joined (
  workspace_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  via TEXT NOT NULL,               -- unused
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS joined_by_user ON joined(user_id);
-- Tokens for apps (the Mac app), made by the /connect flow. Only the hash is stored.
CREATE TABLE IF NOT EXISTS app_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS app_tokens_user ON app_tokens(user_id);
-- Guest edit counting was tried and dropped (guests edit freely).
DROP TABLE IF EXISTS anon_visitors;
DROP TABLE IF EXISTS anon_ip_days;
`);
  if (!columns("repos").includes("owner_id")) {
    // From before folders: whoever made a notebook owns it, and everyone has joined everything.
    db.exec("ALTER TABLE repos ADD COLUMN owner_id TEXT REFERENCES users(id) ON DELETE SET NULL");
    db.exec("UPDATE repos SET owner_id = CASE WHEN created_by IN (SELECT id FROM users) THEN created_by ELSE NULL END");
    db.query("INSERT INTO joined (workspace_id, user_id, via, joined_at) SELECT r.id, u.id, 'link', ? FROM repos r CROSS JOIN users u").run(Date.now());
  }
  if (tableExists("members")) {
    db.exec("INSERT OR IGNORE INTO joined (workspace_id, user_id, via, joined_at) SELECT workspace_id, user_id, 'link', created_at FROM members WHERE user_id IS NOT NULL");
    db.exec("DROP TABLE members");
  }
  const shares = columns("share_links");
  if (shares.includes("kind")) db.query("UPDATE share_links SET revoked_at = ? WHERE revoked_at IS NULL AND (kind != 'agent' OR role = 'viewer')").run(Date.now());
})();

// Line authors (blame.ts) survive a restart with the crash log: each logged update says whose it was (an index into
// room_meta.blame_people), and the compacted state carries the line values it ends with (room_meta.blame).
db.transaction(() => {
  if (!columns("room_updates").includes("author")) db.exec("ALTER TABLE room_updates ADD COLUMN author INTEGER");
  const meta = columns("room_meta");
  if (!meta.includes("blame")) db.exec("ALTER TABLE room_meta ADD COLUMN blame TEXT");
  if (!meta.includes("blame_people")) db.exec("ALTER TABLE room_meta ADD COLUMN blame_people TEXT");
})();

// The last known head commit of each workspace's branch (null until something records it), also
// added in place, so the Bun schema matches migrations/0001_init.sql.
if (!columns("repos").includes("head")) db.exec("ALTER TABLE repos ADD COLUMN head TEXT");

export function newId(prefix = ""): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return prefix + Buffer.from(bytes).toString("base64url");
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
