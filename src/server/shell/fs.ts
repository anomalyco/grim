// The agent shell's view of the notes: /workspace/<repo>/<path>.md over live rooms and Git, plus a private /tmp.
import { posix } from "node:path";
import { DefenseInDepthBox, InMemoryFs, MountableFs } from "just-bash";
import type { BufferEncoding, CpOptions, FileContent, FsStat, IFileSystem, MkdirOptions, RmOptions } from "just-bash";
import type { Access } from "../auth.ts";
import * as ops from "../ops.ts";
import { OpError, type Ctx } from "../ops.ts";
import { cleanPath, listRepoRows, type RepoRow } from "../repos.ts";
import type { Participant } from "../rooms.ts";
import { isMarkdown, type FileMeta } from "../store/types.ts";

type ReadFileOptions = { encoding?: BufferEncoding | null };
type WriteFileOptions = { encoding?: BufferEncoding };
type DirentEntry = { name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean };

export type AccessFn = (repo: RepoRow) => Promise<Access>;

export const WORKSPACE = "/workspace";
/** Redirect targets the session uses to collect a command's output statement by statement. */
export const CAPTURE = { stdout: "/dev/grimoire-stdout", stderr: "/dev/grimoire-stderr" } as const;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Text each session remembers as "what the agent last read", for 3-way merges of later writes. */
const MAX_LAST_READ_BYTES = 8 * 1024 * 1024;
const MD_HINT = "only Markdown files (.md, .markdown, .mdx) can be stored in /workspace; use /tmp for other files";

export class FsError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

const key = (repo: string, path: string) => `${repo}\0${path}`;

/** Committed file contents by repo, commit and path. Contents at a commit never change, so this is shared. */
const blobCache = new Map<string, string>();
let blobBytes = 0;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;

function cacheBlob(k: string, content: string) {
  if (blobCache.has(k)) return;
  blobCache.set(k, content);
  blobBytes += content.length;
  for (const [old, v] of blobCache) {
    if (blobBytes <= MAX_CACHE_BYTES) break;
    blobCache.delete(old);
    blobBytes -= v.length;
  }
}

/** File sizes and dates by repo and commit (one listing per commit), and the date of each commit. */
const metaCache = new Map<string, Promise<Map<string, FileMeta>>>();
const commitDates = new Map<string, Promise<Date>>();

function bounded<V>(m: Map<string, V>, k: string, make: () => V): V {
  let v = m.get(k);
  if (v === undefined) {
    if (m.size >= 200) m.delete(m.keys().next().value!);
    v = make();
    m.set(k, v);
  }
  return v;
}

/** Split an absolute shell path into repo and path under /workspace. Throws on control characters and .git. */
export function workspacePath(abs: string): { repo?: string; path: string } | null {
  if (/[\x00-\x1f\x7f]/.test(abs)) throw new FsError("EINVAL", `invalid path '${abs}'`);
  const norm = posix.resolve("/", abs);
  if (norm !== WORKSPACE && !norm.startsWith(WORKSPACE + "/")) return null;
  const parts = norm.slice(WORKSPACE.length).split("/").filter(Boolean);
  if (parts.some((s) => s.toLowerCase().startsWith(".git"))) throw new FsError("EACCES", `permission denied '${norm}'`);
  return parts.length ? { repo: parts[0], path: parts.slice(1).join("/") } : { path: "" };
}

/** Whether a repo-relative path is a valid note path (Markdown, already normalized). */
export const isNotePath = (p: string) => isMarkdown(p) && cleanPath(p) === p;

const utf8 = new TextDecoder("utf-8", { fatal: true });

function toText(content: FileContent, options?: WriteFileOptions | BufferEncoding): string {
  const enc = typeof options === "string" ? options : options?.encoding;
  let bytes: Uint8Array | null = null;
  if (content instanceof Uint8Array) bytes = content;
  else if (enc === "binary" || enc === "latin1" || enc === "base64" || enc === "hex") bytes = Buffer.from(content, enc);
  let text: string;
  try {
    text = bytes ? utf8.decode(bytes) : (content as string);
  } catch {
    throw new FsError("EINVAL", "binary content can't be stored in a note; use /tmp");
  }
  if (text.includes("\0")) throw new FsError("EINVAL", "binary content can't be stored in a note; use /tmp");
  return text;
}

