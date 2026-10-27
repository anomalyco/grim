import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { db, newId } from "./db.ts";
import { config } from "./config.ts";
import { emit, notifyChange } from "./events.ts";
import { applyDiff } from "./textdiff.ts";
import type { Author, CommitOutcome, GitStore } from "./store/types.ts";
import type { PresenceState, PresenceUser } from "../shared/presence.ts";

export const MSG_SYNC = 0;
export const MSG_AWARENESS = 1;
export const MSG_CONTROL = 2;

export const TEXT_NAME = "md";

export interface Participant {
  id: string;
  name: string;
  email: string;
  kind: "human" | "agent";
  color: string;
  avatar?: string;
}

export interface Conn {
  user: Participant;
  readOnly: boolean;
  /** What this connection may do now (re-checked when a workspace's access settings change). */
  access?: () => Promise<"write" | "read" | "none">;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  awarenessIds: Set<number>;
}

export class NotFoundError extends Error {}

const EXTERNAL = Symbol("external");
const LOAD = Symbol("load");

interface Contributor {
  id: string;
  author: Author;
  edits: number;
}

/** Agents get awareness client ids above the uint32 range that Yjs clients pick theirs from. */
const AGENT_ID_BASE = 2 ** 32;
/** How many awareness client ids one websocket may own (a client may switch docs once on a generation change). */
const MAX_IDS_PER_CONN = 2;

export function agentClientId(agentId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < agentId.length; i++) h = Math.imul(h ^ agentId.charCodeAt(i), 0x01000193) >>> 0;
  return AGENT_ID_BASE + h;
}

export class Room {
  readonly key: string;
  readonly doc = new Y.Doc({ gc: false });
  readonly text = this.doc.getText(TEXT_NAME);
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  readonly conns = new Set<Conn>();
  generation = newId();
  baseCommit: string | null = null;
  baseContent = "";
  /** Whether the file exists at baseCommit. */
  inBase = false;
  private baseSnapshot = Y.snapshot(this.doc);
  private contributors = new Map<string, Contributor>();
  private quietTimer: ReturnType<typeof setTimeout> | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  /** Which connection owns each human awareness client id. */
  private owners = new Map<number, Conn>();
  private lastActivity = Date.now();
  version = 0;
  dirty = false;
  saving = false;
  savedAt: number | null = null;
  closed = false;

