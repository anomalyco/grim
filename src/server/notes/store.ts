// One workspace's notes, versions, search index and image map, in SQLite (docs/storage-v2.md §1): the WorkspaceDO's
// own database on Workers, the server's grimoire.sqlite on Bun (every table has a `ws` column, so workspaces can
// share one database). Synchronous, over the RoomStorage seam. Text, versions and line authors are the truth; the
// Y.Doc (a blob per note, plus the `note_updates` tail since the last compaction) is a merge cache that can be
// rebuilt from the text by bumping the note's epoch.
import { newId } from "../ids.ts";
import type { RoomStorage } from "../seams/room-storage.ts";
import type { ParticipantKind } from "../room.ts";
import { linePairs } from "../../shared/textdiff.ts";

/** Someone who wrote lines (line authors) or made a version. */
export interface Person {
  id: string;
  name: string;
  email: string;
  kind: ParticipantKind;
  color: string;
}

/** A contributor to a version: a person and how many edits they made in it. */
export interface Contributor extends Person {
  edits: number;
}

/** Line authors at a text: `lines[i]` indexes `people` (or -1) for every line (`text.split("\n")`). */
export interface LineAuthors {
  people: Person[];
  lines: number[];
  /** LineMemory entries (undo gives a line back): [line text, people index]. */
  history?: Array<[string, number]>;
}

/** The version a note has open (edits not cut into a version yet). */
export interface Pending {
  started: number;
  last: number;
  authors: Contributor[];
}