function encodeText(text: string, options?: ReadFileOptions | BufferEncoding): string {
  const enc = typeof options === "string" ? options : options?.encoding;
  if (enc === "binary" || enc === "latin1" || enc === "base64" || enc === "hex") return Buffer.from(text, "utf8").toString(enc);
  return text;
}

const stat = (kind: "file" | "dir", size: number, mtime: Date): FsStat => ({
  isFile: kind === "file",
  isDirectory: kind === "dir",
  isSymbolicLink: false,
  mode: kind === "file" ? 0o644 : 0o755,
  size,
  mtime,
});

interface Pending {
  repo: RepoRow;
  path: string;
  /** The text this write is based on: what the agent last read, else the text when first touched (null: new file). */
  base: string | null;
  content: string;
  /** Text appended so far, while this command has only appended (applied at the live end, not as a diff). */
  appended: string | null;
}

interface RepoIndex {
  files: Set<string>;
  dirs: Set<string>;
}

/**
 * The /workspace mount. Paths it receives are relative to the mount ("/notes/a.md"). Writes are collected while a
 * command runs and applied to the live rooms by `sync()` (as minimal edits attributed to the actor), so a shell
 * redirect's truncate-then-write never reaches people's editors as a delete-all and retype, and an unfinished
 * command's writes can be dropped (`discard()`).
 */
export class NotesFs implements IFileSystem {
  private pending = new Map<string, Pending>();
  /** Text of each file as the agent last read (or wrote) it, across commands. */
  private lastRead = new Map<string, string>();
  private lastReadBytes = 0;
  /** Directories made with mkdir that have no files yet, as "repo/dir". */
  private dirs = new Set<string>();
  /** Files this session changed that may still be uncommitted, as "repo\0path" (for `save` without arguments). */
  readonly written = new Set<string>();
  private repoCache: Map<string, { row: RepoRow; access: Access }> | null = null;
  private heads = new Map<string, Promise<string | null>>();
  private index = new Map<string, Promise<RepoIndex>>();
  /** Write errors of the current command; some built-ins (sed -i, tee) replace them with a generic message. */
  private writeErrors = new Set<string>();

  constructor(
    readonly ctx: Ctx,
    readonly actor: Participant,
    /** Replaceable, so a session picks up the caller's current permissions. */
    public access: AccessFn,
  ) {}

  /** Forget per-command caches (repos, access, branch tips, listings) so each command sees fresh state. */
  beginExec() {
    this.repoCache = null;
    this.writeErrors.clear();
    this.invalidate();
  }

  /** Forget branch tips and listings, after something may have changed them. */
  invalidate(repo?: string) {
    if (repo) {
      this.heads.delete(repo);
      this.index.delete(repo);
    } else {
      this.heads.clear();
      this.index.clear();
    }
  }

  // ---- repos ----

  async repos(): Promise<Map<string, { row: RepoRow; access: Access }>> {
    if (this.repoCache) return this.repoCache;
    const out = new Map<string, { row: RepoRow; access: Access }>();
    for (const row of listRepoRows()) {
      if (row.status !== "ready") continue;
      let access = await this.access(row);
      if (access === "write" && row.read_only) access = "read";
      if (access !== "none") out.set(row.id, { row, access });
    }
    this.repoCache = out;
    return out;
  }

  async repo(id: string) {
    return (await this.repos()).get(id);
  }

  head(repo: RepoRow) {
    let h = this.heads.get(repo.id);
    if (!h) {
      h = this.ctx.store.head(repo.id, repo.branch);
      this.heads.set(repo.id, h);
      h.catch(() => this.heads.delete(repo.id));
    }
    return h;
  }

  private repoIndex(repo: RepoRow): Promise<RepoIndex> {
    let ix = this.index.get(repo.id);
    if (!ix) {
      ix = (async () => {
        const files = new Set(await this.ctx.repos.tree(repo));
        for (const r of this.ctx.rooms.inRepo(repo.id)) files.add(r.path);
        for (const p of this.pending.values()) if (p.repo.id === repo.id) files.add(p.path);
        const out: RepoIndex = { files, dirs: new Set() };
        for (const f of files) addParents(out.dirs, f);
        return out;
      })();
      this.index.set(repo.id, ix);
      ix.catch(() => this.index.delete(repo.id));
    }
    return ix;
  }

