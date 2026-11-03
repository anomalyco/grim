export interface Author {
  name: string;
  email: string;
  /** An agent's session (session_id): its commits end with an Agent-Session-Id trailer (withSessionTrailer). */
  session?: string;
  /** The session's title (session_name), with a session only: an Agent-Session-Name trailer after the id. */
  sessionName?: string;
}

/** Commits by an agent (on a workspace URL or MCP) carry this author email domain (auth.ts participantForAgent). */
export const AGENT_EMAIL = /@agents\.grimoire$/i;

/** The Git trailers that name the agent session a commit was made in, and its title. */
export const SESSION_TRAILER = "Agent-Session-Id";
export const SESSION_NAME_TRAILER = "Agent-Session-Name";
const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
/** The longest session name kept (longer ones are cut to it). */
export const MAX_SESSION_NAME = 120;

/** An agent session id (session_id) if it's a valid one; anything else is ignored (undefined), never an error. */
export function parseSessionId(v: unknown): string | undefined {
  return typeof v === "string" && SESSION_ID.test(v) ? v : undefined;
}

/**
 * A session name (session_name) as it's kept: one line (line breaks and tabs become spaces, other control
 * characters are dropped, runs of spaces collapse), trimmed, at most MAX_SESSION_NAME characters. Anything that
 * isn't a string, or nothing left: undefined (dropped, never an error).
 */
export function parseSessionName(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const one = v
    .replace(/[\r\n\t\u2028\u2029]+/g, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === "\u200d" ? c : ""))
    .replace(/\s+/g, " ")
    .trim();
  const cut = [...one].slice(0, MAX_SESSION_NAME).join("").trim();
  return cut || undefined;
}

/**
 * `message` with the author's Agent-Session-Id trailer (and Agent-Session-Name, if it has one) at its end (in its
 * trailer block, if it has one).
 */
export function withSessionTrailer(message: string, author: Author): string {
  if (!author.session || !SESSION_ID.test(author.session)) return message;
  const name = parseSessionName(author.sessionName);
  const lines = `${SESSION_TRAILER}: ${author.session}${name ? `\n${SESSION_NAME_TRAILER}: ${name}` : ""}`;
  const body = message.replace(/\s+$/, "");
  const last = body.split("\n\n").at(-1) ?? "";
  const inTrailers = body.includes("\n\n") && last.split("\n").every((l) => /^[A-Za-z0-9-]+: /.test(l));
  return `${body}${inTrailers ? "\n" : "\n\n"}${lines}`;
}

/** The Agent-Session-Id trailer of a commit message, if it has a valid one. */
export function sessionOf(message: string): string | undefined {
  return sessionTrailers(message).session;
}

/** A commit message's Agent-Session-Id trailer and (with one) its Agent-Session-Name, the valid ones. */
export function sessionTrailers(message: string): { session?: string; sessionName?: string } {
  const last = message.replace(/\s+$/, "").split("\n\n").at(-1) ?? "";
  let session: string | undefined;
  let sessionName: string | undefined;
  for (const l of last.split("\n").reverse()) {
    const m = /^Agent-Session-Id:\s*(\S+)\s*$/i.exec(l);
    if (m && !session && SESSION_ID.test(m[1]!)) session = m[1];
    const n = /^Agent-Session-Name:(.*)$/i.exec(l);
    if (n && !sessionName) sessionName = parseSessionName(n[1]);
  }
  return session ? { session, ...(sessionName ? { sessionName } : {}) } : {};
}

/** An Author with the session trailers of its commit's message (agents' commits only matter). */
export function withTrailers(a: Author, message: string | undefined): Author {
  const t = message === undefined ? {} : sessionTrailers(message);
  return t.session ? { ...a, ...t } : a;
}

/**
 * One name per agent session over a file's blame: the name of that session's newest commit there (`time`: larger
 * is newer), so a session renamed over time shows its latest name on all of its lines.
 */
export function newestSessionNames(lines: Array<{ author: Author; time: number }>): Author[] {
  const newest = new Map<string, { name: string | undefined; time: number }>();
  for (const { author: a, time } of lines) {
    if (!a.session) continue;
    const n = newest.get(a.session);
    if (!n || time > n.time) newest.set(a.session, { name: a.sessionName, time });
  }
  return lines.map(({ author: a }) => {
    if (!a.session) return a;
    const name = newest.get(a.session)?.name;
    if (name === a.sessionName) return a;
    const { sessionName: _, ...rest } = a;
    return name ? { ...rest, sessionName: name } : rest;
  });
}

export interface FileChange {
  path: string;
  /** Text, or bytes for binary files (images). Omitted with delete. */
  content?: string | Uint8Array;
  delete?: boolean;
}

/** One binary file written in its own commit (an uploaded image). */
export interface BlobWrite {
  repo: string;
  branch: string;
  expectedHead: string | null;
  path: string;
  bytes: Uint8Array;
  message: string;
  author: Author;
}