  constructor(
    readonly repo: string,
    readonly path: string,
    readonly branch: string,
    private store: GitStore,
    private onClose: (room: Room) => void,
  ) {
    this.key = roomKey(repo, path);
    // The server has no local user of its own.
    this.awareness.setLocalState(null);

    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === LOAD || this.closed) return;
      db.query("INSERT INTO room_updates (room, data) VALUES (?, ?)").run(this.key, update);
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      const msg = encoding.toUint8Array(enc);
      for (const c of this.conns) if (c !== origin) c.send(msg);
      this.version++;
      this.lastActivity = Date.now();
      notifyChange(this.repo, this.path);
      if (origin === EXTERNAL) return;
      const who = (origin as { user?: Participant } | null)?.user;
      if (who) {
        const c = this.contributors.get(who.id) ?? { id: who.id, author: { name: who.name, email: who.email }, edits: 0 };
        c.edits++;
        this.contributors.set(who.id, c);
      }
      this.markDirty();
    });

    this.awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      const changed = [...added, ...updated, ...removed];
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
      const msg = encoding.toUint8Array(enc);
      for (const c of this.conns) c.send(msg);
      if (added.length || removed.length) this.emitPresence();
    });
  }

  /** Load from the crash log if present, otherwise from Git. */
  async load(create: string | null) {
    const meta = db.query("SELECT * FROM room_meta WHERE room = ?").get(this.key) as
      | { generation: string; base_commit: string | null; base_content: string; base_snapshot: Uint8Array }
      | null;
    if (meta) {
      const rows = db.query("SELECT data FROM room_updates WHERE room = ? ORDER BY seq").all(this.key) as Array<{ data: Uint8Array }>;
      Y.transact(this.doc, () => {
        for (const r of rows) Y.applyUpdate(this.doc, r.data, LOAD);
      }, LOAD);
      this.generation = meta.generation;
      this.baseCommit = meta.base_commit;
      this.baseContent = meta.base_content;
      this.baseSnapshot = Y.decodeSnapshot(meta.base_snapshot);
      this.inBase = meta.base_commit !== null && (await this.store.readFile(this.repo, this.path, meta.base_commit)) !== null;
      if (this.closed) return;
      this.dirty = this.isDirty();
      // Pick up anything that landed in Git while we were down.
      await this.checkRemote().catch((e) => console.error(`[room ${this.key}] check after recovery failed:`, e));
      if (this.dirty && !this.closed) this.scheduleFlush();
      return;
    }
    const head = await this.store.head(this.repo, this.branch);
    const content = head ? await this.store.readFile(this.repo, this.path, head) : null;
    if (this.closed) return;
    if (content === null && create === null) throw new NotFoundError(`${this.path} not found`);
    this.baseCommit = head;
    this.inBase = content !== null;
    // For a new file the committed base is "nothing", so the initial text counts as an edit.
    this.baseContent = content ?? "";
    this.doc.transact(() => this.text.insert(0, this.baseContent), LOAD);
    this.baseSnapshot = content === null ? Y.emptySnapshot : Y.snapshot(this.doc);
    this.saveMeta();
    if (content === null && create) {
      this.doc.transact(() => this.text.insert(0, create), { user: SYSTEM });
    }
    this.dirty = this.isDirty();
    if (this.dirty) this.scheduleFlush();
  }

  /** Persist the base and compact the crash log to a single update holding the whole document. */
  private saveMeta() {
    db.transaction(() => {
      db.query(
        `INSERT INTO room_meta (room, generation, base_commit, base_content, base_snapshot) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(room) DO UPDATE SET generation = excluded.generation, base_commit = excluded.base_commit,
           base_content = excluded.base_content, base_snapshot = excluded.base_snapshot`,
      ).run(this.key, this.generation, this.baseCommit, this.baseContent, Y.encodeSnapshot(this.baseSnapshot));
      db.query("DELETE FROM room_updates WHERE room = ?").run(this.key);
      db.query("INSERT INTO room_updates (room, data) VALUES (?, ?)").run(this.key, Y.encodeStateAsUpdate(this.doc));
    })();
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn);
    this.lock = next.catch(() => {});
    return next;
  }

  private isDirty() {
    return !this.inBase || this.text.toString() !== this.baseContent;
  }

  private setDirty(dirty: boolean) {
    if (dirty !== this.dirty) {
      this.dirty = dirty;
      this.broadcastStatus();
    }
  }

  private markDirty() {
    this.setDirty(true);
    this.scheduleFlush();
  }

  private scheduleFlush(ms = config.quietMs) {
    if (this.closed) return;
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => {
      this.quietTimer = null;
      void this.flush().catch((e) => console.error(`[room ${this.key}] flush failed:`, e));
    }, ms);
  }

  /** Commit the current text to the branch (after merging in anything that landed there first). */
  flush(): Promise<void> {
    if (this.quietTimer) {
      clearTimeout(this.quietTimer);
      this.quietTimer = null;
    }
    return this.serial(async () => {
      let ok = false;
      try {
        await this.commitNow();
        ok = true;
      } finally {
        // Whoever called us, unsaved text always gets another attempt (backing off after a failure).
        if (!this.closed && this.dirty) this.scheduleFlush(ok ? config.quietMs : Math.max(config.quietMs, 5000));
        else if (this.quietTimer) {
          clearTimeout(this.quietTimer);
          this.quietTimer = null;
        }
      }
    });
  }

  private commitNow(): Promise<void> {
    // Rooms of the same repo commit one at a time: they all move the same branch, so committing in parallel
    // would make them conflict with each other. Conflicts now only come from outside pushes.
    return withRepoLock(this.repo, () => this.commitLoop());
  }

  private async commitLoop() {
    for (let attempt = 0; attempt < 6; attempt++) {
      if (this.closed) return;
      if (!this.isDirty()) {
        // Same text, but maybe different CRDT items (deleted and retyped): rebase the snapshot on the live items,
        // so the next 3-way merge replays outside changes onto text that still exists.
        this.baseSnapshot = Y.snapshot(this.doc);
        this.saveMeta();
        this.contributors.clear();
        this.setDirty(false);
        return;
      }
      const head = await this.store.head(this.repo, this.branch);
      if (this.closed) return;
      if (head !== this.baseCommit) {
        if (await this.absorb(head)) return;
        continue;
      }
      // Capture content and snapshot together, synchronously, before awaiting the commit.
      const content = this.text.toString();
      const snap = Y.snapshot(this.doc);
      const contributors = [...this.contributors.values()].sort((a, b) => b.edits - a.edits);
      this.contributors.clear();
      this.saving = true;
      this.broadcastStatus();
      const author = contributors[0]?.author ?? { name: "Grimoire", email: "grimoire@users.noreply.code.storage" };
      const coauthors = contributors.slice(1).map((c) => `Co-authored-by: ${c.author.name} <${c.author.email}>`);
      const verb = this.inBase ? "Update" : "Create";
      const message = `${verb} ${this.path}` + (coauthors.length ? `\n\n${coauthors.join("\n")}` : "");
      let res: CommitOutcome | null = null;
      try {
        res = await this.store.commit({
          repo: this.repo,
          branch: this.branch,
          expectedHead: head,
          changes: [{ path: this.path, content }],
          message,
          author,
        });
      } finally {
        this.saving = false;
        if (!res?.ok) {
          for (const c of contributors) {
            const now = this.contributors.get(c.id);
            this.contributors.set(c.id, now ? { ...now, edits: now.edits + c.edits } : c);
          }
          this.broadcastStatus();
        }
      }
      if (this.closed) return;
      if (!res.ok) continue;
      this.baseCommit = res.sha;
      this.baseContent = content;
      this.baseSnapshot = snap;
      this.inBase = true;
      this.savedAt = Date.now();
      this.saveMeta();
      this.dirty = this.isDirty();
      this.broadcastStatus();
      emit({ type: "saved", repo: this.repo, path: this.path, sha: res.sha });
      if (verb === "Create") emit({ type: "tree", repo: this.repo });
      return;
    }
    throw new Error("could not commit after repeated conflicts");
  }

  /** Bring the room up to date with the branch tip. Returns true if the file was deleted and the room closed. */
  checkRemote(): Promise<boolean> {
    return this.serial(async () => {
      if (this.closed) return true;
      const head = await this.store.head(this.repo, this.branch);
      if (this.closed) return true;
      if (head === this.baseCommit) return false;
      return this.absorb(head);
    });
  }

  /**
   * 3-way merge of the branch tip into the live text: replay the change (base → remote) on a copy of the
   * document as it was at the base snapshot, then merge that copy's update into the live document.
   * Local edits made since the base are preserved by the CRDT.
   */
  private async absorb(head: string | null): Promise<boolean> {
    const remote = head ? await this.store.readFile(this.repo, this.path, head) : null;
    if (this.closed) return true;
    if (remote === null) {
      if (!this.isDirty()) {
        this.closeWith("deleted");
        return true;
      }
      // Deleted (or never created) upstream while we have unsaved text: keep it; the next commit recreates the file.
      this.baseCommit = head;
      this.baseContent = "";
      this.baseSnapshot = Y.emptySnapshot;
      this.inBase = false;
      this.saveMeta();
    } else {
      if (remote !== this.baseContent) {
        const baseDoc = Y.createDocFromSnapshot(this.doc, this.baseSnapshot, new Y.Doc({ gc: false }));
        const before = Y.encodeStateVector(baseDoc);
        baseDoc.transact(() => applyDiff(baseDoc.getText(TEXT_NAME), this.baseContent, remote));
        const update = Y.encodeStateAsUpdate(baseDoc, before);
        this.baseSnapshot = Y.snapshot(baseDoc);
        Y.applyUpdate(this.doc, update, EXTERNAL);
        baseDoc.destroy();
        this.sendControl({ t: "external", commit: head });
      }
      this.baseCommit = head;
      this.baseContent = remote;
      this.inBase = true;
      this.saveMeta();
    }
    this.setDirty(this.isDirty());
    if (this.dirty) this.scheduleFlush();
    return false;
  }

  // ---- connections ----

  addConn(conn: Conn) {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    this.conns.add(conn);
    this.sendControlTo(conn, { t: "hello", generation: this.generation, readOnly: conn.readOnly, ...this.status() });
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, this.doc);
    conn.send(encoding.toUint8Array(enc));
    const states = [...this.awareness.getStates().keys()];
    if (states.length) {
      const a = encoding.createEncoder();
      encoding.writeVarUint(a, MSG_AWARENESS);
      encoding.writeVarUint8Array(a, awarenessProtocol.encodeAwarenessUpdate(this.awareness, states));
      conn.send(encoding.toUint8Array(a));
    }
    this.emitPresence();
  }

  removeConn(conn: Conn) {
    if (!this.conns.delete(conn) || this.closed) return;
    for (const id of conn.awarenessIds) if (this.owners.get(id) === conn) this.owners.delete(id);
    awarenessProtocol.removeAwarenessStates(this.awareness, [...conn.awarenessIds], null);
    this.emitPresence();
    if (this.conns.size === 0) this.scheduleClose();
  }

  onMessage(conn: Conn, data: Uint8Array) {
    if (this.closed) return;
    const dec = decoding.createDecoder(data);
    const type = decoding.readVarUint(dec);
    if (type === MSG_SYNC) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      if (conn.readOnly) {
        const sub = decoding.readVarUint(dec);
        if (sub === syncProtocol.messageYjsSyncStep1) syncProtocol.readSyncStep1(dec, enc, this.doc);
      } else {
        syncProtocol.readSyncMessage(dec, enc, this.doc, conn);
      }
      if (encoding.length(enc) > 1) conn.send(encoding.toUint8Array(enc));
    } else if (type === MSG_AWARENESS) {
      const update = this.ownAwareness(conn, decoding.readVarUint8Array(dec));
      if (update) awarenessProtocol.applyAwarenessUpdate(this.awareness, update, conn);
    } else if (type === MSG_CONTROL) {
      const msg = JSON.parse(decoding.readVarString(dec)) as { t: string };
      if (msg.t === "flush" && !conn.readOnly) void this.flush().catch((e) => console.error(`[room ${this.key}] flush:`, e));
    }
  }

  /**
   * Keep only the entries of an awareness update that this connection may write: client ids it owns (claiming
   * up to MAX_IDS_PER_CONN unowned ones), never agents' or another connection's. The user is always the
   * connection's own, so nobody can show up under someone else's name.
   */
  private ownAwareness(conn: Conn, update: Uint8Array): Uint8Array | null {
    const entries: Array<[number, number, string]> = [];
    const dec = decoding.createDecoder(update);
    const n = decoding.readVarUint(dec);
    for (let i = 0; i < n; i++) {
      const id = decoding.readVarUint(dec);
      const clock = decoding.readVarUint(dec);
      let state = JSON.parse(decoding.readVarString(dec)) as unknown;
      if (id >= AGENT_ID_BASE || id === this.awareness.clientID) continue;
      const owner = this.owners.get(id);
      if (owner !== conn) {
        if (owner || conn.awarenessIds.size >= MAX_IDS_PER_CONN) continue;
        this.owners.set(id, conn);
        conn.awarenessIds.add(id);
      }
      if (state !== null) {
        if (typeof state !== "object" || Array.isArray(state)) continue;
        const u = conn.user;
        const user: PresenceUser = { id: u.id, name: u.name, color: u.color, kind: u.kind, ...(u.avatar ? { avatar: u.avatar } : {}) };
        state = { ...state, user };
      }
      entries.push([id, clock, JSON.stringify(state)]);
    }
    if (!entries.length) return null;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, entries.length);
    for (const [id, clock, state] of entries) {
      encoding.writeVarUint(enc, id);
      encoding.writeVarUint(enc, clock);
      encoding.writeVarString(enc, state);
    }
    return encoding.toUint8Array(enc);
  }

  status() {
    return { dirty: this.dirty, saving: this.saving, commit: this.baseCommit, savedAt: this.savedAt };
  }

  broadcastStatus() {
    this.sendControl({ t: "status", ...this.status() });
  }

  sendControl(msg: object) {
    if (this.closed) return;
    for (const c of this.conns) this.sendControlTo(c, msg);
  }

  private sendControlTo(conn: Conn, msg: object) {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_CONTROL);
    encoding.writeVarString(enc, JSON.stringify(msg));
    conn.send(encoding.toUint8Array(enc));
  }

  participants() {
    const seen = new Map<string, { id: string; name: string; color: string; kind: string }>();
    for (const s of this.awareness.getStates().values()) {
      const u = (s as PresenceState | undefined)?.user;
      if (u) seen.set(u.id, { id: u.id, name: u.name, color: u.color, kind: u.kind });
    }
    for (const c of this.conns) if (!seen.has(c.user.id)) seen.set(c.user.id, { id: c.user.id, name: c.user.name, color: c.user.color, kind: c.user.kind });
    return [...seen.values()];
  }

  private emitPresence() {
    emit({ type: "presence", repo: this.repo, path: this.path, users: this.participants() });
  }

  // ---- agents ----

  /** Apply an edit on behalf of an agent and show its cursor at `cursorIndex()` for a while. */
  agentEdit(agent: Participant, fn: (text: Y.Text) => number | void) {
    this.lastActivity = Date.now();
    let cursor: number | void = undefined;
    this.doc.transact(() => {
      cursor = fn(this.text);
    }, { user: agent });
    // Only agents get a server-side cursor; a person's own cursor comes from their browser.
    if (typeof cursor === "number" && agent.kind === "agent") this.setAgentCursor(agent, cursor);
    if (this.conns.size === 0) this.scheduleClose();
  }

  /**
   * Show an agent's cursor. Agents have no connection, so the room writes their awareness state itself, under a
   * fixed client id per agent. Like any non-local state, it expires after awareness's outdated timeout (30 s).
   */
  setAgentCursor(agent: Participant, index: number) {
    if (this.closed) return;
    const id = agentClientId(agent.id);
    const pos = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(this.text, Math.min(index, this.text.length)));
    const state: PresenceState = {
      user: { id: agent.id, name: agent.name, color: agent.color, kind: "agent" },
      cursor: { anchor: pos, head: pos },
    };
    const aw = this.awareness;
    const isNew = !aw.states.has(id);
    aw.states.set(id, state);
    aw.meta.set(id, { clock: (aw.meta.get(id)?.clock ?? 0) + 1, lastUpdated: Date.now() });
    const change = { added: isNew ? [id] : [], updated: isNew ? [] : [id], removed: [] };
    aw.emit("change", [change, "agent"]);
    aw.emit("update", [change, "agent"]);
  }

  touch() {
    this.lastActivity = Date.now();
    if (this.conns.size === 0) this.scheduleClose();
  }

  // ---- lifecycle ----

  private scheduleClose() {
    if (this.closed) return;
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => void this.tryClose(), 60_000);
  }

  private async tryClose() {
    this.closeTimer = null;
    if (this.conns.size > 0 || this.closed) return;
    if (Date.now() - this.lastActivity < 55_000) return this.scheduleClose();
    try {
      if (this.dirty) await this.flush();
    } catch (e) {
      console.error(`[room ${this.key}] final flush failed, keeping room:`, e);
      return this.scheduleClose();
    }
    if (this.conns.size > 0 || this.closed) return;
    if (this.dirty || Date.now() - this.lastActivity < 55_000) return this.scheduleClose();
    this.destroy(true);
  }

  /** Close the room for a reason that clients should show (deleted, renamed). */
  closeWith(reason: string, extra: object = {}) {
    this.sendControl({ t: "closed", reason, ...extra });
    for (const c of this.conns) c.close(4000, reason);
    this.destroy(true);
  }

  destroy(dropLog: boolean) {
    if (this.closed) return;
    this.closed = true;
    if (this.quietTimer) clearTimeout(this.quietTimer);
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.quietTimer = this.closeTimer = null;
    this.owners.clear();
    this.awareness.destroy();
    if (dropLog) {
      db.query("DELETE FROM room_updates WHERE room = ?").run(this.key);
      db.query("DELETE FROM room_meta WHERE room = ?").run(this.key);
    }
    this.onClose(this);
    this.doc.destroy();
  }
}

