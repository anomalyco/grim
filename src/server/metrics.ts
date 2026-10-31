// Launch metrics: counts of what happens (signups, demo opens, landing views, agent commands, …), kept in this server's
// own database (D1 on Workers, SQLite on Bun) and never sent anywhere. No cookies, no tracking script, no personal
// data: an event name and a count per UTC day and hour, the country Cloudflare saw (Workers only), the referring
// site's host for landing views and signups, and the latest events (name, time, country) for the dashboard's feed.
// METRICS=off records nothing. The owner's dashboard: /admin/stats (admin-stats.ts), for ADMIN_EMAILS.
import { config, devLoginEnabled } from "./config.ts";
import type { Db } from "./seams/db.ts";
import type { User } from "./auth.ts";
import { clientIp } from "./proxy.ts";

export const METRIC_EVENTS = [
  "landing_view",
  "get_started_click",
  "mac_download_click",
  "mac_download",
  "demo_opened",
  "signup",
  "signin",
  "personal_workspace_created",
  "workspace_created",
  "note_created",
  "agent_link_created",
  "agent_command",
  "mcp_connected",
  "mcp_command",
  "account_deleted",
] as const;
export type MetricEvent = (typeof METRIC_EVENTS)[number];

/** What a browser may report itself (POST /api/metrics/hit): what the server never sees on its own. */
const BEACON_EVENTS = new Set<MetricEvent>(["landing_view", "get_started_click", "mac_download_click"]);
/** The events whose referring site is kept (its host). */
const REFERRED = new Set<MetricEvent>(["landing_view", "signup"]);

/** The feed keeps about this many of the latest events; hourly counts are kept this many hours. */
const RECENT_KEPT = 300;
const HOURS_KEPT = 72;

/**
 * How a metric's write runs without holding up the response: by default a moment later (Bun: bun:sqlite is
 * synchronous; Durable Objects stay up for it); the Worker hands it to ctx.waitUntil (router.ts).
 */
let runLater: (work: () => Promise<unknown>) => void = (work) => {
  setTimeout(() => void work().catch((e: unknown) => console.error("[metrics]", e)), 0);
};

export function setMetricsRunner(fn: (work: () => Promise<unknown>) => void) {
  runLater = fn;
}

/** The caller's country as Cloudflare saw it (Workers; a Durable Object gets the forwarded CF-IPCountry); none on Bun. */
let trustCountryHeader = false;
export function setTrustCountryHeader(on: boolean) {
  trustCountryHeader = on;
}

function countryOf(req: Request | null | undefined): string | null {
  if (!req) return null;
  const cf = (req as Request & { cf?: { country?: unknown } }).cf;
  const raw = typeof cf?.country === "string" ? cf.country : trustCountryHeader ? req.headers.get("cf-ipcountry") : null;
  // (XX: unknown, T1: Tor)
  return raw && /^[A-Z][A-Z0-9]$/.test(raw) && raw !== "XX" ? raw : null;
}

