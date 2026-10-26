import { ApiError, GitStorage, RefUpdateError, type Repo } from "@pierre/storage";
import type { CommitInput, CommitOutcome, CommitSummary, FileMeta, GitHubLink, GitStore, SearchHit } from "./types.ts";
import { FileTooLargeError, isMarkdown, MAX_FILE_BYTES, RepoBusyError, StoreUnavailableError, type SearchResult } from "./types.ts";

function busy(e: unknown): never {
  if (e instanceof ApiError && e.status === 409) throw new RepoBusyError(e.message);
  throw e;
}

/** Code Storage (code.storage) backend. Hosted repos, optionally synced with GitHub. */
export class CodeStorageStore implements GitStore {
  readonly kind = "codestorage" as const;
  private client: GitStorage;
  private handles = new Map<string, Repo>();

  constructor(opts: { org: string; key: string; apiBaseUrl?: string; storageBaseUrl?: string }) {
    this.client = new GitStorage({ name: opts.org, key: opts.key, apiBaseUrl: opts.apiBaseUrl, storageBaseUrl: opts.storageBaseUrl });
  }

  private repo(id: string): Repo {
    let r = this.handles.get(id);
    if (!r) {
      r = this.client.repo({ id });
      this.handles.set(id, r);
    }
    return r;
  }

  async createRepo(id: string, opts: { branch: string; github?: GitHubLink }) {
    const existing = await this.client.findOne({ id }).catch(() => null);
    if (existing) return;
    const baseRepo = opts.github
      ? {
          provider: "github" as const,
          owner: opts.github.owner,
          name: opts.github.name,
          defaultBranch: opts.github.branch,
          ...(opts.github.publicReadOnly ? { auth: { authType: "public" as const } } : {}),
        }
      : undefined;
    const repo = await this.client.createRepo({ id, defaultBranch: opts.github?.branch ?? opts.branch, baseRepo });
    this.handles.set(id, repo);
    if (opts.github) await repo.pullUpstream().catch(() => {});
  }

  async deleteRepo(id: string) {
    await this.client.deleteRepo({ id });
    this.handles.delete(id);
  }

  async head(repo: string, branch: string) {
    try {
      const r = await this.repo(repo).listCommits({ branch, limit: 1 });
      return r.commits[0]?.sha ?? null;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      busy(e);
    }
  }

  async listFiles(repo: string, ref: string) {
    const out: string[] = [];
    let cursor: string | undefined;
    try {
      do {
        const r = await this.repo(repo).listFiles({ ref, recursive: true, cursor, limit: 1000 });
        // Older servers send only `paths` (files), no typed `entries`.
        if (r.entries.length) out.push(...r.entries.filter((e) => e.type === "blob").map((e) => e.path));
        else out.push(...r.paths);
        cursor = r.hasMore ? r.nextCursor : undefined;
      } while (cursor);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return out;
      busy(e);
    }
    return out;
  }

  async listFilesWithMetadata(repo: string, ref: string): Promise<FileMeta[]> {
    const out: FileMeta[] = [];
    let cursor: string | undefined;
    try {
      do {
        const r = await this.repo(repo).listFilesWithMetadata({ ref, cursor, limit: 1000 });
        for (const f of r.files) {
          if (f.type && f.type !== "blob") continue;
          out.push({ path: f.path, size: f.size, date: r.commits[f.lastCommitSha]?.rawDate });
        }
        cursor = r.hasMore ? r.nextCursor : undefined;
      } while (cursor);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return out;
      busy(e);
    }
    return out;
  }

  async readFile(repo: string, path: string, ref: string) {
    try {
      const res = await this.repo(repo).getFileStream({ path, ref });
      const length = Number(res.headers.get("content-length"));
      if (length > MAX_FILE_BYTES) {
        await res.body?.cancel();
        throw new FileTooLargeError(path, length);
      }
      const text = await res.text();
      if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new FileTooLargeError(path, Buffer.byteLength(text));
      return text;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      busy(e);
    }
  }

  /**
   * Regular files only (the file listing has entry modes; symlinks and submodules are refused). A path the API
   * rejects or doesn't have is null; other API or network failures are StoreUnavailableError.
   */
  async readBlob(repo: string, path: string, ref: string, maxBytes: number) {
    try {
      const [res, regular] = await Promise.all([this.repo(repo).getFileStream({ path, ref }), this.isRegularFile(repo, path, ref)]);
      if (!regular) {
        await res.body?.cancel();
        return null;
      }
      return await readCapped(res, path, maxBytes);
    } catch (e) {
      if (e instanceof FileTooLargeError) throw e;
      if (e instanceof ApiError && (e.status === 400 || e.status === 404)) return null;
      if (e instanceof ApiError && e.status === 409) busy(e);
      throw new StoreUnavailableError(`couldn't read ${path}: ${(e as Error).message}`);
    }
  }

