/**
 * One workspace's crash log (room_meta / room_updates) and caches. Synchronous on both sides: Bun uses the
 * bun:sqlite database (src/server/bun/room-storage-bun.ts), Workers a Durable Object's ctx.storage.sql.
 */
export interface RoomStorage {
  /** Run one statement; rows for queries, [] otherwise. */
  exec<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
  /** Run `fn` atomically and return its result. */
  transaction<T>(fn: () => T): T;
  putBlob(key: string, bytes: Uint8Array): void;
  getBlob(key: string): Uint8Array | null;
}
