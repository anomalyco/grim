// The agent shell's view of the notes: /workspace/<repo>/<path>.md over live rooms and Git, plus a private /tmp.
import { posix } from "node:path";
import { InMemoryFs, MountableFs } from "just-bash";
import { trusted } from "./trust.ts";
import type { BufferEncoding, CpOptions, FileContent, FsStat, IFileSystem, MkdirOptions, RmOptions } from "just-bash";
import type { Access } from "../auth.ts";
import { cleanPath, type RepoRow, type RepoService } from "../repos.ts";
import { isErr } from "../errors.ts";
import type { Participant } from "../rooms.ts";
import type { ShellSnapshot, ShellWrite } from "../seams/workspace-host.ts";
import { isMarkdown, MAX_FILE_BYTES, type FileMeta } from "../store/types.ts";

type ReadFileOptions = { encoding?: BufferEncoding | null };
type WriteFileOptions = { encoding?: BufferEncoding };
type DirentEntry = { name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean };

export type AccessFn = (repo: RepoRow) => Promise<Access>;

/**
 * What the shell needs of the app: workspace rows (the global tables) and each workspace's runtime (the host). The
 * app's Ctx is one; a ShellDO builds its own over D1 and WorkspaceDO stubs.
 */
export interface ShellCtx {
  repos: Pick<RepoService, "get" | "list" | "host"> & {
    /** The row as it is right now, for the check right before a write (default: `get`, which may be cached). */
    getFresh?(id: string): Promise<RepoRow | null>;
  };
}

/** Workspaces a command looks up one by one before it lists them all instead (one query rather than many). */
const MAX_REPO_LOOKUPS = 8;

export const WORKSPACE = "/workspace";
/** Redirect targets the session uses to collect a command's output statement by statement. */
export const CAPTURE = { stdout: "/dev/grimoire-stdout", stderr: "/dev/grimoire-stderr" } as const;
/** Text each session remembers as "what the agent last read", for 3-way merges of later writes. */
const MAX_LAST_READ_BYTES = 8 * 1024 * 1024;
/** Committed text a session keeps between commands (all workspaces). */
const MAX_VIEW_BYTES = 16 * 1024 * 1024;
const MD_HINT = "only Markdown files (.md, .markdown, .mdx) can be stored in /workspace; use /tmp for other files";

export class FsError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "FsError";
  }
}

const key = (repo: string, path: string) => `${repo}\0${path}`;

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

/** What a session knows of a workspace, kept up to date from the runtime's snapshots (one call per command). */
interface View {
  version: string;
  head: string | null;
  headDate: Date;
  /** Markdown files at the head. */
  meta: Map<string, FileMeta>;
  /** Committed text at the head, as far as fetched. */
  committed: Map<string, string>;
  committedBytes: number;
  /** Open notes' live text. */
  live: Map<string, string>;
  /** Files that couldn't be read in this command. */
  errors: Map<string, { name: string; message: string }>;
  index: RepoIndex | null;
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
  /** Every workspace the actor can see, when a command listed them (ls /workspace, repos). */
  private repoCache: Map<string, { row: RepoRow; access: Access }> | null = null;
  /** Workspaces looked up by id in this command (most commands touch one or two). */
  private repoLookups = new Map<string, Promise<{ row: RepoRow; access: Access } | undefined>>();
  private views = new Map<string, View>();
  /** Workspaces whose view was brought up to date in this command. */
  private fresh = new Set<string>();
  private loading = new Map<string, Promise<View>>();
  private committedBytes = 0;
  /** Write errors of the current command; some built-ins (sed -i, tee) replace them with a generic message. */
  private writeErrors = new Set<string>();

  constructor(
    readonly ctx: ShellCtx,
    /** Replaceable, so a session shows the caller's current display name. */
    public actor: Participant,
    /** Replaceable, so a session picks up the caller's current permissions. */
    public access: AccessFn,
  ) {}

  /** Ask again, right before changing a repo, whether the actor may still write to it (access can be taken away while a command runs, e.g. a revoked share link). */
  private async mayWrite(repo: RepoRow): Promise<boolean> {
    const repos = this.ctx.repos;
    const row = await (repos.getFresh ? repos.getFresh(repo.id) : repos.get(repo.id));
    const ok = !!row && row.status === "ready" && !row.read_only && (await this.access(row)) === "write";
    if (!ok) this.forgetRepos();
    return ok;
  }

  private writeDenied(repo: RepoRow, op: string, p: string) {
    return new FsError("EROFS", `read-only file system, ${op} '${p}' (you no longer have write access to ${repo.id})`);
  }

