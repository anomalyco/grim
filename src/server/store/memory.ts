// A GitStore without Git (the demo folder): per repo, branches and a chain of commits. Files are content-addressed
// blobs (SHA-1 of the bytes); a commit is a small record whose tree maps each path to its blob. Commit ids are the
// SHA-1 of the commit's content (parent, files, message, author, date), so they look and behave like Git's (stable,
// unique, short prefixes work).
//
// Where blobs, commits and heads live is a `MemoryPersistence`: by default plain Maps (nothing survives a restart);
// a Durable Object can pass one over its SQLite storage instead. Runtime-neutral: no Bun APIs.
//
// Optional limits (`MemoryLimits`) keep it small: a commit that would make a note, an image, all images or the whole
// snapshot too big is refused with StoreFullError; only the newest `commits` commits are kept (older ones and the
// blobs only they used are dropped, and history ends at the oldest kept one).
import { createHash } from "node:crypto";
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

/** A file in a commit's tree: its blob and size in bytes. */
export interface MemTreeEntry {
  sha: string;
  size: number;
}

export interface MemCommit {
  sha: string;
  parent: string | null;
  /** path → blob */
  tree: Record<string, MemTreeEntry>;
  message: string;
  authorName: string;
  authorEmail: string;
  date: string;
}

type Awaitable<T> = T | Promise<T>;

/**
 * Storage for a MemoryStore, per repo. Methods may be sync or async. The store serializes writes per repo, writes
 * blobs before the commit that uses them and the commit before moving the head, and never writes for a refused or
 * conflicting commit.
 */
export interface MemoryPersistence {
  createRepo(repo: string): Awaitable<void>;
  hasRepo(repo: string): Awaitable<boolean>;
  /** Drop the repo's blobs, commits and heads. */
  deleteRepo(repo: string): Awaitable<void>;
  getBlob(repo: string, sha: string): Awaitable<Uint8Array | null>;
  putBlob(repo: string, sha: string, bytes: Uint8Array): Awaitable<void>;
  deleteBlob(repo: string, sha: string): Awaitable<void>;
  getCommit(repo: string, sha: string): Awaitable<MemCommit | null>;
  putCommit(repo: string, commit: MemCommit): Awaitable<void>;
  deleteCommit(repo: string, sha: string): Awaitable<void>;
  /** Commit ids, oldest first (in putCommit order). */
  listCommits(repo: string): Awaitable<string[]>;
  getHead(repo: string, branch: string): Awaitable<string | null>;
  setHead(repo: string, branch: string, sha: string): Awaitable<void>;
  /** branch → tip */
  listHeads(repo: string): Awaitable<Record<string, string>>;
}

interface MapRepo {
  blobs: Map<string, Uint8Array>;
  commits: Map<string, MemCommit>;
  heads: Map<string, string>;
}

