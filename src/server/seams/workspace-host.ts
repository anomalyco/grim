// Reaching a workspace's runtime: the same object in-process (Bun: src/server/bun/workspace-host-local.ts), or a
// WorkspaceDO stub on Workers (RPC). Everything here crosses that boundary, so arguments and results are plain data
// (structured-cloneable) and failures are errors matched by name (errors.ts isErr/errStatus): OpError (status),
// NotFoundError, FileTooLargeError, StoreFullError, StoreUnavailableError, RepoBusyError.
import type { ChangesResult } from "../changes.ts";
import type { Participant, Room } from "../room.ts";
import type { RepoRow } from "../repos.ts";
import type { CommitSummary, FileMeta, SearchResult } from "../store/types.ts";

export interface FileRead {
  path: string;
  content: string;
  version: string;
  /** read from an open room (unsaved edits included) rather than from Git */
  live: boolean;
}

export interface RawRead {
  path: string;
  type: string;
  bytes: Uint8Array<ArrayBuffer>;
}

export interface FileWrite {
  path: string;
  version: string;
}

export interface ImageUpload {
  path: string;
  markdownPath: string;
  markdown: string;
  reused: boolean;
}

/**
 * What the agent shell (shell/fs.ts NotesFs) knows of a workspace, from `snapshot`. A full snapshot replaces what the
 * caller had; a delta (same head, same runtime) only carries what changed since the caller's `version`.
 */
export interface ShellSnapshot {
  /** Pass back as `since` to get only what changed. */
  version: string;
  /** true: replaces everything the caller has (first call, a new head, a runtime restart); false: a delta. */
  full: boolean;
  head: string | null;
  /** Date of the head commit (ISO), for directory times and files the listing has no date for. */
  headDate: string | null;
  /** Markdown files at the head with sizes (and dates when the store knows them); full snapshots only. */
  files?: FileMeta[];
  /** Committed text at the head: the files the runtime has cached (full snapshots), plus those asked for in `want`. */
  contents: Record<string, string>;
  /** Text of open notes (unsaved edits included): all of them (full) or those that changed since `since`. */
  live: Record<string, string>;
  /** Notes closed since `since`: their text is the committed one again (if there is one). */
  closed: string[];
  /** Paths in `want` that couldn't be read, by error name (FileTooLargeError, StoreUnavailableError: try again). */
  errors?: Record<string, { name: string; message: string }>;
}

/** One shell write, applied by `applyWrites`. */
export interface ShellWrite {
  path: string;
  /** null: create the file with `content`. */
  base: string | null;
  content: string;
  /** Set when the command only appended: this text goes at the live end (else `base` → `content` is merged). */
  appended: string | null;
}

export interface SaveResult {
  path: string;
  saved: boolean;
  commit: string | null;
}

/** Someone with a note open, as presence events show them. */
export interface PresenceUser {
  id: string;
  name: string;
  color: string;
  kind: string;
}

export interface DirtyNote {
  path: string;
  /** false: a new note, not in Git yet */
  inBase: boolean;
}

/**
 * One workspace's operations: what the API, the shell/MCP, webhooks and cron call. Every call passes the workspace's
 * row as the caller read it (id, branch, read_only, status), so the runtime never reads the global tables itself.
 */
