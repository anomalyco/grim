// One workspace's runtime: its rooms and its NoteStore (notes/store.ts), and the operations shared by the HTTP API,
// the note shell and MCP, so people and agents get identical behavior. Bun keeps one per workspace in a Map
// (bun/workspace-host-local.ts); on Workers a WorkspaceDO hosts one. Methods take and return plain data and throw
// errors matched by name (see seams/workspace-host.ts).
import type * as Y from "yjs";
import { createHash } from "node:crypto";
import { emit, notifyChange } from "./events.ts";
import { isErr } from "./errors.ts";
import { isUntitledPath } from "../shared/untitled.ts";
import { personOf, type Participant, type Room } from "./room.ts";
import type { RoomManager } from "./rooms.ts";
import type { RepoRow } from "./repos.ts";
import { dirPath, encodeLinkPath, escapeAlt, imagePath, IMAGE_TYPES, MAX_NOTE_BYTES, MAX_UPLOAD_BYTES, OpError, path, sniffImage, uploadName, version, writable } from "./ops.ts";
import { DEMO_FULL, demoLimits, isDemoRoom } from "./demo.ts";
import { applyToYText, diffText, rebaseSplices } from "./textdiff.ts";
import { unified } from "./notes/unified.ts";
import { authorsFromVersions, parseVersionRef, versionRef, type NoteStore, type Person, type Version } from "./notes/store.ts";
import { runNoteCommand, type NoteShellResult } from "./notes/shell.ts";
import { zip } from "./notes/zip.ts";
import type { AppEvent } from "./seams/events.ts";
import type { BlobStore } from "./seams/blobs.ts";
import { CLOSE, CODE, createWorkspaceSocket, WorkspaceSocketSet, type AdmittedSocket, type OpenErrorCode, type OpenRoomResult, type WorkspaceSocket } from "./wsmux.ts";
import type { AdmittedWorkspace, ImportNote, NoteCommand, PresenceUser, VersionSummary, WorkspaceApi, WorkspaceHost, WsDecision } from "./seams/workspace-host.ts";
const GUEST_EMAIL = "guest@grimoire.invalid";

/** Calls per minute and commands at a time, per agent caller and workspace (tests lower them). */
export const agentLimits = { perMinute: 120, concurrent: 4 };

/** Replace the whole text with `next` as a minimal edit; returns the index after the last change. */
function replaceMinimal(text: Y.Text, next: string): number {
  return applyToYText(text, diffText(text.toString(), next));
}

/** UTF-8 length of `s`, without encoding it. */
function utf8Bytes(s: string): number {
  let n = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) continue;
    if (c < 0x800) n += 1;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
      n += 2;
      i++;
    } else n += 2;
  }
  return n;
}

/** Refuse (413) an edit that leaves note `p` larger than notes may be; one that shrinks an oversized note is allowed. */
function checkNoteSize(repo: RepoRow, p: string, bytes: number, before = 0) {
  const max = isDemoRoom(repo.id) ? demoLimits.noteBytes : MAX_NOTE_BYTES;
  if (bytes > max && bytes > before) throw new OpError(413, `${p} would be too large: notes can be at most ${max / 1024 / 1024} MB`);
}

/** Whether `p` is folder `dir` or inside it ("" is the whole workspace). */
const under = (dir: string, p: string) => !dir || p === dir || p.startsWith(dir + "/");

/** How a person signs a version (the history API's author fields). */
function signature(p: Person | undefined): { name: string; email: string } {
  if (!p) return { name: "Grim", email: "grim@grimnotes.app" };
  return { name: p.kind === "guest" ? `${p.name} (guest)` : p.name, email: p.email };
}

const VERB: Record<string, string> = { edit: "Update", agent: "Update", restore: "Restore", rename: "Rename", delete: "Delete", import: "Update" };

export function summary(v: Version): VersionSummary {
  const main = signature(v.authors[0]);
  const co = v.authors.slice(1).map((a) => {
    const s = signature(a);
    return `Co-authored-by: ${s.name} <${s.email}>`;
  });
  const message = (v.message ?? `${VERB[v.kind] ?? "Update"} ${v.path}`) + (co.length ? `\n\n${co.join("\n")}` : "");
  return { sha: versionRef(v.id), message, authorName: main.name, authorEmail: main.email, date: new Date(v.ended_at).toISOString(), kind: v.kind, path: v.path };
}