  /** Every file in a repo: committed, open in a room (maybe not committed yet) and written by this command. */
  async files(repo: RepoRow): Promise<Set<string>> {
    return (await this.repoIndex(repo)).files;
  }

  /** Whether `path` is a directory in the repo (from file paths, or made with mkdir in this session). */
  async isDir(repo: RepoRow, path: string): Promise<boolean> {
    if (!path || (await this.repoIndex(repo)).dirs.has(path)) return true;
    const k = `${repo.id}/${path}`;
    for (const d of this.dirs) if (d === k || d.startsWith(k + "/")) return true;
    return false;
  }

  // ---- paths ----

  private full(p: string) {
    return p === "/" ? WORKSPACE : WORKSPACE + p;
  }

  private loc(p: string) {
    return workspacePath(this.full(p))!;
  }

  private async node(l: { repo?: string; path: string }): Promise<{ kind: "file" | "dir"; repo?: RepoRow } | null> {
    if (!l.repo) return { kind: "dir" };
    const r = await this.repo(l.repo);
    if (!r) return null;
    if (!l.path) return { kind: "dir", repo: r.row };
    if ((await this.files(r.row)).has(l.path)) return { kind: "file", repo: r.row };
    return (await this.isDir(r.row, l.path)) ? { kind: "dir", repo: r.row } : null;
  }

  private async need(p: string, op: string) {
    const l = this.loc(p);
    const n = await this.node(l);
    if (!n) throw new FsError("ENOENT", `no such file or directory, ${op} '${this.full(p)}'`);
    return { path: l.path, kind: n.kind, repo: n.repo };
  }

  /** The repo of a path the actor may change, or an error saying why not. */
  private async writableRepo(p: string, op: string, l = this.loc(p)): Promise<RepoRow> {
    if (!l.repo) throw new FsError("EACCES", `permission denied, ${op} '${this.full(p)}' (files go inside a repo: /workspace/<repo>/<file>.md; run \`repos\` to list them)`);
    const r = await this.repo(l.repo);
    if (!r) throw new FsError("ENOENT", `no such file or directory, ${op} '${this.full(p)}' (no repo named ${l.repo}; run \`repos\`)`);
    if (r.access !== "write") throw new FsError("EROFS", `read-only file system, ${op} '${this.full(p)}' (${l.repo} is read-only for you)`);
    return r.row;
  }

  /** Check that `p` may be written as a note and return its repo and path. */
  private async writableFile(p: string, op: string): Promise<{ repo: RepoRow; path: string }> {
    const l = this.loc(p);
    if (l.repo && !l.path && (await this.repo(l.repo))) throw new FsError("EISDIR", `illegal operation on a directory, ${op} '${this.full(p)}'`);
    const repo = await this.writableRepo(p, op, l);
    if (!isNotePath(l.path)) throw new FsError("EACCES", `permission denied, ${op} '${this.full(p)}' (${MD_HINT})`);
    return { repo, path: l.path };
  }

  // ---- contents ----

  /** Current text of a file: what this command wrote, else the live room, else the branch tip. */
  async text(repo: RepoRow, path: string): Promise<string | null> {
    const pend = this.pending.get(key(repo.id, path));
    if (pend) return pend.content;
    return this.liveText(repo, path);
  }

  private async liveText(repo: RepoRow, path: string): Promise<string | null> {
    const room = this.ctx.rooms.peek(repo.id, path);
    if (room) return room.text.toString();
    const head = await this.head(repo);
    if (!head) return null;
    const k = `${repo.id}\0${head}\0${path}`;
    const hit = blobCache.get(k);
    if (hit !== undefined) return hit;
    const content = await this.ctx.store.readFile(repo.id, path, head);
    if (content !== null) cacheBlob(k, content);
    return content;
  }

