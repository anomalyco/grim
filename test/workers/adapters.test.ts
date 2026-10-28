// The Workers adapters (src/workers/db-d1.ts, src/workers/room-storage-do.ts) against real D1 and Durable Object
// SQLite in workerd (Miniflare 5), compared with the Bun implementations running the same contracts.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { bunDb } from "../../src/server/bun/db-bun.ts";
import { BunRoomStorage } from "../../src/server/bun/room-storage-bun.ts";
import { dbContract } from "./db-contract.ts";
import { migrationStatements, startWorker, type StartedWorker } from "./miniflare.ts";
import { roomStorageContract } from "./room-storage-contract.ts";

let w: StartedWorker;

beforeAll(async () => {
  w = await startWorker({ entry: join(import.meta.dir, "adapters.worker.js"), durableObjects: { STORAGE: "StorageDO" } });
}, 60_000);

afterAll(async () => {
  await w?.dispose();
});

async function json(path: string) {
  const res = await w.fetch(path);
  const body = (await res.json()) as unknown;
  if (res.status !== 200) throw new Error(`${path}: ${JSON.stringify(body)}`);
  return body;
}

describe("D1 Db", () => {
  test("matches the Bun Db on get, all, run and atomic batches", async () => {
    const sqlite = new Database(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    for (const s of migrationStatements()) sqlite.exec(s);
    const bun = await dbContract(bunDb(sqlite));
    const d1 = await json("/d1/contract");
    expect(d1).toEqual(bun);
    // The same expectations as schema.test.ts's "bun Db" test, on the D1 side.
    const t = d1 as unknown[];
    expect(t[0]).toEqual({ changes: 1 });
    expect(t[1]).toEqual({ login: "ada" });
    expect(t[2]).toBeNull();
    expect(t[3]).toEqual({ changes: 1 });
    expect(t[10]).toEqual([{ id: "r1", head: "abc" }]);
    expect(t.slice(11, 15)).toEqual([true, [{ id: "r1" }], true, { title: "One", head: "abc" }]);
    expect(t.slice(15)).toEqual([true, true]);
  });

  test("a session started from a bookmark sees the writes before it", async () => {
    expect(await json("/d1/session")).toEqual({ bookmark: "string", row: { id: "s1" } });
  });
});

describe("DO RoomStorage", () => {
  test("matches the Bun RoomStorage (exec, nested transactions, blobs up to 5 MB)", async () => {
    const bun = roomStorageContract(new BunRoomStorage(new Database(":memory:")));
    const doTrace = await json("/do/contract/contract");
    expect(doTrace).toEqual(JSON.parse(JSON.stringify(bun)));
    expect(bun).not.toContain(false);
  }, 30_000);

  test("chunks a 5 MB blob into 1 MB rows that survive eviction", async () => {
    expect(await json("/do/big/chunkSize")).toBe(1024 * 1024);
    expect(await json("/do/big/putBig?seed=5")).toEqual({ n: 6, max: 1024 * 1024 });
    await w.mf.unsafeEvictDurableObject(w.name, "StorageDO", { name: "big" });
    expect(await json("/do/big/checkBig?seed=5")).toBe(true);
    expect(await json("/do/big/checkBig?seed=6")).toBe(false);
  }, 30_000);
});
