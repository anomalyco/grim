import type { RoomStorage } from "../server/seams/room-storage.ts";

/** DO SQLite rejects rows (and values) over 2 MB, so blobs are split into rows of at most this many bytes. */
export const BLOB_CHUNK = 1024 * 1024;

/**
 * RoomStorage over a Durable Object's SQLite (`ctx.storage`). Rows look the way bun:sqlite returns them:
 * BLOB columns come back as Uint8Array (DO SQL gives ArrayBuffers), and Uint8Array/boolean/undefined
 * parameters are bound as BLOB/0-1/NULL. `transaction` uses `transactionSync`, which nests (savepoints).
 * Blobs live in `room_blobs (key, idx, data)`, one row per chunk of up to 1 MB, made on first use.
 */
export class DoRoomStorage implements RoomStorage {
  private blobsReady = false;

  constructor(private storage: DurableObjectStorage) {}

  exec<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    const rows = this.storage.sql.exec(sql, ...params.map(bindable)).toArray();
    for (const row of rows) {
      for (const k in row) {
        const v = row[k];
        if (v instanceof ArrayBuffer) (row as Record<string, unknown>)[k] = new Uint8Array(v);
      }
    }
    return rows as T[];
  }

  transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }

  putBlob(key: string, bytes: Uint8Array) {
    this.blobs();
    this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      sql.exec("DELETE FROM room_blobs WHERE key = ?", key);
      // An empty blob still gets one (empty) row, so getBlob tells it apart from a missing one.
      let idx = 0;
      do {
        sql.exec("INSERT INTO room_blobs (key, idx, data) VALUES (?, ?, ?)", key, idx, bindable(bytes.subarray(idx * BLOB_CHUNK, (idx + 1) * BLOB_CHUNK)));
        idx++;
      } while (idx * BLOB_CHUNK < bytes.length);
    });
  }

  getBlob(key: string): Uint8Array | null {
    this.blobs();
    const chunks = this.storage.sql.exec<{ data: ArrayBuffer }>("SELECT data FROM room_blobs WHERE key = ? ORDER BY idx", key).toArray();
    if (chunks.length === 0) return null;
    if (chunks.length === 1) return new Uint8Array(chunks[0].data);
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.data.byteLength, 0));
    let at = 0;
    for (const c of chunks) {
      out.set(new Uint8Array(c.data), at);
      at += c.data.byteLength;
    }
    return out;
  }

  private blobs() {
    if (this.blobsReady) return;
    this.storage.sql.exec("CREATE TABLE IF NOT EXISTS room_blobs (key TEXT NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (key, idx))");
    this.blobsReady = true;
  }
}

function bindable(v: unknown): SqlStorageValue {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Uint8Array) {
    // Bind exactly the view's bytes (a subarray shares a larger buffer).
    return v.byteOffset === 0 && v.byteLength === v.buffer.byteLength ? (v.buffer as ArrayBuffer) : (v.slice().buffer as ArrayBuffer);
  }
  return v as SqlStorageValue;
}
