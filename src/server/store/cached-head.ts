// A GitStore that remembers branch heads, so reads that start with head() don't ask the backing store (Code Storage:
// ~30 ms a call) every time. Its own successful commits move the cached head; a conflict, invalidate() (webhooks,
// pushes from elsewhere), createRepo/deleteRepo/pullUpstream drop it; head(…, { fresh: true }) re-reads (pollers).
// Everything else is passed through. Holds only shas, never backend objects.
import type { Db } from "../seams/db.ts";
import type { BlobWrite, CommitInput, CommitOutcome, GitHubLink, GitStore } from "./types.ts";

export interface CachedHeadOptions {
  /** Called when a branch's known head changes (after a commit, or a read that found a different head). */
  onHeadChange?: (repo: string, branch: string, sha: string | null) => void | Promise<void>;
  /** Re-read heads older than this. Off by default: the cache is kept up to date by commits and invalidate(). */
  maxAgeMs?: number;
  now?: () => number;
}

interface Entry {
  sha: string | null;
  at: number;
}

export class CachedHeadStore implements GitStore {
  private heads = new Map<string, Map<string, Entry>>();
  /** Last head passed to onHeadChange per repo/branch, so re-reading an unchanged head doesn't report it again. */
  private reported = new Map<string, Map<string, string | null>>();
  /** Bumped by every change to a repo's entries, so a head() read that started before one doesn't overwrite it. */
  private epochs = new Map<string, number>();
  private inflight = new Map<string, Promise<string | null>>();
  private now: () => number;

