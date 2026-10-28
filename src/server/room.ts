import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { newId } from "./db.ts";
import { config } from "./config.ts";
import { emit, notifyChange } from "./events.ts";
import { applyDiff } from "./textdiff.ts";
import type { Author, CommitOutcome, GitStore } from "./store/types.ts";
import { isErr } from "./errors.ts";
import type { PresenceState, PresenceUser } from "../shared/presence.ts";
import { attribute } from "../shared/lineauthors.ts";
import type { RoomStorage } from "./seams/room-storage.ts";
import type { Db } from "./seams/db.ts";
import { blameMessage, originLines, rebase, resolveAuthors, UNKNOWN, type BlameMessage, type LineAuthor, type OriginAuthors } from "./blame.ts";

export const MSG_SYNC = 0;
export const MSG_AWARENESS = 1;
export const MSG_CONTROL = 2;

export const TEXT_NAME = "md";

/**
 * Who a participant is, always decided by the server from how the request authenticated, never from what a client
 * sends: "human" = a signed-in user (session cookie or app token; the wire name predates the others and clients rely
 * on it), "guest" = an anonymous browser visitor (no account; anon.ts), "agent" = an agent (share link shell, MCP,
 * /api/shell). Everyone may edit (read-only folders aside); the kind shows in presence and in guests' commits.
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
}

export class NotFoundError extends Error {
  override name = "NotFoundError";
}

/** How a participant signs commits: guests (no account) as "<name> (guest)". */
export function authorOf(p: Participant): Author {
  return { name: p.kind === "guest" ? `${p.name} (guest)` : p.name, email: p.email };
}

const EXTERNAL = Symbol("external");
const LOAD = Symbol("load");

interface Contributor {
  id: string;
  author: Author;
  edits: number;
}

/** Agents get awareness client ids above the uint32 range that Yjs clients pick theirs from. */
const AGENT_ID_BASE = 2 ** 32;
/** Blame messages go out at most this often while the text changes. */
export const BLAME_MS = 1000;

/** Someone who changed the text while the room was open (line authors), with how they sign commits. */
interface Person extends LineAuthor {
  email: string;
  gitName: string;
}
/** How many awareness client ids one websocket may own (a client may switch docs once on a generation change). */
const MAX_IDS_PER_CONN = 2;
/** Awareness states not renewed for this long are removed (y-protocols' outdatedTimeout). */
export const AWARENESS_TIMEOUT_MS = 30_000;
/** How often outdated awareness states are swept: by the room's own timer (Bun) or on messages. */
export const AWARENESS_SWEEP_MS = 3_000;
/** A room with no connections closes after this long without activity. */
export const IDLE_CLOSE_MS = 55_000;

export interface RoomOptions {
  /** Close the room by itself 60 s after its last connection leaves (default true: Bun). Workers turn it off and call closeIfIdle(). */
  closeTimer?: boolean;
  /** Sweep outdated awareness states with the room's own timer while it has any (default true: Bun). Workers turn it off and call sweepAwareness() from the alarm. */
  sweepTimer?: boolean;
}