  /** Size and date of a file without downloading it when possible. */
  private async meta(repo: RepoRow, path: string): Promise<{ size: number; mtime: Date }> {
    const k = key(repo.id, path);
    const live = this.pending.get(k)?.content ?? this.ctx.rooms.peek(repo.id, path)?.text.toString();
    if (live !== undefined) return { size: Buffer.byteLength(live), mtime: new Date() };
    const head = await this.head(repo);
    if (!head) return { size: 0, mtime: new Date() };
    const cached = blobCache.get(`${repo.id}\0${head}\0${path}`);
    const listed = await this.listing(repo, head);
    const m = listed?.get(path);
    const size = cached !== undefined ? Buffer.byteLength(cached) : (m?.size ?? 0);
    return { size, mtime: m?.date ? new Date(m.date) : await this.commitDate(repo, head) };
  }

  private listing(repo: RepoRow, head: string) {
    const list = this.ctx.store.listFilesWithMetadata?.bind(this.ctx.store);
    if (!list) return null;
    return bounded(metaCache, `${repo.id}\0${head}`, () => {
      const p = list(repo.id, head).then((files) => new Map(files.map((f) => [f.path, f])));
      p.catch(() => metaCache.delete(`${repo.id}\0${head}`));
      return p;
    }).catch(() => null);
  }

  private commitDate(repo: RepoRow, head: string) {
    return bounded(commitDates, `${repo.id}\0${head}`, () =>
      this.ctx.store
        .history(repo.id, repo.branch, undefined, 1)
        .then(([last]) => (last ? new Date(last.date) : new Date()))
        .catch(() => new Date()),
    );
  }

  private remember(k: string, text: string | undefined) {
    const old = this.lastRead.get(k);
    if (old !== undefined) {
      this.lastRead.delete(k);
      this.lastReadBytes -= old.length;
    }
    if (text === undefined) return;
    this.lastRead.set(k, text);
    this.lastReadBytes += text.length;
    for (const [oldKey, v] of this.lastRead) {
      if (this.lastReadBytes <= MAX_LAST_READ_BYTES) break;
      this.lastRead.delete(oldKey);
      this.lastReadBytes -= v.length;
    }
  }

  private async readText(p: string, op = "open"): Promise<string> {
    const n = await this.need(p, op);
    if (n.kind === "dir") throw new FsError("EISDIR", `illegal operation on a directory, read '${this.full(p)}'`);
    const k = key(n.repo!.id, n.path);
    const pend = this.pending.get(k);
    if (pend) return pend.content;
    const t = await this.liveText(n.repo!, n.path);
    if (t === null) throw new FsError("ENOENT", `no such file or directory, ${op} '${this.full(p)}'`);
    this.remember(k, t);
    return t;
  }

  private async put(p: string, op: string, mode: "write" | "append", text: string) {
    const { repo, path } = await this.writableFile(p, op);
    const n = await this.node({ repo: repo.id, path });
    if (n?.kind === "dir") throw new FsError("EISDIR", `illegal operation on a directory, ${op} '${this.full(p)}'`);
    const k = key(repo.id, path);
    let pend = this.pending.get(k);
    if (!pend) {
      const cur = n ? await this.liveText(repo, path) : null;
      // An overwrite is based on what the agent last saw; an append extends the text as it is now.
      const base = mode === "write" ? (cur === null ? null : (this.lastRead.get(k) ?? cur)) : cur;
      pend = { repo, path, base, content: cur ?? "", appended: mode === "append" && cur !== null ? "" : null };
    }
    const content = mode === "write" ? text : pend.content + text;
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new FsError("EFBIG", `file too large, ${op} '${this.full(p)}' (max ${MAX_FILE_BYTES / 1024 / 1024} MB per note)`);
    const appended = mode === "append" && pend.appended !== null ? pend.appended + text : null;
    this.pending.set(k, { ...pend, content, appended });
    const ix = await this.repoIndex(repo);
    ix.files.add(path);
    addParents(ix.dirs, path);
  }

