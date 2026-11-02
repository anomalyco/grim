-- A new account's own workspace ("<First name>'s notes"), made as it signs up (src/server/personal.ts) and not handed
-- to a client yet: POST /api/workspaces/personal answers `created: true` once for it (the first sign-in's welcome),
-- then clears it.
ALTER TABLE users ADD COLUMN welcome_ws TEXT;
