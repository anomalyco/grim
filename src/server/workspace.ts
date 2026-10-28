// One workspace's runtime: its rooms and repo state (tree cache, last seen head, rename queue, refresh), and the file
// operations shared by the HTTP API, the agent shell and MCP, so people and agents get identical behavior. Bun keeps
// one per workspace in a Map (bun/workspace-host-local.ts); on Workers a WorkspaceDO hosts one. Methods take and
// return plain data and throw errors matched by name (see seams/workspace-host.ts).
import type * as Y from "yjs";
import { emit, notifyChange, waitForChange } from "./events.ts";
import { isErr } from "./errors.ts";
import { isUntitledPath } from "../shared/untitled.ts";
import { authorOf, type Participant } from "./room.ts";
import type { RoomManager } from "./rooms.ts";
import type { RepoRow } from "./repos.ts";
import { dirPath, encodeLinkPath, escapeAlt, imagePath, IMAGE_TYPES, MAX_RAW_BYTES, MAX_UPLOAD_BYTES, OpError, path, SAFE_REF, sniffImage, uploadName, version, writable } from "./ops.ts";
import { isMarkdown, type GitStore } from "./store/types.ts";
import { applyToYText, diffText, rebaseSplices } from "./textdiff.ts";
import type { AdmittedWorkspace, WorkspaceApi, WorkspaceHost, WsDecision } from "./seams/workspace-host.ts";

/**
 * The store as the runtime uses it: a CachedHeadStore (index.ts) also takes `{ fresh: true }` (pollers) and
 * `invalidate(repo)` (webhooks); any other GitStore ignores both.
 */
export type HeadCachingStore = GitStore & {
  head(repo: string, branch: string, opts?: { fresh?: boolean }): Promise<string | null>;
  invalidate?(repo: string): void;
};

type Change = { path: string; content?: string | Uint8Array; delete?: boolean };