export interface WorkspaceApi {
  readFile(repo: RepoRow, path: string, ref?: string): Promise<FileRead>;
  readRaw(repo: RepoRow, path: string, ref?: string): Promise<RawRead>;
  createFile(repo: RepoRow, path: string, content: string | undefined, actor: Participant): Promise<FileWrite>;
  patchFile(repo: RepoRow, path: string, base: string, next: string, actor: Participant): Promise<FileWrite>;
  appendText(repo: RepoRow, path: string, text: string, actor: Participant): Promise<FileWrite>;
  restoreFile(repo: RepoRow, path: string, sha: string, actor: Participant): Promise<{ path: string }>;
  deleteFile(repo: RepoRow, path: string, actor: Participant): Promise<{ ok: true }>;
  renameFile(repo: RepoRow, from: string, to: string, actor: Participant, opts?: { ifUntitled?: boolean }): Promise<{ path: string }>;
  renameFolder(repo: RepoRow, from: string, to: string, actor: Participant): Promise<{ path: string }>;
  deleteFolder(repo: RepoRow, dir: string, actor: Participant): Promise<{ ok: true }>;
  uploadImage(repo: RepoRow, notePath: string, filename: string, bytes: Uint8Array, actor: Participant): Promise<ImageUpload>;
  /**
   * The shell's view in one call: the head listing, open notes' live text and cached committed text, only what
   * changed since `since` (a version from an earlier snapshot). `want`: committed files to read too, in that order,
   * as many as fit in one response (at least the first).
   */
  snapshot(repo: RepoRow, since: string | null, want?: string[]): Promise<ShellSnapshot>;
  /**
   * The shell's writes of one command, in order (create, append at the live end, or a 3-way merge of base → content
   * into the live text). One result per write: null when applied, else the error message.
   */
  applyWrites(repo: RepoRow, writes: ShellWrite[], actor: Participant): Promise<(string | null)[]>;
  /**
   * Shell `save`: commit these notes now, then the open notes under each folder of `dirs` ("" is the whole workspace).
   * One result per note, in that order: `saved` false when it had nothing unsaved; `commit` its base commit after.
   */
  save(repo: RepoRow, paths: string[], dirs?: string[]): Promise<SaveResult[]>;
  /** Shell `who`: the people and agents who have the note open (none when it isn't open). */
  who(repo: RepoRow, path: string): Promise<PresenceUser[]>;
  /** Shell `git status`: open notes under `dir` ("" for all) with edits not committed yet, by path. */
  status(repo: RepoRow, dir: string): Promise<DirtyNote[]>;
  /** Shell `git diff` without a commit: unified diffs of those notes' unsaved edits against their base. */
  liveDiff(repo: RepoRow, dir: string): Promise<string>;
  /** What people changed by hand since the newest agent commit, live edits included (changes.ts). */
  changes(repo: RepoRow, path?: string): Promise<ChangesResult>;
  /** Markdown files at the branch tip, plus open notes that aren't committed yet. */
  tree(repo: RepoRow): Promise<string[]>;
  head(repo: RepoRow): Promise<string | null>;
  /** `anyPath`: `path` is a folder or file as given (the shell's `git log`), not a note path made to end in .md. */
  history(repo: RepoRow, path: string | undefined, limit?: number, opts?: { anyPath?: boolean }): Promise<CommitSummary[]>;
  diff(repo: RepoRow, sha: string, path?: string, opts?: { anyPath?: boolean }): Promise<string>;
  search(repo: RepoRow, q: string): Promise<SearchResult>;
  /** Shell `watch`: true when the file (a folder if `path` ends with "/", the whole workspace without one) changes, false on timeout. */
  waitForChange(path: string | undefined, timeoutMs: number): Promise<boolean>;
  /**
   * The branch may have moved (our commits, a webhook, a poller): merge it into open rooms and tell clients.
   * `fresh` re-reads the head past the head cache (pollers); `invalidate` drops the cached head first (webhooks).
   */
  onPush(repo: RepoRow, opts?: { fresh?: boolean; invalidate?: boolean }): Promise<void>;
  /** Pull GitHub's latest commits into a read-only GitHub copy (at most every `minIntervalMs`), then onPush. */
  refresh(repo: RepoRow, minIntervalMs?: number): Promise<void>;
  /** The head a finished import left the branch at (counts as already seen by onPush). */
  seenHead(head: string | null): Promise<void>;
  /** The workspace is being removed: commit what can be, close every room ("removed"), drop cached state. */
  remove(): Promise<void>;
}

export interface WsReject {
  code: number;
  reason: string;
}

/** The workspace-level WebSocket admission (app.ts admitWorkspace, in the Worker on Workers): plain data. */
export interface AdmittedWorkspace {
  repoId: string;
  branch: string;
  path: string;
  participant: Participant;
  readOnly: boolean;
}

/** The outcome of WebSocket admission: close at once with a code, or join the room. */
export type WsDecision = { reject: WsReject } | { room: Room; participant: Participant; readOnly: boolean };

export interface WorkspaceHost {
  get(repoId: string): WorkspaceApi;
  /**
   * File-level WebSocket admission + socket attach, in-process hosts only: open the note's room (the caller then
   * upgrades and calls room.addConn). On Workers the WorkspaceDO does this inside its own fetch.
   */
  admitFile?(a: AdmittedWorkspace): Promise<WsDecision>;
  /** Drop a removed workspace's runtime (in-process hosts). */
  forget?(repoId: string): void;
}
