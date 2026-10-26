import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { anonymousGitEnv, catBlobs, git, gitBytes, gitOk } from "./gitexec.ts";
import {
  FileTooLargeError,
  isMarkdown,
  MARKDOWN_PATHSPECS,
  MAX_FILE_BYTES,
  StoreUnavailableError,
  type CommitInput,
  type CommitOutcome,
  type CommitSummary,
  type FileMeta,
  type GitHubLink,
  type GitStore,
  type SearchHit,
  type SearchResult,
} from "./types.ts";

/** Refs and shas come from callers; never let one be read as an option or smuggle control characters. */
function safe(s: string): string {
  if (s.startsWith("-") || /[\x00-\x1f\x7f]/.test(s)) throw new Error(`invalid argument ${JSON.stringify(s)}`);
  return s;
}

/** Paths only ever follow `--`, `<ref>:` or a pathspec prefix, so a leading "-" is fine; control characters aren't. */
function safePath(s: string): string {
  if (!s || /[\x00-\x1f\x7f]/.test(s)) throw new Error(`invalid path ${JSON.stringify(s)}`);
  return s;
}

/** A pathspec that matches exactly this path (no globbing). */
const literal = (path: string) => `:(literal)${safePath(path)}`;

const firstError = (stderr: string) => (stderr.split("\n").find((l) => l.startsWith("fatal:") || l.startsWith("error:")) ?? stderr.trim().split("\n")[0] ?? "").replace(/^(fatal|error): /, "");

const SEP = "\x1f";
/** How much one listing, search or diff may download from GitHub. */
const FETCH_LIMITS = { files: 200, bytes: 20 * 1024 * 1024 };
const FETCH_CHUNK = 50;
/** How many commits of history read-only GitHub copies keep. */
const CLONE_DEPTH = 200;
/** Commands run without lazy fetching: missing blobs are reported instead of downloaded one at a time. */
const NO_LAZY = { GIT_NO_LAZY_FETCH: "1" };
/** How many single-file downloads (opening a note, showing an image) run at once per repo. */
const FETCH_CONCURRENCY = 2;
/** Tree entry modes of regular files (not symlinks 120000 or submodules 160000). */
const REGULAR_MODES = new Set(["100644", "100755"]);
const REC = "\x1e";

/** Bare repositories on local disk. Used for development and tests when Code Storage isn't configured. */
export class LocalGitStore implements GitStore {
  readonly kind = "local" as const;
  constructor(
    private root: string,
    /** Clone URL of a GitHub repo (tests point this at local repos). */
    private githubUrl: (owner: string, name: string) => string = (owner, name) => `https://github.com/${owner}/${name}.git`,
  ) {
    mkdirSync(root, { recursive: true });
  }

  private dir(repo: string) {
    if (!/^[A-Za-z0-9._-]+$/.test(repo)) throw new Error(`invalid repo id ${repo}`);
    return join(this.root, `${repo}.git`);
  }

  /**
   * GitHub repos are partial clones (`--filter=blob:none`): commits and trees only. File contents are fetched from
   * GitHub when first read, or in bounded batches for listings with sizes, search and diffs. Read-only copies are
   * also shallow (the last CLONE_DEPTH commits).
   */
  async createRepo(id: string, opts: { branch: string; github?: GitHubLink }) {
    const dir = this.dir(id);
    if (existsSync(dir)) return;
    if (opts.github) {
      const { owner, name, branch, publicReadOnly } = opts.github;
      // Clone next to the target and move it into place, so a failed clone leaves nothing behind.
      const tmp = `${dir}.tmp-${crypto.randomUUID()}`;
      try {
        await gitOk(["clone", "--bare", "-q", "--filter=blob:none", "--single-branch", ...(publicReadOnly ? ["--depth", String(CLONE_DEPTH)] : []), ...(branch ? ["--branch", safe(branch)] : []), this.githubUrl(owner, name), tmp], {
          env: anonymousGitEnv,
          timeoutMs: 10 * 60_000,
        });
        renameSync(tmp, dir);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
      return;
    }
    await gitOk(["init", "--bare", "-q", "-b", safe(opts.branch), dir]);
  }

  async deleteRepo(id: string) {
    rmSync(this.dir(id), { recursive: true, force: true });
    this.promisors.delete(id);
  }

  private promisors = new Map<string, boolean>();

  /** Whether the repo is a partial clone whose missing blobs come from GitHub. */
  private async partial(repo: string): Promise<boolean> {
    let p = this.promisors.get(repo);
    if (p === undefined) {
      const r = await git(["config", "--get", "remote.origin.promisor"], { cwd: this.dir(repo) });
      p = r.stdout.trim() === "true";
      this.promisors.set(repo, p);
    }
    return p;
  }

  /** Sizes of the blobs that are on disk (missing ones are left out). Never downloads anything. */
  private async presentSizes(repo: string, oids: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!oids.length) return out;
    const r = await git(["cat-file", "--batch-check=%(objectname) %(objectsize)"], { cwd: this.dir(repo), env: NO_LAZY, stdin: oids.join("\n") + "\n" });
    for (const line of r.stdout.split("\n")) {
      const [oid, size] = line.split(" ");
      if (oid && size && size !== "missing") out.set(oid, Number(size));
    }
    return out;
  }