/** Replace the whole text with `next` as a minimal edit; returns the index after the last change. */
function replaceMinimal(text: Y.Text, next: string): number {
  return applyToYText(text, diffText(text.toString(), next));
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** WebSocket admission, file level: open the note's room (4404 missing, 4413 too large, 1013 transient, 1011 other). */
export async function admitFile(rooms: RoomManager, a: AdmittedWorkspace): Promise<WsDecision> {
  try {
    const room = await rooms.get(a.repoId, a.path, a.branch);
    return { room, participant: a.participant, readOnly: a.readOnly };
  } catch (e) {
    if (isErr(e, "NotFoundError")) return { reject: { code: 4404, reason: "file not found" } };
    if (isErr(e, "FileTooLargeError")) return { reject: { code: 4413, reason: "file too large" } };
    // Transient (e.g. GitHub unreachable): the client retries.
    if (isErr(e, "StoreUnavailableError")) return { reject: { code: 1013, reason: "try again later" } };
    console.error(`[ws] open ${a.repoId}:${a.path}:`, e);
    return { reject: { code: 1011, reason: "could not open file" } };
  }
}

export class WorkspaceRuntime implements WorkspaceApi {
  /** Committed Markdown files at the last head listed. */
  private treeCache: { head: string | null; files: string[] } | null = null;
  /** Branch tip last seen by onPush (undefined: none yet). */
  private lastHead: string | null | undefined = undefined;
  /** Renames (notes and folders) run one at a time. */
  private renaming: Promise<unknown> | null = null;
  private refreshing: Promise<void> | null = null;
  private lastRefresh = 0;

  constructor(
    readonly id: string,
    private store: HeadCachingStore,
    /** The rooms; only this workspace's are touched (Bun shares one RoomManager between runtimes, keyed by repo). */
    readonly rooms: RoomManager,
  ) {}

  private check(repo: RepoRow) {
    if (repo.id !== this.id) throw new Error(`workspace ${this.id} got a call for ${repo.id}`);
  }

  private async room(repo: RepoRow, p: string) {
    try {
      return await this.rooms.get(repo.id, p, repo.branch);
    } catch (e) {
      if (isErr(e, "NotFoundError")) throw new OpError(404, `${p} not found in ${repo.id}`);
      throw e;
    }
  }

  private async exists(repo: RepoRow, p: string) {
    if (this.rooms.peek(repo.id, p)) return true;
    const head = await this.store.head(repo.id, repo.branch);
    return head !== null && (await this.store.readFile(repo.id, p, head)) !== null;
  }

  admitFile(a: AdmittedWorkspace): Promise<WsDecision> {
    if (a.repoId !== this.id) throw new Error(`workspace ${this.id} got a socket for ${a.repoId}`);
    return admitFile(this.rooms, a);
  }

  async readFile(repo: RepoRow, p: string, ref?: string) {
    this.check(repo);
    p = path(p);
    if (ref && !SAFE_REF.test(ref)) throw new OpError(400, `invalid ref: ${ref}`);
    if (!ref) {
      const open = this.rooms.peek(repo.id, p);
      if (open) return { path: p, content: open.text.toString(), version: version(open.text.toString()), live: true };
      ref = (await this.store.head(repo.id, repo.branch)) ?? undefined;
    }
    const content = ref ? await this.store.readFile(repo.id, p, ref) : null;
    if (content === null) throw new OpError(404, `${p} not found`);
    return { path: p, content, version: version(content), live: false };
  }

  /** An image file's bytes at `ref` (default: the branch tip). Images aren't edited live, so there's no room text. */
  async readRaw(repo: RepoRow, p: string, ref?: string) {
    this.check(repo);
    const { path, type } = imagePath(p);
    if (ref && !SAFE_REF.test(ref)) throw new OpError(400, `invalid ref: ${ref}`);
    ref ??= (await this.store.head(repo.id, repo.branch)) ?? undefined;
    const bytes = ref ? await this.store.readBlob(repo.id, path, ref, MAX_RAW_BYTES) : null;
    if (bytes === null) throw new OpError(404, `${path} not found`);
    return { path, type, bytes };
  }

  /**
   * Store an uploaded image in `images/` next to note `notePath`, committed at once by `actor` ("Add <path>"). The
   * name is kept; another file with that name gets `name-2.png`, `name-3.png`…; an identical file already there is
   * reused (nothing committed). Returns the repo path and the Markdown that shows it in the note.
   */
  async uploadImage(repo: RepoRow, notePath: string, filename: string, bytes: Uint8Array, actor: Participant) {
    this.check(repo);
    writable(repo);
    const note = path(notePath);
    if (!bytes.length) throw new OpError(400, "the file is empty");
    if (bytes.length > MAX_UPLOAD_BYTES) throw new OpError(413, `images can be at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
    const sniffed = sniffImage(bytes);
    if (!sniffed) throw new OpError(415, `not an image (${Object.keys(IMAGE_TYPES).join(", ")})`);
    const { name, stem, ext } = uploadName(filename, sniffed);
    const dir = [...note.split("/").slice(0, -1), "images"].join("/");
    const candidate = (n: number) => imagePath(`${dir}/${n === 1 ? name : `${stem}-${n}.${ext}`}`).path;
    const result = (p: string, reused: boolean) => {
      const markdownPath = encodeLinkPath(p.slice(dir.length - "images".length));
      return { path: p, markdownPath, markdown: `![${escapeAlt(stem)}](${markdownPath})`, reused };
    };
    for (let attempt = 0; attempt < 5; attempt++) {
      const head = await this.store.head(repo.id, repo.branch);
      let target: string | null = null;
      for (let n = 1; n <= 1000 && !target; n++) {
        const cand = candidate(n);
        let existing: Uint8Array | null | "other" = null;
        if (head) {
          try {
            existing = await this.store.readBlob(repo.id, cand, head, MAX_UPLOAD_BYTES);
          } catch (e) {
            if (!isErr(e, "FileTooLargeError")) throw e;
            existing = "other";
          }
        }
        if (existing === null) target = cand;
        else if (existing !== "other" && sameBytes(existing, bytes)) return result(cand, true);
      }
      if (!target) throw new OpError(409, `too many images named ${name}`);
      const res = await this.store.writeBlob({ repo: repo.id, branch: repo.branch, expectedHead: head, path: target, bytes, message: `Add ${target}`, author: authorOf(actor) });
      if (res.ok) {
        await this.onPush(repo);
        return result(target, false);
      }
    }
    throw new OpError(409, "could not commit: the branch keeps moving");
  }

  async createFile(repo: RepoRow, p: string, content: string | undefined, actor: Participant) {
    this.check(repo);
    writable(repo);
    p = path(p);
    if (await this.exists(repo, p)) throw new OpError(409, `${p} already exists`);
    const base = p.split("/").pop()!.replace(/\.(md|markdown|mdx)$/i, "");
    const r = await this.rooms.get(repo.id, p, repo.branch, "");
    const initial = content ?? `# ${base}\n`;
    r.agentEdit(actor, (t) => {
      // An empty file still needs an edit, so it is attributed to the actor and wakes watchers.
      t.insert(0, initial || " ");
      if (!initial) t.delete(0, 1);
      return t.length;
    });
    // Like any edit, the new file is in the crash log now and gets committed after the quiet period.
    emit({ type: "tree", repo: repo.id });
    return { path: p, version: version(r.text.toString()) };
  }

  /**
   * Apply the change `base` → `next` to the live text, keeping edits that others made since `base` was read.
   * Fails (409) if both touched the same or adjacent places. Used by the agent shell, which reads, computes and writes later.
   */
  async patchFile(repo: RepoRow, p: string, base: string, next: string, actor: Participant) {
    this.check(repo);
    writable(repo);
    p = path(p);
    const r = await this.room(repo, p);
    const cur = r.text.toString();
    const theirs = cur === base ? [] : diffText(base, cur);
    const ours = rebaseSplices(theirs, diffText(base, next));
    if (!ours) throw new OpError(409, `${p} was changed by someone else at the same place since you read it; read it again and redo the edit`);
    r.agentEdit(actor, (t) => applyToYText(t, ours));
    return { path: p, version: version(r.text.toString()) };
  }

  /** Append text to the end of the live text, exactly as given (like a shell's `>>`). */
  async appendText(repo: RepoRow, p: string, text: string, actor: Participant) {
    this.check(repo);
    writable(repo);
    p = path(p);
    const r = await this.room(repo, p);
    r.agentEdit(actor, (t) => {
      t.insert(t.length, text);
      return t.length;
    });
    return { path: p, version: version(r.text.toString()) };
  }

  async restoreFile(repo: RepoRow, p: string, sha: string, actor: Participant) {
    this.check(repo);
    writable(repo);
    p = path(p);
    const old = await this.store.readFile(repo.id, p, sha);
    if (old === null) throw new OpError(404, `${p} not found at ${sha}`);
    const r = await this.room(repo, p);
    r.agentEdit(actor, (t) => replaceMinimal(t, old));
    return { path: p };
  }

  private async commitTreeChange(repo: RepoRow, changes: Change[], message: string, actor: Participant) {
    for (let i = 0; i < 5; i++) {
      const head = await this.store.head(repo.id, repo.branch);
      const res = await this.store.commit({ repo: repo.id, branch: repo.branch, expectedHead: head, changes, message, author: authorOf(actor) });
      if (res.ok) return res.sha;
    }
    throw new OpError(409, "could not commit: the branch keeps moving");
  }

  async deleteFile(repo: RepoRow, p: string, actor: Participant): Promise<{ ok: true }> {
    this.check(repo);
    writable(repo);
    p = path(p);
    const open = this.rooms.peek(repo.id, p);
    const head = await this.store.head(repo.id, repo.branch);
    if (!head || (await this.store.readFile(repo.id, p, head)) === null) {
      if (!open) throw new OpError(404, `${p} not found`);
      open.closeWith("deleted");
      notifyChange(repo.id, p);
      emit({ type: "tree", repo: repo.id });
      return { ok: true };
    }
    // Commit first: closing the room drops its unsaved edits, so only do it once the delete is in Git.
    await this.commitTreeChange(repo, [{ path: p, delete: true }], `Delete ${p}`, actor);
    open?.closeWith("deleted");
    await this.onPush(repo);
    return { ok: true };
  }

  /** Run `fn` in the rename queue: renames in a workspace run one at a time, each after the previous one settled. */
  private queued<T>(fn: () => Promise<T>): Promise<T> {
    const next = (this.renaming ?? Promise.resolve()).then(fn, fn);
    const tail = next.catch(() => {});
    this.renaming = tail;
    void tail.then(() => this.renaming === tail && (this.renaming = null));
    return next;
  }

  /**
   * Rename a note (one commit). `ifUntitled` (a new note named after its heading): only while the note is still
   * untitled, so when two people trigger it at once the second one is refused (409/404).
   */
  renameFile(repo: RepoRow, from: string, to: string, actor: Participant, opts: { ifUntitled?: boolean } = {}) {
    this.check(repo);
    return this.queued(() => this.renameNow(repo, from, to, actor, opts));
  }

  private async renameNow(repo: RepoRow, from: string, to: string, actor: Participant, opts: { ifUntitled?: boolean }) {
    writable(repo);
    from = path(from);
    to = path(to);
    if (opts.ifUntitled && !isUntitledPath(from)) throw new OpError(409, `${from} isn't untitled`);
    if (from === to) return { path: to };
    if (await this.exists(repo, to)) throw new OpError(409, `${to} already exists`);
    const open = this.rooms.peek(repo.id, from);
    // Commit pending edits first, so they are attributed to their authors rather than to the rename.
    if (open?.dirty) await open.flush();
    const head = await this.store.head(repo.id, repo.branch);
    const atHead = head ? await this.store.readFile(repo.id, from, head) : null;
    const content = open && !open.closed ? open.text.toString() : atHead;
    if (content === null) throw new OpError(404, `${from} not found`);
    const changes = [...(atHead !== null ? [{ path: from, delete: true }] : []), { path: to, content }];
    await this.commitTreeChange(repo, changes, `Rename ${from} to ${to}`, actor);
    open?.closeWith("renamed", { to });
    await this.onPush(repo);
    return { path: to };
  }

  /** Everything under folder `dir` (committed files, and notes that only exist in open rooms so far). */
  private async filesUnder(repo: RepoRow, dir: string) {
    const prefix = `${dir}/`;
    const head = await this.store.head(repo.id, repo.branch);
    const committed = head ? (await this.store.listFiles(repo.id, head)).filter((f) => f.startsWith(prefix)) : [];
    const pending = this.rooms.inRepo(repo.id).map((r) => r.path).filter((f) => f.startsWith(prefix) && !committed.includes(f));
    return { head, committed, all: [...committed, ...pending] };
  }

  /** Rename folder `from` to `to`: every file under it moves, in one commit. Runs in the rename queue. */
  renameFolder(repo: RepoRow, from: string, to: string, actor: Participant) {
    this.check(repo);
    return this.queued(() => this.renameFolderNow(repo, from, to, actor));
  }

  private async renameFolderNow(repo: RepoRow, from: string, to: string, actor: Participant) {
    writable(repo);
    from = dirPath(from);
    to = dirPath(to);
    if (from === to) return { path: to };
    if (to.startsWith(`${from}/`)) throw new OpError(400, `can't move ${from} into itself`);
    if ((await this.filesUnder(repo, to)).all.length) throw new OpError(409, `${to} already exists`);
    const { all } = await this.filesUnder(repo, from);
    if (!all.length) throw new OpError(404, `${from} not found`);
    const rooms = all.map((f) => this.rooms.peek(repo.id, f));
    // Commit pending edits first, so they are attributed to their authors rather than to the rename.
    for (const r of rooms) if (r?.dirty) await r.flush();
    const head = await this.store.head(repo.id, repo.branch);
    const changes: Change[] = [];
    const moved: Array<{ room: (typeof rooms)[number]; to: string }> = [];
    for (const [i, f] of all.entries()) {
      const room = rooms[i];
      const dest = to + f.slice(from.length);
      const atHead = head ? await this.store.readBlob(repo.id, f, head, MAX_UPLOAD_BYTES) : null;
      const content = room && !room.closed ? room.text.toString() : atHead;
      if (content === null) continue;
      if (atHead !== null) changes.push({ path: f, delete: true });
      changes.push({ path: dest, content });
      moved.push({ room, to: dest });
    }
    if (!changes.length) throw new OpError(404, `${from} not found`);
    await this.commitTreeChange(repo, changes, `Rename ${from} to ${to}`, actor);
    for (const m of moved) m.room?.closeWith("renamed", { to: m.to });
    await this.onPush(repo);
    emit({ type: "tree", repo: repo.id });
    return { path: to };
  }

  /** Delete folder `dir` and everything under it, in one commit. */
  async deleteFolder(repo: RepoRow, dir: string, actor: Participant): Promise<{ ok: true }> {
    this.check(repo);
    writable(repo);
    dir = dirPath(dir);
    // Let the notes' own commits (pending or in flight) land first, so none of them brings a file back afterwards.
    await Promise.allSettled(this.rooms.inRepo(repo.id).filter((r) => r.path.startsWith(`${dir}/`)).map((r) => r.flush()));
    const { committed, all } = await this.filesUnder(repo, dir);
    if (!all.length) throw new OpError(404, `${dir} not found`);
    if (committed.length) await this.commitTreeChange(repo, committed.map((f) => ({ path: f, delete: true })), `Delete ${dir}`, actor);
    for (const f of all) {
      this.rooms.peek(repo.id, f)?.closeWith("deleted");
      if (!committed.includes(f)) notifyChange(repo.id, f);
    }
    await this.onPush(repo);
    emit({ type: "tree", repo: repo.id });
    return { ok: true };
  }

  async tree(repo: RepoRow): Promise<string[]> {
    this.check(repo);
    const head = await this.store.head(repo.id, repo.branch);
    let committed = this.treeCache?.head === head ? this.treeCache.files : null;
    if (!committed) {
      committed = head ? (await this.store.listFiles(repo.id, head)).filter(isMarkdown).sort() : [];
      this.treeCache = { head, files: committed };
    }
    const pending = this.rooms.inRepo(repo.id).filter((r) => !r.inBase).map((r) => r.path);
    return pending.length ? [...new Set([...committed, ...pending])].sort() : committed;
  }

  head(repo: RepoRow) {
    this.check(repo);
    return this.store.head(repo.id, repo.branch);
  }

  history(repo: RepoRow, p: string | undefined, limit = 50) {
    this.check(repo);
    return this.store.history(repo.id, repo.branch, p ? path(p) : undefined, Math.min(Math.max(limit, 1), 200));
  }

  async diff(repo: RepoRow, sha: string, p?: string) {
    this.check(repo);
    if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw new OpError(400, "invalid sha");
    try {
      return await this.store.diff(repo.id, sha, p ? path(p) : undefined);
    } catch {
      throw new OpError(404, `commit ${sha} not found`);
    }
  }

  async search(repo: RepoRow, q: string) {
    this.check(repo);
    if (!q.trim()) return { hits: [] };
    const head = await this.store.head(repo.id, repo.branch);
    return head ? this.store.search(repo.id, head, q, 100) : { hits: [] };
  }

  /** In-process callers may pass a signal (the shell's Ctrl-C); it can't cross RPC. */
  waitForChange(p: string | undefined, timeoutMs: number, signal?: AbortSignal) {
    return waitForChange(this.id, p, timeoutMs, signal);
  }

  async onPush(repo: RepoRow, opts: { fresh?: boolean; invalidate?: boolean } = {}) {
    this.check(repo);
    if (opts.invalidate) this.store.invalidate?.(repo.id);
    if (repo.status !== "ready") return;
    let head: string | null;
    try {
      head = await this.store.head(repo.id, repo.branch, opts.fresh ? { fresh: true } : undefined);
    } catch {
      return;
    }
    if (this.lastHead === head) return;
    this.treeCache = null;
    // Merge into open rooms first, so anyone woken by the notification reads the new text.
    // Our own commits move the head too; rooms that already have it treat this as a no-op.
    const results = await Promise.allSettled(this.rooms.inRepo(repo.id).map((r) => r.checkRemote()));
    // Only remember the head once every room has it, so a failed merge is retried on the next poll.
    if (results.every((r) => r.status === "fulfilled")) this.lastHead = head;
    emit({ type: "tree", repo: repo.id });
    notifyChange(repo.id);
  }

  /** Concurrent calls share one refresh; `minIntervalMs` skips pulls that just ran (other workspaces only re-check their head). */
  refresh(repo: RepoRow, minIntervalMs = 0): Promise<void> {
    this.check(repo);
    if (this.refreshing) return this.refreshing;
    const p = (async () => {
      const upstream = repo.kind === "github" && !!repo.read_only && repo.status === "ready" && !!this.store.pullUpstream;
      if (upstream && Date.now() - this.lastRefresh >= minIntervalMs) {
        // Counted from the attempt, so failures are rate limited too.
        this.lastRefresh = Date.now();
        await this.store.pullUpstream!(repo.id, repo.branch);
      }
      await this.onPush(repo, { fresh: true });
    })().finally(() => {
      if (this.refreshing === p) this.refreshing = null;
    });
    this.refreshing = p;
    return p;
  }

  async seenHead(head: string | null) {
    this.lastHead = head;
  }

  async remove() {
    for (const room of this.rooms.inRepo(this.id)) {
      if (room.dirty) await room.flush().catch(() => {});
      room.closeWith("removed");
    }
    this.treeCache = null;
    this.lastHead = undefined;
    this.lastRefresh = 0;
  }
}

/**
 * The in-process host: a Map of runtimes, made on first use. The runtimes share one store and one RoomManager
 * (keyed by workspace, so each runtime only sees its own rooms).
 */
export class RuntimeMap implements WorkspaceHost {
  protected runtimes = new Map<string, WorkspaceRuntime>();

  constructor(
    protected store: HeadCachingStore,
    readonly rooms: RoomManager,
  ) {}

  get(repoId: string): WorkspaceRuntime {
    let rt = this.runtimes.get(repoId);
    if (!rt) this.runtimes.set(repoId, (rt = new WorkspaceRuntime(repoId, this.store, this.rooms)));
    return rt;
  }

  admitFile(a: AdmittedWorkspace): Promise<WsDecision> {
    return this.get(a.repoId).admitFile(a);
  }

  forget(repoId: string) {
    this.runtimes.delete(repoId);
  }
}
