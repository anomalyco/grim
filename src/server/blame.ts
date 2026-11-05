// Who wrote each line of a live note (see docs/05-v1-architecture.md, "Line authors"). A room keeps one value per
// line of its live text (`LineAttribution`):
//   ≥ 0   the room's participant with that index (someone changed the line while the room was open),
//   -1    unknown,
//   ≤ -2  line (-value - 2) of the origin text: the Git text the room opened with (or last merged from outside),
//         whose author comes from Git blame.
// Every document update moves the values through a line diff of the text before and after it: lines it left as
// they were keep theirs, the others become the updating participant's. Clients get `{t:"blame"}` messages.
import { linePairs } from "../shared/textdiff.ts";
export { attribute } from "../shared/lineauthors.ts";
import { GUEST_EMAIL } from "./anon.ts";
import { colorFor } from "./auth.ts";
import type { ParticipantKind } from "./room.ts";
import type { Db } from "./seams/db.ts";
import type { Author } from "./store/types.ts";

export const UNKNOWN = -1;
export const baseLine = (i: number) => -i - 2;
export const isBaseLine = (v: number) => v <= -2;
export const baseIndex = (v: number) => -v - 2;

/** One author in a blame message. */
export interface LineAuthor {
  id: string;
  name: string;
  kind: ParticipantKind;
  color: string;
  /** An agent's session (the Agent-Session-Id trailer, or the session_id of a live write), and its colour. */
  session?: string;
  /** The session's title (the Agent-Session-Name trailer, or the session_name of a live write): its lines' label. */
  sessionName?: string;
  sessionColor?: string;
}

/** Who created the note: an agent (its first commit's author is an @agents.grimoire one) or a person. */
export type NoteOrigin = "agent" | "human";

/** How live people and Git authors are matched: the Git identity, plus the agent session if any. */
export const gitIdentity = (a: { name: string; email: string; session?: string }) => `${a.name}\0${a.email}${a.session ? `\0${a.session}` : ""}`;

/**
 * The control message: `lines[i]` is an index into `authors`, or -1 (unknown), for every line of the text.
 * `origin`: who created the note, once known (in a note an agent created, people's lines are tinted).
 */
export interface BlameMessage {
  t: "blame";
  authors: LineAuthor[];
  lines: number[];
  origin?: NoteOrigin;
}

/** A note's origin from the author of its first commit. */
export const originOf = (a: { email: string }): NoteOrigin => (a.email.endsWith("@agents.grimoire") ? "agent" : "human");

/** Values for a text that is all origin text. */
export function originLines(text: string): number[] {
  return text.split("\n").map((_, i) => baseLine(i));
}

/**
 * After the origin text changed (a merge from outside): every value that isn't a participant's is re-pointed at
 * the matching line of the new origin text, or unknown where the live line isn't one of it.
 */
export function rebase(values: number[], live: string, origin: string | null): number[] {
  const out = values.map((v) => (v >= 0 ? v : UNKNOWN));
  if (origin === null) return out;
  for (const [a, b] of linePairs(origin.split("\n"), live.split("\n"))) if (out[b] === UNKNOWN) out[b] = baseLine(a);
  return out;
}

/** An account whose email is a Git author's. */
export interface UserRow {
  id: string;
  name: string;
  login: string;
}

/**
 * How a Git author shows: guests' commits are "<name> (guest)", agents' use an @agents.grimoire address (one author
 * per agent session when the commit has an Agent-Session-Id trailer), and people with an account (`user`, looked
 * up by email) show as that account.
 */
export function gitAuthor(a: Author, user: UserRow | null = null): LineAuthor {
  if (a.email === GUEST_EMAIL && a.name.endsWith(" (guest)")) {
    const name = a.name.slice(0, -" (guest)".length);
    return { id: `guest-name:${name}`, name, kind: "guest", color: colorFor(`guest-name:${name}`) };
  }
  if (a.email.endsWith("@agents.grimoire")) {
    const agent: LineAuthor = { id: `agent-name:${a.name}`, name: a.name, kind: "agent", color: colorFor(`agent-name:${a.name}`) };
    return a.session ? { ...agent, id: `${agent.id}#${a.session}`, session: a.session, ...(a.sessionName ? { sessionName: a.sessionName } : {}), sessionColor: colorFor(a.session) } : agent;
  }
  if (user) return { id: user.id, name: user.name || user.login || a.name, kind: "human", color: colorFor(user.id) };
  const id = `git:${a.email || a.name}`;
  return { id, name: a.name || a.email, kind: "human", color: colorFor(id) };
}

/** A resolved Git author, with the Git identity (`name\0email`) that live people are matched by. */
export interface OriginAuthor extends LineAuthor {
  git: string;
}

/** The origin text's Git blame, resolved: `lines[i]` indexes `authors` (or is -1) for every line of the origin text. */
export interface OriginAuthors {
  authors: OriginAuthor[];
  lines: number[];
}

/** Bound parameters per users query (D1 allows 100). */
const EMAILS_PER_QUERY = 100;

/** SQLite's lower(): ASCII only. */
const lowerAscii = (s: string) => s.replace(/[A-Z]+/g, (c) => c.toLowerCase());

/**
 * Resolve a Git blame (one Author per line) into line authors, with one users query for all the distinct emails
 * (one per EMAILS_PER_QUERY of them). If the lookup fails, everyone shows by their Git name.
 */