export interface Note {
  id: string;
  path: string;
  text: string;
  epoch: number;
  authors: LineAuthors | null;
  pending: Pending | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export type VersionKind = "edit" | "agent" | "restore" | "rename" | "delete" | "import";

export interface Version {
  id: number;
  note_id: string;
  kind: VersionKind;
  path: string;
  started_at: number;
  ended_at: number;
  authors: Contributor[];
  message: string | null;
  text: string;
  line_authors: LineAuthors | null;
}

export interface ImageRow {
  path: string;
  sha256: string;
  type: string;
  size: number;
}

/** A version id as the API shows it (its "sha"): 12 hex digits. */
export const versionRef = (id: number) => id.toString(16).padStart(12, "0");
/** A version id from the API, or null if it isn't one. */
export function parseVersionRef(ref: string): number | null {
  if (!/^[0-9a-f]{1,16}$/i.test(ref)) return null;
  const n = parseInt(ref, 16);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** A version is cut after this long without edits… */
export const VERSION_IDLE_MS = 5 * 60_000;
/** …or after this long of continuous editing. */
export const VERSION_SPAN_MS = 30 * 60_000;

const ready = new WeakSet<RoomStorage>();

/** Make the tables (idempotent, once per storage). */
export function ensureNoteTables(s: RoomStorage) {
  if (ready.has(s)) return;
  s.exec(`CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, ws TEXT NOT NULL, path TEXT NOT NULL, text TEXT NOT NULL,
    epoch INTEGER NOT NULL, authors TEXT, pending TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER)`);
  s.exec("CREATE UNIQUE INDEX IF NOT EXISTS notes_path ON notes(ws, path) WHERE deleted_at IS NULL");
  s.exec(`CREATE TABLE IF NOT EXISTS note_updates (note_id TEXT NOT NULL, epoch INTEGER NOT NULL, seq INTEGER NOT NULL,
    data BLOB NOT NULL, author INTEGER, PRIMARY KEY (note_id, seq)) WITHOUT ROWID`);
  s.exec(`CREATE TABLE IF NOT EXISTS versions (id INTEGER PRIMARY KEY AUTOINCREMENT, ws TEXT NOT NULL, note_id TEXT NOT NULL,
    kind TEXT NOT NULL, path TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL, authors TEXT NOT NULL,
    message TEXT, text TEXT NOT NULL, line_authors TEXT)`);
  s.exec("CREATE INDEX IF NOT EXISTS versions_note ON versions(note_id, id)");
  s.exec("CREATE INDEX IF NOT EXISTS versions_ws ON versions(ws, id)");
  s.exec("CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(note_id UNINDEXED, ws UNINDEXED, path, text, tokenize = 'trigram')");
  s.exec(`CREATE TABLE IF NOT EXISTS images (ws TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL, type TEXT NOT NULL,
    size INTEGER NOT NULL, by TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (ws, path)) WITHOUT ROWID`);
  s.getBlob(""); // makes room_blobs, which bumpEpoch and wipe delete from
  ready.add(s);
}

const json = <T>(s: unknown): T | null => {
  if (typeof s !== "string" || !s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
};

interface NoteSql {
  id: string;
  path: string;
  text: string;
  epoch: number;
  authors: string | null;
  pending: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

const toNote = (r: NoteSql): Note => ({ ...r, authors: json<LineAuthors>(r.authors), pending: json<Pending>(r.pending) });

interface VersionSql {
  id: number;
  note_id: string;
  kind: VersionKind;
  path: string;
  started_at: number;
  ended_at: number;
  authors: string;
  message: string | null;
  text: string;
  line_authors: string | null;
}

const toVersion = (r: VersionSql): Version => ({ ...r, authors: json<Contributor[]>(r.authors) ?? [], line_authors: json<LineAuthors>(r.line_authors) });

const docKey = (id: string, epoch: number) => `ydoc:${id}:${epoch}`;

/** Add `edits` by `p` to a contributor list (main author first after sorting). */
export function addContributor(list: Contributor[], p: Person, edits = 1): Contributor[] {
  const out = list.map((c) => ({ ...c }));
  const c = out.find((x) => x.id === p.id);
  if (c) {
    c.edits += edits;
    c.name = p.name;
    c.color = p.color;
  } else out.push({ id: p.id, name: p.name, email: p.email, kind: p.kind, color: p.color, edits });
  return out.sort((a, b) => b.edits - a.edits);
}

/**
 * Line authors from a note's versions, oldest first: lines of the oldest version are its main author's, then each
 * version keeps the authors of the lines it left as they were and takes the rest (imports).
 */
export function authorsFromVersions(versions: Array<{ text: string; author: Person }>): LineAuthors {
  const people: Person[] = [];
  const index = (p: Person) => {
    let i = people.findIndex((q) => q.id === p.id);
    if (i < 0) i = people.push(p) - 1;
    return i;
  };
  let prev: string[] = [];
  let lines: number[] = [];
  for (const v of versions) {
    const next = v.text.split("\n");
    const who = index(v.author);
    const vals: number[] = next.map(() => who);
    for (const [a, b] of linePairs(prev, next)) vals[b] = lines[a] ?? -1;
    prev = next;
    lines = vals;
  }
  return { people, lines };
}

export class NoteStore {
  constructor(
    readonly storage: RoomStorage,
    readonly ws: string,
  ) {
    ensureNoteTables(storage);
  }

  private q<T>(sql: string, ...params: unknown[]): T[] {
    return this.storage.exec<T>(sql, ...params);
  }

  // ---- notes ----

  byPath(path: string): Note | null {
    const r = this.q<NoteSql>("SELECT * FROM notes WHERE ws = ? AND path = ? AND deleted_at IS NULL", this.ws, path)[0];
    return r ? toNote(r) : null;
  }

  byId(id: string): Note | null {
    const r = this.q<NoteSql>("SELECT * FROM notes WHERE ws = ? AND id = ?", this.ws, id)[0];
    return r ? toNote(r) : null;
  }

  /** The newest note (live, else deleted) that had `path`: history of deleted notes stays reachable by path. */
  anyByPath(path: string): Note | null {
    const live = this.byPath(path);
    if (live) return live;
    const r = this.q<NoteSql>("SELECT * FROM notes WHERE ws = ? AND path = ? ORDER BY deleted_at DESC LIMIT 1", this.ws, path)[0];
    return r ? toNote(r) : null;
  }

  /** Live notes: paths with sizes and change times, sorted by path. */
  list(): Array<{ path: string; size: number; updated_at: number }> {
    return this.q<{ path: string; size: number; updated_at: number }>(
      "SELECT path, length(text) AS size, updated_at FROM notes WHERE ws = ? AND deleted_at IS NULL ORDER BY path",
      this.ws,
    );
  }

  paths(): string[] {
    return this.q<{ path: string }>("SELECT path FROM notes WHERE ws = ? AND deleted_at IS NULL ORDER BY path", this.ws).map((r) => r.path);
  }

  /** A new note (throws if a live note has the path). Its text gets `authors`; `pending` opens its first version. */
  create(path: string, text: string, opts: { authors?: LineAuthors | null; pending?: Pending | null; now?: number; id?: string } = {}): Note {
    const now = opts.now ?? Date.now();
    const id = opts.id ?? newId("n_");
    this.storage.transaction(() => {
      if (this.byPath(path)) throw new Error(`${path} already exists`);
      this.q(
        "INSERT INTO notes (id, ws, path, text, epoch, authors, pending, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)",
        id,
        this.ws,
        path,
        text,
        opts.authors ? JSON.stringify(opts.authors) : null,
        opts.pending ? JSON.stringify(opts.pending) : null,
        now,
        now,
      );
      this.index(id, path, text);
    });
    return this.byId(id)!;
  }

  /** The Y.Doc state of a note at its compacted text (this epoch), or null (built from the text then). */
  loadDoc(id: string, epoch: number): Uint8Array | null {
    return this.storage.getBlob(docKey(id, epoch));
  }

  saveDoc(id: string, epoch: number, state: Uint8Array) {
    this.storage.putBlob(docKey(id, epoch), state);
  }

  tail(id: string, epoch: number): Array<{ seq: number; data: Uint8Array; author: number | null }> {
    return this.q("SELECT seq, data, author FROM note_updates WHERE note_id = ? AND epoch = ? ORDER BY seq", id, epoch);
  }

  appendUpdate(id: string, epoch: number, seq: number, data: Uint8Array, author: number | null, pending: Pending | null) {
    this.storage.transaction(() => {
      this.q("INSERT INTO note_updates (note_id, epoch, seq, data, author) VALUES (?, ?, ?, ?, ?)", id, epoch, seq, data, author);
      this.q("UPDATE notes SET pending = ?, updated_at = ? WHERE id = ?", pending ? JSON.stringify(pending) : null, Date.now(), id);
    });
  }

  /** Write the note's current state (text, doc, line authors, open version) and drop the update tail. */
  compact(id: string, epoch: number, s: { text: string; doc: Uint8Array; authors: LineAuthors; pending: Pending | null }) {
    this.storage.transaction(() => {
      this.saveDoc(id, epoch, s.doc);
      this.q("UPDATE notes SET text = ?, authors = ?, pending = ?, updated_at = ? WHERE id = ?", s.text, JSON.stringify(s.authors), s.pending ? JSON.stringify(s.pending) : null, Date.now(), id);
      this.q("DELETE FROM note_updates WHERE note_id = ?", id);
    });
  }

  /**
   * Rebuild a note from its text: a new epoch (clients merge by text), no doc, no tail. For imports, demo resets,
   * restores from backup.
   */
  bumpEpoch(id: string, text?: string): number {
    const n = this.byId(id);
    if (!n) return 0;
    const epoch = n.epoch + 1;
    this.storage.transaction(() => {
      this.q("DELETE FROM note_updates WHERE note_id = ?", id);
      this.q("DELETE FROM room_blobs WHERE key = ?", docKey(id, n.epoch));
      this.q("UPDATE notes SET epoch = ?, text = COALESCE(?, text), updated_at = ? WHERE id = ?", epoch, text ?? null, Date.now(), id);
    });
    return epoch;
  }

  rename(id: string, to: string) {
    this.storage.transaction(() => {
      if (this.byPath(to)) throw new Error(`${to} already exists`);
      this.q("UPDATE notes SET path = ?, updated_at = ? WHERE id = ?", to, Date.now(), id);
      this.q("UPDATE notes_fts SET path = ? WHERE note_id = ?", to, id);
    });
  }

  softDelete(id: string) {
    const now = Date.now();
    this.storage.transaction(() => {
      this.q("UPDATE notes SET deleted_at = ?, updated_at = ?, pending = NULL WHERE id = ?", now, now, id);
      this.q("DELETE FROM notes_fts WHERE note_id = ?", id);
      this.q("DELETE FROM note_updates WHERE note_id = ?", id);
    });
  }

  /** Every note of the workspace (deleted ones too) and its data, gone (a removed workspace, a demo reset). */
  wipe() {
    const ids = this.q<{ id: string; epoch: number }>("SELECT id, epoch FROM notes WHERE ws = ?", this.ws);
    this.storage.transaction(() => {
      for (const { id, epoch } of ids) {
        this.q("DELETE FROM note_updates WHERE note_id = ?", id);
        this.q("DELETE FROM room_blobs WHERE key = ?", docKey(id, epoch));
      }
      this.q("DELETE FROM notes WHERE ws = ?", this.ws);
      this.q("DELETE FROM versions WHERE ws = ?", this.ws);
      this.q("DELETE FROM notes_fts WHERE ws = ?", this.ws);
      this.q("DELETE FROM images WHERE ws = ?", this.ws);
    });
  }

  private index(id: string, path: string, text: string) {
    this.q("DELETE FROM notes_fts WHERE note_id = ?", id);
    this.q("INSERT INTO notes_fts (note_id, ws, path, text) VALUES (?, ?, ?, ?)", id, this.ws, path, text);
  }

  // ---- versions ----

  /**
   * Cut a version of note `id` at `text` with `authors` (contributors, main first) and line authors; the note's
   * open version is closed. Returns the new version's id.
   */
  cutVersion(
    id: string,
    v: { kind: VersionKind; path: string; text: string; started: number; authors: Contributor[]; lines: LineAuthors | null; message?: string | null; ended?: number },
  ): number {
    let vid = 0;
    this.storage.transaction(() => {
      const r = this.q<{ id: number }>(
        `INSERT INTO versions (ws, note_id, kind, path, started_at, ended_at, authors, message, text, line_authors) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        this.ws,
        id,
        v.kind,
        v.path,
        v.started,
        v.ended ?? Date.now(),
        JSON.stringify(v.authors),
        v.message ?? null,
        v.text,
        v.lines ? JSON.stringify({ people: v.lines.people, lines: v.lines.lines }) : null,
      );
      vid = r[0]!.id;
      this.q("UPDATE notes SET pending = NULL WHERE id = ?", id);
      const n = this.byId(id);
      if (n && n.deleted_at === null) this.index(id, n.path, v.text);
    });
    return vid;
  }

  /** Versions of a note, newest first. */
  versions(noteId: string, limit = 50, before?: number): Version[] {
    return this.q<VersionSql>(
      `SELECT * FROM versions WHERE note_id = ? ${before ? "AND id < ?" : ""} ORDER BY id DESC LIMIT ?`,
      ...(before ? [noteId, before, limit] : [noteId, limit]),
    ).map(toVersion);
  }

  /** Versions of every note under `prefix` ("" all), newest first. */
  versionsUnder(prefix: string, limit = 50): Version[] {
    return this.q<VersionSql>(
      "SELECT * FROM versions WHERE ws = ? AND (? = '' OR path = ? OR substr(path, 1, length(?) + 1) = ? || '/') ORDER BY id DESC LIMIT ?",
      this.ws,
      prefix,
      prefix,
      prefix,
      prefix,
      limit,
    ).map(toVersion);
  }

  version(id: number): Version | null {
    const r = this.q<VersionSql>("SELECT * FROM versions WHERE ws = ? AND id = ?", this.ws, id)[0];
    return r ? toVersion(r) : null;
  }

  /** The version of the same note just before `v` (null for its first). */
  previous(v: Version): Version | null {
    const r = this.q<VersionSql>("SELECT * FROM versions WHERE note_id = ? AND id < ? ORDER BY id DESC LIMIT 1", v.note_id, v.id)[0];
    return r ? toVersion(r) : null;
  }

  latestVersion(noteId: string): Version | null {
    return this.versions(noteId, 1)[0] ?? null;
  }

  /** Notes whose open version has been idle for `idleMs` (or open for `spanMs`), skipping `skip` (notes with open rooms). */
  dueVersions(now: number, skip: Set<string>, idleMs = VERSION_IDLE_MS, spanMs = VERSION_SPAN_MS): Note[] {
    return this.q<NoteSql>("SELECT * FROM notes WHERE ws = ? AND pending IS NOT NULL AND deleted_at IS NULL", this.ws)
      .map(toNote)
      .filter((n) => !skip.has(n.id) && n.pending && (now - n.pending.last >= idleMs || now - n.pending.started >= spanMs));
  }

  /** Cut the versions of closed notes that are due (the alarm, Bun's sweep). Their compacted text is current. */
  cutDue(now: number, skip: Set<string>): number {
    const due = this.dueVersions(now, skip);
    for (const n of due) {
      if (this.tail(n.id, n.epoch).length) continue; // a room that died before compacting: it cuts when reopened
      this.cutVersion(n.id, { kind: "edit", path: n.path, text: n.text, started: n.pending!.started, ended: n.pending!.last, authors: n.pending!.authors, lines: n.authors });
    }
    return due.length;
  }

  /** Whether any note has an open version (the alarm keeps running for them). */
  hasPending(): boolean {
    return this.q("SELECT 1 FROM notes WHERE ws = ? AND pending IS NOT NULL AND deleted_at IS NULL LIMIT 1", this.ws).length > 0;
  }

  // ---- search ----

  /** Notes matching `q` (case-insensitive substring), up to `limit` hits as lines. */
  search(q: string, limit = 100): Array<{ path: string; line: number; text: string }> {
    const needle = q.trim();
    if (!needle) return [];
    const rows =
      [...needle].length >= 3
        ? this.q<{ path: string; text: string }>(
            "SELECT path, text FROM notes_fts WHERE notes_fts MATCH ? AND ws = ? ORDER BY path LIMIT 500",
            `"${needle.replace(/"/g, '""')}"`,
            this.ws,
          )
        : this.q<{ path: string; text: string }>("SELECT path, text FROM notes WHERE ws = ? AND deleted_at IS NULL AND instr(lower(text), lower(?)) > 0 ORDER BY path LIMIT 500", this.ws, needle);
    const lower = needle.toLowerCase();
    const hits: Array<{ path: string; line: number; text: string }> = [];
    for (const r of rows) {
      const lines = r.text.split("\n");
      for (let i = 0; i < lines.length && hits.length < limit; i++) {
        if (lines[i]!.toLowerCase().includes(lower)) hits.push({ path: r.path, line: i + 1, text: lines[i]!.slice(0, 500) });
      }
      if (hits.length >= limit) break;
    }
    return hits;
  }

  // ---- images ----

  image(path: string): ImageRow | null {
    return this.q<ImageRow>("SELECT path, sha256, type, size FROM images WHERE ws = ? AND path = ?", this.ws, path)[0] ?? null;
  }

  putImage(row: ImageRow, by: string | null) {
    this.q(
      "INSERT INTO images (ws, path, sha256, type, size, by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (ws, path) DO UPDATE SET sha256 = excluded.sha256, type = excluded.type, size = excluded.size",
      this.ws,
      row.path,
      row.sha256,
      row.type,
      row.size,
      by,
      Date.now(),
    );
  }

  images(): ImageRow[] {
    return this.q<ImageRow>("SELECT path, sha256, type, size FROM images WHERE ws = ? ORDER BY path", this.ws);
  }

  imagesUnder(prefix: string): ImageRow[] {
    return this.images().filter((i) => i.path.startsWith(`${prefix}/`));
  }

  moveImage(from: string, to: string) {
    this.q("UPDATE images SET path = ? WHERE ws = ? AND path = ?", to, this.ws, from);
  }

  deleteImage(path: string) {
    this.q("DELETE FROM images WHERE ws = ? AND path = ?", this.ws, path);
  }

  /** Every version of the workspace, oldest first (export). */
  allVersions(): Version[] {
    return this.q<VersionSql>("SELECT * FROM versions WHERE ws = ? ORDER BY id", this.ws).map(toVersion);
  }
}
