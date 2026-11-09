// Reaching a workspace's runtime: the same object in-process (Bun: src/server/bun/workspace-host-local.ts), or a
// WorkspaceDO stub on Workers (RPC). Everything here crosses that boundary, so arguments and results are plain data
// (structured-cloneable) and failures are errors matched by name (errors.ts isErr/errStatus): OpError (status),
// NotFoundError.
import type { Participant, Room } from "../room.ts";
import type { RepoRow } from "../repos.ts";
import type { NoteShellResult } from "../notes/shell.ts";

export interface FileRead {
  path: string;
  content: string;
  version: string;
  /** the live text (false: a version's) */
  live: boolean;
}

export interface RawRead {
  path: string;
  type: string;
  bytes: Uint8Array<ArrayBuffer>;
  /** the image's content hash (immutable caching) */
  sha256: string;
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

/** A version as the history API shows it (the shape Git commits had: `sha` is the version id). */
export interface VersionSummary {
  sha: string;
  message: string;
  authorName: string;
  authorEmail: string;
  date: string;
  /** edit | agent | restore | rename | delete | import */
  kind: string;
  path: string;
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export interface SearchResult {
  hits: SearchHit[];
  incomplete?: string;
}

/** Someone with a note open, as presence events show them. */
export interface PresenceUser {
  id: string;
  name: string;
  color: string;
  kind: string;
}

/** An agent's command on one note (the note shell). */
export interface NoteCommand {
  command: string;
  timeoutMs: number;
  /** The caller may create the note when it doesn't exist (else 404). */
  create: boolean;
  /** Caller key and limits are checked by the runtime (one object sees every call to the workspace). */
  limitKey: string;
}

/** A note as imported (staging migration, docs/storage-v2.md §12): its text and its versions, oldest first. */
export interface ImportNote {
  path: string;
  text: string;
  versions: Array<{ text: string; authorName: string; authorEmail: string; date: string; message?: string }>;
}

/**
 * One workspace's operations: what the API, the note shell, MCP and cron call. Every call passes the workspace's
 * row as the caller read it (id, read_only, status), so the runtime never reads the global tables itself.
 */
export interface WorkspaceApi {
  readFile(repo: RepoRow, path: string, ref?: string): Promise<FileRead>;
  readRaw(repo: RepoRow, path: string): Promise<RawRead>;
  createFile(repo: RepoRow, path: string, content: string | undefined, actor: Participant): Promise<FileWrite>;
  patchFile(repo: RepoRow, path: string, base: string, next: string, actor: Participant): Promise<FileWrite>;
  appendText(repo: RepoRow, path: string, text: string, actor: Participant): Promise<FileWrite>;
  restoreFile(repo: RepoRow, path: string, sha: string, actor: Participant): Promise<{ path: string }>;
  deleteFile(repo: RepoRow, path: string, actor: Participant): Promise<{ ok: true }>;
  renameFile(repo: RepoRow, from: string, to: string, actor: Participant, opts?: { ifUntitled?: boolean }): Promise<{ path: string }>;
  renameFolder(repo: RepoRow, from: string, to: string, actor: Participant): Promise<{ path: string }>;
  deleteFolder(repo: RepoRow, dir: string, actor: Participant): Promise<{ ok: true }>;
  uploadImage(repo: RepoRow, notePath: string, filename: string, bytes: Uint8Array, actor: Participant): Promise<ImageUpload>;
  /** Live notes, sorted. */
  tree(repo: RepoRow): Promise<string[]>;
  /** A short tag that changes whenever the tree does (ETags, the v2 `tree` event). */
  head(repo: RepoRow): Promise<string | null>;
  /** Versions of a note (or of every note under a folder, or of the workspace), newest first. */
  history(repo: RepoRow, path: string | undefined, limit?: number): Promise<VersionSummary[]>;
  /** A version against the note's version before it, as a unified diff. */
  diff(repo: RepoRow, sha: string, path?: string): Promise<string>;
  search(repo: RepoRow, q: string): Promise<SearchResult>;
  /** Run an agent's command on one note (notes/shell.ts); its write lands live as the agent's own version. */
  noteCommand(repo: RepoRow, path: string, cmd: NoteCommand, actor: Participant): Promise<NoteShellResult>;
  /** Who has the note open. */
  who(repo: RepoRow, path: string): Promise<PresenceUser[]>;
  /** The workspace as a zip: notes, images, .grim/versions.json. */
  exportZip(repo: RepoRow): Promise<Uint8Array<ArrayBuffer>>;
  /** Import notes with their versions (staging migration). Returns the paths made. */
  importNotes(repo: RepoRow, notes: ImportNote[], images: Array<{ path: string; base64: string }>): Promise<string[]>;
  /** Bump every note's epoch (after a point-in-time restore): clients merge by text. */
  bumpEpochs(): Promise<number>;
  /** The workspace is being removed: close every room ("removed"), drop its notes and images. */
  remove(): Promise<void>;
}

export interface WsReject {
  code: number;
  reason: string;
}

/** The workspace-level WebSocket admission (app.ts admitWorkspace, in the Worker on Workers): plain data. */
export interface AdmittedWorkspace {
  repoId: string;
  path: string;
  participant: Participant;
  readOnly: boolean;
}

/** The outcome of WebSocket admission: close at once with a code, or join the room. */
export type WsDecision = { reject: WsReject } | { room: Room; participant: Participant; readOnly: boolean };

export interface WorkspaceHost {
  get(repoId: string): WorkspaceApi;
  /** File-level WebSocket admission, in-process hosts only (Workers: the WorkspaceDO's own fetch). */
  admitFile?(a: AdmittedWorkspace): Promise<WsDecision>;
  /** Drop a removed workspace's runtime (in-process hosts). */
  forget?(repoId: string): void;
}
