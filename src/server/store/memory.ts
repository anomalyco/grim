// A GitStore entirely in memory (the demo folder): per repo, branches and a chain of commits, each a snapshot of all
// files (text and binary). Commit ids are the SHA-1 of the commit's content (parent, files, message, author, date),
// so they look and behave like Git's (stable, unique, short prefixes work). Nothing survives a restart.
//
// Optional limits (`MemoryLimits`) keep it small: a commit that would make a note, an image, all images or the whole
// snapshot too big is refused with StoreFullError; only the newest `commits` commits are kept (older snapshots are
// dropped, and history ends at the oldest kept one).
import {
  FileTooLargeError,
  isMarkdown,
  MAX_FILE_BYTES,
  StoreFullError,
  type Author,
  type BlobWrite,
  type CommitInput,
  type CommitOutcome,
  type CommitSummary,
  type FileMeta,
  type GitStore,
  type SearchHit,
  type SearchResult,
} from "./types.ts";
import { unified } from "./unified.ts";
import { BLAME_DEPTH, blameFromVersions } from "./blame.ts";

export interface MemoryLimits {
  /** Largest note (Markdown file). */
  noteBytes: number;
  /** Largest other file (an image). */
  imageBytes: number;
  /** All non-Markdown files of a snapshot together. */
  imagesBytes: number;
  /** A whole snapshot. */
  totalBytes: number;
  /** Commits kept per repo (newest). */
  commits: number;
  /** What a refused commit says. */
  fullMessage: string;
}

interface MemCommit {
  sha: string;
  parent: string | null;
  files: Map<string, Uint8Array>;
  message: string;
  authorName: string;
  authorEmail: string;
  date: string;
}

interface MemRepo {
  branches: Map<string, string>;
  commits: Map<string, MemCommit>;
  /** Commit ids, oldest first (for dropping the oldest). */
  order: string[];
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const hex = (b: Uint8Array | string) => new Bun.CryptoHasher("sha1").update(b).digest("hex");

export class MemoryStore implements GitStore {
  readonly kind = "memory" as const;
  private repos = new Map<string, MemRepo>();
  /** Test hook: the clock for commit dates. */
  now = () => Date.now();

  constructor(readonly limits: MemoryLimits | null = null) {}

  private repo(id: string): MemRepo {
    const r = this.repos.get(id);
    if (!r) throw new Error(`repo ${id} not found`);
    return r;
  }

  /** A branch name, a commit id or a unique prefix of one (4+ hex characters). */
  private resolve(repoId: string, ref: string): MemCommit | null {
    const r = this.repos.get(repoId);
    if (!r) return null;
    const sha = r.branches.get(ref) ?? (r.commits.has(ref) ? ref : null);
    if (sha) return r.commits.get(sha) ?? null;
    if (!/^[0-9a-f]{4,39}$/.test(ref)) return null;
    const found = [...r.commits.keys()].filter((k) => k.startsWith(ref));
    return found.length === 1 ? r.commits.get(found[0]!)! : null;
  }

  async createRepo(id: string, opts: { branch: string }) {
    if (!this.repos.has(id)) this.repos.set(id, { branches: new Map(), commits: new Map(), order: [] });
    void opts;
  }

  async deleteRepo(id: string) {
    this.repos.delete(id);
  }

  async head(repo: string, branch: string) {
    return this.repos.get(repo)?.branches.get(branch) ?? null;
  }

  async listFiles(repo: string, ref: string) {
    const c = this.resolve(repo, ref);
    return c ? [...c.files.keys()].sort() : [];
  }

