// One open note: its Y.Doc (a merge cache of the note's text, docs/storage-v2.md), awareness, connections, line
// authors and open version. Everything is persisted in the workspace's NoteStore (notes/store.ts), synchronously:
// updates are buffered 250 ms per author and written as one row of the note's update tail, then acked; the state is
// compacted (text, doc, line authors) on version cuts, on close and when the tail grows. The room's generation is
// "<note id>.<epoch>": stable across closes, hibernation, evictions and deploys, so clients keep their documents.
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { emit, notifyChange } from "./events.ts";
import type { PresenceState, PresenceUser } from "../shared/presence.ts";
import { attribute, LineMemory } from "../shared/lineauthors.ts";
import { addContributor, VERSION_IDLE_MS, VERSION_SPAN_MS, versionRef, type Contributor, type LineAuthors, type Note, type NoteStore, type Pending, type Person, type VersionKind } from "./notes/store.ts";

export const MSG_SYNC = 0;
export const MSG_AWARENESS = 1;
export const MSG_CONTROL = 2;

export const TEXT_NAME = "md";

/**
 * Who a participant is, always decided by the server from how the request authenticated, never from what a client
 * sends: "human" = a signed-in user (session cookie or app token; the wire name predates the others and clients rely
 * on it), "guest" = an anonymous browser visitor (no account; anon.ts), "agent" = an agent (the note shell, /mcp).
 */
export type ParticipantKind = "human" | "guest" | "agent";

export interface Participant {
  id: string;
  name: string;
  email: string;
  kind: ParticipantKind;
  color: string;
  avatar?: string;
}

export interface Conn {
  user: Participant;
  readOnly: boolean;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  awarenessIds: Set<number>;
  /** Not presence (a v2 prefetch channel): participants() skips it unless it has an awareness state. */
  hidden?: boolean;
  /** Its awareness states expire after this (v2 channels: 12 min); default AWARENESS_TIMEOUT_MS (30 s). */
  awarenessTimeoutMs?: number;
  /** Only v2 channels have it: asks the client to renew its awareness every `ms`. */
  renew?(ms: number): void;
  /** Sync frames with document changes received from it, and how many of them were acked (ack after durable write). */
  received?: number;
  acked?: number;
}

export class NotFoundError extends Error {
  override name = "NotFoundError";
}

/** A participant as a person of line authors and versions. */
export const personOf = (p: Participant): Person => ({ id: p.id, name: p.name, email: p.email, kind: p.kind, color: p.color });

const LOAD = Symbol("load");

/** Agents get awareness client ids above the uint32 range that Yjs clients pick theirs from. */
const AGENT_ID_BASE = 2 ** 32;
/** Blame messages go out at most this often while the text changes. */
export const BLAME_MS = 1000;
/** How many awareness client ids one websocket may own (a client may switch docs once on a generation change). */
const MAX_IDS_PER_CONN = 2;
/** Updates are buffered this long per room: one tail row, one line-author pass and one ack per burst. */
export const BATCH_MS = 250;
/** The tail is compacted once it has this many rows. */
const COMPACT_ROWS = 500;
/** Awareness states not renewed for this long are removed (y-protocols' outdatedTimeout). */
export const AWARENESS_TIMEOUT_MS = 30_000;
/** Awareness renewal v2 channels are asked for (`renew`) while a v1 connection is in the room, and otherwise (wsmux.ts). */
export const V1_RENEW_MS = 15_000;
export const RENEW_MS = 300_000;
/** How often outdated awareness states are swept: by the room's own timer (Bun) or on messages. */
export const AWARENESS_SWEEP_MS = 3_000;
/** A room with no connections closes after this long without activity. */
export const IDLE_CLOSE_MS = 55_000;
const UNKNOWN = -1;

export interface RoomOptions {
  /** Close the room by itself after its last connection leaves (default true: Bun). Workers call closeIfIdle(). */
  closeTimer?: boolean;
  /** Sweep outdated awareness states (and cut idle versions) with the room's own timers (default true: Bun). */
  sweepTimer?: boolean;
}

interface PendingBatch {
  by: number;
  who: string | null;
  updates: Uint8Array[];
}

