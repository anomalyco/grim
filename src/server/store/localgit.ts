import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { anonymousGitEnv, git, gitOk } from "./gitexec.ts";
import { isMarkdown, type CommitInput, type CommitOutcome, type CommitSummary, type FileMeta, type GitHubLink, type GitStore, type SearchHit } from "./types.ts";

/** Refs, shas and paths come from callers; never let one be read as an option or smuggle control characters. */
function safe(s: string): string {
  if (s.startsWith("-") || /[\x00-\x1f\x7f]/.test(s)) throw new Error(`invalid argument ${JSON.stringify(s)}`);
  return s;
}

const SEP = "\x1f";
const MD_PATHSPECS = ["*.md", "*.markdown", "*.mdx"];
/** Reads that may have to download a blob from GitHub first. */
const LAZY_MS = 30_000;
/** Commands run without lazy fetching: missing blobs are reported instead of downloaded one at a time. */
const NO_LAZY = { GIT_NO_LAZY_FETCH: "1" };
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
   * GitHub when first read, or in one batch for listings with sizes, search and diffs.
   */
  async createRepo(id: string, opts: { branch: string; github?: GitHubLink }) {
    const dir = this.dir(id);
    if (existsSync(dir)) return;
    if (opts.github) {
      const { owner, name, branch } = opts.github;
      // Clone next to the target and move it into place, so a failed clone leaves nothing behind.
      const tmp = `${dir}.tmp-${crypto.randomUUID()}`;
      try {
        await gitOk(["clone", "--bare", "-q", "--filter=blob:none", "--single-branch", ...(branch ? ["--branch", safe(branch)] : []), this.githubUrl(owner, name), tmp], {
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

  /** Env for commands on this repo: lazy fetches from GitHub are anonymous. */
  private async env(repo: string): Promise<Record<string, string> | undefined> {
    return (await this.partial(repo)) ? anonymousGitEnv : undefined;
  }

  /** Download the given blobs that aren't here yet, in one fetch. */
  private async ensureBlobs(repo: string, oids: string[]) {
    if (!oids.length || !(await this.partial(repo))) return;
    const cwd = this.dir(repo);
    const check = await git(["cat-file", "--batch-check=%(objectname) %(objecttype)"], { cwd, env: NO_LAZY, stdin: oids.join("\n") + "\n" });
    const missing = check.stdout.split("\n").filter((l) => l.endsWith(" missing")).map((l) => l.split(" ")[0]!);
    if (!missing.length) return;
    // What git's own lazy fetch runs, but for all of them at once.
    const r = await git(["-c", "fetch.negotiationAlgorithm=noop", "fetch", "origin", "--no-tags", "--no-write-fetch-head", "--recurse-submodules=no", "--filter=blob:none", "--stdin"], {
      cwd,
      env: anonymousGitEnv,
      stdin: missing.join("\n") + "\n",
      timeoutMs: 60_000,
    });
    if (r.code !== 0) console.error(`[localgit] ${repo}: fetching ${missing.length} blobs failed: ${r.stderr.trim()}`);
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

  /** Update a read-only GitHub repo's branch from GitHub (commits and trees only). */
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
      // `ls-tree -l` would download every blob one by one to learn its size. Only Markdown files are listed here,
      // and their blobs are fetched in one go.
      const md = await this.markdownBlobs(repo, ref);
      await this.ensureBlobs(repo, md.map(([oid]) => oid));
      const r = await git(["cat-file", "--batch-check=%(objectname) %(objectsize)"], { cwd, env: NO_LAZY, stdin: md.map(([oid]) => oid).join("\n") + "\n" });
      const sizes = new Map(r.stdout.split("\n").map((l) => l.split(" ") as [string, string]).filter(([, s]) => s && s !== "missing").map(([o, s]) => [o, Number(s)]));
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

  async readFile(repo: string, path: string, ref: string) {
    // In a partial clone this downloads the blob from GitHub the first time.
    const r = await git(["cat-file", "blob", `${safe(ref)}:${safe(path)}`], { cwd: this.dir(repo), env: await this.env(repo), timeoutMs: LAZY_MS });
    return r.code === 0 ? r.stdout : null;
  }

  async commit(input: CommitInput): Promise<CommitOutcome> {
    const cwd = this.dir(input.repo);
    safe(input.branch);
    if (input.expectedHead) safe(input.expectedHead);
    for (const c of input.changes) safe(c.path);
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
    const r = await git(["log", `-n${limit}`, `--format=${fmt}`, `refs/heads/${safe(branch)}`, ...(path ? ["--", safe(path)] : [])], { cwd: this.dir(repo), env: NO_LAZY });
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
    const paths = path ? [safe(path)] : MD_PATHSPECS;
    if (await this.partial(repo)) {
      // Fetch both sides of every changed file at once instead of one blob at a time; only Markdown is shown.
      const r = await git(["diff-tree", "-r", "-z", "--no-commit-id", "--root", safe(sha), "--", ...paths], { cwd, env: NO_LAZY });
      const oids = [...r.stdout.matchAll(/:\d+ \d+ ([0-9a-f]+) ([0-9a-f]+) /g)].flatMap((m) => [m[1]!, m[2]!]).filter((o) => !/^0+$/.test(o));
      await this.ensureBlobs(repo, oids);
      return gitOk(["show", "--format=", "--no-color", safe(sha), "--", ...paths], { cwd, env: anonymousGitEnv, timeoutMs: LAZY_MS });
    }
    return gitOk(["show", "--format=", "--no-color", safe(sha), ...(path ? ["--", safe(path)] : [])], { cwd });
  }

  async search(repo: string, ref: string, query: string, limit: number): Promise<SearchHit[]> {
    if (!query.trim()) return [];
    if (await this.partial(repo)) await this.ensureBlobs(repo, (await this.markdownBlobs(repo, ref)).map(([oid]) => oid));
    const r = await git(["grep", "-z", "-n", "-I", "-i", "-F", "-e", query, safe(ref), "--", ...MD_PATHSPECS], { cwd: this.dir(repo), env: await this.env(repo), timeoutMs: LAZY_MS });
    if (r.code !== 0) return [];
    const hits: SearchHit[] = [];
    for (const line of r.stdout.split("\n")) {
      // <ref>:<path>\0<line>\0<text>
      const [path, n, text] = line.slice(ref.length + 1).split("\0");
      if (path && n && text !== undefined) hits.push({ path, line: Number(n), text });
      if (hits.length >= limit) break;
    }
    return hits;
  }
}