/** A referring site's host (lower case, no port, no "www."), or null for none, a malformed one or this site itself. */
export function referrerHost(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw || raw.length > 300) return null;
  let host = raw.trim().toLowerCase();
  try {
    if (host.includes("/")) host = new URL(host.includes("://") ? host : `https://${host}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/:\d+$/, "").replace(/^www\./, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || host.length > 100) return null;
  if (host === new URL(config.publicUrl).hostname.replace(/^www\./, "")) return null;
  return host;
}

/**
 * Count one `event` (in the background: never awaited, never fails the request). `req`: whose country to count;
 * `referrer`: the referring site (kept as its host, for landing views and signups only).
 */
export function metric(db: Db, event: MetricEvent, req?: Request | null, opts: { referrer?: unknown } = {}): void {
  if (!config.metrics) return;
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const hour = Math.floor(now / 3_600_000);
  const country = countryOf(req);
  const host = REFERRED.has(event) ? referrerHost(opts.referrer) : null;
  const stmts: Array<[string, ...unknown[]]> = [
    ["INSERT INTO metrics_daily (day, event, count) VALUES (?, ?, 1) ON CONFLICT (day, event) DO UPDATE SET count = count + 1", day, event],
    ["INSERT INTO metrics_hourly (hour, event, count) VALUES (?, ?, 1) ON CONFLICT (hour, event) DO UPDATE SET count = count + 1", hour, event],
    ["INSERT INTO metrics_recent (at, event, country) VALUES (?, ?, ?)", now, event, country],
  ];
  if (country) stmts.push(["INSERT INTO metrics_country (day, event, country, count) VALUES (?, ?, ?, 1) ON CONFLICT (day, event, country) DO UPDATE SET count = count + 1", day, event, country]);
  if (host) stmts.push(["INSERT INTO metrics_referrer (day, event, host, count) VALUES (?, ?, ?, 1) ON CONFLICT (day, event, host) DO UPDATE SET count = count + 1", day, event, host]);
  // now and then, the feed and the hourly counts are trimmed
  if (Math.random() < 0.02) {
    stmts.push(["DELETE FROM metrics_recent WHERE id <= (SELECT MAX(id) FROM metrics_recent) - ?", RECENT_KEPT]);
    stmts.push(["DELETE FROM metrics_hourly WHERE hour < ?", hour - HOURS_KEPT]);
  }
  runLater(() => db.batch(stmts).catch((e: unknown) => console.error(`[metrics] ${event}:`, e)));
}

// ---- POST /api/metrics/hit: what only the browser knows (a landing view, a click) ----

/** Beacons per IP per minute (in memory only: the address is never stored). */
const HITS_PER_MINUTE = 30;
const hitWindows = new Map<string, { start: number; n: number }>();

function hitAllowed(ip: string): boolean {
  const now = Date.now();
  if (hitWindows.size > 10_000) for (const [k, w] of hitWindows) if (now - w.start >= 60_000) hitWindows.delete(k);
  let w = hitWindows.get(ip);
  if (!w || now - w.start >= 60_000) hitWindows.set(ip, (w = { start: now, n: 0 }));
  return ++w.n <= HITS_PER_MINUTE;
}

/** `{e: "<event>", r?: "<referring host>"}` from navigator.sendBeacon: 204 whatever happens, except a bad request. */
export async function metricsHit(db: Db, req: Request, sameOrigin: boolean): Promise<Response> {
  const done = (status = 204) => new Response(null, { status, headers: { "cache-control": "no-store" } });
  if (req.method !== "POST") return done(405);
  if (req.headers.get("origin") && !sameOrigin) return done(403);
  if (Number(req.headers.get("content-length") ?? 0) > 1024) return done(413);
  let b: { e?: unknown; r?: unknown } | null = null;
  try {
    b = JSON.parse((await req.text()).slice(0, 1024)) as { e?: unknown; r?: unknown };
  } catch {
    return done(400);
  }
  const event = typeof b?.e === "string" ? (b.e as MetricEvent) : null;
  if (!event || !BEACON_EVENTS.has(event)) return done(400);
  if (!hitAllowed(clientIp(req))) return done(429);
  metric(db, event, req, { referrer: b!.r });
  return done();
}

// ---- who sees them ----

/** May `user` open /admin/stats? An account whose verified email is in ADMIN_EMAILS ("*" with sign-in off: anyone). */
export function isAdmin(user: User | null): boolean {
  if (!config.signIn) return config.adminEmails.has("*");
  if (!user || !user.email) return false;
  // (test sign-in accounts have unverified emails: they count on plain-http test servers only)
  if (!user.emailVerified && !devLoginEnabled()) return false;
  return config.adminEmails.has(user.email.toLowerCase());
}

// ---- GET /api/admin/stats ----

const DAYS = 30;

export async function adminStats(db: Db) {
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const since = new Date(now - (DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  const hour = Math.floor(now / 3_600_000);
  const [totals, daily, hourly, referrers, countries, recent] = await Promise.all([
    db.all<{ event: string; n: number }>("SELECT event, SUM(count) AS n FROM metrics_daily GROUP BY event"),
    db.all<{ day: string; event: string; count: number }>("SELECT day, event, count FROM metrics_daily WHERE day >= ? ORDER BY day", since),
    db.all<{ hour: number; event: string; count: number }>("SELECT hour, event, count FROM metrics_hourly WHERE hour > ? ORDER BY hour", hour - 24),
    db.all<{ host: string; views: number; signups: number; today: number }>(
      `SELECT host, SUM(CASE WHEN event = 'landing_view' THEN count ELSE 0 END) AS views, SUM(CASE WHEN event = 'signup' THEN count ELSE 0 END) AS signups,
         SUM(CASE WHEN day = ? THEN count ELSE 0 END) AS today
       FROM metrics_referrer WHERE day >= ? GROUP BY host ORDER BY views + signups DESC LIMIT 15`,
      today,
      since,
    ),
    db.all<{ country: string; views: number; signups: number; events: number }>(
      `SELECT country, SUM(CASE WHEN event = 'landing_view' THEN count ELSE 0 END) AS views, SUM(CASE WHEN event = 'signup' THEN count ELSE 0 END) AS signups,
         SUM(count) AS events
       FROM metrics_country WHERE day >= ? GROUP BY country ORDER BY views DESC, events DESC LIMIT 15`,
      since,
    ),
    db.all<{ at: number; event: string; country: string | null }>("SELECT at, event, country FROM metrics_recent ORDER BY id DESC LIMIT 30"),
  ]);
  const days: string[] = [];
  for (let i = DAYS - 1; i >= 0; i--) days.push(new Date(now - i * 86_400_000).toISOString().slice(0, 10));
  const hours: number[] = [];
  for (let i = 23; i >= 0; i--) hours.push(hour - i);
  const events: Record<string, { total: number; today: number; days: number[]; hours: number[] }> = {};
  for (const e of METRIC_EVENTS) events[e] = { total: 0, today: 0, days: days.map(() => 0), hours: hours.map(() => 0) };
  for (const r of totals) if (events[r.event]) events[r.event]!.total = r.n;
  for (const r of daily) {
    const e = events[r.event];
    if (!e) continue;
    const i = days.indexOf(r.day);
    if (i >= 0) e.days[i] = r.count;
    if (r.day === today) e.today = r.count;
  }
  for (const r of hourly) {
    const e = events[r.event];
    const i = hours.indexOf(r.hour);
    if (e && i >= 0) e.hours[i] = r.count;
  }
  return { now, today, days, hours: hours.map((h) => h * 3_600_000), events, referrers, countries, recent, metrics: config.metrics };
}