const SYSTEM: Participant = { id: "system", name: "Grimoire", email: "grimoire@users.noreply.code.storage", kind: "agent", color: "#888" };

const repoLocks = new Map<string, Promise<unknown>>();

function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(repo) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  repoLocks.set(repo, tail);
  void tail.then(() => {
    if (repoLocks.get(repo) === tail) repoLocks.delete(repo);
  });
  return next;
}

export function roomKey(repo: string, path: string) {
  return `${repo}\u0000${path}`;
}

export class RoomManager {
  private loading = new Map<string, Promise<Room>>();
  private open = new Map<string, Room>();

  constructor(private store: GitStore) {}

  /** Get or open a room. `create` is the initial text when the file doesn't exist; null means it must exist. */
  async get(repo: string, path: string, branch: string, create: string | null = null): Promise<Room> {
    const key = roomKey(repo, path);
    const existing = this.open.get(key);
    if (existing && !existing.closed) return existing;
    let p = this.loading.get(key);
    if (!p) {
      p = (async () => {
        const room = new Room(repo, path, branch, this.store, (r) => {
          if (this.open.get(r.key) === r) this.open.delete(r.key);
        });
        try {
          await room.load(create);
        } catch (e) {
          // Stop the room's timers; keep its crash log (if any) for the next attempt.
          room.destroy(false);
          throw e;
        }
        if (room.closed) throw new NotFoundError(`${path} not found`);
        this.open.set(key, room);
        return room;
      })();
      this.loading.set(key, p);
      p.finally(() => this.loading.delete(key)).catch(() => {});
    }
    return p;
  }