export interface CommitInput {
  repo: string;
  branch: string;
  expectedHead: string | null; // null: the branch must not exist yet (first commit)
  changes: FileChange[];
  message: string;
  author: Author;
}

export type CommitOutcome = { ok: true; sha: string } | { ok: false; reason: "conflict" };

export interface CommitSummary {
  sha: string;
  message: string;
  authorName: string;
  authorEmail: string;
  date: string;
}

export interface FileMeta {
  path: string;
  size: number;
  /** ISO date of the last commit that changed the file, if known. */
  date?: string;
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export interface GitHubLink {
  owner: string;
  name: string;
  branch?: string;
  publicReadOnly?: boolean;
}

export class RepoBusyError extends Error {
  override name = "RepoBusyError";
  constructor(message = "repository sync in progress") {
    super(message);
  }
}

/** The file exists but couldn't be read right now (e.g. downloading it from GitHub failed). Try again later. */
export class StoreUnavailableError extends Error {
  override name = "StoreUnavailableError";
}

/** A store with a size budget (the demo's MemoryStore) refused a commit. The message says so for people. */
export class StoreFullError extends Error {
  override name = "StoreFullError";
}

/** The file is too large to open as a note. */
export class FileTooLargeError extends Error {
  override name = "FileTooLargeError";
  constructor(
    readonly path: string,
    readonly size: number,
    limit = MAX_FILE_BYTES,
  ) {
    super(`${path} is too large to open (${(size / 1024 / 1024).toFixed(1)} MB; the limit is ${limit / 1024 / 1024} MB)`);
  }
}

/** Largest file that is loaded into memory as a note. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

export interface SearchResult {
  hits: SearchHit[];
  /** Set when not every file could be searched (e.g. a GitHub copy whose files aren't all downloaded yet). */
  incomplete?: string;
}

/** Git-backed storage. Every method works on a branch/ref of a hosted repo; no working tree. */
export interface GitStore {
  readonly kind: "codestorage" | "local" | "memory";
  createRepo(id: string, opts: { branch: string; github?: GitHubLink }): Promise<void>;
  deleteRepo(id: string): Promise<void>;
  /** Tip of the branch, or null if the branch has no commits. Throws RepoBusyError while importing. */
  head(repo: string, branch: string): Promise<string | null>;
  listFiles(repo: string, ref: string): Promise<string[]>;
  /** Files with their sizes (and last-change dates when the backend knows them cheaply). Optional. */
  listFilesWithMetadata?(repo: string, ref: string): Promise<FileMeta[]>;
  /**
   * The file's text, or null if it doesn't exist at `ref`. Throws FileTooLargeError above MAX_FILE_BYTES and
   * StoreUnavailableError when it exists but can't be fetched right now.
   */
  readFile(repo: string, path: string, ref: string): Promise<string | null>;
  /**
   * The file's bytes (any file type), or null if it doesn't exist at `ref`. Throws FileTooLargeError above
   * `maxBytes` and StoreUnavailableError like readFile. Used to serve images; listings stay Markdown-only.
   */
  readBlob(repo: string, path: string, ref: string, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | null>;
  commit(input: CommitInput): Promise<CommitOutcome>;
  /** Commit one file's bytes as is (any file type), compare-and-swap on `expectedHead` like commit. */
  writeBlob(input: BlobWrite): Promise<CommitOutcome>;
  history(repo: string, branch: string, path: string | undefined, limit: number): Promise<CommitSummary[]>;
  /** Unified diff of one commit against its parent, optionally limited to one path. */
  diff(repo: string, sha: string, path?: string): Promise<string>;
  search(repo: string, ref: string, query: string, limit: number): Promise<SearchResult>;
  /**
   * Git blame of a file at `ref`: the author of the commit that last changed each line, one per line of the file
   * as Git counts them (no entry for the empty "line" after a final newline). null if the file isn't there or its
   * history can't be read right now. Optional (test stores may not have it).
   */
  blame?(repo: string, path: string, ref: string): Promise<Author[] | null>;
  /**
   * The author of the commit that created the file at `ref` (the oldest commit in its history there). null if
   * it isn't there or its history can't be read (or is too long to page through). Optional, like blame.
   */
  firstAuthor?(repo: string, path: string, ref: string): Promise<Author | null>;
  /** Update a repo copied from GitHub with GitHub's latest commits on `branch`. */
  pullUpstream?(repo: string, branch: string): Promise<void>;
}

export const isMarkdown = (p: string) => /\.(md|markdown|mdx)$/i.test(p);
/** Git pathspecs matching isMarkdown. */
export const MARKDOWN_PATHSPECS = [":(icase)*.md", ":(icase)*.markdown", ":(icase)*.mdx"];