/** A person from a Git-style author (imports). */
export function importedPerson(name: string, email: string): Person {
  const kind = email === GUEST_EMAIL ? "guest" : email.endsWith("@agents.grimoire") ? "agent" : "human";
  const shown = kind === "guest" ? name.replace(/ \(guest\)$/, "") : name;
  const id = kind === "human" ? `email:${email.toLowerCase()}` : `${kind}-name:${shown}`;
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  const colors = ["#e06c75", "#61afef", "#98c379", "#c678dd", "#d19a66", "#56b6c2", "#e5c07b", "#be5046"];
  return { id, name: shown || email, email, kind, color: colors[(h >>> 0) % colors.length]! };
}

/** WebSocket admission, file level: open the note's room (4404 missing, 1011 other). */
export async function admitFile(rooms: RoomManager, a: AdmittedWorkspace): Promise<WsDecision> {
  try {
    const room = await rooms.get(a.repoId, a.path);
    return { room, participant: a.participant, readOnly: a.readOnly };
  } catch (e) {
    if (isErr(e, "NotFoundError")) return { reject: { code: 4404, reason: "file not found" } };
    console.error(`[ws] open ${a.repoId}:${a.path}:`, e);
    return { reject: { code: 1011, reason: "could not open file" } };
  }
}

export class WorkspaceRuntime implements WorkspaceApi {
  /** Renames (notes and folders) run one at a time. */
  private renaming: Promise<unknown> | null = null;
  /** Protocol v2 sockets of this workspace (Bun: attachSocket) and their events. */
  readonly sockets = new WorkspaceSocketSet({ room: (p) => this.rooms.peek(this.id, p), rooms: () => this.rooms.inRepo(this.id) });
  private calls = new Map<string, { start: number; n: number }>();
  private running = new Map<string, number>();

  constructor(
    readonly id: string,
    readonly rooms: RoomManager,
    private blobs: BlobStore,
  ) {}

  get store(): NoteStore {
    return this.rooms.store(this.id);
  }

  private check(repo: RepoRow) {
    if (repo.id !== this.id) throw new Error(`workspace ${this.id} got a call for ${repo.id}`);
  }

  private room(p: string): Room {
    const r = this.rooms.getSync(this.id, p);
    if (!r) throw new OpError(404, `${p} not found in ${this.id}`);
    return r;
  }

  admitFile(a: AdmittedWorkspace): Promise<WsDecision> {
    if (a.repoId !== this.id) throw new Error(`workspace ${this.id} got a socket for ${a.repoId}`);
    return admitFile(this.rooms, a);
  }

  /** A protocol v2 socket of this workspace (in-process hosts). */
  attachSocket(a: AdmittedSocket, transport: { send(data: Uint8Array | string): void; close(code: number, reason?: string): void }): WorkspaceSocket {
    if (a.repoId !== this.id) throw new Error(`workspace ${this.id} got a socket for ${a.repoId}`);
    this.sockets.status = a.status;
    this.sockets.error = a.error;
    const sock = createWorkspaceSocket(
      {
        openRoom: (p) => this.openNote(a, p),
        send: transport.send,
        closeSocket: transport.close,
        persist() {},
        presenceChanged: (paths) => {
          for (const p of paths) this.sockets.updatePresence(p);
        },
      },
      { admission: a },
    );
    sock.start(a.status, a.error, this.sockets.presenceSnapshot());
    this.sockets.add(sock);
    return sock;
  }

  detachSocket(sock: WorkspaceSocket) {
    this.sockets.remove(sock);
    sock.closed();
  }

  closeSockets(code: number, reason: string) {
    for (const s of this.sockets.all()) s.closeSocket(code, reason);
  }

  private async openNote(a: AdmittedSocket, p: string): Promise<OpenRoomResult> {
    const status = this.sockets.status;
    if (status !== "ready") return { reject: { code: CODE.retry, reason: `workspace ${status}` } };
    const d = await admitFile(this.rooms, { repoId: a.repoId, path: p, participant: a.participant, readOnly: a.readOnly });
    return "reject" in d ? { reject: { code: d.reject.code as OpenErrorCode, reason: d.reject.reason } } : { room: d.room };
  }

