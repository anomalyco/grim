import type { Database, SQLQueryBindings } from "bun:sqlite";
import { db } from "../db.ts";
import type { RoomStorage } from "../seams/room-storage.ts";

/** RoomStorage over a bun:sqlite database (by default the server's grimoire.sqlite, where db.ts makes the room tables). */
export class BunRoomStorage implements RoomStorage {
  private blobsReady = false;

  constructor(private db: Database) {}

  exec<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.db.query(sql).all(...(params as SQLQueryBindings[])) as T[];
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  putBlob(key: string, bytes: Uint8Array) {
    this.blobs();
    this.db.query("INSERT INTO room_blobs (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data").run(key, bytes);
  }

  getBlob(key: string): Uint8Array | null {
    this.blobs();
    const row = this.db.query("SELECT data FROM room_blobs WHERE key = ?").get(key) as { data: Uint8Array } | null;
    return row ? new Uint8Array(row.data) : null;
  }

  /** room_blobs is made on first use, so databases that never store a blob don't get the table. */
  private blobs() {
    if (this.blobsReady) return;
    this.db.exec("CREATE TABLE IF NOT EXISTS room_blobs (key TEXT PRIMARY KEY, data BLOB NOT NULL)");
    this.blobsReady = true;
  }
}

let shared: BunRoomStorage | null = null;

/** The RoomStorage over the server's database. */
export function bunRoomStorage(): BunRoomStorage {
  return (shared ??= new BunRoomStorage(db));
}