  /** False if the path's tree entry is a symlink or submodule. Unknown (not listed, older servers) counts as a file. */
  private async isRegularFile(repo: string, path: string, ref: string): Promise<boolean> {
    const slash = path.lastIndexOf("/");
    const dir = slash < 0 ? "" : path.slice(0, slash);
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const r = await this.repo(repo).listFiles({ ref, path: dir || undefined, recursive: false, cursor, limit: 1000 });
      // entry paths may be relative to the listed folder or to the repo
      const e = r.entries.find((e) => e.path === path || (dir && `${dir}/${e.path}` === path));
      if (e) return e.type === "blob" && (!e.mode || e.mode === "100644" || e.mode === "100755");
      if (!r.hasMore || !r.nextCursor) break;
      cursor = r.nextCursor;
    }
    return true;
  }

  async commit(input: CommitInput): Promise<CommitOutcome> {
    let builder = this.repo(input.repo).createCommit({
      targetBranch: input.branch,
      commitMessage: input.message,
      author: input.author,
      committer: { name: "Grimoire", email: "grimoire@users.noreply.code.storage" },
      ...(input.expectedHead ? { expectedHeadSha: input.expectedHead } : {}),
    });
    for (const c of input.changes) builder = c.delete ? builder.deletePath(c.path) : builder.addFileFromString(c.path, c.content ?? "");
    try {
      const r = await builder.send();
      return { ok: true, sha: r.commitSha };
    } catch (e) {
      // precondition_failed: the branch tip is no longer expectedHead (compare-and-swap lost).
      if (e instanceof RefUpdateError && (e.reason === "conflict" || e.reason === "precondition_failed")) return { ok: false, reason: "conflict" };
      busy(e);
    }
  }

  async history(repo: string, branch: string, path: string | undefined, limit: number): Promise<CommitSummary[]> {
    try {
      const r = await this.repo(repo).listCommits({ branch, path, limit });
      return r.commits.map((c) => ({ sha: c.sha, message: c.message.split("\n")[0] ?? "", authorName: c.authorName, authorEmail: c.authorEmail, date: c.rawDate }));
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return [];
      busy(e);
    }
  }

  async diff(repo: string, sha: string, path?: string) {
    try {
      const r = await this.repo(repo).getCommitDiff({ sha, paths: path ? [path] : undefined });
      // Only Markdown is shown, like the local store.
      return r.files.filter((f) => path || isMarkdown(f.path)).map((f) => f.raw).join("\n");
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return "";
      busy(e);
    }
  }

  async search(repo: string, ref: string, query: string, limit: number): Promise<SearchResult> {
    if (!query.trim()) return { hits: [] };
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let r;
    try {
      r = await this.repo(repo).grep({
        ref,
        query: { pattern: escaped, caseSensitive: false },
        fileFilters: { extensionFilters: ["md", "markdown", "mdx"] },
        limits: { maxLines: limit },
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return { hits: [] };
      busy(e);
    }
    const hits: SearchHit[] = [];
    for (const m of r.matches) for (const l of m.lines) if (l.type === "match") hits.push({ path: m.path, line: l.lineNumber, text: l.text });
    return { hits: hits.slice(0, limit) };
  }

  async pullUpstream(repo: string, _branch: string) {
    // Callers decide what a failure means: the periodic refresh logs it once, a manual refresh reports it.
    await this.repo(repo).pullUpstream();
  }
}

/** A response body as bytes, read into one buffer (sized by content-length when sent), refusing more than `maxBytes`. */
async function readCapped(res: Response, path: string, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const length = Number(res.headers.get("content-length") ?? NaN);
  if (length > maxBytes) {
    await res.body?.cancel();
    throw new FileTooLargeError(path, length, maxBytes);
  }
  let buf = new Uint8Array(Number.isInteger(length) && length >= 0 ? length : Math.min(maxBytes, 64 * 1024));
  let total = 0;
  if (res.body) {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      // throwing out of the loop cancels the stream
      if (total + chunk.byteLength > maxBytes) throw new FileTooLargeError(path, total + chunk.byteLength, maxBytes);
      if (total + chunk.byteLength > buf.length) {
        const grown = new Uint8Array(Math.min(maxBytes, Math.max(buf.length * 2, total + chunk.byteLength)));
        grown.set(buf.subarray(0, total));
        buf = grown;
      }
      buf.set(chunk, total);
      total += chunk.byteLength;
    }
  }
  return total === buf.length ? buf : buf.slice(0, total);
}
