// Test Worker for test/workers/adapters.test.ts: runs the Db and RoomStorage contracts against real D1 and
// Durable Object SQLite in workerd. Plain JS so the Bun tsconfig (which covers test/) doesn't need Workers types.
import { DurableObject } from "cloudflare:workers";
import { d1Db } from "../../src/workers/db-d1.ts";
import { BLOB_CHUNK, DoRoomStorage } from "../../src/workers/room-storage-do.ts";
import { dbContract } from "./db-contract.ts";
import { BIG, bytes, roomStorageContract, same } from "./room-storage-contract.ts";

export class StorageDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.rooms = new DoRoomStorage(ctx.storage);
  }

  contract() {
    return roomStorageContract(this.rooms);
  }

  putBig(seed) {
    this.rooms.putBlob("big", bytes(BIG, seed));
    return this.rooms.exec("SELECT count(*) AS n, max(length(data)) AS max FROM room_blobs WHERE key = 'big'")[0];
  }

  checkBig(seed) {
    return same(this.rooms.getBlob("big"), bytes(BIG, seed));
  }

  chunkSize() {
    return BLOB_CHUNK;
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/d1/contract") return Response.json(await dbContract(d1Db(env.DB)));
      if (url.pathname === "/d1/session") {
        // A write through one session is visible to a later session started from its bookmark.
        const a = d1Db(env.DB, "first-primary");
        await a.run("INSERT INTO users (id, login, name, email, created_at) VALUES ('s1', 's', 'S', 's@x', 1)");
        const bookmark = a.bookmark();
        const b = d1Db(env.DB, bookmark ?? "first-primary");
        return Response.json({ bookmark: typeof bookmark, row: await b.get("SELECT id FROM users WHERE id = 's1'") });
      }
      const m = url.pathname.match(/^\/do\/([^/]+)\/(\w+)$/);
      if (m) {
        const stub = env.STORAGE.getByName(m[1]);
        const seed = Number(url.searchParams.get("seed") ?? 1);
        return Response.json(await stub[m[2]](seed));
      }
      return new Response("not found", { status: 404 });
    } catch (e) {
      return Response.json({ error: String(e?.stack ?? e) }, { status: 500 });
    }
  },
};