  /** Download blobs from GitHub in one fetch. Throws StoreUnavailableError if that fails. */
  private async fetchBlobs(repo: string, oids: string[]) {
    // What git's own lazy fetch runs, but for many objects at once.
    const r = await git(["-c", "fetch.negotiationAlgorithm=noop", "fetch", "origin", "--no-tags", "--no-write-fetch-head", "--recurse-submodules=no", "--filter=blob:none", "--stdin"], {
      cwd: this.dir(repo),
      env: anonymousGitEnv,
      stdin: oids.join("\n") + "\n",
      timeoutMs: 60_000,
    });
    if (r.code !== 0) throw new StoreUnavailableError(`couldn't download ${oids.length === 1 ? "the file" : `${oids.length} files`} from GitHub: ${firstError(r.stderr)}`);
  }

  /**
   * Make blobs available, downloading missing ones in chunks until FETCH_LIMITS (files, then bytes) is reached.
   * Returns the sizes of the blobs that are now on disk; the others weren't downloaded.
   */
  private async ensureBlobs(repo: string, oids: string[]): Promise<Map<string, number>> {
    const sizes = await this.presentSizes(repo, oids);
    if (!(await this.partial(repo))) return sizes;
    const missing = [...new Set(oids.filter((o) => !sizes.has(o)))].slice(0, FETCH_LIMITS.files);
    let bytes = 0;
    for (let i = 0; i < missing.length && bytes < FETCH_LIMITS.bytes; i += FETCH_CHUNK) {
      const chunk = missing.slice(i, i + FETCH_CHUNK);
      try {
        await this.fetchBlobs(repo, chunk);
      } catch (e) {
        console.error(`[localgit] ${repo}: ${(e as Error).message}`);
        break;
      }
      for (const [oid, size] of await this.presentSizes(repo, chunk)) {
        sizes.set(oid, size);
        bytes += size;
      }
    }
    return sizes;
  }

  /** Markdown blobs at a ref: [oid, path]. Reads trees only. */
  private async markdownBlobs(repo: string, ref: string): Promise<Array<[string, string]>> {
    const r = await git(["ls-tree", "-r", "-z", safe(ref)], { cwd: this.dir(repo), env: NO_LAZY });
    if (r.code !== 0) return [];
    const out: Array<[string, string]> = [];
    for (const line of r.stdout.split("\0")) {
      const tab = line.indexOf("\t");
      const [, type, oid] = line.slice(0, tab).split(" ");
      const path = line.slice(tab + 1);
      if (type === "blob" && oid && isMarkdown(path)) out.push([oid, path]);
    }
    return out;
  }

  /** Update a GitHub copy's branch from GitHub (commits and trees only; shallow copies stay shallow at the old cut). */
  async pullUpstream(repo: string, branch: string) {
    if (!(await this.partial(repo))) return;
    safe(branch);
    await gitOk(["fetch", "-q", "--no-tags", "--filter=blob:none", "origin", `+refs/heads/${branch}:refs/heads/${branch}`], {
      cwd: this.dir(repo),
      env: anonymousGitEnv,
      timeoutMs: 120_000,
    });
  }

  async head(repo: string, branch: string) {
    const r = await git(["rev-parse", "--verify", "-q", `refs/heads/${safe(branch)}`], { cwd: this.dir(repo) });
    return r.code === 0 ? r.stdout.trim() : null;
  }

  async listFiles(repo: string, ref: string) {
    const r = await git(["ls-tree", "-r", "-z", "--name-only", safe(ref)], { cwd: this.dir(repo) });
    if (r.code !== 0) return [];
    return r.stdout.split("\0").filter(Boolean);
  }