export async function resolveAuthors(db: Db, blame: Author[]): Promise<OriginAuthors> {
  const authors: OriginAuthor[] = [];
  const index = new Map<string, number>();
  const distinct: Author[] = [];
  const lines = blame.map((a) => {
    const git = gitIdentity(a);
    let i = index.get(git);
    if (i === undefined) {
      index.set(git, (i = distinct.push(a) - 1));
    }
    return i;
  });
  const emails = [...new Set(distinct.filter((a) => a.email && gitAuthor(a).kind === "human").map((a) => lowerAscii(a.email)))];
  const users = new Map<string, UserRow>();
  try {
    for (let i = 0; i < emails.length; i += EMAILS_PER_QUERY) {
      const chunk = emails.slice(i, i + EMAILS_PER_QUERY);
      const rows = await db.all<UserRow & { email: string }>(
        `SELECT id, name, login, email FROM users WHERE lower(email) IN (${chunk.map(() => "?").join(", ")})`,
        ...chunk,
      );
      for (const r of rows) if (!users.has(lowerAscii(r.email))) users.set(lowerAscii(r.email), r);
    }
  } catch (e) {
    console.error("[blame] looking up authors failed:", e);
    users.clear();
  }
  for (const a of distinct) authors.push({ ...gitAuthor(a, a.email ? (users.get(lowerAscii(a.email)) ?? null) : null), git: gitIdentity(a) });
  return { authors, lines };
}

/**
 * The message for `values`: participants' entries, and `origin(i)` (the author of origin line i, if known). One
 * name per agent session: a live participant's (the newest), else the Git blame's (already its newest).
 * `noteOrigin`: who created the note, if known.
 */
export function blameMessage(values: number[], people: LineAuthor[], origin: (i: number) => LineAuthor | null, noteOrigin?: NoteOrigin | null): BlameMessage {
  const authors: LineAuthor[] = [];
  const index = new Map<string, number>();
  const names = new Map<string, string>();
  for (const p of people) if (p.session && p.sessionName) names.set(p.session, p.sessionName);
  const ref = (a: LineAuthor | null | undefined) => {
    if (!a) return UNKNOWN;
    let i = index.get(a.id);
    if (i === undefined) {
      const name = a.session ? (names.get(a.session) ?? a.sessionName) : undefined;
      i = authors.push({ id: a.id, name: a.name, kind: a.kind, color: a.color, ...(a.session ? { session: a.session, ...(name ? { sessionName: name } : {}), sessionColor: a.sessionColor } : {}) }) - 1;
      index.set(a.id, i);
    }
    return i;
  };
  const lines = values.map((v) => (v >= 0 ? ref(people[v]) : isBaseLine(v) ? ref(origin(baseIndex(v))) : UNKNOWN));
  return { t: "blame", authors, lines, ...(noteOrigin ? { origin: noteOrigin } : {}) };
}

/** The author of an agent session known by nothing but its id (and title): an agent named "Agent", as Git blame shows one. */
export function sessionAgent(session: string, sessionName?: string): LineAuthor {
  return gitAuthor({ name: "Agent", email: "agent@agents.grimoire", session, ...(sessionName ? { sessionName } : {}) });
}

/** The most lines one setAuthors message may assign. */
export const MAX_ASSIGN_LINES = 20_000;

/**
 * Where a client's line block is in the live text: `expected` (the block's lines, as the client saw them) at
 * `from` if they're there, else the occurrence nearest to it (someone added or removed lines above meanwhile).
 * Null if the live text doesn't have the block (it changed under the client).
 */
export function findBlock(live: string[], from: number, expected: string[]): number | null {
  const at = (i: number) => i >= 0 && i + expected.length <= live.length && expected.every((t, k) => live[i + k] === t);
  if (at(from)) return from;
  for (let d = 1; d <= live.length; d++) {
    if (at(from - d)) return from - d;
    if (at(from + d)) return from + d;
    if (from - d < 0 && from + d >= live.length) break;
  }
  return null;
}

/**
 * Lines assigned an author outside Git (setAuthors), kept across the room's crash log being dropped (an idle
 * room closes): the text they were assigned in, `lines` = [line index in it, index into `people`].
 */
export interface SavedAssignments<P> {
  text: string;
  people: P[];
  lines: Array<[number, number]>;
}

/**
 * The assignments of `values` (lines of `text` whose value `isAssigned`), to save; null if there are none.
 */
export function saveAssignments<P>(text: string, values: number[], people: P[], isAssigned: (p: P) => boolean): SavedAssignments<P> | null {
  const out: P[] = [];
  const index = new Map<number, number>();
  const lines: Array<[number, number]> = [];
  values.forEach((v, i) => {
    const p = v >= 0 ? people[v] : undefined;
    if (!p || !isAssigned(p)) return;
    let k = index.get(v);
    if (k === undefined) index.set(v, (k = out.push(p) - 1));
    lines.push([i, k]);
  });
  return lines.length ? { text, people: out, lines } : null;
}

/**
 * Put saved assignments back on `values` (lines of `text`): every assigned line that's still a line of `text`
 * (line diff from the saved text) gets its author again (`person` turns a saved person into a value).
 */
export function restoreAssignments<P>(saved: SavedAssignments<P>, text: string, values: number[], person: (p: P) => number): number[] {
  const assigned = new Map(saved.lines.map(([i, k]) => [i, k]));
  const out = values.slice();
  for (const [a, b] of linePairs(saved.text.split("\n"), text.split("\n"))) {
    const k = assigned.get(a);
    const p = k === undefined ? undefined : saved.people[k];
    if (p !== undefined) out[b] = person(p);
  }
  return out;
}
