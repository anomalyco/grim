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
-- Agent tokens were replaced by share links.
DROP TABLE IF EXISTS agent_tokens;
`);

// Agent share links (/a/<uuid>) were replaced by the workspace URL itself (agent-url.ts). Same as
// migrations/0009_drop_share_links.sql.
db.exec("DROP INDEX IF EXISTS share_links_repo; DROP TABLE IF EXISTS share_links;");

const VERIFIED_EMAIL_SQL = `
UPDATE users SET email_verified = 0 WHERE email_verified = 1 AND id NOT IN (
  SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY lower(email) ORDER BY google_sub IS NULL, created_at, id) AS n FROM users WHERE email_verified = 1) WHERE n = 1
);
UPDATE users SET email = lower(email) WHERE email_verified = 1 AND email != lower(email);
CREATE UNIQUE INDEX users_verified_email ON users(lower(email)) WHERE email_verified = 1;
`;

// Folders (workspaces), Google users and app tokens (see docs/workspaces/SPEC.md). Every folder is public: anyone
// signed in may open and edit it; only its owner (whoever made it) may remove it. Older databases are migrated in
// place: memberships become joined entries, and the old access columns (repos.link_access, repos.domain_rule) are
// left unread.
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
-- Tokens for apps (the Mac app), made by the app sign-in (/auth/google/start, tokens.ts). Only the hash is stored.
CREATE TABLE IF NOT EXISTS app_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER,
  -- "mcp": an MCP client's token (oauth.ts), good only at /mcp; NULL: an app's, good everywhere
  audience TEXT
);
CREATE INDEX IF NOT EXISTS app_tokens_user ON app_tokens(user_id);
-- One-time codes of the app sign-in (the app exchanges one for a token with its PKCE verifier). Hashed.
CREATE TABLE IF NOT EXISTS connect_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  audience TEXT
);
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
})();

// Storage v2 (docs/storage-v2.md): notes live in the notes tables (notes/store.ts); the Git-era crash log and GitHub
// workspaces are gone. Same as migrations/0011_storage_v2.sql.
db.exec("DROP TABLE IF EXISTS room_updates; DROP TABLE IF EXISTS room_meta; DELETE FROM repos WHERE kind = 'github';");

// Tokens for one resource (MCP clients' tokens: oauth.ts). Same as migrations/0007_token_audience.sql.
if (!columns("app_tokens").includes("audience")) db.exec("ALTER TABLE app_tokens ADD COLUMN audience TEXT");
if (!columns("connect_codes").includes("audience")) db.exec("ALTER TABLE connect_codes ADD COLUMN audience TEXT");
// A new account's own workspace, made at sign-up and not welcomed yet (personal.ts). Same as
// migrations/0010_welcome_workspace.sql.
if (!columns("users").includes("welcome_ws")) db.exec("ALTER TABLE users ADD COLUMN welcome_ws TEXT");

// The last known head commit of each workspace's branch (null until something records it), also
// added in place, so the Bun schema matches migrations/0001_init.sql.
if (!columns("repos").includes("head")) db.exec("ALTER TABLE repos ADD COLUMN head TEXT");

// Email is the identity that carries across systems (a later auth provider finds accounts by it): one verified,
// lower-case email is one account. Older databases: duplicates keep the address verified only on the account that
// signs in with Google (else the oldest). Same as migrations/0003_verified_email.sql.
if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'users_verified_email'").get()) {
  db.transaction(() => {
    db.exec(VERIFIED_EMAIL_SQL);
  })();
}

// The demo is only for people who aren't signed in: no account keeps it in its joined list (recordJoin refuses it for
// accounts). Same as migrations/0005_demo_not_joined.sql; cheap enough to run at every start.
db.exec("DELETE FROM joined WHERE workspace_id = 'demo' AND user_id NOT LIKE 'guest:%'");

// Launch metrics (metrics.ts): counts only. Same as migrations/0008_metrics.sql.
db.exec(`
CREATE TABLE IF NOT EXISTS metrics_daily (day TEXT NOT NULL, event TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (day, event)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS metrics_hourly (hour INTEGER NOT NULL, event TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (hour, event)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS metrics_country (day TEXT NOT NULL, event TEXT NOT NULL, country TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (day, event, country)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS metrics_referrer (day TEXT NOT NULL, event TEXT NOT NULL, host TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (day, event, host)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS metrics_recent (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, event TEXT NOT NULL, country TEXT);
`);

export { newId, sha256 } from "./ids.ts";
