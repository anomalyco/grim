-- The global tables (users, sessions, workspaces, share links, joined workspaces, app tokens) as a fresh database.
-- Shared by D1 (wrangler d1 migrations) and bun:sqlite. src/server/db.ts builds the same shape in place for
-- self-hosted databases (test/server/schema.test.ts keeps them equal). Room crash logs live per workspace, not here.
-- Column order follows db.ts, where later columns were added with ALTER TABLE.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  github_id INTEGER UNIQUE,
  login TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  avatar TEXT,
  github_token TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,  -- unused (there are no admins)
  created_at INTEGER NOT NULL,
  google_sub TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL;

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE repos (
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
  created_at INTEGER NOT NULL,
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  head TEXT                        -- last known head commit of the branch, or NULL
);

-- "Share with agent" links: /a/<id> gives whoever has the URL a shell over one notebook.
CREATE TABLE share_links (
  id TEXT PRIMARY KEY,             -- a random UUID; the capability itself
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  label TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX share_links_repo ON share_links(repo_id);

-- The workspaces someone opened while signed in: their switcher lists them.
CREATE TABLE joined (
  workspace_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  via TEXT NOT NULL,               -- unused
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX joined_by_user ON joined(user_id);

-- Tokens for apps (the Mac app), made by the /connect flow. Only the hash is stored.
CREATE TABLE app_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX app_tokens_user ON app_tokens(user_id);
