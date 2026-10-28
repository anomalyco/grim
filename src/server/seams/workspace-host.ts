// Reaching a workspace's runtime: the same object in-process (Bun: src/server/bun/workspace-host-local.ts), or a
// WorkspaceDO stub on Workers (RPC). Everything here crosses that boundary, so arguments and results are plain data
// (structured-cloneable) and failures are errors matched by name (errors.ts isErr/errStatus): OpError (status),
// NotFoundError, FileTooLargeError, StoreFullError, StoreUnavailableError, RepoBusyError.
import type { Participant, Room } from "../room.ts";
import type { RepoRow } from "../repos.ts";
import type { CommitSummary, SearchResult } from "../store/types.ts";

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
  /** Markdown files at the branch tip, plus open notes that aren't committed yet. */
  tree(repo: RepoRow): Promise<string[]>;
  head(repo: RepoRow): Promise<string | null>;
  history(repo: RepoRow, path: string | undefined, limit?: number): Promise<CommitSummary[]>;
  diff(repo: RepoRow, sha: string, path?: string): Promise<string>;
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