  /** Throws EROFS if the actor may no longer write to the repo. */
  private async recheckWrite(repo: RepoRow, op: string, p: string) {
    if (!(await this.mayWrite(repo))) throw this.writeDenied(repo, op, p);
  }

  /** Forget per-command state (repos, access, read errors) so each command sees fresh state. */
  beginExec() {
    this.forgetRepos();
    this.writeErrors.clear();
    this.invalidate();
    for (const v of this.views.values()) v.errors.clear();
  }

  /** Ask the workspace what changed (once) before the next read, after something may have changed it. */
  invalidate(repo?: string) {
    if (repo) this.fresh.delete(repo);
    else this.fresh.clear();
  }

  private host(repo: RepoRow) {
    return this.ctx.repos.host.get(repo.id);
  }

  /** The session's view of a workspace, brought up to date once per command with one snapshot call. */
  private async view(repo: RepoRow): Promise<View> {
    const v = this.views.get(repo.id);
    if (v && this.fresh.has(repo.id)) return v;
    return this.load(repo);
  }

  private load(repo: RepoRow, want?: string[]): Promise<View> {
    const busy = this.loading.get(repo.id);
    if (busy) return want ? busy.then(() => this.load(repo, want), () => this.load(repo, want)) : busy;
    const p = (async () => {
      const snap = await this.host(repo).snapshot(repo, this.views.get(repo.id)?.version ?? null, want);
      this.fresh.add(repo.id);
      return this.apply(repo.id, snap);
    })().finally(() => this.loading.delete(repo.id));
    this.loading.set(repo.id, p);
    return p;
  }

  private dropCommitted(v: View) {
    this.committedBytes -= v.committedBytes;
    v.committed.clear();
    v.committedBytes = 0;
  }

  private apply(id: string, s: ShellSnapshot): View {
    let v = this.views.get(id);
    if (s.full || !v) {
      if (v) this.dropCommitted(v);
      v = { version: s.version, head: s.head, headDate: new Date(), meta: new Map(), committed: new Map(), committedBytes: 0, live: new Map(), errors: v?.errors ?? new Map(), index: null };
      for (const f of s.files ?? []) v.meta.set(f.path, f);
      this.views.set(id, v);
    }
    v.version = s.version;
    v.head = s.head;
    v.headDate = s.headDate ? new Date(s.headDate) : new Date();
    v.index = null;
    for (const p of s.closed) v.live.delete(p);
    for (const [p, text] of Object.entries(s.live)) v.live.set(p, text);
    for (const [p, text] of Object.entries(s.contents)) {
      v.errors.delete(p);
      if (v.committed.has(p)) continue;
      v.committed.set(p, text);
      v.committedBytes += text.length;
      this.committedBytes += text.length;
    }
    for (const [p, e] of Object.entries(s.errors ?? {})) v.errors.set(p, e);
    if (this.committedBytes > MAX_VIEW_BYTES) {
      // Over budget: other workspaces' text goes first, then this one's oldest.
      for (const w of [...this.views.values()].filter((w) => w !== v)) this.dropCommitted(w);
      for (const [p, text] of v.committed) {
        if (this.committedBytes <= MAX_VIEW_BYTES) break;
        v.committed.delete(p);
        v.committedBytes -= text.length;
        this.committedBytes -= text.length;
      }
    }
    return v;
  }

  // ---- repos ----

  private forgetRepos() {
    this.repoCache = null;
    this.repoLookups.clear();
  }

  /** Every workspace the actor can see (one listing per command). */
  async repos(): Promise<Map<string, { row: RepoRow; access: Access }>> {
    if (this.repoCache) return this.repoCache;
    const out = new Map<string, { row: RepoRow; access: Access }>();
    for (const row of await this.ctx.repos.list()) {
      const r = await this.entry(row);
      if (r) out.set(row.id, r);
    }
    this.repoCache = out;
    return out;
  }

  /** One workspace, if the actor can see it: only its row is read (once per command), unless the command listed them all. */
  async repo(id: string): Promise<{ row: RepoRow; access: Access } | undefined> {
    if (this.repoCache) return this.repoCache.get(id);
    let r = this.repoLookups.get(id);
    if (!r) {
      if (this.repoLookups.size >= MAX_REPO_LOOKUPS) return (await this.repos()).get(id);
      r = this.ctx.repos.get(id).then((row) => (row?.id === id ? this.entry(row) : undefined));
      this.repoLookups.set(id, r);
    }
    return r;
  }

