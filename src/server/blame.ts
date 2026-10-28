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
}

/** The control message: `lines[i]` is an index into `authors`, or -1 (unknown), for every line of the text. */
export interface BlameMessage {
  t: "blame";
  authors: LineAuthor[];
  lines: number[];
}

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
 * How a Git author shows: guests' commits are "<name> (guest)", agents' use an @agents.grimoire address, and people
 * with an account (`user`, looked up by email) show as that account.
 */
export function gitAuthor(a: Author, user: UserRow | null = null): LineAuthor {
  if (a.email === GUEST_EMAIL && a.name.endsWith(" (guest)")) {
    const name = a.name.slice(0, -" (guest)".length);
    return { id: `guest-name:${name}`, name, kind: "guest", color: colorFor(`guest-name:${name}`) };
  }
  if (a.email.endsWith("@agents.grimoire")) return { id: `agent-name:${a.name}`, name: a.name, kind: "agent", color: colorFor(`agent-name:${a.name}`) };
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
    const git = `${a.name}\0${a.email}`;
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
  for (const a of distinct) authors.push({ ...gitAuthor(a, a.email ? (users.get(lowerAscii(a.email)) ?? null) : null), git: `${a.name}\0${a.email}` });
  return { authors, lines };
}

/** The message for `values`: participants' entries, and `origin(i)` (the author of origin line i, if known). */
export function blameMessage(values: number[], people: LineAuthor[], origin: (i: number) => LineAuthor | null): BlameMessage {
  const authors: LineAuthor[] = [];
  const index = new Map<string, number>();
  const ref = (a: LineAuthor | null | undefined) => {
    if (!a) return UNKNOWN;
    let i = index.get(a.id);
    if (i === undefined) {
      i = authors.push({ id: a.id, name: a.name, kind: a.kind, color: a.color }) - 1;
      index.set(a.id, i);
    }
    return i;
  };
  const lines = values.map((v) => (v >= 0 ? ref(people[v]) : isBaseLine(v) ? ref(origin(baseIndex(v))) : UNKNOWN));
  return { t: "blame", authors, lines };
}