  /** An app event of this workspace, for its v2 sockets (presence, tree, saved, workspace). */
  async socketEvent(e: AppEvent) {
    if (!("repo" in e) || e.repo !== this.id || !this.sockets.size) return;
    switch (e.type) {
      case "presence":
        return this.sockets.updatePresence(e.path);
      case "saved":
        return this.sockets.broadcast({ t: "saved", path: e.path, sha: e.sha });
      case "workspace":
        return this.sockets.broadcast({ t: "workspace", status: e.status, ...(e.error ? { error: e.error } : {}) });
      case "tree":
        return this.sockets.broadcast({ t: "tree", head: this.treeTag() });
    }
  }

  private treeTag(): string {
    return createHash("sha1").update(this.store.paths().join("\n")).digest("hex").slice(0, 16);
  }

  // ---- reading ----

  async readFile(repo: RepoRow, p: string, ref?: string) {
    this.check(repo);
    p = path(p);
    if (ref) {
      const v = this.versionOf(p, ref);
      return { path: p, content: v.text, version: version(v.text), live: false };
    }
    const open = this.rooms.peek(this.id, p);
    const text = open ? open.text.toString() : this.store.byPath(p)?.text;
    if (text === undefined) throw new OpError(404, `${p} not found`);
    return { path: p, content: text, version: version(text), live: true };
  }

  /** Version `ref` of the note at `p` (a live note, or the newest deleted one with that path). */
  private versionOf(p: string, ref: string): Version {
    const id = parseVersionRef(ref);
    const v = id === null ? null : this.store.version(id);
    const note = this.store.anyByPath(p);
    if (!v || (note && v.note_id !== note.id && v.path !== p) || (!note && v.path !== p)) throw new OpError(404, `${p} not found at ${ref}`);
    return v;
  }

  async readRaw(repo: RepoRow, p: string) {
    this.check(repo);
    const { path: ip, type } = imagePath(p);
    const img = this.store.image(ip);
    const bytes = img ? await this.blobs.get(`${this.id}/${img.sha256}`) : null;
    if (!img || !bytes) throw new OpError(404, `${ip} not found`);
    return { path: ip, type, bytes, sha256: img.sha256 };
  }

  async tree(repo: RepoRow): Promise<string[]> {
    this.check(repo);
    return this.store.paths();
  }

  async head(repo: RepoRow) {
    this.check(repo);
    return this.treeTag();
  }

  async history(repo: RepoRow, p: string | undefined, limit = 50): Promise<VersionSummary[]> {
    this.check(repo);
    limit = Math.min(Math.max(limit, 1), 200);
    if (!p) return this.store.versionsUnder("", limit).map(summary);
    const note = this.store.anyByPath(path(p));
    if (note) return this.store.versions(note.id, limit).map(summary);
    return this.store.versionsUnder(dirPath(p), limit).map(summary);
  }

  async diff(repo: RepoRow, sha: string, p?: string) {
    this.check(repo);
    const id = parseVersionRef(sha);
    const v = id === null ? null : this.store.version(id);
    if (!v) throw new OpError(404, `version ${sha} not found`);
    if (p && !under(dirPath(p), v.path) && v.path !== path(p) && this.store.anyByPath(path(p))?.id !== v.note_id) return "";
    if (v.kind === "delete") return unified(v.path, v.text, null);
    const prev = this.store.previous(v);
    return unified(v.path, prev ? prev.text : null, v.text);
  }

  async search(repo: RepoRow, q: string) {
    this.check(repo);
    return { hits: this.store.search(q, 100) };
  }

  async who(repo: RepoRow, p: string): Promise<PresenceUser[]> {
    this.check(repo);
    return this.sockets.presence(path(p));
  }

  // ---- writing ----

  async createFile(repo: RepoRow, p: string, content: string | undefined, actor: Participant) {
    this.check(repo);
    writable(repo);
    p = path(p);
    const base = p.split("/").pop()!.replace(/\.(md|markdown|mdx)$/i, "");
    const text = content ?? `# ${base}\n`;
    checkNoteSize(repo, p, utf8Bytes(text));
    if (this.store.byPath(p)) throw new OpError(409, `${p} already exists`);
    const now = Date.now();
    const me = personOf(actor);
    this.store.create(p, text, { authors: { people: [me], lines: text.split("\n").map(() => 0) }, pending: { started: now, last: now, authors: [{ ...me, edits: 1 }] } });
    emit({ type: "tree", repo: repo.id });
    notifyChange(repo.id, p);
    return { path: p, version: version(text) };
  }

