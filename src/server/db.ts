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

export function newId(prefix = ""): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return prefix + Buffer.from(bytes).toString("base64url");
}

export function sha256(s: string): string {
  return new Bun.CryptoHasher("sha256").update(s).digest("hex");
}