  /**
   * Apply pending writes to the rooms (people see them live; the room commits after its quiet period).
   * Returns error messages for writes that could not be applied. `only` limits it to some "repo\0path" keys.
   */
  async sync(only?: (key: string) => boolean): Promise<string[]> {
    const errors: string[] = [];
    for (const [k, p] of [...this.pending]) {
      if (only && !only(k)) continue;
      this.pending.delete(k);
      try {
        if (p.base === null) await ops.createFile(this.ctx, p.repo, p.path, p.content, this.actor);
        else if (p.appended !== null) {
          if (p.appended) await ops.appendText(this.ctx, p.repo, p.path, p.appended, this.actor);
        } else if (p.content !== p.base) await ops.patchFile(this.ctx, p.repo, p.path, p.base, p.content, this.actor);
        else continue;
        this.remember(k, p.content);
        this.written.add(k);
      } catch (e) {
        this.invalidate(p.repo.id);
        errors.push(`${WORKSPACE}/${p.repo.id}/${p.path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return errors;
  }

  /** Drop the pending writes of a command that didn't finish. */
  discard() {
    if (!this.pending.size) return;
    this.pending.clear();
    this.invalidate();
  }

  private async syncOrThrow(only: (key: string) => boolean) {
    const errors = await this.sync(only);
    if (errors.length) throw new FsError("EIO", errors.join("; "));
  }

  private opError(e: unknown, op: string, p: string): never {
    if (e instanceof OpError) {
      const code = e.status === 404 ? "ENOENT" : e.status === 403 ? "EROFS" : e.status === 409 ? "EBUSY" : "EIO";
      throw new FsError(code, `${e.message}, ${op} '${this.full(p)}'`);
    }
    throw e;
  }

  /** Write errors since the command started (and forget them). */
  takeWriteErrors(): string[] {
    const out = [...this.writeErrors];
    this.writeErrors.clear();
    return out;
  }

  private async noting(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      if (e instanceof FsError && e.code !== "ENOENT") this.writeErrors.add(e.message);
      throw e;
    }
  }

  // ---- IFileSystem ----

  async readFile(p: string, options?: ReadFileOptions | BufferEncoding): Promise<string> {
    return encodeText(await this.readText(p), options);
  }

  async readFileBuffer(p: string): Promise<Uint8Array> {
    return new TextEncoder().encode(await this.readText(p));
  }

  writeFile(p: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void> {
    return this.noting(() => this.put(p, "open", "write", toText(content, options)));
  }

  appendFile(p: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void> {
    return this.noting(() => this.put(p, "open", "append", toText(content, options)));
  }

  async exists(p: string): Promise<boolean> {
    try {
      return (await this.node(this.loc(p))) !== null;
    } catch {
      return false;
    }
  }

  async stat(p: string): Promise<FsStat> {
    const n = await this.need(p, "stat");
    if (n.kind === "dir" || !n.repo) {
      const head = n.repo && (await this.head(n.repo));
      return stat("dir", 4096, n.repo && head ? await this.commitDate(n.repo, head) : new Date());
    }
    const m = await this.meta(n.repo, n.path);
    return stat("file", m.size, m.mtime);
  }

  lstat(p: string): Promise<FsStat> {
    return this.stat(p);
  }

  async mkdir(p: string, options?: MkdirOptions): Promise<void> {
    const l = this.loc(p);
    const n = await this.node(l);
    if (n) {
      if (n.kind === "dir" && options?.recursive) return;
      throw new FsError("EEXIST", `file already exists, mkdir '${this.full(p)}'`);
    }
    if (!l.repo || !l.path) throw new FsError("EPERM", `operation not permitted, mkdir '${this.full(p)}' (repos can't be created from the shell)`);
    const repo = await this.writableRepo(p, "mkdir", l);
    const parent = posix.dirname(l.path);
    if (!options?.recursive && parent !== "." && !(await this.isDir(repo, parent))) throw new FsError("ENOENT", `no such file or directory, mkdir '${this.full(p)}'`);
    this.dirs.add(`${l.repo}/${l.path}`);
  }

  mkdirSync(): void {
    // Called by Bash for the starting directory; directories under /workspace are implicit.
  }

  async readdir(p: string): Promise<string[]> {
    return (await this.readdirWithFileTypes(p)).map((d) => d.name);
  }

  async readdirWithFileTypes(p: string): Promise<DirentEntry[]> {
    const n = await this.need(p, "scandir");
    if (n.kind === "file") throw new FsError("ENOTDIR", `not a directory, scandir '${this.full(p)}'`);
    const entries = new Map<string, boolean>(); // name → is directory
    if (!n.repo) {
      for (const id of (await this.repos()).keys()) entries.set(id, true);
    } else {
      const prefix = n.path ? n.path + "/" : "";
      for (const f of await this.files(n.repo)) {
        if (!f.startsWith(prefix)) continue;
        const rest = f.slice(prefix.length);
        const i = rest.indexOf("/");
        if (i < 0) entries.set(rest, false);
        else entries.set(rest.slice(0, i), true);
      }
      const dprefix = `${n.repo.id}/${prefix}`;
      for (const d of this.dirs) {
        if (!d.startsWith(dprefix)) continue;
        const name = d.slice(dprefix.length).split("/")[0];
        if (name) entries.set(name, true);
      }
    }
    return [...entries]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, dir]) => ({ name, isFile: !dir, isDirectory: dir, isSymbolicLink: false }));
  }

  async rm(p: string, options?: RmOptions): Promise<void> {
    let n;
    try {
      n = await this.need(p, "rm");
    } catch (e) {
      if (options?.force && e instanceof FsError && e.code === "ENOENT") return;
      throw e;
    }
    if (!n.repo || !n.path) throw new FsError("EPERM", `operation not permitted, rm '${this.full(p)}' (repos can't be removed from the shell)`);
    await this.writableRepo(p, "rm");
    if (n.kind === "file") return this.deleteOne(n.repo, n.path, p);
    const prefix = n.path + "/";
    const inside = [...(await this.files(n.repo))].filter((f) => f.startsWith(prefix));
    if (inside.length && !options?.recursive) throw new FsError("ENOTEMPTY", `directory not empty, rm '${this.full(p)}'`);
    for (const f of inside) await this.deleteOne(n.repo, f, `/${n.repo.id}/${f}`);
    const k = `${n.repo.id}/${n.path}`;
    for (const d of [...this.dirs]) if (d === k || d.startsWith(k + "/")) this.dirs.delete(d);
  }

  private async deleteOne(repo: RepoRow, path: string, p: string) {
    const k = key(repo.id, path);
    const pend = this.pending.get(k);
    this.pending.delete(k);
    this.remember(k, undefined);
    this.written.delete(k);
    try {
      // A file only this command created, never applied: nothing to delete.
      if (pend?.base !== null || this.ctx.rooms.peek(repo.id, path)) await ops.deleteFile(this.ctx, repo, path, this.actor);
    } catch (e) {
      this.opError(e, "rm", p);
    } finally {
      this.invalidate(repo.id);
    }
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const n = await this.need(src, "cp");
    if (n.kind === "file") return this.writeFile(dest, await this.readText(src, "cp"));
    if (!options?.recursive) throw new FsError("EISDIR", `illegal operation on a directory, cp '${this.full(src)}'`);
    if (!n.repo) throw new FsError("EPERM", `operation not permitted, cp '${this.full(src)}'`);
    const prefix = n.path ? n.path + "/" : "";
    const files = [...(await this.files(n.repo))].filter((f) => f.startsWith(prefix));
    for (const f of files) await this.writeFile(`${dest}/${f.slice(prefix.length)}`, (await this.text(n.repo, f)) ?? "");
    if (!files.length) await this.mkdir(dest, { recursive: true });
  }

  async mv(src: string, dest: string): Promise<void> {
    const n = await this.need(src, "mv");
    if (!n.repo || !n.path) throw new FsError("EPERM", `operation not permitted, mv '${this.full(src)}' (repos can't be renamed from the shell)`);
    await this.writableRepo(src, "mv");
    if (n.kind === "file") return this.moveOne(n.repo, n.path, src, dest);
    const to = this.loc(dest);
    if (!to.path) throw new FsError("EPERM", `operation not permitted, mv '${this.full(dest)}'`);
    await this.writableRepo(dest, "mv", to);
    if (cleanPath(to.path + "/x.md") !== `${to.path}/x.md`) throw new FsError("EINVAL", `invalid destination, mv '${this.full(dest)}'`);
    const prefix = n.path + "/";
    for (const f of [...(await this.files(n.repo))].filter((f) => f.startsWith(prefix))) {
      await this.moveOne(n.repo, f, `/${n.repo.id}/${f}`, `${dest}/${f.slice(prefix.length)}`);
    }
    const k = `${n.repo.id}/${n.path}`;
    for (const d of [...this.dirs]) {
      if (d !== k && !d.startsWith(k + "/")) continue;
      this.dirs.delete(d);
      this.dirs.add(`${to.repo}/${to.path}${d.slice(k.length)}`);
    }
  }

  private async moveOne(repo: RepoRow, path: string, src: string, dest: string) {
    const to = await this.writableFile(dest, "mv");
    if (to.repo.id === repo.id && to.path === path) return;
    const k = key(repo.id, path);
    const destExists = (await this.node({ repo: to.repo.id, path: to.path })) !== null;
    const pend = this.pending.get(k);
    if (pend?.base === null && !destExists) {
      // A file this command created and hasn't applied yet: just move the pending write.
      this.pending.delete(k);
      this.invalidate(repo.id);
      await this.put(dest, "mv", "write", pend.content);
      return;
    }
    await this.syncOrThrow((x) => x === k);
    if (to.repo.id === repo.id && !destExists) {
      try {
        await ops.renameFile(this.ctx, repo, path, to.path, this.actor);
      } catch (e) {
        this.opError(e, "mv", src);
      } finally {
        this.invalidate(repo.id);
      }
      const text = this.lastRead.get(k);
      this.remember(k, undefined);
      if (text !== undefined) this.remember(key(repo.id, to.path), text);
      if (this.written.delete(k)) this.written.add(key(repo.id, to.path));
      return;
    }
    const content = (await this.text(repo, path)) ?? "";
    await this.put(dest, "mv", "write", content);
    await this.syncOrThrow((x) => x === key(to.repo.id, to.path));
    this.invalidate(to.repo.id);
    await this.deleteOne(repo, path, src);
  }

  resolvePath(base: string, p: string): string {
    return posix.resolve(base, p);
  }

  getAllPaths(): string[] {
    return [];
  }

  async chmod(p: string): Promise<void> {
    await this.need(p, "chmod");
  }

  async symlink(_target: string, linkPath: string): Promise<void> {
    throw new FsError("EPERM", `operation not permitted, symlink '${this.full(linkPath)}' (links are not supported in /workspace)`);
  }

  async link(_existing: string, newPath: string): Promise<void> {
    throw new FsError("EPERM", `operation not permitted, link '${this.full(newPath)}' (links are not supported in /workspace)`);
  }

  async readlink(p: string): Promise<string> {
    await this.need(p, "readlink");
    throw new FsError("EINVAL", `invalid argument, readlink '${this.full(p)}'`);
  }

  async realpath(p: string): Promise<string> {
    const n = await this.need(p, "realpath");
    return n.repo ? `/${[n.repo.id, n.path].filter(Boolean).join("/")}` : "/";
  }

  async utimes(p: string): Promise<void> {
    await this.need(p, "utime");
  }

  async createExclusive(p: string, options: { mode: number; directory?: boolean }): Promise<void> {
    if (await this.exists(p)) throw new FsError("EEXIST", `file already exists, open '${this.full(p)}'`);
    if (options.directory) return this.mkdir(p);
    return this.writeFile(p, "");
  }
}

function addParents(dirs: Set<string>, file: string) {
  for (let i = file.lastIndexOf("/"); i > 0; i = file.lastIndexOf("/", i - 1)) dirs.add(file.slice(0, i));
}

/**
 * Run every method of the object as trusted host code. just-bash's defense-in-depth blocks things like
 * process.env and timers inside commands; our filesystem legitimately needs them (Git, the database, rooms).
 */
function trusted<T extends object>(target: T): T {
  return new Proxy(target, {
    get(t, k) {
      const v = (t as Record<string | symbol, unknown>)[k];
      return typeof v === "function" ? (...args: unknown[]) => DefenseInDepthBox.runTrusted(() => (v as (...a: unknown[]) => unknown).apply(t, args)) : v;
    },
  });
}

/** Paths outside /workspace and /tmp that the shell may read but not change. */
const PROTECTED = /^\/(bin|usr|proc|dev)(\/|$)/;

/** Collected output of one statement-by-statement run (see ShellSession). */
export class Capture {
  text = "";
  bytes = 0;
  constructor(private max: number) {}
  add(s: string) {
    this.bytes += Buffer.byteLength(s);
    if (this.text.length < this.max * 2) this.text += s;
  }
}

/**
 * The whole filesystem of a shell session: the notes at /workspace, an in-memory scratch space elsewhere,
 * read-only system directories, and the capture targets for the session's output.
 */
export class ShellFs extends MountableFs {
  private notes: NotesFs;
  private scratch: InMemoryFs;
  capture: { stdout: Capture; stderr: Capture } | null = null;