  /** An already-open room, without loading. */
  peek(repo: string, path: string): Room | undefined {
    const r = this.open.get(roomKey(repo, path));
    return r && !r.closed ? r : undefined;
  }

  list(): Room[] {
    return [...this.open.values()].filter((r) => !r.closed);
  }

  inRepo(repo: string): Room[] {
    return this.list().filter((r) => r.repo === repo);
  }

  /** Rooms with crash-log entries from a previous run: reopen them so their edits get committed. */
  async recover(branchOf: (repo: string) => string | undefined) {
    const rows = db.query("SELECT room FROM room_meta").all() as Array<{ room: string }>;
    for (const { room } of rows) {
      const [repo, path] = room.split("\u0000") as [string, string];
      const branch = branchOf(repo);
      if (!branch) {
        db.query("DELETE FROM room_meta WHERE room = ?").run(room);
        db.query("DELETE FROM room_updates WHERE room = ?").run(room);
        continue;
      }
      try {
        const r = await this.get(repo, path, branch);
        r.touch();
      } catch (e) {
        console.error(`[recover] ${repo}:${path}:`, e);
      }
    }
  }

  /** Commit every open room and close them all (shutdown). Rooms that could not be saved keep their crash log. */
  async flushAll() {
    await Promise.allSettled([...this.loading.values()]);
    const rooms = this.list();
    await Promise.allSettled(rooms.map((r) => r.flush()));
    for (const r of rooms) r.destroy(!r.dirty);
  }
}