/** The default persistence: Maps in this process. */
export class MapPersistence implements MemoryPersistence {
  private repos = new Map<string, MapRepo>();
  private r(repo: string) {
    return this.repos.get(repo);
  }
  createRepo(repo: string) {
    if (!this.repos.has(repo)) this.repos.set(repo, { blobs: new Map(), commits: new Map(), heads: new Map() });
  }
  hasRepo(repo: string) {
    return this.repos.has(repo);
  }
  deleteRepo(repo: string) {
    this.repos.delete(repo);
  }
  getBlob(repo: string, sha: string) {
    return this.r(repo)?.blobs.get(sha) ?? null;
  }
  putBlob(repo: string, sha: string, bytes: Uint8Array) {
    this.r(repo)?.blobs.set(sha, bytes);
  }
  deleteBlob(repo: string, sha: string) {
    this.r(repo)?.blobs.delete(sha);
  }
  getCommit(repo: string, sha: string) {
    return this.r(repo)?.commits.get(sha) ?? null;
  }
  putCommit(repo: string, commit: MemCommit) {
    this.r(repo)?.commits.set(commit.sha, commit);
  }
  deleteCommit(repo: string, sha: string) {
    this.r(repo)?.commits.delete(sha);
  }
  listCommits(repo: string) {
    return [...(this.r(repo)?.commits.keys() ?? [])];
  }
  getHead(repo: string, branch: string) {
    return this.r(repo)?.heads.get(branch) ?? null;
  }
  setHead(repo: string, branch: string, sha: string) {
    this.r(repo)?.heads.set(branch, sha);
  }
  listHeads(repo: string) {
    return Object.fromEntries(this.r(repo)?.heads ?? []);
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const hex = (b: Uint8Array | string) => createHash("sha1").update(b).digest("hex");
const sortedPaths = (tree: Record<string, MemTreeEntry>) => Object.keys(tree).sort();

export class MemoryStore implements GitStore {
  readonly kind = "memory" as const;
  /** Test hook: the clock for commit dates. */
  now = () => Date.now();
  private locks = new Map<string, Promise<unknown>>();

  constructor(
    readonly limits: MemoryLimits | null = null,
    readonly persistence: MemoryPersistence = new MapPersistence(),
  ) {}

  /** Run `fn` after the repo's earlier writes (commits compare-and-swap the head across awaits). */
  private exclusive<T>(repo: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(repo) ?? Promise.resolve()).then(fn);
    const tail = run.catch(() => {});
    this.locks.set(repo, tail);
    void tail.then(() => {
      if (this.locks.get(repo) === tail) this.locks.delete(repo);
    });
    return run;
  }

  /** A branch name, a commit id or a unique prefix of one (4+ hex characters). */
  private async resolve(repo: string, ref: string): Promise<MemCommit | null> {
    const p = this.persistence;
    const head = await p.getHead(repo, ref);
    if (head) return p.getCommit(repo, head);
    if (!/^[0-9a-f]{4,40}$/.test(ref)) return null;
    if (ref.length === 40) return p.getCommit(repo, ref);
    const found = (await p.listCommits(repo)).filter((k) => k.startsWith(ref));
    return found.length === 1 ? p.getCommit(repo, found[0]!) : null;
  }

  private parentOf(repo: string, c: MemCommit): Awaitable<MemCommit | null> {
    return c.parent ? this.persistence.getCommit(repo, c.parent) : null;
  }

  private async bytes(repo: string, path: string, e: MemTreeEntry): Promise<Uint8Array> {
    const b = await this.persistence.getBlob(repo, e.sha);
    if (!b) throw new Error(`missing blob ${e.sha} for ${path}`);
    return b;
  }

  async createRepo(id: string, opts: { branch: string }) {
    void opts;
    await this.exclusive(id, async () => this.persistence.createRepo(id));
  }

  async deleteRepo(id: string) {
    await this.exclusive(id, async () => this.persistence.deleteRepo(id));
  }

  async head(repo: string, branch: string) {
    return (await this.persistence.getHead(repo, branch)) ?? null;
  }

  async listFiles(repo: string, ref: string) {
    const c = await this.resolve(repo, ref);
    return c ? sortedPaths(c.tree) : [];
  }

  async listFilesWithMetadata(repo: string, ref: string): Promise<FileMeta[]> {
    const c = await this.resolve(repo, ref);
    return c ? sortedPaths(c.tree).map((path) => ({ path, size: c.tree[path]!.size })) : [];
  }

  async readFile(repo: string, path: string, ref: string) {
    const e = (await this.resolve(repo, ref))?.tree[path];
    if (!e) return null;
    if (e.size > MAX_FILE_BYTES) throw new FileTooLargeError(path, e.size);
    return dec.decode(await this.bytes(repo, path, e));
  }

  async readBlob(repo: string, path: string, ref: string, maxBytes: number) {
    const e = (await this.resolve(repo, ref))?.tree[path];
    if (!e) return null;
    if (e.size > maxBytes) throw new FileTooLargeError(path, e.size, maxBytes);
    return new Uint8Array(await this.bytes(repo, path, e)) as Uint8Array<ArrayBuffer>;
  }

  commit(input: CommitInput): Promise<CommitOutcome> {
    return this.exclusive(input.repo, () => this.commitLocked(input));
  }

  private async commitLocked(input: CommitInput): Promise<CommitOutcome> {
    const p = this.persistence;
    const repo = input.repo;
    if (!(await p.hasRepo(repo))) throw new Error(`repo ${repo} not found`);
    const current = (await p.getHead(repo, input.branch)) ?? null;
    if (current !== input.expectedHead) return { ok: false, reason: "conflict" };
    const parent = current ? await p.getCommit(repo, current) : null;
    const tree: Record<string, MemTreeEntry> = { ...parent?.tree };
    const blobs = new Map<string, Uint8Array>();
    for (const c of input.changes) {
      if (!c.path || /[\x00-\x1f\x7f]/.test(c.path)) throw new Error(`invalid path ${JSON.stringify(c.path)}`);
      if (c.delete) {
        delete tree[c.path];
        continue;
      }
      const b = typeof c.content === "string" ? enc.encode(c.content) : new Uint8Array(c.content ?? new Uint8Array());
      const sha = hex(b);
      tree[c.path] = { sha, size: b.byteLength };
      blobs.set(sha, b);
    }
    this.check(tree, input.changes.map((c) => c.path));
    const date = new Date(Math.floor(this.now() / 1000) * 1000).toISOString().replace(/\.000Z$/, "Z");
    const entries = sortedPaths(tree).map((path) => `${tree[path]!.sha} ${path}`);
    const body = [`parent ${current ?? ""}`, `author ${input.author.name} <${input.author.email}> ${date}`, ...entries, "", input.message].join("\n");
    let sha = hex(body);
    // the same content at the same second as an existing commit: still a new commit
    for (let n = 1; await p.getCommit(repo, sha); n++) sha = hex(`${body}\n${n}`);
    for (const [blobSha, b] of blobs) if (!(await p.getBlob(repo, blobSha))) await p.putBlob(repo, blobSha, b);
    await p.putCommit(repo, { sha, parent: current, tree, message: input.message, authorName: input.author.name, authorEmail: input.author.email, date });
    await p.setHead(repo, input.branch, sha);
    await this.retain(repo);
    return { ok: true, sha };
  }

  /** Refuse a snapshot over the limits (only the files this commit changes can make a single file too big). */
  private check(tree: Record<string, MemTreeEntry>, changed: string[]) {
    const l = this.limits;
    if (!l) return;
    for (const path of changed) {
      const e = tree[path];
      if (e && e.size > (isMarkdown(path) ? l.noteBytes : l.imageBytes)) throw new StoreFullError(l.fullMessage);
    }
    let total = 0;
    let images = 0;
    for (const [path, e] of Object.entries(tree)) {
      total += e.size;
      if (!isMarkdown(path)) images += e.size;
    }
    if (total > l.totalBytes || images > l.imagesBytes) throw new StoreFullError(l.fullMessage);
  }

  /** Keep the newest commits (`limits.commits`); a branch tip is never dropped. Blobs no kept commit uses go too. */
  private async retain(repo: string) {
    const max = this.limits?.commits;
    if (!max) return;
    const p = this.persistence;
    const order = await p.listCommits(repo);
    if (order.length <= max) return;
    const tips = new Set(Object.values(await p.listHeads(repo)));
    const drop: string[] = [];
    for (const s of order) {
      if (order.length - drop.length <= max) break;
      if (!tips.has(s)) drop.push(s);
    }
    if (!drop.length) return;
    const dropped = new Set(drop);
    const kept = order.filter((s) => !dropped.has(s));
    for (const s of drop) {
      const c = await p.getCommit(repo, s);
      await p.deleteCommit(repo, s);
      if (!c) continue;
      const orphans = new Set(Object.values(c.tree).map((e) => e.sha));
      // oldest kept first: usually the next commit still has nearly all of them, so this stops early
      for (const k of kept) {
        if (!orphans.size) break;
        const kc = await p.getCommit(repo, k);
        for (const e of Object.values(kc?.tree ?? {})) orphans.delete(e.sha);
      }
      for (const b of orphans) await p.deleteBlob(repo, b);
    }
  }

  writeBlob(input: BlobWrite): Promise<CommitOutcome> {
    const { path, bytes, ...rest } = input;
    return this.commit({ ...rest, changes: [{ path, content: bytes }] });
  }

  /** Newest first, following parents from the branch tip; with `path`, only commits that changed it. */
  async history(repo: string, branch: string, path: string | undefined, limit: number): Promise<CommitSummary[]> {
    const out: CommitSummary[] = [];
    let c = await this.resolve(repo, branch);
    while (c && out.length < limit) {
      const parent = await this.parentOf(repo, c);
      if (!path || c.tree[path]?.sha !== parent?.tree[path]?.sha) {
        out.push({ sha: c.sha, message: c.message.split("\n")[0] ?? "", authorName: c.authorName, authorEmail: c.authorEmail, date: c.date });
      }
      c = parent;
    }
    return out;
  }

  /** Unified diff of a commit against its parent (Markdown files, or just `path`). */
  async diff(repo: string, sha: string, path?: string) {
    const c = await this.resolve(repo, sha);
    if (!c) throw new Error(`unknown revision ${sha}`);
    const before = (await this.parentOf(repo, c))?.tree ?? {};
    const paths = [...new Set([...Object.keys(before), ...Object.keys(c.tree)])].filter((p) => (path ? p === path : isMarkdown(p))).sort();
    let out = "";
    for (const p of paths) {
      const ea = before[p];
      const eb = c.tree[p];
      if (ea?.sha === eb?.sha) continue;
      const a = ea ? await this.bytes(repo, p, ea) : null;
      const b = eb ? await this.bytes(repo, p, eb) : null;
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
    let c = await this.resolve(repo, ref);
    if (!c?.tree[path]) return null;
    const versions: Array<{ text: string; author: Author }> = [];
    while (c && versions.length < BLAME_DEPTH) {
      const e: MemTreeEntry | undefined = c.tree[path];
      if (!e) break;
      const parent: MemCommit | null = await this.parentOf(repo, c);
      if (e.sha !== parent?.tree[path]?.sha) versions.push({ text: dec.decode(await this.bytes(repo, path, e)), author: { name: c.authorName, email: c.authorEmail } });
      c = parent;
    }
    return blameFromVersions(versions.reverse());
  }

  async search(repo: string, ref: string, query: string, limit: number): Promise<SearchResult> {
    const c = await this.resolve(repo, ref);
    if (!c || !query.trim()) return { hits: [] };
    const needle = query.toLowerCase();
    const hits: SearchHit[] = [];
    for (const path of sortedPaths(c.tree)) {
      const e = c.tree[path]!;
      if (!isMarkdown(path) || e.size > MAX_FILE_BYTES) continue;
      const b = await this.bytes(repo, path, e);
      if (isBinary(b)) continue;
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

/** Like git: a NUL in the first 8000 bytes means binary. */
const isBinary = (b: Uint8Array) => b.subarray(0, 8000).includes(0);
