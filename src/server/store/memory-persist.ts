// A MemoryPersistence over a RoomStorage, so the demo's MemoryStore survives a restart (a Durable Object's SQLite on
// Workers, bun:sqlite in tests). Tables are made on first use, like room_blobs, so databases that never hold a demo
// don't get them. Blobs are split into 1 MiB parts: a Durable Object SQLite row holds at most 2 MB, and the demo
// allows 2 MiB images.
import type { RoomStorage } from "../seams/room-storage.ts";
import type { MemCommit, MemoryPersistence } from "./memory.ts";

/** Bytes per demo_blobs row. */
export const BLOB_PART_BYTES = 1024 * 1024;

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS demo_repos (repo TEXT PRIMARY KEY) WITHOUT ROWID",
  "CREATE TABLE IF NOT EXISTS demo_blobs (repo TEXT NOT NULL, sha TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (repo, sha, part)) WITHOUT ROWID",
  "CREATE TABLE IF NOT EXISTS demo_commits (repo TEXT NOT NULL, sha TEXT NOT NULL, seq INTEGER NOT NULL, record TEXT NOT NULL, PRIMARY KEY (repo, sha)) WITHOUT ROWID",
  "CREATE TABLE IF NOT EXISTS demo_heads (repo TEXT NOT NULL, branch TEXT NOT NULL, sha TEXT NOT NULL, PRIMARY KEY (repo, branch)) WITHOUT ROWID",
];

/** bun:sqlite returns a Uint8Array, Durable Object SQLite an ArrayBuffer. */
const toBytes = (v: unknown) => (v instanceof Uint8Array ? v : new Uint8Array(v as ArrayBuffer));

export class RoomStoragePersistence implements MemoryPersistence {
  private ready = false;

  constructor(private storage: RoomStorage) {}

  private db(): RoomStorage {
    if (!this.ready) {
      this.storage.transaction(() => {
        for (const sql of SCHEMA) this.storage.exec(sql);
      });
      this.ready = true;
    }
    return this.storage;
  }

  createRepo(repo: string) {
    this.db().exec("INSERT OR IGNORE INTO demo_repos (repo) VALUES (?)", repo);
  }

  hasRepo(repo: string) {
    return this.db().exec("SELECT 1 FROM demo_repos WHERE repo = ?", repo).length > 0;
  }

  deleteRepo(repo: string) {
    const s = this.db();
    s.transaction(() => {
      for (const table of ["demo_heads", "demo_commits", "demo_blobs", "demo_repos"]) s.exec(`DELETE FROM ${table} WHERE repo = ?`, repo);
    });
  }

  getBlob(repo: string, sha: string) {
    const rows = this.db().exec<{ data: unknown }>("SELECT data FROM demo_blobs WHERE repo = ? AND sha = ? ORDER BY part", repo, sha);
    if (!rows.length) return null;
    if (rows.length === 1) return new Uint8Array(toBytes(rows[0]!.data));
    const parts = rows.map((r) => toBytes(r.data));
    const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.byteLength;
    }
    return out;
  }

  putBlob(repo: string, sha: string, bytes: Uint8Array) {
    const s = this.db();
    s.transaction(() => {
      s.exec("DELETE FROM demo_blobs WHERE repo = ? AND sha = ?", repo, sha);
      let part = 0;
      for (let at = 0; at < bytes.byteLength || part === 0; at += BLOB_PART_BYTES, part++) {
        s.exec("INSERT INTO demo_blobs (repo, sha, part, data) VALUES (?, ?, ?, ?)", repo, sha, part, bytes.subarray(at, at + BLOB_PART_BYTES));
      }
    });
  }

  deleteBlob(repo: string, sha: string) {
    this.db().exec("DELETE FROM demo_blobs WHERE repo = ? AND sha = ?", repo, sha);
  }

  getCommit(repo: string, sha: string): MemCommit | null {
    const row = this.db().exec<{ record: string }>("SELECT record FROM demo_commits WHERE repo = ? AND sha = ?", repo, sha)[0];
    return row ? (JSON.parse(row.record) as MemCommit) : null;
  }

  putCommit(repo: string, commit: MemCommit) {
    // seq keeps putCommit order for listCommits; putting the same commit again keeps its place
    this.db().exec(
      "INSERT INTO demo_commits (repo, sha, seq, record) VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM demo_commits WHERE repo = ?), ?) ON CONFLICT (repo, sha) DO UPDATE SET record = excluded.record",
      repo,
      commit.sha,
      repo,
      JSON.stringify(commit),
    );
  }

  deleteCommit(repo: string, sha: string) {
    this.db().exec("DELETE FROM demo_commits WHERE repo = ? AND sha = ?", repo, sha);
  }

  listCommits(repo: string) {
    return this.db().exec<{ sha: string }>("SELECT sha FROM demo_commits WHERE repo = ? ORDER BY seq", repo).map((r) => r.sha);
  }

  getHead(repo: string, branch: string) {
    return this.db().exec<{ sha: string }>("SELECT sha FROM demo_heads WHERE repo = ? AND branch = ?", repo, branch)[0]?.sha ?? null;
  }

  setHead(repo: string, branch: string, sha: string) {
    this.db().exec("INSERT INTO demo_heads (repo, branch, sha) VALUES (?, ?, ?) ON CONFLICT (repo, branch) DO UPDATE SET sha = excluded.sha", repo, branch, sha);
  }

  listHeads(repo: string) {
    return Object.fromEntries(this.db().exec<{ branch: string; sha: string }>("SELECT branch, sha FROM demo_heads WHERE repo = ?", repo).map((r) => [r.branch, r.sha]));
  }
}
