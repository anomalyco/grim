import { ApiError, GitStorage, RefUpdateError, type Repo } from "@pierre/storage";
import { blameFromVersions, REMOTE_BLAME_DEPTH, REMOTE_BLAME_PARALLEL } from "./blame.ts";
import type { Author, BlobWrite, CommitInput, CommitOutcome, CommitSummary, FileMeta, GitHubLink, GitStore, SearchHit } from "./types.ts";
import { AGENT_EMAIL, FileTooLargeError, isMarkdown, MAX_FILE_BYTES, newestSessionNames, RepoBusyError, StoreUnavailableError, withTrailers, type SearchResult } from "./types.ts";

/** Node's util.inspect.custom, which Bun.inspect also uses; a registered symbol, so it exists on Workers too. */
const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/**
 * Agent commits' full messages by commit (the commit list and blame have only the subject; the Agent-Session-Id
 * and Agent-Session-Name trailers are in the body), so each commit is read once: commits don't change.
 */
const commitMessages = new Map<string, string>();
const MAX_COMMIT_MESSAGES = 5000;
/** At most this many agent commits' messages are read per history call (newest first; cached ones don't count). */
export const MAX_MESSAGE_READS = 20;
/** firstAuthor pages through at most this many commits of a file's history (then gives up: null). */
const FIRST_AUTHOR_PAGES = 20;
const FIRST_AUTHOR_PAGE = 100;

function busy(e: unknown): never {
  if (e instanceof ApiError && e.status === 409) throw new RepoBusyError(e.message);
  throw e;
}

/**
 * The SDK keeps the private key in `options.key` of its GitStorage and of every Repo (plain enumerable fields), so
 * JSON.stringify / console.log / Bun.inspect of one would print it. Hide `options` (and the JWT signer) from those,
 * keeping them usable by the SDK, and make the objects print as a redacted stub.
 */
export function sealSecrets<T extends object>(obj: T, label: string): T {
  const o = obj as Record<string, unknown>;
  // the key itself becomes an accessor: even an inspect of `options` shows [Getter/Setter], not the PEM
  const options = o.options as Record<string, unknown> | undefined;
  if (options && typeof options.key === "string") hideValue(options, "key");
  for (const k of ["options", "generateJWT"]) {
    const d = Object.getOwnPropertyDescriptor(obj, k);
    if (d) Object.defineProperty(obj, k, { ...d, enumerable: false });
  }
  const stub = `[${label} (redacted)]`;
  Object.defineProperty(obj, "toJSON", { value: () => stub, enumerable: false, configurable: true });
  Object.defineProperty(obj, INSPECT, { value: () => stub, enumerable: false, configurable: true });
  return obj;
}

/** Turn `obj[key]` into a non-enumerable accessor over a closure: still readable and writable, never printed. */
export function hideValue(obj: object, key: string) {
  const d = Object.getOwnPropertyDescriptor(obj, key);
  if (!d || d.get) return;
  let value = d.value as unknown;
  Object.defineProperty(obj, key, { get: () => value, set: (v) => (value = v), enumerable: false, configurable: true });
}

/** Code Storage (code.storage) backend. Hosted repos, optionally synced with GitHub. */
export class CodeStorageStore implements GitStore {
  readonly kind = "codestorage" as const;
  // true private fields: TypeScript `private` ones are still enumerable (stringify/inspect would show the SDK objects)
  #client: GitStorage;
  #handles = new Map<string, Repo>();
  /** Prepended to every repo id sent to Code Storage, so deployments sharing an org (staging: "stg-") never meet. */
  readonly #prefix: string;

  constructor(opts: { org: string; key: string; apiBaseUrl?: string; storageBaseUrl?: string; repoPrefix?: string }) {
    this.#client = sealSecrets(new GitStorage({ name: opts.org, key: opts.key, apiBaseUrl: opts.apiBaseUrl, storageBaseUrl: opts.storageBaseUrl }), "GitStorage");
    this.#prefix = opts.repoPrefix ?? "";
  }

  toJSON() {
    return { kind: this.kind };
  }

  [INSPECT]() {
    return "CodeStorageStore {}";
  }