  /**
   * Apply the change `base` → `next` to the live text, keeping edits that others made since `base` was read.
   * Fails (409) if both touched the same or adjacent places.
   */
  async patchFile(repo: RepoRow, p: string, base: string, next: string, actor: Participant) {
    this.check(repo);
    writable(repo);
    p = path(p);
    const r = this.room(p);
    this.patchRoom(repo, r, base, next, actor);
    return { path: p, version: version(r.text.toString()) };
  }

  private patchRoom(repo: RepoRow, r: Room, base: string, next: string, actor: Participant) {
    const cur = r.text.toString();
    const theirs = cur === base ? [] : diffText(base, cur);
    const ours = rebaseSplices(theirs, diffText(base, next));
    if (!ours) throw new OpError(409, `${r.path} was changed by someone else at the same place since you read it; read it again and redo the edit`);
    const now = utf8Bytes(cur);
    checkNoteSize(repo, r.path, now + utf8Bytes(next) - utf8Bytes(base), now);
    r.agentEdit(actor, (t) => applyToYText(t, ours));
  }

  async appendText(repo: RepoRow, p: string, text: string, actor: Participant) {
    this.check(repo);
    writable(repo);
    p = path(p);
    const r = this.room(p);
    const now = utf8Bytes(r.text.toString());
    checkNoteSize(repo, p, now + utf8Bytes(text), now);
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
    const old = this.versionOf(p, sha).text;
    const r = this.room(p);
    r.cut("edit");
    r.agentEdit(actor, (t) => replaceMinimal(t, old));
    r.cut("restore", { force: true, by: actor, message: `Restore ${p} to ${sha}` });
    return { path: p };
  }

  async deleteFile(repo: RepoRow, p: string, actor: Participant): Promise<{ ok: true }> {
    this.check(repo);
    writable(repo);
    p = path(p);
    this.deleteNote(p, actor);
    emit({ type: "tree", repo: repo.id });
    return { ok: true };
  }

  /** A note goes: its open version is cut, then a delete version; the row is kept (deleted) with its history. */
  private deleteNote(p: string, actor: Participant) {
    const open = this.rooms.peek(this.id, p);
    if (open) {
      open.cut("edit");
      open.closeWith("deleted");
    }
    const note = this.store.byPath(p);
    if (!note) throw new OpError(404, `${p} not found`);
    if (note.pending) this.store.cutVersion(note.id, { kind: "edit", path: p, text: note.text, started: note.pending.started, ended: note.pending.last, authors: note.pending.authors, lines: note.authors });
    this.store.cutVersion(note.id, { kind: "delete", path: p, text: note.text, started: Date.now(), authors: [{ ...personOf(actor), edits: 1 }], lines: note.authors, message: `Delete ${p}` });
    this.store.softDelete(note.id);
    notifyChange(this.id, p);
  }

  private queued<T>(fn: () => Promise<T>): Promise<T> {
    const next = (this.renaming ?? Promise.resolve()).then(fn, fn);
    const tail = next.catch(() => {});
    this.renaming = tail;
    void tail.then(() => this.renaming === tail && (this.renaming = null));
    return next;
  }

  renameFile(repo: RepoRow, from: string, to: string, actor: Participant, opts: { ifUntitled?: boolean } = {}) {
    this.check(repo);
    return this.queued(async () => {
      writable(repo);
      from = path(from);
      to = path(to);
      if (opts.ifUntitled && !isUntitledPath(from)) throw new OpError(409, `${from} isn't untitled`);
      if (from === to) return { path: to };
      if (this.store.byPath(to)) throw new OpError(409, `${to} already exists`);
      if (!this.store.byPath(from)) throw new OpError(404, `${from} not found`);
      this.moveNote(from, to, actor);
      emit({ type: "tree", repo: repo.id });
      return { path: to };
    });
  }