  constructor(notes: NotesFs, scratchBytes: number) {
    const scratch = new InMemoryFs(undefined, { maxTotalBytes: scratchBytes });
    super({ base: scratch });
    scratch.mkdirSync("/tmp", { recursive: true });
    this.scratch = scratch;
    this.notes = trusted(notes);
    this.mount(WORKSPACE, this.notes);
  }

  private captured(p: string): Capture | null {
    if (!this.capture) return null;
    const n = posix.resolve("/", p);
    return n === CAPTURE.stdout ? this.capture.stdout : n === CAPTURE.stderr ? this.capture.stderr : null;
  }

  private guard(p: string, op: string) {
    const n = posix.resolve("/", p);
    if (n === "/" || (PROTECTED.test(n) && n !== "/dev/null")) throw new FsError("EPERM", `operation not permitted, ${op} '${n}'`);
  }

  private isNull(p: string) {
    return posix.resolve("/", p) === "/dev/null";
  }

  async readdirWithFileTypes(p: string): Promise<DirentEntry[]> {
    const n = posix.resolve("/", p);
    if (n === WORKSPACE || n.startsWith(WORKSPACE + "/")) return this.notes.readdirWithFileTypes(n.slice(WORKSPACE.length) || "/");
    const out = await this.scratch.readdirWithFileTypes(n);
    if (n === "/" && !out.some((e) => e.name === "workspace")) {
      out.push({ name: "workspace", isFile: false, isDirectory: true, isSymbolicLink: false });
      out.sort((a, b) => (a.name < b.name ? -1 : 1));
    }
    return out;
  }

