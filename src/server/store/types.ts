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

/** Git-backed storage. Every method works on a branch/ref of a hosted repo; no working tree. */
export interface GitStore {
  readonly kind: "codestorage" | "local";
  createRepo(id: string, opts: { branch: string; github?: GitHubLink }): Promise<void>;
  deleteRepo(id: string): Promise<void>;
  /** Tip of the branch, or null if the branch has no commits. Throws RepoBusyError while importing. */
  head(repo: string, branch: string): Promise<string | null>;
  listFiles(repo: string, ref: string): Promise<string[]>;
  readFile(repo: string, path: string, ref: string): Promise<string | null>;
  commit(input: CommitInput): Promise<CommitOutcome>;
  history(repo: string, branch: string, path: string | undefined, limit: number): Promise<CommitSummary[]>;
  /** Unified diff of one commit against its parent, optionally limited to one path. */
  diff(repo: string, sha: string, path?: string): Promise<string>;
  search(repo: string, ref: string, query: string, limit: number): Promise<SearchHit[]>;
  pullUpstream?(repo: string): Promise<void>;
}

export const isMarkdown = (p: string) => /\.(md|markdown|mdx)$/i.test(p);