  /** Move one note: its room closes ("renamed", clients reopen the new path: same note, same epoch, same document). */
  private moveNote(from: string, to: string, actor: Participant) {
    const open = this.rooms.peek(this.id, from);
    if (open) open.cut("edit");
    const note = this.store.byPath(from)!;
    // closed first (it compacts), renamed before anyone can reopen it
    open?.closeWith("renamed", { to });
    this.store.rename(note.id, to);
    const now = this.store.byId(note.id)!;
    if (now.pending) this.store.cutVersion(note.id, { kind: "edit", path: from, text: now.text, started: now.pending.started, ended: now.pending.last, authors: now.pending.authors, lines: now.authors });
    this.store.cutVersion(note.id, { kind: "rename", path: to, text: now.text, started: Date.now(), authors: [{ ...personOf(actor), edits: 1 }], lines: now.authors, message: `Rename ${from} to ${to}` });
    notifyChange(this.id, from);
    notifyChange(this.id, to);
  }

  renameFolder(repo: RepoRow, from: string, to: string, actor: Participant) {
    this.check(repo);
    return this.queued(async () => {
      writable(repo);
      from = dirPath(from);
      to = dirPath(to);
      if (from === to) return { path: to };
      if (to.startsWith(`${from}/`)) throw new OpError(400, `can't move ${from} into itself`);
      const paths = this.store.paths();
      if (paths.some((f) => f.startsWith(`${to}/`))) throw new OpError(409, `${to} already exists`);
      const moving = paths.filter((f) => f.startsWith(`${from}/`));
      const images = this.store.imagesUnder(from);
      if (!moving.length && !images.length) throw new OpError(404, `${from} not found`);
      for (const f of moving) this.moveNote(f, to + f.slice(from.length), actor);
      for (const i of images) this.store.moveImage(i.path, to + i.path.slice(from.length));
      emit({ type: "tree", repo: repo.id });
      return { path: to };
    });
  }

  async deleteFolder(repo: RepoRow, dir: string, actor: Participant): Promise<{ ok: true }> {
    this.check(repo);
    writable(repo);
    dir = dirPath(dir);
    const notes = this.store.paths().filter((f) => f.startsWith(`${dir}/`));
    const images = this.store.imagesUnder(dir);
    if (!notes.length && !images.length) throw new OpError(404, `${dir} not found`);
    for (const f of notes) this.deleteNote(f, actor);
    for (const i of images) this.store.deleteImage(i.path);
    emit({ type: "tree", repo: repo.id });
    return { ok: true };
  }

  /**
   * Store an uploaded image in `images/` next to note `notePath` (bytes content-addressed, the path mapped to them).
   * The name is kept; another image with that name gets `name-2.png`…; an identical one already there is reused.
   */
  async uploadImage(repo: RepoRow, notePath: string, filename: string, bytes: Uint8Array, actor: Participant) {
    this.check(repo);
    writable(repo);
    const note = path(notePath);
    if (!bytes.length) throw new OpError(400, "the file is empty");
    const max = isDemoRoom(repo.id) ? demoLimits.imageBytes : MAX_UPLOAD_BYTES;
    if (bytes.length > max) throw new OpError(413, `images can be at most ${max / 1024 / 1024} MB`);
    const sniffed = sniffImage(bytes);
    if (!sniffed) throw new OpError(415, `not an image (${Object.keys(IMAGE_TYPES).join(", ")})`);
    const { name, stem, ext } = uploadName(filename, sniffed);
    const dir = [...note.split("/").slice(0, -1), "images"].join("/");
    const candidate = (n: number) => imagePath(`${dir}/${n === 1 ? name : `${stem}-${n}.${ext}`}`).path;
    const result = (p: string, reused: boolean) => {
      const markdownPath = encodeLinkPath(p.slice(dir.length - "images".length));
      return { path: p, markdownPath, markdown: `![${escapeAlt(stem)}](${markdownPath})`, reused };
    };
    const sha = createHash("sha256").update(bytes).digest("hex");
    for (let n = 1; n <= 1000; n++) {
      const cand = candidate(n);
      const existing = this.store.image(cand);
      if (existing?.sha256 === sha) return result(cand, true);
      if (existing) continue;
      if (isDemoRoom(repo.id) && this.store.images().reduce((s, i) => s + i.size, 0) + bytes.length > demoLimits.imagesBytes) throw new OpError(413, DEMO_FULL);
      await this.blobs.put(`${this.id}/${sha}`, bytes, IMAGE_TYPES[ext]);
      this.store.putImage({ path: cand, sha256: sha, type: imagePath(cand).type, size: bytes.length }, actor.id);
      return result(cand, false);
    }
    throw new OpError(409, `too many images named ${name}`);
  }

