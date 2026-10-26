export interface Author {
  name: string;
  email: string;
}

export interface FileChange {
  path: string;
  content?: string; // omitted with delete
  delete?: boolean;
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
  constructor(message = "repository sync in progress") {
    super(message);
  }
}

/** The file exists but couldn't be read right now (e.g. downloading it from GitHub failed). Try again later. */
export class StoreUnavailableError extends Error {}

/** The file is too large to open as a note. */
export class FileTooLargeError extends Error {
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
  readonly kind: "codestorage" | "local";
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
  history(repo: string, branch: string, path: string | undefined, limit: number): Promise<CommitSummary[]>;
  /** Unified diff of one commit against its parent, optionally limited to one path. */
  diff(repo: string, sha: string, path?: string): Promise<string>;
  search(repo: string, ref: string, query: string, limit: number): Promise<SearchResult>;
  /** Update a repo copied from GitHub with GitHub's latest commits on `branch`. */
  pullUpstream?(repo: string, branch: string): Promise<void>;
}

export const isMarkdown = (p: string) => /\.(md|markdown|mdx)$/i.test(p);
/** Git pathspecs matching isMarkdown. */
export const MARKDOWN_PATHSPECS = [":(icase)*.md", ":(icase)*.markdown", ":(icase)*.mdx"];
