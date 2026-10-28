// Visitors who aren't signed in. They have no account: they open any folder and note anonymously, show up in rooms
// under a made-up name the browser picked ("moist-noodle", kind "guest"), and get a few edits before they're asked
// to sign in. The count is kept per browser in an httpOnly cookie (grimoire_anon, a random id the server made, so
// editing localStorage doesn't reset it; clearing cookies does) and per IP address per day.
//
// An "edit" is a burst of changes with no pause of QUIET_MS (3 s, the autosave's quiet period) or more, so one edit
// is about one commit. See docs/05-v1-architecture.md ("Anonymous visitors").
import { config } from "./config.ts";
import { db } from "./db.ts";
import { colorFor, parseCookies, randomToken } from "./auth.ts";
import type { EditLimit, Participant } from "./rooms.ts";
import { requestProto } from "./proxy.ts";

export const ANON_COOKIE = "grimoire_anon";
const COOKIE_MAX_AGE = 365 * 24 * 3600;
const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** The clock (tests move it). */
export const anonClock = { now: () => Date.now() };

/** The anon id of a request's grimoire_anon cookie, if it has a valid one. */
export function anonCookieId(req: Request): string | null {
  const v = parseCookies(req)[ANON_COOKIE];
  return v && ID_RE.test(v) ? v : null;
}

/** The request's anon id, made (with the Set-Cookie header to send) when it has none. */
export function ensureAnon(req: Request): { id: string; setCookie: string | null } {
  const have = anonCookieId(req);
  const id = have ?? randomToken(18);
  const now = anonClock.now();
  db.query("INSERT INTO anon_visitors (id, edit_count, first_seen, last_seen) VALUES (?, 0, ?, ?) ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen").run(id, now, now);
  if (have) return { id, setCookie: null };
  const secure = config.publicUrl.startsWith("https:") || requestProto(req) === "https:";
  return { id, setCookie: `${ANON_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}${secure ? "; Secure" : ""}` };
}

/** How many edits an anon id has used, of how many, and the quiet period that ends an edit. */
export function anonStatus(id: string): { used: number; limit: number; burstMs: number } {
  const row = db.query("SELECT edit_count FROM anon_visitors WHERE id = ?").get(id) as { edit_count: number } | null;
  return { used: row?.edit_count ?? 0, limit: config.anonEditLimit, burstMs: config.quietMs };
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

function ipEdits(ip: string, t: number): number {
  return (db.query("SELECT edits FROM anon_ip_days WHERE ip = ? AND day = ?").get(ip, day(t)) as { edits: number } | null)?.edits ?? 0;
}

/**
 * What a change from this visitor right now would be: part of the edit they're making ("same"), a new edit ("new"),
 * or refused (a new edit over their limit, or over their IP address's limit for today).
 */
export function anonEditCheck(id: string, ip: string): "same" | "new" | "limit" | "ip" {
  const now = anonClock.now();
  const row = db.query("SELECT edit_count, last_edit_at FROM anon_visitors WHERE id = ?").get(id) as { edit_count: number; last_edit_at: number | null } | null;
  if (row?.last_edit_at != null && now - row.last_edit_at < config.quietMs) return "same";
  if ((row?.edit_count ?? 0) >= config.anonEditLimit) return "limit";
  if (ipEdits(ip, now) >= config.anonEditsPerIpDay) return "ip";
  return "new";
}

let lastPrune = 0;

/** A change from this visitor was applied: counts a new edit when it starts one. Returns true if it did. */
export const recordAnonEdit = db.transaction((id: string, ip: string): boolean => {
  const now = anonClock.now();
  const kind = anonEditCheck(id, ip);
  if (kind === "same") {
    db.query("UPDATE anon_visitors SET last_edit_at = ?, last_seen = ? WHERE id = ?").run(now, now, id);
    return false;
  }
  // Over a limit only when another connection of theirs got there first: the change is in, so it counts.
  db.query(
    "INSERT INTO anon_visitors (id, edit_count, first_seen, last_seen, last_edit_at) VALUES (?1, 1, ?2, ?2, ?2) ON CONFLICT(id) DO UPDATE SET edit_count = edit_count + 1, last_edit_at = ?2, last_seen = ?2",
  ).run(id, now);
  db.query("INSERT INTO anon_ip_days (ip, day, edits) VALUES (?, ?, 1) ON CONFLICT(ip, day) DO UPDATE SET edits = edits + 1").run(ip, day(now));
  if (now - lastPrune > 3600_000) {
    lastPrune = now;
    db.query("DELETE FROM anon_ip_days WHERE day < ?").run(day(now - 2 * 86400_000));
  }
  return true;
});

// ---- rooms ----

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,39}$/u;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;

/**
 * The participant of an anonymous room connection, from what the browser sent (`/ws?…&anon=<id>&name=<name>&color=`):
 * its own random id (namespaced "guest:"), its made-up name and colour. null if the id or name isn't acceptable.
 */
export function guestParticipant(params: URLSearchParams): Participant | null {
  const clientId = params.get("anon") ?? "";
  const name = (params.get("name") ?? "").replace(/\s+/g, " ").trim();
  if (!CLIENT_ID_RE.test(clientId) || !NAME_RE.test(name)) return null;
  const id = `guest:${clientId}`;
  const color = params.get("color") ?? "";
  return { id, name, email: GUEST_EMAIL, kind: "guest", color: COLOR_RE.test(color) ? color : colorFor(id) };
}

/** Commits by anonymous visitors: "<name> (guest) <guest@grimoire.invalid>" (.invalid never resolves). */
export const GUEST_EMAIL = "guest@grimoire.invalid";

const listeners = new Map<string, Set<(msg: object) => void>>();

/**
 * The edit limit of one anonymous room connection (anon id `id`, from IP `ip`); `send` sends it a control message.
 * Its connections everywhere hear `{t:"anon", used, limit, burstMs}` when it starts a new edit.
 */
export function anonEditLimit(id: string, ip: string, send: (msg: object) => void): EditLimit & { dispose(): void } {
  let set = listeners.get(id);
  if (!set) listeners.set(id, (set = new Set()));
  set.add(send);
  return {
    info: () => ({ t: "anon", ...anonStatus(id) }),
    refuses: () => {
      const c = anonEditCheck(id, ip);
      return c === "limit" || c === "ip" ? c : null;
    },
    edited: () => {
      if (!recordAnonEdit(id, ip)) return;
      const msg = { t: "anon", ...anonStatus(id) };
      for (const fn of listeners.get(id) ?? []) fn(msg);
    },
    dispose: () => {
      set.delete(send);
      if (!set.size) listeners.delete(id);
    },
  };
}