  // ---- the note shell ----

  private limited(key: string): number {
    const now = Date.now();
    if (this.calls.size > 10_000) for (const [k, v] of this.calls) if (now - v.start >= 60_000) this.calls.delete(k);
    const c = this.calls.get(key);
    if (!c || now - c.start >= 60_000) {
      this.calls.set(key, { start: now, n: 1 });
      return 0;
    }
    return ++c.n > agentLimits.perMinute ? Math.max(1, Math.ceil((c.start + 60_000 - now) / 1000)) : 0;
  }

  async noteCommand(repo: RepoRow, p: string, cmd: NoteCommand, actor: Participant): Promise<NoteShellResult> {
    this.check(repo);
    p = path(p);
    const wait = this.limited(cmd.limitKey);
    if (wait) throw new OpError(429, `Too many calls: at most ${agentLimits.perMinute} per minute. Retry in ${wait} s.`);
    if ((this.running.get(cmd.limitKey) ?? 0) >= agentLimits.concurrent) throw new OpError(429, `${agentLimits.concurrent} commands are already running; wait for them to finish`);
    const note = this.store.byPath(p);
    if (!note && !cmd.create) throw new OpError(404, `${p} doesn't exist (creating notes needs an account: send Authorization: Bearer <token>)`);
    const room = note ? this.room(p) : null;
    const base = room ? room.text.toString() : null;
    const noteId = note?.id ?? null;
    const store = this.store;
    this.running.set(cmd.limitKey, (this.running.get(cmd.limitKey) ?? 0) + 1);
    let r: NoteShellResult;
    try {
      r = await runNoteCommand({
        name: p.split("/").pop()!,
        text: base,
        command: cmd.command,
        timeoutMs: cmd.timeoutMs,
        user: actor.name,
        host: {
          history: (n) =>
            noteId
              ? store.versions(noteId, n).map((v) => {
                  const s = summary(v);
                  return { id: s.sha, date: s.date.replace(/\.\d+Z$/, "Z"), author: s.authorName, kind: v.kind, message: v.kind === "rename" || v.kind === "restore" ? (v.message ?? "") : "" };
                })
              : [],
          show: (id) => {
            const v = noteId ? store.version(parseVersionRef(id) ?? 0) : null;
            return v && v.note_id === noteId ? v.text : null;
          },
          diff: (id) => {
            const v = noteId ? store.version(parseVersionRef(id) ?? 0) : null;
            if (!v || v.note_id !== noteId) return null;
            const prev = store.previous(v);
            return unified(v.path, prev ? prev.text : null, v.text) || "(no changes)\n";
          },
          who: () => this.sockets.presence(p).map((u) => ({ name: u.name, kind: u.kind })),
        },
      });
    } finally {
      const n = (this.running.get(cmd.limitKey) ?? 1) - 1;
      if (n > 0) this.running.set(cmd.limitKey, n);
      else this.running.delete(cmd.limitKey);
    }
    if (r.wrote === undefined) return r;
    const note2 = (msg: string) => {
      r.stderr += `[grim: ${msg}]\n`;
      if (r.exitCode === 0) r.exitCode = 1;
    };
    if (r.wrote === null) {
      note2(`${p.split("/").pop()} can't be deleted from the shell; nothing was changed`);
      delete r.wrote;
      return r;
    }
    try {
      if (!room) {
        await this.createFile(repo, p, r.wrote, actor);
        this.room(p).cut("agent", { force: true, by: actor });
      } else {
        writable(repo);
        if (room.closed) throw new OpError(409, `${p} was closed (renamed or deleted) while the command ran`);
        // people's edits not cut yet are their own version; the agent's write is its own
        room.cut("edit");
        this.patchRoom(repo, room, base!, r.wrote, actor);
        room.cut("agent", { by: actor });
      }
    } catch (e) {
      note2(`not saved: ${e instanceof Error ? e.message : String(e)}`);
      delete r.wrote;
    }
    return r;
  }

  // ---- export, import, epochs, removal ----