export function agentClientId(agentId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < agentId.length; i++) h = Math.imul(h ^ agentId.charCodeAt(i), 0x01000193) >>> 0;
  return AGENT_ID_BASE + h;
}

/** The line authors as clients get them (docs/05-v1-architecture.md, "Line authors"). */
export interface BlameMessage {
  t: "blame";
  authors: Array<{ id: string; name: string; kind: ParticipantKind; color: string }>;
  lines: number[];
}

export function blameMessage(values: number[], people: Person[]): BlameMessage {
  const authors: BlameMessage["authors"] = [];
  const index = new Map<string, number>();
  const lines = values.map((v) => {
    const p = v >= 0 ? people[v] : undefined;
    if (!p) return UNKNOWN;
    let i = index.get(p.id);
    if (i === undefined) index.set(p.id, (i = authors.push({ id: p.id, name: p.name, kind: p.kind, color: p.color }) - 1));
    return i;
  });
  return { t: "blame", authors, lines };
}

export class Room {
  readonly key: string;
  readonly doc = new Y.Doc({ gc: true });
  readonly text = this.doc.getText(TEXT_NAME);
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  readonly conns = new Set<Conn>();
  /** "<note id>.<epoch>" once opened. */
  generation = "";
  noteId = "";
  private epoch = 0;
  private quietTimer: ReturnType<typeof setTimeout> | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private sweepTimer: ReturnType<typeof setTimeout> | null = null;
  private blameTimer: ReturnType<typeof setTimeout> | null = null;
  private batch: PendingBatch | null = null;
  private nextSeq = 1;
  private tailRows = 0;
  private lastSweep = Date.now();
  private owners = new Map<number, Conn>();
  private lastActivity = Date.now();
  private v1Mix = false;
  /** Line authors: one value per line of `liveText`, indexes into `people`. */
  private lineValues: number[] = [UNKNOWN];
  private liveText = "";
  private history = new LineMemory();
  private people: Person[] = [];
  private sentBlame: string | null = null;
  /** The open version (edits not cut yet). */
  private pending: Pending | null = null;
  /** The newest version's id (the "commit" clients show) and when it was cut. */
  private lastVersion: number | null = null;
  savedAt: number | null = null;
  version = 0;
  closed = false;