  async listFilesWithMetadata(repo: string, ref: string): Promise<FileMeta[]> {
    const cwd = this.dir(repo);
    if (await this.partial(repo)) {
      // `ls-tree -l` would download every blob one by one to learn its size. Only Markdown files are listed here;
      // a bounded batch of them is downloaded, and files that aren't on disk yet show size 0.
      const md = await this.markdownBlobs(repo, ref);
      const sizes = await this.ensureBlobs(repo, md.map(([oid]) => oid));
      return md.map(([oid, path]) => ({ path, size: sizes.get(oid) ?? 0 }));
    }
    const r = await git(["ls-tree", "-r", "-l", "-z", safe(ref)], { cwd });
    if (r.code !== 0) return [];
    // <mode> <type> <object> <size>\t<path>
    return r.stdout
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf("\t");
        const [, type, , size] = line.slice(0, tab).split(/\s+/);
        return { type, path: line.slice(tab + 1), size: Number(size) };
      })
      .filter((f) => f.type === "blob")
      .map(({ path, size }) => ({ path, size }));
  }

  /**
   * The blob at <ref>:<path>, its mode and size, downloading it first in a partial clone. Null if there's no such
   * file (or it's a folder or submodule). Downloads are bounded: a blob that can't fit in `maxBytes` throws
   * FileTooLargeError without being kept.
   */
  private async locate(repo: string, path: string, ref: string, maxBytes: number): Promise<{ oid: string; size: number; mode: string } | null> {
    const cwd = this.dir(repo);
    // ls-tree reads trees only, so "not in the tree" is told apart from "not downloaded yet".
    const r = await git(["ls-tree", "-z", safe(ref), "--", literal(path)], { cwd, env: NO_LAZY });
    if (r.code !== 0) return null;
    let entry: { mode: string; oid: string } | undefined;
    for (const line of r.stdout.split("\0")) {
      // <mode> <type> <object>\t<path>
      const tab = line.indexOf("\t");
      const [mode, type, oid] = line.slice(0, tab).split(" ");
      if (line.slice(tab + 1) === path && type === "blob" && mode && oid) entry = { mode, oid };
    }
    if (!entry) return null;
    const { oid, mode } = entry;
    let size = (await this.presentSizes(repo, [oid])).get(oid);
    if (size === undefined) {
      if (!(await this.partial(repo))) throw new StoreUnavailableError(`${path}: object ${oid} is missing`);
      // In a partial clone the first read downloads the file from GitHub.
      await this.fetchOne(repo, oid, path, maxBytes);
      size = (await this.presentSizes(repo, [oid])).get(oid);
      if (size === undefined) throw new StoreUnavailableError(`couldn't download ${path} from GitHub`);
    }
    return { oid, size, mode };
  }

  private fetching = new Map<string, Promise<void>>();
  private fetchQueues = new Map<string, Limiter>();

  /**
   * Download one blob for a read, at most FETCH_CONCURRENCY at a time per repo (and once per blob). GitHub can't
   * tell its size first (an explicitly wanted blob ignores --filter=blob:limit), so the download may only write
   * a pack of about `maxBytes`: a bigger one is cut off and deleted, and the file is too large.
   */
  private fetchOne(repo: string, oid: string, path: string, maxBytes: number): Promise<void> {
    const key = `${repo}\0${oid}\0${maxBytes}`;
    let p = this.fetching.get(key);
    if (!p) {
      let q = this.fetchQueues.get(repo);
      if (!q) this.fetchQueues.set(repo, (q = new Limiter(FETCH_CONCURRENCY)));
      p = q.run(() => this.fetchCapped(repo, oid, path, maxBytes)).finally(() => this.fetching.delete(key));
      this.fetching.set(key, p);
    }
    return p;
  }

  private async fetchCapped(repo: string, oid: string, path: string, maxBytes: number) {
    const cwd = this.dir(repo);
    // A one-blob pack is the zlib stream of the blob (at worst a little larger than the blob) plus small headers.
    const cap = Math.ceil((maxBytes + Math.ceil(maxBytes / 1000) + 4096) / 512) * 512;
    // unpackLimit=1 keeps what arrives as a pack (written by index-pack) rather than loose objects.
    const r = await git(["-c", "fetch.negotiationAlgorithm=noop", "-c", "fetch.unpackLimit=1", "-c", "transfer.unpackLimit=1", "fetch", "origin", "--no-tags", "--no-write-fetch-head", "--recurse-submodules=no", "--filter=blob:none", "--stdin"], {
      cwd,
      env: anonymousGitEnv,
      stdin: oid + "\n",
      timeoutMs: 60_000,
      maxFileBytes: cap,
    });
    if (r.code === 0) return;
    // A pack cut off at the cap (SIGXFSZ) is left behind as a tmp_pack_* file of exactly `cap` bytes.
    let cut = /signal 25\b/.test(r.stderr);
    const packs = join(cwd, "objects", "pack");
    for (const f of readdirSync(packs)) {
      if (!f.startsWith("tmp_pack_")) continue;
      try {
        if (statSync(join(packs, f)).size !== cap) continue;
        rmSync(join(packs, f), { force: true });
        cut = true;
      } catch {
        // already gone
      }
    }
    if (cut) throw new FileTooLargeError(path, cap, maxBytes);
    throw new StoreUnavailableError(`couldn't download the file from GitHub: ${firstError(r.stderr)}`);
  }

  async readFile(repo: string, path: string, ref: string) {
    const blob = await this.locate(repo, path, ref, MAX_FILE_BYTES);
    if (!blob) return null;
    if (blob.size > MAX_FILE_BYTES) throw new FileTooLargeError(path, blob.size);
    const r = await git(["cat-file", "blob", blob.oid], { cwd: this.dir(repo), env: NO_LAZY });
    if (r.code !== 0) throw new StoreUnavailableError(`couldn't read ${path}: ${r.stderr.trim()}`);
    return r.stdout;
  }

  /** Regular files only: not symlinks (whose blob is the link's target path) or submodules. */
  async readBlob(repo: string, path: string, ref: string, maxBytes: number) {
    const blob = await this.locate(repo, path, ref, maxBytes);
    if (!blob || !REGULAR_MODES.has(blob.mode)) return null;
    if (blob.size > maxBytes) throw new FileTooLargeError(path, blob.size, maxBytes);
    const r = await gitBytes(["cat-file", "blob", blob.oid], { cwd: this.dir(repo), env: NO_LAZY, timeoutMs: 60_000 });
    if (r.code !== 0) throw new StoreUnavailableError(`couldn't read ${path}: ${r.stderr.trim()}`);
    return r.stdout;
  }

  async commit(input: CommitInput): Promise<CommitOutcome> {
    const cwd = this.dir(input.repo);
    safe(input.branch);
    if (input.expectedHead) safe(input.expectedHead);
    for (const c of input.changes) safePath(c.path);
    const index = join(cwd, `index-${crypto.randomUUID()}`);
    const env = { GIT_INDEX_FILE: index };
    try {
      if (input.expectedHead) await gitOk(["read-tree", input.expectedHead], { cwd, env });
      else await gitOk(["read-tree", "--empty"], { cwd, env });
      for (const c of input.changes) {
        if (c.delete) {
          // --index-info with mode 0 removes the entry without needing a work tree (bare repo).
          await gitOk(["update-index", "--index-info"], { cwd, env, stdin: `0 ${"0".repeat(40)}\t${c.path}\n` });
        } else {
          const blob = (await gitOk(["hash-object", "-w", "--stdin"], { cwd, stdin: c.content ?? "" })).trim();
          await gitOk(["update-index", "--add", "--cacheinfo", `100644,${blob},${c.path}`], { cwd, env });
        }
      }
      // Partial clones don't have every blob the tree points at; that's fine.
      const tree = (await gitOk(["write-tree", ...((await this.partial(input.repo)) ? ["--missing-ok"] : [])], { cwd, env })).trim();
      const who = {
        GIT_AUTHOR_NAME: input.author.name,
        GIT_AUTHOR_EMAIL: input.author.email,
        GIT_COMMITTER_NAME: "Grimoire",
        GIT_COMMITTER_EMAIL: "grimoire@localhost",
      };
      const parents = input.expectedHead ? ["-p", input.expectedHead] : [];
      const sha = (await gitOk(["commit-tree", tree, ...parents, "-F", "-"], { cwd, env: who, stdin: input.message })).trim();
      // update-ref with an old value is an atomic compare-and-swap on the branch.
      const old = input.expectedHead ?? "0".repeat(40);
      const r = await git(["update-ref", `refs/heads/${input.branch}`, sha, old], { cwd });
      if (r.code !== 0) return { ok: false, reason: "conflict" };
      return { ok: true, sha };
    } finally {
      rmSync(index, { force: true });
    }
  }

  async history(repo: string, branch: string, path: string | undefined, limit: number): Promise<CommitSummary[]> {
    const fmt = ["%H", "%s", "%an", "%ae", "%aI"].join(SEP) + REC;
    const r = await git(["log", `-n${limit}`, `--format=${fmt}`, `refs/heads/${safe(branch)}`, ...(path ? ["--", literal(path)] : [])], { cwd: this.dir(repo), env: NO_LAZY });
    if (r.code !== 0) return [];
    return r.stdout
      .split(REC)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const [sha, message, authorName, authorEmail, date] = s.split(SEP);
        return { sha: sha!, message: message!, authorName: authorName!, authorEmail: authorEmail!, date: date! };
      });
  }

  async diff(repo: string, sha: string, path?: string) {
    const cwd = this.dir(repo);
    let paths = path ? [literal(path)] : MARKDOWN_PATHSPECS;
    let note = "";
    if (await this.partial(repo)) {
      // Download both sides of the changed files in bounded batches, then diff without lazy fetches (which would
      // download one blob at a time). Files that couldn't be downloaded are left out, with a note.
      const r = await git(["diff-tree", "-r", "-z", "--no-commit-id", "--root", safe(sha), "--", ...paths], { cwd, env: NO_LAZY });
      if (r.code !== 0) throw new Error(`git diff-tree failed: ${r.stderr.trim()}`);
      const parts = r.stdout.split("\0");
      const changes: Array<{ path: string; oids: string[] }> = [];
      for (let i = 0; i + 1 < parts.length; i += 2) {
        const m = /^:\d+ \d+ ([0-9a-f]+) ([0-9a-f]+) /.exec(parts[i]!);
        if (m) changes.push({ path: parts[i + 1]!, oids: [m[1]!, m[2]!].filter((o) => !/^0+$/.test(o)) });
      }
      const sizes = await this.ensureBlobs(repo, changes.flatMap((c) => c.oids));
      const ready = changes.filter((c) => c.oids.every((o) => sizes.has(o)));
      if (ready.length < changes.length) {
        note = `\n# ${changes.length - ready.length} more changed file${changes.length - ready.length === 1 ? "" : "s"} not shown (not downloaded from GitHub yet)\n`;
        paths = ready.map((c) => literal(c.path));
        if (!paths.length) return note.trimStart();
      }
    }
    const out = await gitOk(["show", "--format=", "--no-color", safe(sha), "--", ...paths], { cwd, env: NO_LAZY });
    return out + note;
  }

  async search(repo: string, ref: string, query: string, limit: number): Promise<SearchResult> {
    if (!query.trim()) return { hits: [] };
    if (await this.partial(repo)) return this.searchPartial(repo, ref, query, limit);
    const r = await git(["grep", "-z", "-n", "-I", "-i", "-F", "-e", query, safe(ref), "--", ...MARKDOWN_PATHSPECS], { cwd: this.dir(repo), env: NO_LAZY, timeoutMs: 30_000 });
    if (r.code !== 0) return { hits: [] };
    const hits: SearchHit[] = [];
    for (const line of r.stdout.split("\n")) {
      // <ref>:<path>\0<line>\0<text>
      const [path, n, text] = line.slice(ref.length + 1).split("\0");
      if (path && n && text !== undefined) hits.push({ path, line: Number(n), text });
      if (hits.length >= limit) break;
    }
    return { hits };
  }

  /** Search a partial clone: only files on disk (after a bounded download) are searched, so say when that's not all. */
  private async searchPartial(repo: string, ref: string, query: string, limit: number): Promise<SearchResult> {
    const md = await this.markdownBlobs(repo, ref);
    const sizes = await this.ensureBlobs(repo, md.map(([oid]) => oid));
    const searchable = md.filter(([oid]) => (sizes.get(oid) ?? Infinity) <= MAX_FILE_BYTES);
    const blobs = await catBlobs(this.dir(repo), [...new Set(searchable.map(([oid]) => oid))], NO_LAZY);
    const needle = query.toLowerCase();
    const hits: SearchHit[] = [];
    outer: for (const [oid, path] of searchable.sort((a, b) => (a[1] < b[1] ? -1 : 1))) {
      const text = blobs.get(oid);
      if (text === undefined || text.includes("\0")) continue;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i]!.toLowerCase().includes(needle)) continue;
        hits.push({ path, line: i + 1, text: lines[i]! });
        if (hits.length >= limit) break outer;
      }
    }
    const skipped = md.length - searchable.length;
    return skipped ? { hits, incomplete: `Searched ${searchable.length} of ${md.length} notes; the rest aren't downloaded from GitHub yet (search again to include more).` } : { hits };
  }
}

/** Runs at most `n` tasks at once, in order. */
class Limiter {
  private active = 0;
  private waiting: Array<() => void> = [];
  constructor(private n: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    // a finished task hands its slot straight to the next waiting one
    if (this.active >= this.n) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
