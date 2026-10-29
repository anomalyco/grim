-- One-time codes of the /connect flow: the loopback redirect carries a code, never the token; the app exchanges it
-- (once, within two minutes) with its PKCE verifier at POST /connect/token. Same as the table in src/server/db.ts.
CREATE TABLE IF NOT EXISTS connect_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
