import { Database } from "bun:sqlite";
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
  is_admin INTEGER NOT NULL DEFAULT 0,
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

// Workspaces, Google users, app tokens and note share links (see docs/workspaces/SPEC.md). Older databases are
// migrated in place: existing notebooks become workspaces anyone may edit through their URL (owner: the admin),
// read-only GitHub copies ones anyone may view (owner: whoever added them), and every existing user has joined
// every existing workspace, so nothing changes for them.
const columns = (table: string) => (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
db.transaction(() => {
  const users = columns("users");
  if (!users.includes("google_sub")) db.exec("ALTER TABLE users ADD COLUMN google_sub TEXT");
  if (!users.includes("email_verified")) db.exec("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0");
  db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL;
-- Workspace members. An invite has an email and no user yet; it becomes a membership when someone signs in with
-- that verified email.
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  email TEXT,
  role TEXT NOT NULL,              -- 'owner' | 'editor' | 'viewer'
  invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS members_user ON members(workspace_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS members_invite ON members(workspace_id, email) WHERE user_id IS NULL;
CREATE INDEX IF NOT EXISTS members_by_user ON members(user_id);
CREATE INDEX IF NOT EXISTS members_by_email ON members(email) WHERE user_id IS NULL;
-- Workspaces someone opened through link access or a domain rule (their switcher lists them; grants nothing).
CREATE TABLE IF NOT EXISTS joined (
  workspace_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  via TEXT NOT NULL,               -- 'link' | 'domain'
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
`);
  if (!columns("repos").includes("link_access")) {
    // DEFAULT 'edit' migrates existing rows; new workspaces always set it explicitly.
    db.exec("ALTER TABLE repos ADD COLUMN link_access TEXT NOT NULL DEFAULT 'edit'");
    db.exec("ALTER TABLE repos ADD COLUMN domain_rule TEXT");
    db.exec("ALTER TABLE repos ADD COLUMN owner_id TEXT REFERENCES users(id) ON DELETE SET NULL");
    db.exec("UPDATE repos SET link_access = 'view' WHERE kind = 'github' AND read_only = 1");
    const admin = (db.query("SELECT id FROM users WHERE is_admin = 1 ORDER BY created_at LIMIT 1").get() as { id: string } | null)?.id ?? null;
    db.query(
      "UPDATE repos SET owner_id = CASE WHEN kind = 'github' AND read_only = 1 AND created_by IN (SELECT id FROM users) THEN created_by ELSE ? END",
    ).run(admin);
    const now = Date.now();
    db.query(
      "INSERT INTO members (id, workspace_id, user_id, role, created_at) SELECT 'm_' || lower(hex(randomblob(12))), id, owner_id, 'owner', ? FROM repos WHERE owner_id IS NOT NULL",
    ).run(now);
    db.query(
      "INSERT INTO joined (workspace_id, user_id, via, joined_at) SELECT r.id, u.id, 'link', ? FROM repos r CROSS JOIN users u WHERE r.owner_id IS NOT u.id",
    ).run(now);
  }
  const shares = columns("share_links");
  if (!shares.includes("kind")) db.exec("ALTER TABLE share_links ADD COLUMN kind TEXT NOT NULL DEFAULT 'agent'");
  if (!shares.includes("path")) db.exec("ALTER TABLE share_links ADD COLUMN path TEXT");
  if (!shares.includes("role")) db.exec("ALTER TABLE share_links ADD COLUMN role TEXT");
})();

export function newId(prefix = ""): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return prefix + Buffer.from(bytes).toString("base64url");
}

export function sha256(s: string): string {
  return new Bun.CryptoHasher("sha256").update(s).digest("hex");
}
