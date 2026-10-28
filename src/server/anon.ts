// Visitors who aren't signed in ("guests"). They have no account: they open and edit any folder (every folder is
// public), under a made-up name and colour their browser picked and keeps ("moist-noodle", kind "guest"). Rooms get
// them as `/ws?…&anon=<id>&name=<name>&color=<#rrggbb>`, the REST API as the X-Grimoire-Guest(-Name, -Color)
// headers. Only creating and opening folders needs an account. See docs/05-v1-architecture.md ("Guests").
import { colorFor } from "./auth.ts";
import type { Participant } from "./rooms.ts";

/** Commits by guests: "<name> (guest) <guest@grimoire.invalid>" (.invalid never resolves). */
export const GUEST_EMAIL = "guest@grimoire.invalid";

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,39}$/u;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;

/**
 * A guest participant from what the browser sent: its own random id (namespaced "guest:"), its made-up name and
 * colour. The kind is always "guest", whatever else the request says. null if the id or name isn't acceptable.
 */
export function guestParticipant(id: string | null, rawName: string | null, color: string | null): Participant | null {
  const clientId = id ?? "";
  const name = (rawName ?? "").replace(/\s+/g, " ").trim();
  if (!CLIENT_ID_RE.test(clientId) || !NAME_RE.test(name)) return null;
  const pid = `guest:${clientId}`;
  return { id: pid, name, email: GUEST_EMAIL, kind: "guest", color: color && COLOR_RE.test(color) ? color : colorFor(pid) };
}

/** A room connection's guest (`anon`, `name`, `color` query parameters). */
export const guestFromQuery = (q: URLSearchParams) => guestParticipant(q.get("anon"), q.get("name"), q.get("color"));

/** A REST request's guest (X-Grimoire-Guest, X-Grimoire-Guest-Name (URL-encoded), X-Grimoire-Guest-Color). */
export function guestFromHeaders(req: Request): Participant | null {
  let name: string | null = null;
  try {
    name = decodeURIComponent(req.headers.get("x-grimoire-guest-name") ?? "");
  } catch {
    return null;
  }
  return guestParticipant(req.headers.get("x-grimoire-guest"), name, req.headers.get("x-grimoire-guest-color"));
}