  constructor(
    private inner: GitStore,
    private opts: CachedHeadOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  get kind() {
    return this.inner.kind;
  }

  /** Forget the cached heads of `repo` (all branches): it changed outside this store. */
  invalidate(repo: string) {
    this.heads.delete(repo);
    this.bump(repo);
  }

  async head(repo: string, branch: string, opts?: { fresh?: boolean }): Promise<string | null> {
    if (!opts?.fresh) {
      const e = this.heads.get(repo)?.get(branch);
      if (e && (this.opts.maxAgeMs === undefined || this.now() - e.at < this.opts.maxAgeMs)) return e.sha;
      const pending = this.inflight.get(key(repo, branch));
      if (pending) return pending;
    }
    const epoch = this.epoch(repo);
    const read = this.inner.head(repo, branch).then((sha) => {
      if (this.epoch(repo) === epoch) this.set(repo, branch, sha);
      return sha;
    });
    if (opts?.fresh) return read;
    const k = key(repo, branch);
    this.inflight.set(k, read);
    try {
      return await read;
    } finally {
      if (this.inflight.get(k) === read) this.inflight.delete(k);
    }
  }

  async commit(input: CommitInput) {
    return this.after(input.repo, input.branch, await this.inner.commit(input));
  }
  async writeBlob(input: BlobWrite) {
    return this.after(input.repo, input.branch, await this.inner.writeBlob(input));
  }

  async createRepo(id: string, opts: { branch: string; github?: GitHubLink }) {
    this.invalidate(id);
    try {
      await this.inner.createRepo(id, opts);
    } finally {
      this.invalidate(id);
    }
  }
  async deleteRepo(id: string) {
    this.invalidate(id);
    try {
      await this.inner.deleteRepo(id);
    } finally {
      this.invalidate(id);
      this.reported.delete(id);
    }
  }
  async pullUpstream(repo: string, branch: string) {
    try {
      await this.inner.pullUpstream?.(repo, branch);
    } finally {
      this.invalidate(repo);
    }
  }

  listFiles(repo: string, ref: string) {
    return this.inner.listFiles(repo, ref);
  }
  async listFilesWithMetadata(repo: string, ref: string) {
    if (this.inner.listFilesWithMetadata) return this.inner.listFilesWithMetadata(repo, ref);
    return (await this.inner.listFiles(repo, ref)).map((path) => ({ path, size: 0 }));
  }
  readFile(repo: string, path: string, ref: string) {
    return this.inner.readFile(repo, path, ref);
  }
  readBlob(repo: string, path: string, ref: string, maxBytes: number) {
    return this.inner.readBlob(repo, path, ref, maxBytes);
  }
  history(repo: string, branch: string, path: string | undefined, limit: number) {
    return this.inner.history(repo, branch, path, limit);
  }
  diff(repo: string, sha: string, path?: string) {
    return this.inner.diff(repo, sha, path);
  }
  search(repo: string, ref: string, query: string, limit: number) {
    return this.inner.search(repo, ref, query, limit);
  }
  async blame(repo: string, path: string, ref: string) {
    return (await this.inner.blame?.(repo, path, ref)) ?? null;
  }

  private after(repo: string, branch: string, out: CommitOutcome): CommitOutcome {
    this.bump(repo);
    if (out.ok) this.set(repo, branch, out.sha);
    else this.heads.get(repo)?.delete(branch);
    return out;
  }

  private set(repo: string, branch: string, sha: string | null) {
    let m = this.heads.get(repo);
    if (!m) this.heads.set(repo, (m = new Map()));
    m.set(branch, { sha, at: this.now() });
    let r = this.reported.get(repo);
    if (!r) this.reported.set(repo, (r = new Map()));
    if (r.has(branch) && r.get(branch) === sha) return;
    r.set(branch, sha);
    const cb = this.opts.onHeadChange;
    if (!cb) return;
    try {
      void Promise.resolve(cb(repo, branch, sha)).catch(() => {});
    } catch {}
  }

  private epoch(repo: string) {
    return this.epochs.get(repo) ?? 0;
  }
  private bump(repo: string) {
    this.epochs.set(repo, this.epoch(repo) + 1);
    for (const k of this.inflight.keys()) if (k.startsWith(`${repo}\0`)) this.inflight.delete(k);
  }
}

const key = (repo: string, branch: string) => `${repo}\0${branch}`;

export interface RepoHeadWriter {
  (repo: string, branch: string, sha: string | null): Promise<void>;
  /** Write every head still waiting for its interval now (tests, shutdown). */
  flush(): Promise<void>;
}

/**
 * An `onHeadChange` for CachedHeadStore that records heads in `repos.head`, so the workspace list reads them from the
 * Db instead of asking the store for each workspace. Writes only a changed sha, at most once per `minIntervalMs` per
 * repo and branch: changes inside the interval are coalesced into one write of the latest at its end. Only the
 * workspace's own branch is written (the UPDATE matches `branch`), and an unchanged column isn't rewritten.
 */
export function repoHeadWriter(db: Db, opts: { minIntervalMs?: number; now?: () => number } = {}): RepoHeadWriter {
  const minIntervalMs = opts.minIntervalMs ?? 5_000;
  const now = opts.now ?? Date.now;
  const state = new Map<string, { written?: string | null; at: number; latest: string | null; timer?: ReturnType<typeof setTimeout> }>();

  const write = async (repo: string, branch: string) => {
    const s = state.get(key(repo, branch))!;
    if (s.timer) clearTimeout(s.timer);
    s.timer = undefined;
    const sha = s.latest;
    if (s.written === sha) return;
    s.written = sha;
    s.at = now();
    try {
      await db.run("UPDATE repos SET head = ? WHERE id = ? AND branch = ? AND head IS NOT ?", sha, repo, branch, sha);
    } catch {
      if (s.written === sha) s.written = undefined;
    }
  };

  const onHeadChange = (async (repo, branch, sha) => {
    const k = key(repo, branch);
    let s = state.get(k);
    if (!s) state.set(k, (s = { at: -Infinity, latest: sha }));
    s.latest = sha;
    if (s.written === sha) {
      if (s.timer) clearTimeout(s.timer);
      s.timer = undefined;
      return;
    }
    if (s.timer) return;
    const wait = s.at + minIntervalMs - now();
    if (wait <= 0) return write(repo, branch);
    s.timer = setTimeout(() => void write(repo, branch), wait);
    (s.timer as { unref?: () => void }).unref?.();
  }) as RepoHeadWriter;

  onHeadChange.flush = async () => {
    await Promise.all(
      [...state].filter(([, s]) => s.timer).map(([k]) => {
        const [repo, branch] = k.split("\0") as [string, string];
        return write(repo, branch);
      }),
    );
  };
  return onHeadChange;
}