/** What room_meta.state holds besides the base: so wake() needs nothing but the room storage. */
interface SavedState {
  inBase: boolean;
  savedAt: number | null;
  contributors: Contributor[];
}

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
  private sweepTimer: ReturnType<typeof setTimeout> | null = null;
  /** Contributors changed since room_meta.state was last written. */
  private stateDirty = false;
  /** The next room_updates seq of this room. */
  private nextSeq = 1;
  private lastSweep = Date.now();
  /** wake() restored a crash log from before room_meta.state, so inBase still has to be checked against the store. */
  private legacyLog = false;
  private lock: Promise<unknown> = Promise.resolve();
  /** Which connection owns each human awareness client id. */
  private owners = new Map<number, Conn>();
  private lastActivity = Date.now();
  private fullWarned = false;
  /** Line authors (blame.ts): one value per line of `liveText`. */
  private lineValues: number[] = [UNKNOWN];
  private liveText = "";
  /** Everyone who changed the text in this room; lineValues ≥ 0 index into it. */
  private people: Person[] = [];
  /** The commit whose text the origin lines are lines of, and its Git blame with authors resolved (null until loaded). */
  private originCommit: string | null = null;
  private originAuthors: OriginAuthors | null = null;
  private blameTimer: ReturnType<typeof setTimeout> | null = null;
  /** The last blame message the connections got (JSON), so unchanged ones aren't sent again. */
  private sentBlame: string | null = null;
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
    private storage: RoomStorage,
    /** The global tables (users: who Git authors are). */
    private db: Db,
    private onClose: (room: Room) => void,
    /** Keep nothing in the crash log (the demo folder: it starts from its seed after a restart anyway). */
    readonly ephemeral = false,
    private opts: RoomOptions = {},
  ) {
    this.key = roomKey(repo, path);
    if (!ephemeral) ensureRoomTables(storage);
    // Awareness's own 3 s interval would keep a Durable Object from hibernating: the room sweeps instead (sweepAwareness).
    clearInterval((this.awareness as unknown as { _checkInterval: ReturnType<typeof setInterval> })._checkInterval);
    (this.awareness as unknown as { _checkInterval: unknown })._checkInterval = undefined;
    // The server has no local user of its own.
    this.awareness.setLocalState(null);

    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === LOAD || this.closed) return;
      const by = origin === EXTERNAL ? UNKNOWN : this.personIndex((origin as { user?: Participant } | null)?.user);
      this.track(by);
      if (!this.ephemeral) this.storage.exec("INSERT INTO room_updates (room, seq, data, author) VALUES (?, ?, ?, ?)", this.key, this.nextSeq++, update, by >= 0 ? by : null);
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      const msg = encoding.toUint8Array(enc);
      for (const c of this.conns) if (c !== origin) c.send(msg);
      this.version++;
      this.lastActivity = Date.now();
      notifyChange(this.repo, this.path);
      this.scheduleBlame();
      if (origin === EXTERNAL) return;
      const who = (origin as { user?: Participant } | null)?.user;
      if (who) {
        const c = this.contributors.get(who.id) ?? { id: who.id, author: authorOf(who), edits: 0 };
        c.edits++;
        this.contributors.set(who.id, c);
        this.saveState();
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
      if (added.length) this.scheduleSweep();
    });
  }

  /** Open the room: from the crash log if it has one (wake(), then catch up with the branch), otherwise from Git. */
  async open(create: string | null) {
    if (this.wake()) {
      if (this.legacyLog) {
        // a log from before room_meta.state: whether the file exists at the base has to be asked
        this.inBase = this.baseCommit !== null && (await this.store.readFile(this.repo, this.path, this.baseCommit)) !== null;
        if (this.closed) return;
        this.legacyLog = false;
        this.dirty = this.isDirty();
        this.saveState();
      }
      this.ensureBlame();
      // Pick up anything that landed in Git while we were down.
      await this.checkRemote().catch((e) => console.error(`[room ${this.key}] check after recovery failed:`, e));
      if (this.dirty && !this.closed) this.scheduleFlush();
      return;
    }
    const head = await this.store.head(this.repo, this.branch);
    if (this.closed) return;
    // The file and its Git blame in parallel (the blame is only used if the file exists).
    const blame = head && !this.cachedBlame(head) ? this.fetchBlame(head) : undefined;
    const content = head ? await this.store.readFile(this.repo, this.path, head) : null;
    if (this.closed) return;
    if (content === null && create === null) throw new NotFoundError(`${this.path} not found`);
    this.baseCommit = head;
    this.inBase = content !== null;
    // For a new file the committed base is "nothing", so the initial text counts as an edit.
    this.baseContent = content ?? "";
    this.doc.transact(() => this.text.insert(0, this.baseContent), LOAD);
    this.baseSnapshot = content === null ? Y.emptySnapshot : Y.snapshot(this.doc);
    this.liveText = this.baseContent;
    this.lineValues = originLines(this.baseContent);
    this.originCommit = content === null ? null : head;
    this.saveMeta();
    this.loadBlame(content === null ? undefined : blame);
    if (content === null && create) {
      this.doc.transact(() => this.text.insert(0, create), { user: SYSTEM });
    }
    this.dirty = this.isDirty();
    if (this.dirty) this.scheduleFlush();
  }

  /** @deprecated open() */
  load(create: string | null) {
    return this.open(create);
  }

  /**
   * Restore the room from its crash log, synchronously and with nothing but the room storage (no store, no Db): the
   * document, base, inBase, dirty, savedAt, generation, contributors, line authors and the resolved origin authors
   * (from the blame cache). For a Durable Object waking from hibernation; open() uses it too. Call it once, on a
   * new room. Returns false (and changes nothing) when there is no crash log. If the blame cache missed,
   * `ensureBlame()` fetches it later.
   */
  wake(): boolean {
    if (this.ephemeral || this.closed) return false;
    const meta =
      this.storage.exec<{ generation: string; base_commit: string | null; base_content: string; base_snapshot: Uint8Array; blame: string | null; blame_people: string | null; state: string | null }>(
        "SELECT * FROM room_meta WHERE room = ?",
        this.key,
      )[0] ?? null;
    if (!meta) return false;
    const rows = this.storage.exec<{ seq: number; data: Uint8Array; author: number | null }>("SELECT seq, data, author FROM room_updates WHERE room = ? ORDER BY seq", this.key);
    this.replay(rows, meta);
    this.nextSeq = (rows.at(-1)?.seq ?? 0) + 1;
    this.generation = meta.generation;
    this.baseCommit = meta.base_commit;
    this.baseContent = meta.base_content;
    this.baseSnapshot = Y.decodeSnapshot(new Uint8Array(meta.base_snapshot));
    let state: SavedState | null = null;
    try {
      state = meta.state ? (JSON.parse(meta.state) as SavedState) : null;
    } catch {
      state = null;
    }
    this.legacyLog = state === null;
    this.inBase = state ? state.inBase : meta.base_commit !== null;
    this.savedAt = state?.savedAt ?? null;
    this.contributors = new Map((state?.contributors ?? []).map((c) => [c.id, c]));
    this.originAuthors = this.originCommit === null ? { authors: [], lines: [] } : this.cachedBlame(this.originCommit);
    this.dirty = this.isDirty();
    return true;
  }

  /** Fetch the origin commit's blame if wake() found no cached one (it may hit the store). */
  ensureBlame() {
    if (this.originAuthors === null && !this.closed) this.loadBlame();
  }

  /**
   * Rebuild the document from the crash log, and its line authors: the first row is the state saveMeta compacted
   * (with the line values saved alongside it), each later row an update by its `author`.
   */
  private replay(rows: Array<{ data: Uint8Array | ArrayBuffer; author: number | null }>, meta: { base_commit: string | null; base_content: string; blame: string | null; blame_people: string | null }) {
    let saved: { origin: string | null; lines: number[] } | null = null;
    try {
      saved = meta.blame ? JSON.parse(meta.blame) : null;
      this.people = meta.blame_people ? JSON.parse(meta.blame_people) : [];
    } catch {
      saved = null;
      this.people = [];
    }
    let values: number[] | null = null;
    let prev = "";
    rows.forEach((r, i) => {
      Y.applyUpdate(this.doc, new Uint8Array(r.data), LOAD);
      const next = this.text.toString();
      if (i === 0) values = saved && saved.lines.length === next.split("\n").length ? saved.lines : null;
      else if (values) values = attribute(prev, next, values, r.author !== null && this.people[r.author] ? r.author : UNKNOWN);
      prev = next;
    });
    this.liveText = prev;
    if (values && saved) {
      this.lineValues = values;
      this.originCommit = saved.origin;
    } else {
      // a log from before line authors (or one that doesn't add up): Git blame for what's still the base text
      this.lineValues = rebase(prev.split("\n").map(() => UNKNOWN), prev, meta.base_commit ? meta.base_content : null);
      this.originCommit = meta.base_commit;
    }
  }

  /** The index of `p` in `people` (added, and persisted for the crash log, the first time); unknown for the system. */
  private personIndex(p: Participant | undefined): number {
    if (!p || p === SYSTEM) return UNKNOWN;
    let i = this.people.findIndex((q) => q.id === p.id);
    if (i < 0) {
      i = this.people.push({ id: p.id, name: p.name, kind: p.kind, color: p.color, email: p.email, gitName: authorOf(p).name }) - 1;
      if (!this.ephemeral) this.storage.exec("UPDATE room_meta SET blame_people = ? WHERE room = ?", JSON.stringify(this.people), this.key);
    } else if (this.people[i]!.name !== p.name || this.people[i]!.color !== p.color) {
      // a guest renamed themselves (or picked another colour): show the current one
      this.people[i] = { ...this.people[i]!, name: p.name, color: p.color, gitName: authorOf(p).name };
    }
    return i;
  }

  /** The text changed (by `by`) since liveText: move the line authors along. */
  private track(by: number) {
    const next = this.text.toString();
    this.lineValues = attribute(this.liveText, next, this.lineValues, by);
    this.liveText = next;
  }

  private savedState(): string {
    const state: SavedState = { inBase: this.inBase, savedAt: this.savedAt, contributors: [...this.contributors.values()] };
    return JSON.stringify(state);
  }

  /** Persist inBase, savedAt and the contributors (the base and the log are saveMeta's). */
  private saveState() {
    this.stateDirty = false;
    if (this.ephemeral) return;
    this.storage.exec("UPDATE room_meta SET state = ? WHERE room = ?", this.savedState(), this.key);
  }

  /** The origin text is now `text` at `commit` (merged from outside, or gone): re-point origin lines, fetch its blame. */
  private setOrigin(commit: string | null, text: string | null) {
    this.lineValues = rebase(this.lineValues, this.liveText, text);
    this.originCommit = commit;
    this.loadBlame();
  }

  /**
   * Fetch the origin commit's Git blame and resolve its authors (one users query), then tell the clients. The
   * resolved authors are cached in the room storage per path and commit, so reopening the room needs neither.
   */
  private loadBlame(prefetched?: Promise<BlameResult>) {
    const commit = this.originCommit;
    this.originAuthors = commit === null ? { authors: [], lines: [] } : this.cachedBlame(commit);
    if (this.originAuthors) return this.scheduleBlame(0);
    void (prefetched ?? this.fetchBlame(commit!))
      .then((r) => {
        if ("error" in r) console.error(`[room ${this.key}] blame failed:`, r.error);
        return "error" in r ? null : r.blame;
      })
      .then(async (blame) => {
        if (this.closed || this.originCommit !== commit) return;
        const resolved = await resolveAuthors(this.db, blame ?? []);
        if (this.closed || this.originCommit !== commit) return;
        if (blame && !this.ephemeral) this.storage.putBlob(this.blameKey(), new TextEncoder().encode(JSON.stringify({ commit, ...resolved })));
        this.originAuthors = resolved;
        this.scheduleBlame(0);
      });
  }

  /** Start fetching a commit's Git blame; errors are returned, so a blame nobody uses doesn't log. */
  private fetchBlame(commit: string): Promise<BlameResult> {
    return Promise.resolve()
      .then(() => this.store.blame?.(this.repo, this.path, commit) ?? null)
      .then(
        (blame) => ({ blame }),
        (error: unknown) => ({ error }),
      );
  }

  /** One cache entry per room (its newest origin commit), so the cache doesn't grow with every commit. */
  private blameKey() {
    return `blame\u0000${this.key}`;
  }

  private cachedBlame(commit: string): OriginAuthors | null {
    if (this.ephemeral) return null;
    try {
      const bytes = this.storage.getBlob(this.blameKey());
      const saved = bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as OriginAuthors & { commit: string }) : null;
      return saved?.commit === commit ? { authors: saved.authors, lines: saved.lines } : null;
    } catch {
      return null;
    }
  }

  /** The line authors as clients get them (docs/05-v1-architecture.md, "Line authors"). No queries: authors are resolved. */
  blame(): BlameMessage {
    const byIdentity = new Map(this.people.map((p) => [`${p.gitName}\0${p.email}`, p]));
    const origin = this.originAuthors;
    return blameMessage(this.lineValues, this.people, (i) => {
      const a = origin?.authors[origin.lines[i] ?? UNKNOWN];
      return a ? (byIdentity.get(a.git) ?? a) : null;
    });
  }

  /**
   * Send the line authors to everyone within `ms` (at most once per BLAME_MS while the text keeps changing), and
   * only if they changed since the last message.
   */
  private scheduleBlame(ms = BLAME_MS) {
    if (this.closed || this.originAuthors === null) return;
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

  /** Persist the base and compact the crash log to a single update holding the whole document. */
  private saveMeta() {
    this.stateDirty = false;
    if (this.ephemeral) return;
    this.storage.transaction(() => {
      this.storage.exec(
        `INSERT INTO room_meta (room, generation, base_commit, base_content, base_snapshot, blame, blame_people, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(room) DO UPDATE SET generation = excluded.generation, base_commit = excluded.base_commit,
           base_content = excluded.base_content, base_snapshot = excluded.base_snapshot, blame = excluded.blame,
           blame_people = excluded.blame_people, state = excluded.state`,
        this.key,
        this.generation,
        this.baseCommit,
        this.baseContent,
        Y.encodeSnapshot(this.baseSnapshot),
        JSON.stringify({ origin: this.originCommit, lines: this.lineValues }),
        JSON.stringify(this.people),
        this.savedState(),
      );
      this.storage.exec("DELETE FROM room_updates WHERE room = ?", this.key);
      this.storage.exec("INSERT INTO room_updates (room, seq, data) VALUES (?, ?, ?)", this.key, 0, Y.encodeStateAsUpdate(this.doc));
    });
    this.nextSeq = 1;
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
      void this.flush().catch((e) => {
        // a store with a size budget (the demo) is full: say so once, keep the text live, try again now and then
        if (!isErr(e, "StoreFullError")) console.error(`[room ${this.key}] flush failed:`, e);
        else if (!this.fullWarned) {
          this.fullWarned = true;
          console.warn(`[room ${this.key}] not saved: ${e.message}`);
        }
      });
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
      let full = false;
      try {
        await this.commitNow();
        ok = true;
      } catch (e) {
        full = isErr(e, "StoreFullError");
        throw e;
      } finally {
        // Whoever called us, unsaved text always gets another attempt (backing off after a failure).
        if (!this.closed && this.dirty) this.scheduleFlush(ok ? config.quietMs : full ? 60_000 : Math.max(config.quietMs, 5000));
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
        this.contributors.clear();
        this.saveMeta();
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
      this.setOrigin(null, null);
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
        // the lines that came from outside are the new commit's: re-point origin lines at its text
        this.setOrigin(head, remote);
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
    // (while Git blame is still loading, everyone gets the line authors once it's there)
    if (this.originAuthors !== null) {
      const msg = this.blame();
      this.sendControlTo(conn, msg);
      // the only connection: what everyone has now
      if (this.conns.size === 1) this.sentBlame = JSON.stringify(msg);
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

  /**
   * Remove awareness states nobody renewed within AWARENESS_TIMEOUT_MS (people whose tab froze, agents' cursors).
   * The host may call it from its timer or alarm; the room also sweeps on messages and, with `sweepTimer`, by itself.
   * Returns how many states were removed.
   */
  sweepAwareness(now = Date.now()): number {
    this.lastSweep = now;
    if (this.closed) return 0;
    const stale: number[] = [];
    for (const [id, meta] of this.awareness.meta) {
      if (id !== this.awareness.clientID && this.awareness.states.has(id) && now - meta.lastUpdated >= AWARENESS_TIMEOUT_MS) stale.push(id);
    }
    if (stale.length) awarenessProtocol.removeAwarenessStates(this.awareness, stale, "timeout");
    return stale.length;
  }

  /** With `sweepTimer`: sweep every AWARENESS_SWEEP_MS while there are awareness states, and not otherwise. */
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

  /** Whether the room has no connections and nothing happened in it for `idleMs`. */
  idle(idleMs = IDLE_CLOSE_MS): boolean {
    return !this.closed && this.conns.size === 0 && Date.now() - this.lastActivity >= idleMs;
  }

  /**
   * Commit and close the room if it's idle (see idle()); the close timer calls it, and hosts without one (Workers)
   * call it from their alarm. Returns whether the room is closed now. A failed commit keeps the room (and logs).
   */
  async closeIfIdle(idleMs = IDLE_CLOSE_MS): Promise<boolean> {
    if (this.closed) return true;
    if (!this.idle(idleMs)) return false;
    try {
      if (this.dirty) await this.flush();
    } catch (e) {
      console.error(`[room ${this.key}] final flush failed, keeping room:`, e);
      return false;
    }
    if (this.closed) return true;
    if (this.dirty || !this.idle(idleMs)) return false;
    this.destroy(true);
    return true;
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
    for (const t of [this.quietTimer, this.closeTimer, this.blameTimer, this.sweepTimer]) if (t) clearTimeout(t);
    this.quietTimer = this.closeTimer = this.blameTimer = this.sweepTimer = null;
    this.owners.clear();
    this.awareness.destroy();
    if (dropLog && !this.ephemeral) {
      this.storage.transaction(() => {
        this.storage.exec("DELETE FROM room_updates WHERE room = ?", this.key);
        this.storage.exec("DELETE FROM room_meta WHERE room = ?", this.key);
      });
    }
    this.onClose(this);
    this.doc.destroy();
  }
}

type BlameResult = { blame: Author[] | null } | { error: unknown };

const roomTablesReady = new WeakSet<RoomStorage>();

/**
 * Make sure the crash-log tables exist in `storage` and have today's shape (Bun's db.ts makes older ones; a Durable
 * Object starts empty), upgrading in place: room_meta gets the blame, blame_people and state columns, and a
 * room_updates with a global rowid seq becomes `PRIMARY KEY (room, seq) WITHOUT ROWID`, rows copied as they are.
 * Rooms call it once per storage.
 */
export function ensureRoomTables(storage: RoomStorage) {
  if (roomTablesReady.has(storage)) return;
  storage.exec(`CREATE TABLE IF NOT EXISTS room_meta (room TEXT PRIMARY KEY, generation TEXT NOT NULL, base_commit TEXT,
    base_content TEXT NOT NULL, base_snapshot BLOB NOT NULL, blame TEXT, blame_people TEXT, state TEXT)`);
  storage.exec(ROOM_UPDATES("room_updates"));
  const has = (sql: string) => {
    try {
      storage.exec(sql);
      return true;
    } catch {
      return false;
    }
  };
  for (const col of ["blame", "blame_people", "state"]) {
    if (!has(`SELECT ${col} FROM room_meta LIMIT 0`)) storage.exec(`ALTER TABLE room_meta ADD COLUMN ${col} TEXT`);
  }
  // only a table with a rowid has one: the old shape
  if (has("SELECT rowid FROM room_updates LIMIT 0")) {
    const author = has("SELECT author FROM room_updates LIMIT 0") ? "author" : "NULL";
    storage.transaction(() => {
      storage.exec("DROP TABLE IF EXISTS room_updates_new");
      storage.exec(ROOM_UPDATES("room_updates_new"));
      storage.exec(`INSERT INTO room_updates_new (room, seq, data, author) SELECT room, seq, data, ${author} FROM room_updates`);
      storage.exec("DROP TABLE room_updates");
      storage.exec("ALTER TABLE room_updates_new RENAME TO room_updates");
    });
  }
  // an index db.ts used to make for the old shape: the primary key covers it now
  storage.exec("DROP INDEX IF EXISTS room_updates_room");
  roomTablesReady.add(storage);
}

const ROOM_UPDATES = (name: string) =>
  `CREATE TABLE IF NOT EXISTS ${name} (room TEXT NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL, author INTEGER, PRIMARY KEY (room, seq)) WITHOUT ROWID`;

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