  /** The SDK handle for repo `id` (sealed; a method, not a field, so tests can stand one in). */
  private repo(id: string): Repo {
    let r = this.#handles.get(id);
    if (!r) {
      r = sealSecrets(this.#client.repo({ id: this.#prefix + id }), "Repo");
      this.#handles.set(id, r);
    }
    return r;
  }

  async createRepo(id: string, opts: { branch: string; github?: GitHubLink }) {
    const existing = await this.#client.findOne({ id: this.#prefix + id }).catch(() => null);
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
    const repo = await this.#client.createRepo({ id: this.#prefix + id, defaultBranch: opts.github?.branch ?? opts.branch, baseRepo });
    this.#handles.set(id, sealSecrets(repo, "Repo"));
    if (opts.github) await repo.pullUpstream().catch(() => {});
  }

  async deleteRepo(id: string) {
    await this.#client.deleteRepo({ id: this.#prefix + id });
    this.#handles.delete(id);
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
      committer: { name: "Grim", email: "grimoire@users.noreply.code.storage" },
      ...(input.expectedHead ? { expectedHeadSha: input.expectedHead } : {}),
    });
    for (const c of input.changes) {
      if (c.delete) builder = builder.deletePath(c.path);
      else if (c.content instanceof Uint8Array) builder = builder.addFile(c.path, c.content);
      else builder = builder.addFileFromString(c.path, c.content ?? "");
    }
    try {
      const r = await builder.send();
      return { ok: true, sha: r.commitSha };
    } catch (e) {
      // precondition_failed: the branch tip is no longer expectedHead (compare-and-swap lost).
      if (e instanceof RefUpdateError && (e.reason === "conflict" || e.reason === "precondition_failed")) return { ok: false, reason: "conflict" };
      busy(e);
    }
  }

  writeBlob(input: BlobWrite): Promise<CommitOutcome> {
    const { path, bytes, ...rest } = input;
    return this.commit({ ...rest, changes: [{ path, content: bytes }] });
  }

  async history(repo: string, branch: string, path: string | undefined, limit: number): Promise<CommitSummary[]> {
    try {
      const r = await this.repo(repo).listCommits({ branch, path, limit });
      const commits = r.commits.slice(0, limit);
      // the list has only the subject: agents' commits are read in full for their Agent-Session-Id trailer
      const agents = commits.filter((c) => AGENT_EMAIL.test(c.authorEmail)).map((c) => c.sha);
      const full = await this.messages(repo, agents, MAX_MESSAGE_READS);
      return commits.map((c) => ({ sha: c.sha, message: (full.get(c.sha) ?? c.message).replace(/\s+$/, ""), authorName: c.authorName, authorEmail: c.authorEmail, date: c.rawDate }));
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

  /**
   * The full messages of these commits: cached ones, plus up to `reads` read (the first uncached ones, in order),
   * REMOTE_BLAME_PARALLEL at a time. Commits that couldn't be read are left out.
   */
  private async messages(repo: string, shas: string[], reads = Infinity): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const todo: string[] = [];
    for (const sha of shas) {
      const m = commitMessages.get(sha);
      if (m !== undefined) out.set(sha, m);
      else if (todo.length < reads) todo.push(sha);
    }
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const sha = todo[next++]!;
        try {
          const message = (await this.repo(repo).getCommit({ sha })).commit.message;
          if (commitMessages.size >= MAX_COMMIT_MESSAGES) commitMessages.delete(commitMessages.keys().next().value!);
          commitMessages.set(sha, message);
          out.set(sha, message);
        } catch (e) {
          console.warn(`[codestorage] commit ${repo}:${sha}: ${(e as Error).message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(REMOTE_BLAME_PARALLEL, todo.length) }, worker));
    return out;
  }

  /**
   * Code Storage's blame endpoint (one request). If that fails (older servers), computed from the file's history:
   * the newest commits that changed it (up to REMOTE_BLAME_DEPTH) and its text at each, REMOTE_BLAME_PARALLEL at a
   * time, newest first, stopping at the newest version where the file didn't exist.
   */
  async blame(repo: string, path: string, ref: string): Promise<Author[] | null> {
    try {
      const r = await this.repo(repo).getBlame({ path, ref });
      const lines = [...r.lines].sort((a, b) => a.lineNumber - b.lineNumber);
      // the blame has only the summary: agents' commits are read for their session trailers
      const messages = await this.messages(repo, [...new Set(lines.filter((l) => AGENT_EMAIL.test(l.authorEmail)).map((l) => l.commitSha))]);
      return newestSessionNames(lines.map((l) => ({ author: withTrailers({ name: l.authorName, email: l.authorEmail }, messages.get(l.commitSha)), time: l.authorTime.getTime() })));
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      console.warn(`[codestorage] blame ${repo}:${path}: ${(e as Error).message}; computing it from the history`);
    }
    try {
      const commits = (await this.repo(repo).listCommits({ branch: ref, path, limit: REMOTE_BLAME_DEPTH })).commits.slice(0, REMOTE_BLAME_DEPTH);
      const versions: Array<{ text: string; author: Author } | null> = new Array(commits.length).fill(null);
      let next = 0;
      let missing = commits.length;
      const worker = async () => {
        for (let i = next++; i < missing; i = next++) {
          const c = commits[i]!;
          const text = await this.readFile(repo, path, c.sha);
          if (text === null) missing = Math.min(missing, i);
          else versions[i] = { text, author: withTrailers({ name: c.authorName, email: c.authorEmail }, c.message) };
        }
      };
      await Promise.all(Array.from({ length: Math.min(REMOTE_BLAME_PARALLEL, commits.length) }, worker));
      // newest first; stop where the file didn't exist
      const end = versions.indexOf(null);
      const kept = (end < 0 ? versions : versions.slice(0, end)) as Array<{ text: string; author: Author }>;
      if (!kept.length) return null;
      // (oldest first: a later version is newer)
      const order = new Map(kept.reverse().map((v, i) => [v.author, i]));
      return newestSessionNames(blameFromVersions(kept).map((author) => ({ author, time: order.get(author) ?? 0 })));
    } catch (e) {
      console.warn(`[codestorage] blame ${repo}:${path}: ${(e as Error).message}`);
      return null;
    }
  }

  /** The last commit of the file's history (paged, FIRST_AUTHOR_PAGE at a time, up to FIRST_AUTHOR_PAGES pages). */
  async firstAuthor(repo: string, path: string, ref: string): Promise<Author | null> {
    try {
      let cursor: string | undefined;
      let last: { authorName: string; authorEmail: string; message: string } | undefined;
      for (let page = 0; page < FIRST_AUTHOR_PAGES; page++) {
        const r = await this.repo(repo).listCommits({ branch: ref, path, limit: FIRST_AUTHOR_PAGE, ...(cursor ? { cursor } : {}) });
        last = r.commits.at(-1) ?? last;
        if (!r.hasMore || !r.nextCursor) return last ? withTrailers({ name: last.authorName, email: last.authorEmail }, last.message) : null;
        cursor = r.nextCursor;
      }
      return null;
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) console.warn(`[codestorage] first author ${repo}:${path}: ${(e as Error).message}`);
      return null;
    }
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
