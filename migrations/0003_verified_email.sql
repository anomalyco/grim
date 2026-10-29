-- Email is the identity that carries across systems (a later auth provider finds accounts by it): one verified,
-- lower-case email is one account. Name-only accounts have no verified email and aren't affected. Existing
-- duplicates keep the address verified only on the account that signs in with Google (else the oldest). Same as the
-- in-place upgrade in src/server/db.ts.
UPDATE users SET email_verified = 0 WHERE email_verified = 1 AND id NOT IN (
  SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY lower(email) ORDER BY google_sub IS NULL, created_at, id) AS n FROM users WHERE email_verified = 1) WHERE n = 1
);
UPDATE users SET email = lower(email) WHERE email_verified = 1 AND email != lower(email);
CREATE UNIQUE INDEX users_verified_email ON users(lower(email)) WHERE email_verified = 1;