  constructor(
    readonly repo: string,
    readonly path: string,
    private store: NoteStore,
    private onClose: (room: Room) => void,
    private opts: RoomOptions = {},
  ) {
    this.key = roomKey(repo, path);
    // Awareness's own 3 s interval would keep a Durable Object from hibernating: the room sweeps instead.
    clearInterval((this.awareness as unknown as { _checkInterval: ReturnType<typeof setInterval> })._checkInterval);
    (this.awareness as unknown as { _checkInterval: unknown })._checkInterval = undefined;
    this.awareness.setLocalState(null);

    // Another author's change is about to land: the batch's line authors must be worked out on the text before it.
    this.doc.on("beforeTransaction", (tr: Y.Transaction) => {
      if (this.batch && this.batch.who !== authorId(tr.origin)) this.flushBatch();
    });
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === LOAD || this.closed) return;
      const who = (origin as { user?: Participant } | null)?.user;
      const by = this.personIndex(who);
      this.buffer(by, authorId(origin), update);
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      const msg = encoding.toUint8Array(enc);
      for (const c of this.conns) if (c !== origin) c.send(msg);
      this.version++;
      this.lastActivity = Date.now();
      notifyChange(this.repo, this.path);
      this.scheduleBlame();
      if (who) this.contribute(who);
    });

    this.awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      const changed = [...added, ...updated, ...removed];
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
      const msg = encoding.toUint8Array(enc);
      for (const c of this.conns) c.send(msg);
      if (added.length || removed.length) this.emitPresence();
      if (added.length) this.scheduleSweep();
    });
  }

  /**
   * Load the note (synchronously, from the store only): its doc at the compacted text (built from the text and saved
   * when the epoch has none yet), the tail replayed with its line authors. Throws NotFoundError when it doesn't exist.
   */
  open(): void {
    if (!this.wake()) throw new NotFoundError(`${this.path} not found`);
  }

  /** open() without throwing: false when the note doesn't exist (a Durable Object waking for a deleted note). */
  wake(): boolean {
    if (this.closed) return false;
    const note = this.store.byPath(this.path);
    if (!note) return false;
    this.load(note);
    return true;
  }

  private load(note: Note) {
    this.noteId = note.id;
    this.epoch = note.epoch;
    this.generation = `${note.id}.${note.epoch}`;
    const saved = this.store.loadDoc(note.id, note.epoch);
    if (saved) Y.applyUpdate(this.doc, saved, LOAD);
    else {
      this.doc.transact(() => this.text.insert(0, note.text), LOAD);
      // everyone who opens this epoch must get the same items: the doc is saved before anyone sees it
      this.store.saveDoc(note.id, note.epoch, Y.encodeStateAsUpdate(this.doc));
    }
    let text = this.text.toString();
    if (text !== note.text) {
      // (never expected: the doc and the text are written together) the text wins
      console.error(`[room ${this.key}] doc and text differ at load; rebuilding epoch`);
      this.epoch = this.store.bumpEpoch(note.id);
      this.generation = `${note.id}.${this.epoch}`;
      this.doc.transact(() => {
        this.text.delete(0, this.text.length);
        this.text.insert(0, note.text);
      }, LOAD);
      this.store.saveDoc(note.id, this.epoch, Y.encodeStateAsUpdate(this.doc));
      text = note.text;
    }
    const a = note.authors;
    this.people = a?.people ?? [];
    this.lineValues = a && a.lines.length === text.split("\n").length ? a.lines : text.split("\n").map(() => UNKNOWN);
    this.history = new LineMemory(a?.history ?? []);
    this.pending = note.pending;
    this.savedPeople = this.people.length;
    const last = this.store.latestVersion(note.id);
    this.lastVersion = last?.id ?? null;
    this.savedAt = last?.ended_at ?? null;
    // the tail: each row an update by its author
    const rows = this.store.tail(note.id, this.epoch);
    for (const r of rows) {
      Y.applyUpdate(this.doc, new Uint8Array(r.data), LOAD);
      const next = this.text.toString();
      const by = r.author !== null && this.people[r.author] ? r.author : UNKNOWN;
      this.lineValues = attribute(text, next, this.lineValues, by, by >= 0 ? this.history : undefined);
      text = next;
    }
    this.liveText = text;
    this.nextSeq = (rows.at(-1)?.seq ?? 0) + 1;
    this.tailRows = rows.length;
    this.scheduleVersion();
  }

  private personIndex(p: Participant | undefined): number {
    if (!p) return UNKNOWN;
    let i = this.people.findIndex((q) => q.id === p.id);
    if (i < 0) i = this.people.push(personOf(p)) - 1;
    else if (this.people[i]!.name !== p.name || this.people[i]!.color !== p.color) this.people[i] = { ...this.people[i]!, name: p.name, color: p.color };
    return i;
  }

  private contribute(p: Participant) {
    const now = Date.now();
    // a long session: the version so far is cut first (its text is the text before this change, buffered in the batch)
    this.pending = this.pending ? { ...this.pending, last: now, authors: addContributor(this.pending.authors, personOf(p)) } : { started: now, last: now, authors: addContributor([], personOf(p)) };
    this.scheduleVersion();
  }

  private buffer(by: number, who: string | null, update: Uint8Array) {
    if (this.batch) this.batch.updates.push(update);
    else this.batch = { by, who, updates: [update] };
    this.batchTimer ??= setTimeout(() => this.flushBatch(), BATCH_MS);
  }

  /** Move the line authors along, write the buffered updates as one tail row, and ack the connections they came from. */
  private flushBatch() {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    const b = this.batch;
    if (!b) return this.ackAll();
    this.batch = null;
    const next = this.text.toString();
    this.lineValues = attribute(this.liveText, next, this.lineValues, b.by, b.by >= 0 ? this.history : undefined);
    this.liveText = next;
    const data = b.updates.length === 1 ? b.updates[0]! : Y.mergeUpdates(b.updates);
    this.store.appendUpdate(this.noteId, this.epoch, this.nextSeq++, data, b.by >= 0 ? b.by : null, this.pending);
    this.tailRows++;
    // the people list is saved with the compacted state: a tail row's author must be in the saved list
    if (this.tailRows >= COMPACT_ROWS || this.people.length > this.savedPeople) this.compact();
    this.ackAll();
  }

  private savedPeople = 0;

  /** Everything received so far is durable: tell the connections that sent changes. */
  private ackAll() {
    if (this.batch) return;
    for (const c of this.conns) {
      if ((c.received ?? 0) > (c.acked ?? 0)) {
        c.acked = c.received;
        this.sendControlTo(c, { t: "ack", n: c.received });
      }
    }
  }

  /** Write the note's whole state (text, doc, line authors, open version) and drop the tail. */
  compact() {
    if (this.closed || !this.noteId) return;
    if (this.batch) return this.flushBatch(); // (it compacts, or the rows are few)
    this.store.compact(this.noteId, this.epoch, {
      text: this.liveText,
      doc: Y.encodeStateAsUpdate(this.doc),
      authors: { people: this.people, lines: this.lineValues, history: this.history.entries() },
      pending: this.pending,
    });
    this.savedPeople = this.people.length;
    this.tailRows = 0;
    this.nextSeq = 1;
  }

  /** The line authors now: who wrote each line of the current text. */
  lineAuthors(): LineAuthors {
    this.flushBatch();
    return { people: this.people, lines: this.lineValues };
  }

  /**
   * Cut the open version (or, with `force`, a version even without edits: restore, rename, delete), with `by` as its
   * author when given. Returns the version id, or null when nothing was cut.
   */
  cut(kind: VersionKind = "edit", opts: { force?: boolean; by?: Participant; message?: string; path?: string } = {}): number | null {
    if (this.closed || !this.noteId) return null;
    this.flushBatch();
    if (!this.pending && !opts.force) return null;
    let authors: Contributor[] = this.pending?.authors ?? [];
    const by = opts.by;
    if (by) authors = [{ ...personOf(by), edits: authors.find((a) => a.id === by.id)?.edits ?? 1 }, ...authors.filter((a) => a.id !== by.id)];
    const now = Date.now();
    const started = this.pending?.started ?? now;
    this.pending = null;
    this.compact();
    const id = this.store.cutVersion(this.noteId, { kind, path: opts.path ?? this.path, text: this.liveText, started, authors, lines: { people: this.people, lines: this.lineValues }, message: opts.message ?? null });
    this.lastVersion = id;
    this.savedAt = now;
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = null;
    this.broadcastStatus();
    emit({ type: "saved", repo: this.repo, path: this.path, sha: versionRef(id) });
    return id;
  }

  /** Cut the open version if it's due (idle VERSION_IDLE_MS or open VERSION_SPAN_MS). */
  cutIfDue(now = Date.now()): boolean {
    const p = this.pending;
    if (!p || (now - p.last < VERSION_IDLE_MS && now - p.started < VERSION_SPAN_MS)) return false;
    this.cut("edit");
    return true;
  }

  /** With timers (Bun, and Workers while the object is awake): cut the version when it's due. */
  private scheduleVersion() {
    if (this.closed || !this.pending) return;
    if (this.quietTimer) clearTimeout(this.quietTimer);
    const p = this.pending;
    const at = Math.min(p.last + VERSION_IDLE_MS, p.started + VERSION_SPAN_MS);
    this.quietTimer = setTimeout(() => {
      this.quietTimer = null;
      if (!this.cutIfDue()) this.scheduleVersion();
    }, Math.max(0, at - Date.now()) + 50);
  }

  get dirty(): boolean {
    return this.pending !== null;
  }

  /** Make everything durable now (shutdown, before a rename). */
  async flush(): Promise<void> {
    this.flushBatch();
    this.compact();
  }

  /** No Git blame to load any more: line authors are always known. */
  ensureBlame() {}

  blame(): BlameMessage {
    this.flushBatch();
    return blameMessage(this.lineValues, this.people);
  }

  private scheduleBlame(ms = BLAME_MS) {
    if (this.closed) return;
    if (this.blameTimer) {
      if (ms > 0) return;
      clearTimeout(this.blameTimer);
    }
    this.blameTimer = setTimeout(() => {
      this.blameTimer = null;
      if (!this.conns.size || this.closed) return;
      const msg = this.blame();
      const json = JSON.stringify(msg);
      if (json === this.sentBlame) return;
      this.sentBlame = json;
      this.sendControl(msg);
    }, ms);
  }

  // ---- connections ----

  addConn(conn: Conn, sv?: Uint8Array) {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    this.conns.add(conn);
    this.sendControlTo(conn, { t: "hello", generation: this.generation, readOnly: conn.readOnly, ...this.status() });
    const msg = this.blame();
    this.sendControlTo(conn, msg);
    if (this.conns.size === 1) this.sentBlame = JSON.stringify(msg);
    if (sv) {
      const s2 = encoding.createEncoder();
      encoding.writeVarUint(s2, MSG_SYNC);
      syncProtocol.writeSyncStep2(s2, this.doc, sv);
      conn.send(encoding.toUint8Array(s2));
    }
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
    if (!this.updateMix() && this.v1Mix) conn.renew?.(V1_RENEW_MS);
    this.emitPresence();
  }

  private updateMix(): boolean {
    let v1 = false;
    for (const c of this.conns) if (!c.renew) v1 = true;
    if (v1 === this.v1Mix) return false;
    this.v1Mix = v1;
    for (const c of this.conns) c.renew?.(v1 ? V1_RENEW_MS : RENEW_MS);
    return true;
  }

  /** Put back a connection the host had before it slept (no hello, no sync), with its awareness states. */
  reattach(conn: Conn, states: Array<[number, number, Record<string, unknown> | null]>) {
    if (this.closed) return;
    this.conns.add(conn);
    const now = Date.now();
    for (const [id, clock, state] of states) {
      if (id >= AGENT_ID_BASE || this.owners.has(id) || conn.awarenessIds.size >= MAX_IDS_PER_CONN) continue;
      this.owners.set(id, conn);
      conn.awarenessIds.add(id);
      if (state === null) continue;
      this.awareness.states.set(id, state);
      this.awareness.meta.set(id, { clock, lastUpdated: now });
    }
    this.updateMix();
  }

  removeConn(conn: Conn) {
    if (!this.conns.delete(conn) || this.closed) return;
    this.flushBatch();
    for (const id of conn.awarenessIds) if (this.owners.get(id) === conn) this.owners.delete(id);
    awarenessProtocol.removeAwarenessStates(this.awareness, [...conn.awarenessIds], null);
    this.updateMix();
    this.emitPresence();
    if (this.conns.size === 0) this.scheduleClose();
  }

  onMessage(conn: Conn, data: Uint8Array) {
    if (this.closed) return;
    if (Date.now() - this.lastSweep >= AWARENESS_SWEEP_MS) this.sweepAwareness();
    const dec = decoding.createDecoder(data);
    const type = decoding.readVarUint(dec);
    if (type === MSG_SYNC) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      if (conn.readOnly) {
        const sub = decoding.readVarUint(dec);
        if (sub === syncProtocol.messageYjsSyncStep1) syncProtocol.readSyncStep1(dec, enc, this.doc);
      } else {
        const sub = syncProtocol.readSyncMessage(dec, enc, this.doc, conn);
        if (sub !== syncProtocol.messageYjsSyncStep1) {
          conn.received = (conn.received ?? 0) + 1;
          // nothing new (already had it): durable already
          if (!this.batch) this.ackAll();
        }
      }
      if (encoding.length(enc) > 1) conn.send(encoding.toUint8Array(enc));
    } else if (type === MSG_AWARENESS) {
      const update = this.ownAwareness(conn, decoding.readVarUint8Array(dec));
      if (update) awarenessProtocol.applyAwarenessUpdate(this.awareness, update, conn);
    } else if (type === MSG_CONTROL) {
      const msg = JSON.parse(decoding.readVarString(dec)) as { t: string };
      // (a client's "save now"): make it durable; versions are cut by time and agents
      if (msg.t === "flush" && !conn.readOnly) this.flushBatch();
    }
  }

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

  /** `dirty`: a version is open (edits not cut into one yet); `commit`: the newest version. Saving is immediate. */
  status() {
    return { dirty: this.dirty, saving: false, commit: this.lastVersion === null ? null : versionRef(this.lastVersion), savedAt: this.savedAt };
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
    for (const c of this.conns) if (!c.hidden && !seen.has(c.user.id)) seen.set(c.user.id, { id: c.user.id, name: c.user.name, color: c.user.color, kind: c.user.kind });
    return [...seen.values()];
  }

  emitPresence() {
    emit({ type: "presence", repo: this.repo, path: this.path, users: this.participants() });
  }

  // ---- agents and the server's own edits ----

  /** Apply an edit as `who` (an agent, a restorer, a creator) and show an agent's cursor at the returned index. */
  agentEdit(who: Participant, fn: (text: Y.Text) => number | void) {
    this.lastActivity = Date.now();
    let cursor: number | void = undefined;
    this.doc.transact(() => {
      cursor = fn(this.text);
    }, { user: who });
    this.flushBatch();
    if (typeof cursor === "number" && who.kind === "agent") this.setAgentCursor(who, cursor);
    if (this.conns.size === 0) this.scheduleClose();
  }

  setAgentCursor(agent: Participant, index: number) {
    if (this.closed) return;
    const id = agentClientId(agent.id);
    const pos = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(this.text, Math.min(index, this.text.length)));
    const state: PresenceState = { user: { id: agent.id, name: agent.name, color: agent.color, kind: "agent" }, cursor: { anchor: pos, head: pos } };
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

  sweepAwareness(now = Date.now()): number {
    this.lastSweep = now;
    if (this.closed) return 0;
    const stale: number[] = [];
    for (const [id, meta] of this.awareness.meta) {
      if (id === this.awareness.clientID || !this.awareness.states.has(id)) continue;
      const timeout = this.owners.get(id)?.awarenessTimeoutMs ?? AWARENESS_TIMEOUT_MS;
      if (now - meta.lastUpdated >= timeout) stale.push(id);
    }
    if (stale.length) awarenessProtocol.removeAwarenessStates(this.awareness, stale, "timeout");
    return stale.length;
  }

  private scheduleSweep() {
    if (this.closed || this.opts.sweepTimer === false || this.sweepTimer) return;
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = null;
      this.sweepAwareness();
      if (this.awareness.states.size) this.scheduleSweep();
    }, AWARENESS_SWEEP_MS);
  }

  private scheduleClose() {
    if (this.closed || this.opts.closeTimer === false) return;
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null;
      void this.closeIfIdle().then((closed) => {
        if (!closed && !this.conns.size) this.scheduleClose();
      });
    }, 60_000);
  }

  idle(idleMs = IDLE_CLOSE_MS): boolean {
    return !this.closed && this.conns.size === 0 && Date.now() - this.lastActivity >= idleMs;
  }

  /** Compact and close the room if nobody is in it and nothing happened for `idleMs`. The open version stays open. */
  async closeIfIdle(idleMs = IDLE_CLOSE_MS): Promise<boolean> {
    if (this.closed) return true;
    if (!this.idle(idleMs)) return false;
    this.cutIfDue();
    this.destroy();
    return true;
  }

  /** Close the room for a reason clients should show (deleted, renamed, removed). */
  closeWith(reason: string, extra: object = {}) {
    this.sendControl({ t: "closed", reason, ...extra });
    for (const c of this.conns) c.close(4000, reason);
    this.destroy();
  }

  /** Close: everything is compacted first (`discard`: a deleted note or a reset demo, nothing kept). */
  destroy(discard = false) {
    if (this.closed) return;
    if (!discard) {
      try {
        this.flushBatch();
        this.compact();
      } catch (e) {
        console.error(`[room ${this.key}] compact on close:`, e);
      }
    }
    this.closed = true;
    for (const t of [this.quietTimer, this.closeTimer, this.blameTimer, this.batchTimer, this.sweepTimer]) if (t) clearTimeout(t);
    this.quietTimer = this.closeTimer = this.blameTimer = this.batchTimer = this.sweepTimer = null;
    this.owners.clear();
    this.awareness.destroy();
    this.onClose(this);
    this.doc.destroy();
  }
}

/** Whose a change is, for batching: a participant's id, or null. */
function authorId(origin: unknown): string | null {
  return (origin as { user?: Participant } | null)?.user?.id ?? null;
}

export function roomKey(repo: string, path: string) {
  return `${repo}\u0000${path}`;
}
