import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CommitInput, CommitOutcome, CommitSummary, GitStore, SearchHit } from "./types.ts";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function git(args: string[], opts: { cwd?: string; env?: Record<string, string>; stdin?: string } = {}): Promise<RunResult> {
  // quotepath=false: print non-ASCII paths verbatim instead of quoted octal escapes.
  const proc = Bun.spawn(["git", "-c", "core.quotepath=false", ...args], {
    cwd: opts.cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
    stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

async function gitOk(args: string[], opts: Parameters<typeof git>[1] = {}): Promise<string> {
  const r = await git(args, opts);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

/** Refs, shas and paths come from callers; never let one be read as an option or smuggle control characters. */
function safe(s: string): string {
  if (s.startsWith("-") || /[\x00-\x1f\x7f]/.test(s)) throw new Error(`invalid argument ${JSON.stringify(s)}`);
  return s;
}

const SEP = "\x1f";
const REC = "\x1e";

/** Bare repositories on local disk. Used for development and tests when Code Storage isn't configured. */
export class LocalGitStore implements GitStore {
  readonly kind = "local" as const;
  constructor(private root: string) {
    mkdirSync(root, { recursive: true });
  }

  private dir(repo: string) {
    if (!/^[A-Za-z0-9._-]+$/.test(repo)) throw new Error(`invalid repo id ${repo}`);
    return join(this.root, `${repo}.git`);
  }

  async createRepo(id: string, opts: { branch: string; github?: { owner: string; name: string; branch?: string } }) {
    const dir = this.dir(id);
    if (existsSync(dir)) return;
    if (opts.github) {
      const url = `https://github.com/${opts.github.owner}/${opts.github.name}.git`;
      await gitOk(["clone", "--bare", "--single-branch", ...(opts.github.branch ? ["--branch", opts.github.branch] : []), url, dir]);
      return;
    }
    await gitOk(["init", "--bare", "-q", "-b", safe(opts.branch), dir]);
  }

  async deleteRepo(id: string) {
    rmSync(this.dir(id), { recursive: true, force: true });
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

  async readFile(repo: string, path: string, ref: string) {
    const r = await git(["cat-file", "blob", `${safe(ref)}:${safe(path)}`], { cwd: this.dir(repo) });
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
      const tree = (await gitOk(["write-tree"], { cwd, env })).trim();
      const who = {
        GIT_AUTHOR_NAME: input.author.name,
        GIT_AUTHOR_EMAIL: input.author.email,
        GIT_COMMITTER_NAME: "Notepad",
        GIT_COMMITTER_EMAIL: "notepad@localhost",
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
    const r = await git(["log", `-n${limit}`, `--format=${fmt}`, `refs/heads/${safe(branch)}`, ...(path ? ["--", safe(path)] : [])], { cwd: this.dir(repo) });
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
    return gitOk(["show", "--format=", "--no-color", safe(sha), ...(path ? ["--", safe(path)] : [])], { cwd: this.dir(repo) });
  }

  async search(repo: string, ref: string, query: string, limit: number): Promise<SearchHit[]> {
    if (!query.trim()) return [];
    const r = await git(["grep", "-z", "-n", "-I", "-i", "-F", "-e", query, safe(ref), "--", "*.md", "*.markdown", "*.mdx"], { cwd: this.dir(repo) });
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