  override async exists(p: string) {
    return this.captured(p) ? true : super.exists(p);
  }

  override async stat(p: string) {
    return this.captured(p) ? stat("file", 0, new Date()) : super.stat(p);
  }

  override async lstat(p: string) {
    return this.captured(p) ? stat("file", 0, new Date()) : super.lstat(p);
  }

  override async realpath(p: string) {
    return this.captured(p) ? posix.resolve("/", p) : super.realpath(p);
  }

  override async writeFile(p: string, content: FileContent, options?: WriteFileOptions | BufferEncoding) {
    return this.appendFile(p, content, options, true);
  }

  override async appendFile(p: string, content: FileContent, options?: WriteFileOptions | BufferEncoding, truncate = false) {
    const cap = this.captured(p);
    if (cap) {
      const enc = typeof options === "string" ? options : options?.encoding;
      cap.add(content instanceof Uint8Array ? Buffer.from(content).toString("utf8") : enc === "binary" || enc === "latin1" ? Buffer.from(content, "latin1").toString("utf8") : content);
      return;
    }
    if (this.isNull(p)) return;
    this.guard(p, "open");
    return truncate ? super.writeFile(p, content, options) : super.appendFile(p, content, options);
  }

  override async rm(p: string, options?: RmOptions) {
    this.guard(p, "rm");
    return super.rm(p, options);
  }

  override async mv(src: string, dest: string) {
    this.guard(src, "mv");
    this.guard(dest, "mv");
    return super.mv(src, dest);
  }

  override async cp(src: string, dest: string, options?: CpOptions) {
    this.guard(dest, "cp");
    return super.cp(src, dest, options);
  }

  override async mkdir(p: string, options?: MkdirOptions) {
    this.guard(p, "mkdir");
    return super.mkdir(p, options);
  }

  override async chmod(p: string, mode: number) {
    this.guard(p, "chmod");
    return super.chmod(p, mode);
  }

  override async symlink(target: string, linkPath: string) {
    this.guard(linkPath, "symlink");
    return super.symlink(target, linkPath);
  }

  override async link(existing: string, newPath: string) {
    this.guard(newPath, "link");
    return super.link(existing, newPath);
  }
}
