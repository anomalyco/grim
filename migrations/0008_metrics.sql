-- Launch metrics (src/server/metrics.ts): counts only, kept server-side. No user ids, IPs, cookies or content: an
-- event name and a count per UTC day and per hour, the country Cloudflare saw (per event and day), the referring site's
-- host for landing views and signups, and the last few hundred events (name, time, country) for the dashboard's feed.
CREATE TABLE IF NOT EXISTS metrics_daily (
  day TEXT NOT NULL,               -- YYYY-MM-DD (UTC)
  event TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (day, event)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS metrics_hourly (
  hour INTEGER NOT NULL,           -- hours since the Unix epoch (kept for 3 days)
  event TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (hour, event)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS metrics_country (
  day TEXT NOT NULL,
  event TEXT NOT NULL,
  country TEXT NOT NULL,           -- ISO 3166-1 alpha-2, from Cloudflare
  count INTEGER NOT NULL,
  PRIMARY KEY (day, event, country)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS metrics_referrer (
  day TEXT NOT NULL,
  event TEXT NOT NULL,             -- landing_view | signup
  host TEXT NOT NULL,              -- the referring site's host only, e.g. news.ycombinator.com
  count INTEGER NOT NULL,
  PRIMARY KEY (day, event, host)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS metrics_recent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  event TEXT NOT NULL,
  country TEXT
);