  async listFilesWithMetadata(repo: string, ref: string): Promise<FileMeta[]> {
    const c = this.resolve(repo, ref);
    return c ? [...c.files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, b]) => ({ path, size: b.byteLength })) : [];
  }

  async readFile(repo: string, path: string, ref: string) {
    const b = this.resolve(repo, ref)?.files.get(path);
    if (!b) return null;
    if (b.byteLength > MAX_FILE_BYTES) throw new FileTooLargeError(path, b.byteLength);
    return dec.decode(b);
  }

  async readBlob(repo: string, path: string, ref: string, maxBytes: number) {
    const b = this.resolve(repo, ref)?.files.get(path);
    if (!b) return null;
    if (b.byteLength > maxBytes) throw new FileTooLargeError(path, b.byteLength, maxBytes);
    return new Uint8Array(b) as Uint8Array<ArrayBuffer>;
  }

  async commit(input: CommitInput): Promise<CommitOutcome> {
    const r = this.repo(input.repo);
    const current = r.branches.get(input.branch) ?? null;
    if (current !== input.expectedHead) return { ok: false, reason: "conflict" };
    const parent = current ? r.commits.get(current)! : null;
    const files = new Map(parent?.files ?? []);
    for (const c of input.changes) {
      if (!c.path || /[\x00-\x1f\x7f]/.test(c.path)) throw new Error(`invalid path ${JSON.stringify(c.path)}`);
      if (c.delete) files.delete(c.path);
      else files.set(c.path, typeof c.content === "string" ? enc.encode(c.content) : new Uint8Array(c.content ?? new Uint8Array()));
    }
    this.check(files, input.changes.map((c) => c.path));
    const date = new Date(Math.floor(this.now() / 1000) * 1000).toISOString().replace(/\.000Z$/, "Z");
    const entries = [...files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, b]) => `${hex(b)} ${p}`);
    const body = [`parent ${current ?? ""}`, `author ${input.author.name} <${input.author.email}> ${date}`, ...entries, "", input.message].join("\n");
    let sha = hex(body);
    // the same content at the same second as an existing commit: still a new commit
    for (let n = 1; r.commits.has(sha); n++) sha = hex(`${body}\n${n}`);
    r.commits.set(sha, { sha, parent: current, files, message: input.message, authorName: input.author.name, authorEmail: input.author.email, date });
    r.order.push(sha);
    r.branches.set(input.branch, sha);
    this.retain(r);
    return { ok: true, sha };
  }

  /** Refuse a snapshot over the limits (only the files this commit changes can make a single file too big). */
  private check(files: Map<string, Uint8Array>, changed: string[]) {
    const l = this.limits;
    if (!l) return;
    for (const p of changed) {
      const b = files.get(p);
      if (b && b.byteLength > (isMarkdown(p) ? l.noteBytes : l.imageBytes)) throw new StoreFullError(l.fullMessage);
    }
    let total = 0;
    let images = 0;
    for (const [p, b] of files) {
      total += b.byteLength;
      if (!isMarkdown(p)) images += b.byteLength;
    }
    if (total > l.totalBytes || images > l.imagesBytes) throw new StoreFullError(l.fullMessage);
  }

  /** Keep the newest commits (`limits.commits`); a branch tip is never dropped. */
  private retain(r: MemRepo) {
    const max = this.limits?.commits;
    if (!max) return;
    const tips = new Set(r.branches.values());
    while (r.order.length > max) {
      const i = r.order.findIndex((s) => !tips.has(s));
      if (i < 0) break;
      r.commits.delete(r.order[i]!);
      r.order.splice(i, 1);
    }
  }

  writeBlob(input: BlobWrite): Promise<CommitOutcome> {
    const { path, bytes, ...rest } = input;
    return this.commit({ ...rest, changes: [{ path, content: bytes }] });
  }

  /** Newest first, following parents from the branch tip; with `path`, only commits that changed it. */
  async history(repo: string, branch: string, path: string | undefined, limit: number): Promise<CommitSummary[]> {
    const r = this.repos.get(repo);
    const out: CommitSummary[] = [];
    let c = r ? (this.resolve(repo, branch) ?? null) : null;
    while (c && out.length < limit) {
      const parent = c.parent ? (r!.commits.get(c.parent) ?? null) : null;
      if (!path || !same(c.files.get(path), parent?.files.get(path))) {
        out.push({ sha: c.sha, message: c.message.split("\n")[0] ?? "", authorName: c.authorName, authorEmail: c.authorEmail, date: c.date });
      }
      c = parent;
    }
    return out;
  }

  /** Unified diff of a commit against its parent (Markdown files, or just `path`). */
  async diff(repo: string, sha: string, path?: string) {
    const c = this.resolve(repo, sha);
    if (!c) throw new Error(`unknown revision ${sha}`);
    const parent = c.parent ? (this.repos.get(repo)!.commits.get(c.parent)?.files ?? new Map<string, Uint8Array>()) : new Map<string, Uint8Array>();
    const paths = [...new Set([...parent.keys(), ...c.files.keys()])].filter((p) => (path ? p === path : isMarkdown(p))).sort();
    let out = "";
    for (const p of paths) {
      const a = parent.get(p);
      const b = c.files.get(p);
      if (same(a, b)) continue;
      if ((a && isBinary(a)) || (b && isBinary(b))) {
        out += `diff --git a/${p} b/${p}\nBinary files ${a ? `a/${p}` : "/dev/null"} and ${b ? `b/${p}` : "/dev/null"} differ\n`;
        continue;
      }
      out += unified(p, a ? dec.decode(a) : null, b ? dec.decode(b) : null);
    }
    return out;
  }

  /** Computed from the file's versions on the commit chain (the newest BLAME_DEPTH; the chain ends at the oldest kept commit). */
  async blame(repo: string, path: string, ref: string): Promise<Author[] | null> {
    const r = this.repos.get(repo);
    let c = this.resolve(repo, ref);
    if (!r || !c?.files.has(path)) return null;
    const versions: Array<{ text: string; author: Author }> = [];
    while (c && versions.length < BLAME_DEPTH) {
      const b = c.files.get(path);
      if (!b) break;
      const parent: MemCommit | null = c.parent ? (r.commits.get(c.parent) ?? null) : null;
      if (!same(b, parent?.files.get(path))) versions.push({ text: dec.decode(b), author: { name: c.authorName, email: c.authorEmail } });
      c = parent;
    }
    return blameFromVersions(versions.reverse());
  }

  async search(repo: string, ref: string, query: string, limit: number): Promise<SearchResult> {
    const c = this.resolve(repo, ref);
    if (!c || !query.trim()) return { hits: [] };
    const needle = query.toLowerCase();
    const hits: SearchHit[] = [];
    for (const [path, b] of [...c.files].sort(([x], [y]) => (x < y ? -1 : 1))) {
      if (!isMarkdown(path) || b.byteLength > MAX_FILE_BYTES || isBinary(b)) continue;
      const lines = dec.decode(b).split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i]!.toLowerCase().includes(needle)) continue;
        hits.push({ path, line: i + 1, text: lines[i]! });
        if (hits.length >= limit) return { hits };
      }
    }
    return { hits };
  }
}

function same(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Like git: a NUL in the first 8000 bytes means binary. */
const isBinary = (b: Uint8Array) => b.subarray(0, 8000).includes(0);