  async exportZip(repo: RepoRow): Promise<Uint8Array<ArrayBuffer>> {
    this.check(repo);
    for (const r of this.rooms.inRepo(this.id)) r.compact();
    const notes = this.store.list().map((n) => ({ path: n.path, data: this.store.byPath(n.path)!.text }));
    const images: Array<{ path: string; data: Uint8Array }> = [];
    for (const i of this.store.images()) {
      const bytes = await this.blobs.get(`${this.id}/${i.sha256}`);
      if (bytes) images.push({ path: i.path, data: bytes });
    }
    const versions = this.store.allVersions().map((v) => ({ ...summary(v), note: v.note_id, text: v.text }));
    return zip([...notes, ...images, { path: ".grim/versions.json", data: JSON.stringify({ workspace: { id: repo.id, title: repo.title }, exported: new Date().toISOString(), versions }, null, 1) }]);
  }

  async importNotes(repo: RepoRow, notes: ImportNote[], images: Array<{ path: string; base64: string }>): Promise<string[]> {
    this.check(repo);
    const made: string[] = [];
    for (const n of notes) {
      const p = path(n.path);
      if (this.store.byPath(p)) continue;
      const versions = n.versions.map((v) => ({ ...v, person: importedPerson(v.authorName, v.authorEmail), at: Date.parse(v.date) || Date.now() }));
      const lines = versions.length ? authorsFromVersions([...versions.map((v) => ({ text: v.text, author: v.person })), { text: n.text, author: versions.at(-1)!.person }]) : null;
      const note = this.store.create(p, n.text, { authors: lines, now: versions[0]?.at });
      for (const v of versions) {
        const vl = authorsFromVersions(versions.slice(0, versions.indexOf(v) + 1).map((x) => ({ text: x.text, author: x.person })));
        this.store.cutVersion(note.id, { kind: "import", path: p, text: v.text, started: v.at, ended: v.at, authors: [{ ...v.person, edits: 1 }], lines: vl, message: v.message?.split("\n")[0] || null });
      }
      if (!versions.length || versions.at(-1)!.text !== n.text) this.store.cutVersion(note.id, { kind: "import", path: p, text: n.text, started: Date.now(), authors: [], lines, message: `Import ${p}` });
      made.push(p);
    }
    for (const i of images) {
      const bytes = new Uint8Array(Buffer.from(i.base64, "base64"));
      const { path: ip, type } = imagePath(i.path);
      const sha = createHash("sha256").update(bytes).digest("hex");
      await this.blobs.put(`${this.id}/${sha}`, bytes, type);
      this.store.putImage({ path: ip, sha256: sha, type, size: bytes.length }, null);
    }
    emit({ type: "tree", repo: repo.id });
    return made;
  }

  async bumpEpochs(): Promise<number> {
    for (const r of this.rooms.inRepo(this.id)) {
      for (const c of [...r.conns]) c.close(1013, "reset");
      r.destroy();
    }
    let n = 0;
    for (const p of this.store.paths()) {
      const note = this.store.byPath(p)!;
      this.store.bumpEpoch(note.id);
      n++;
    }
    return n;
  }

  async remove() {
    for (const room of this.rooms.inRepo(this.id)) room.closeWith("removed");
    if (this.sockets.size) {
      this.sockets.broadcast({ t: "workspace", status: "removed" });
      this.closeSockets(CLOSE.notFound, "workspace removed");
    }
    for (const i of this.store.images()) await this.blobs.delete(`${this.id}/${i.sha256}`).catch(() => {});
    this.store.wipe();
  }
}

/**
 * The in-process host: a Map of runtimes, made on first use, sharing one RoomManager (keyed by workspace).
 */
export class RuntimeMap implements WorkspaceHost {
  protected runtimes = new Map<string, WorkspaceRuntime>();

  constructor(
    readonly rooms: RoomManager,
    protected blobsFor: (repoId: string) => BlobStore,
  ) {}

  get(repoId: string): WorkspaceRuntime {
    let rt = this.runtimes.get(repoId);
    if (!rt) this.runtimes.set(repoId, (rt = new WorkspaceRuntime(repoId, this.rooms, this.blobsFor(repoId))));
    return rt;
  }

  admitFile(a: AdmittedWorkspace): Promise<WsDecision> {
    return this.get(a.repoId).admitFile(a);
  }

  forget(repoId: string) {
    this.runtimes.delete(repoId);
  }
}