  private async entry(row: RepoRow): Promise<{ row: RepoRow; access: Access } | undefined> {
    if (row.status !== "ready") return undefined;
    let access = await this.access(row);
    if (access === "write" && row.read_only) access = "read";
    return access === "none" ? undefined : { row, access };
  }

  private async repoIndex(repo: RepoRow): Promise<RepoIndex> {
    const v = await this.view(repo);
    if (!v.index) {
      const files = new Set(v.meta.keys());
      for (const p of v.live.keys()) files.add(p);
      for (const p of this.pending.values()) if (p.repo.id === repo.id) files.add(p.path);
      v.index = { files, dirs: new Set() };
      for (const f of files) addParents(v.index.dirs, f);
    }
    return v.index;
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

  /** The live or committed text of a file (not this command's writes); reads committed text from the workspace when needed. */
  private async liveText(repo: RepoRow, path: string): Promise<string | null> {
    let v = await this.view(repo);
    let want: string[] | null = null;
    for (;;) {
      const t = v.live.get(path) ?? v.committed.get(path);
      if (t !== undefined) return t;
      const err = v.errors.get(path);
      if (err?.name === "FileTooLargeError") throw new FsError("EFBIG", `file too large, '/workspace/${repo.id}/${path}' (max ${MAX_FILE_BYTES / 1024 / 1024} MB per note)`);
      if (err) throw new FsError("EIO", `${err.message}, '/workspace/${repo.id}/${path}' (try again)`);
      if (!v.meta.has(path) || want) return null;
      // Reads run in parallel (grep -r): one already asking for every file may bring this one too.
      const busy = this.loading.get(repo.id);
      if (busy) {
        v = await busy;
        continue;
      }
      // A miss usually means more are coming (grep -r, cat *): ask for every committed file not here yet, this one first.
      want = [path, ...[...v.meta.keys()].filter((p) => p !== path && !v.committed.has(p) && !v.live.has(p) && !v.errors.has(p))];
      v = await this.load(repo, want);
    }
  }

  /** Size and date of a file without downloading it. */
  private async meta(repo: RepoRow, path: string): Promise<{ size: number; mtime: Date }> {
    const v = await this.view(repo);
    const live = this.pending.get(key(repo.id, path))?.content ?? v.live.get(path);
    if (live !== undefined) return { size: Buffer.byteLength(live), mtime: new Date() };
    const m = v.meta.get(path);
    const cached = v.committed.get(path);
    return { size: cached !== undefined ? Buffer.byteLength(cached) : (m?.size ?? 0), mtime: m?.date ? new Date(m.date) : v.headDate };
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
   * Apply pending writes to the rooms (people see them live; the room commits after its quiet period), one batch per
   * workspace. Returns error messages for writes that could not be applied. `only` limits it to some "repo\0path" keys.
   */
  async sync(only?: (key: string) => boolean): Promise<string[]> {
    const errors: string[] = [];
    const batches = new Map<string, Array<[string, Pending]>>();
    for (const [k, p] of [...this.pending]) {
      if (only && !only(k)) continue;
      this.pending.delete(k);
      // Unchanged text: nothing to apply.
      if (p.base !== null && p.appended === null && p.content === p.base) continue;
      let batch = batches.get(p.repo.id);
      if (!batch) batches.set(p.repo.id, (batch = []));
      batch.push([k, p]);
    }
    for (const batch of batches.values()) {
      const repo = batch[0]![1].repo;
      const shown = (p: Pending) => `${WORKSPACE}/${repo.id}/${p.path}`;
      const writes: ShellWrite[] = batch.map(([, p]) => ({ path: p.path, base: p.base, content: p.content, appended: p.appended }));
      let results: (string | null)[];
      try {
        if (!(await this.mayWrite(repo))) results = batch.map(([, p]) => this.writeDenied(repo, "write", shown(p)).message);
        else results = await this.host(repo).applyWrites(repo, writes, this.actor);
      } catch (e) {
        results = batch.map(() => (e instanceof Error ? e.message : String(e)));
      }
      this.invalidate(repo.id);
      for (const [i, [k, p]] of batch.entries()) {
        const err = results[i];
        if (err == null) {
          this.remember(k, p.content);
          this.written.add(k);
        } else errors.push(`${shown(p)}: ${err}`);
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
    if (isErr(e, "OpError")) {
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
      const v = n.repo && (await this.view(n.repo));
      return stat("dir", 4096, v && v.head ? v.headDate : new Date());
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
      if (pend?.base !== null || (await this.view(repo)).live.has(path)) {
        await this.recheckWrite(repo, "rm", this.full(p));
        await this.host(repo).deleteFile(repo, path, this.actor);
      }
    } catch (e) {
      if (e instanceof FsError) throw e;
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
        await this.recheckWrite(repo, "mv", this.full(src));
        await this.host(repo).renameFile(repo, path, to.path, this.actor);
      } catch (e) {
        if (e instanceof FsError) throw e;
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
function trustAll<T extends object>(target: T): T {
  return new Proxy(target, {
    get(t, k) {
      const v = (t as Record<string | symbol, unknown>)[k];
      return typeof v === "function" ? (...args: unknown[]) => trusted(() => (v as (...a: unknown[]) => unknown).apply(t, args)) : v;
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
  /** Bumped by every change that may touch the scratch space (to know when a checkpoint must save it again). */
  scratchVersion = 0;

  constructor(notes: NotesFs, scratchBytes: number) {
    const scratch = new InMemoryFs(undefined, { maxTotalBytes: scratchBytes });
    super({ base: scratch });
    scratch.mkdirSync("/tmp", { recursive: true });
    this.scratch = scratch;
    this.notes = trustAll(notes);
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
    this.scratchVersion++;
    return truncate ? super.writeFile(p, content, options) : super.appendFile(p, content, options);
  }

  override async rm(p: string, options?: RmOptions) {
    this.guard(p, "rm");
    this.scratchVersion++;
    return super.rm(p, options);
  }

  override async mv(src: string, dest: string) {
    this.guard(src, "mv");
    this.guard(dest, "mv");
    this.scratchVersion++;
    return super.mv(src, dest);
  }

  override async cp(src: string, dest: string, options?: CpOptions) {
    this.guard(dest, "cp");
    this.scratchVersion++;
    return super.cp(src, dest, options);
  }

  override async mkdir(p: string, options?: MkdirOptions) {
    this.guard(p, "mkdir");
    this.scratchVersion++;
    return super.mkdir(p, options);
  }

  override async chmod(p: string, mode: number) {
    this.guard(p, "chmod");
    this.scratchVersion++;
    return super.chmod(p, mode);
  }

  override async symlink(target: string, linkPath: string) {
    this.guard(linkPath, "symlink");
    this.scratchVersion++;
    return super.symlink(target, linkPath);
  }

  override async link(existing: string, newPath: string) {
    this.guard(newPath, "link");
    this.scratchVersion++;
    return super.link(existing, newPath);
  }

  override async createExclusive(p: string, options: { mode: number; directory?: boolean }) {
    this.scratchVersion++;
    return super.createExclusive(p, options);
  }

  /**
   * The scratch space's files (/tmp and anything else outside /workspace and the system directories), for a
   * checkpoint; null when they come to more than `maxBytes`.
   */
  async exportScratch(maxBytes: number): Promise<ScratchEntry[] | null> {
    const out: ScratchEntry[] = [];
    let bytes = 0;
    for (const p of this.scratch.getAllPaths().sort()) {
      if (p === "/" || PROTECTED.test(p) || p === WORKSPACE || p.startsWith(WORKSPACE + "/")) continue;
      const st = await this.scratch.lstat(p);
      if (st.isSymbolicLink) out.push({ path: p, kind: "symlink", mode: st.mode, target: await this.scratch.readlink(p) });
      else if (st.isDirectory) out.push({ path: p, kind: "dir", mode: st.mode });
      else {
        const data = await this.scratch.readFileBuffer(p);
        bytes += data.byteLength + p.length;
        if (bytes > maxBytes) return null;
        out.push({ path: p, kind: "file", mode: st.mode, data });
      }
      bytes += p.length;
    }
    return out;
  }

  /** Put back a checkpoint's scratch files (on a new session). */
  async importScratch(entries: ScratchEntry[]) {
    for (const e of entries) {
      try {
        if (e.kind === "dir") this.scratch.mkdirSync(e.path, { recursive: true });
        else if (e.kind === "file") this.scratch.writeFileSync(e.path, e.data ?? new Uint8Array(), undefined, { mode: e.mode });
        else await this.scratch.symlink(e.target ?? "", e.path);
      } catch {
        // a damaged entry is skipped
      }
    }
  }
}

/** One file, directory or link of a session's scratch space, as a checkpoint keeps it. */
export interface ScratchEntry {
  path: string;
  kind: "file" | "dir" | "symlink";
  mode: number;
  data?: Uint8Array;
  target?: string;
}
