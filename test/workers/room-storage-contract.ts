// The `RoomStorage` contract as one synchronous scenario. It returns a trace of every result, so the same run
// against bun:sqlite (BunRoomStorage) and Durable Object SQLite (DoRoomStorage, inside workerd) can be compared.
import type { RoomStorage } from "../../src/server/seams/room-storage.ts";

/** Deterministic pseudo-random bytes (no crypto needed on either side). */
export function bytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

export function same(a: Uint8Array | null, b: Uint8Array): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export const BIG = 5 * 1024 * 1024 + 123;

export function roomStorageContract(s: RoomStorage): unknown[] {
  const trace: unknown[] = [];
  const threw = (fn: () => unknown) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };
  const blob = (v: unknown) => (v instanceof Uint8Array ? { u8: Array.from(v) } : v);
  const rows = (sql: string, ...params: unknown[]) =>
    s.exec<Record<string, unknown>>(sql, ...params).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, blob(v)])));

  trace.push(s.exec("CREATE TABLE IF NOT EXISTS t (k TEXT PRIMARY KEY, n INTEGER, data BLOB)"));
  trace.push(s.exec("INSERT INTO t (k, n, data) VALUES (?, ?, ?)", "a", 1, new Uint8Array([1, 2, 3])));
  // A subarray binds only its own bytes; undefined and booleans bind as NULL and 0/1.
  trace.push(s.exec("INSERT INTO t (k, n, data) VALUES (?, ?, ?)", "b", true, new Uint8Array([9, 8, 7, 6]).subarray(1, 3)));
  trace.push(s.exec("INSERT INTO t (k, n, data) VALUES (?, ?, ?)", "c", undefined, null));
  trace.push(rows("SELECT k, n, data FROM t ORDER BY k"));
  trace.push(s.exec("SELECT data FROM t WHERE k = 'a'")[0]?.data instanceof Uint8Array);
  trace.push(rows("SELECT k FROM t WHERE k = ?", "nobody"));

  // transaction: returns fn's value, commits, and rolls back everything when fn throws.
  trace.push(s.transaction(() => (s.exec("UPDATE t SET n = 10 WHERE k = 'a'"), "ok")));
  trace.push(
    threw(() =>
      s.transaction(() => {
        s.exec("UPDATE t SET n = 20 WHERE k = 'a'");
        s.exec("DELETE FROM t WHERE k = 'b'");
        throw new Error("boom");
      }),
    ),
  );
  trace.push(rows("SELECT k, n FROM t ORDER BY k"));
  // A failing inner transaction that is caught rolls back only itself.
  trace.push(
    s.transaction(() => {
      s.exec("UPDATE t SET n = 11 WHERE k = 'a'");
      const inner = threw(() =>
        s.transaction(() => {
          s.exec("UPDATE t SET n = 99 WHERE k = 'b'");
          throw new Error("inner");
        }),
      );
      return inner;
    }),
  );
  trace.push(rows("SELECT k, n FROM t ORDER BY k"));
  trace.push(threw(() => s.exec("SELECT * FROM nope")));

  // Blobs: missing, small, empty, overwrite, 5 MB (chunked on Workers), rolled back with a transaction.
  trace.push(s.getBlob("missing"));
  s.putBlob("small", new Uint8Array([1, 2, 3]));
  trace.push(blob(s.getBlob("small")));
  s.putBlob("empty", new Uint8Array(0));
  trace.push(blob(s.getBlob("empty")));
  const big = bytes(BIG, 7);
  s.putBlob("big", big);
  trace.push(same(s.getBlob("big"), big));
  s.putBlob("big", new Uint8Array([4, 5]));
  trace.push(blob(s.getBlob("big")));
  s.putBlob("big", big);
  trace.push(same(s.getBlob("big"), big));
  s.putBlob("view", bytes(10, 3).subarray(2, 6));
  trace.push(blob(s.getBlob("view")));
  trace.push(
    threw(() =>
      s.transaction(() => {
        s.putBlob("small", new Uint8Array([7]));
        s.putBlob("new", new Uint8Array([8]));
        throw new Error("boom");
      }),
    ),
  );
  trace.push(blob(s.getBlob("small")), s.getBlob("new"));
  return trace;
}
