// The demo workspace on Workers, kept in memory as on Bun: its WorkspaceDO holds a plain MemoryStore with Bun's seed
// and limits (server/demo.ts), so a full demo answers with the same StoreFullError message. Its rooms keep no crash
// log, and its sockets are standard (not hibernatable), so the object stays in memory while anyone is connected.
// Each new instance seeds itself: once everyone has left and the object is evicted, the next visitor gets the seed.
// The 6-hourly cron resets it (WorkspaceDO resetDemo): rooms discarded, sockets closed with 1013, the seed back.
import { config } from "../server/config.ts";
import { DEMO_ID, ensureDemoRow, newDemoStore, seedDemoRepo } from "../server/demo.ts";
import { emit } from "../server/events.ts";
import type { RoomManager } from "../server/rooms.ts";
import type { Db } from "../server/seams/db.ts";
import type { GitStore } from "../server/store/types.ts";

export { DEMO_ID, newDemoStore };

/** The demo's branch, putting its workspace row in if it's missing (as Bun does at startup). */
async function demoBranch(db: Db): Promise<string> {
  try {
    await ensureDemoRow(db);
    return (await db.get<{ branch: string }>("SELECT branch FROM repos WHERE id = ?", DEMO_ID))?.branch ?? config.defaultBranch;
  } catch (e) {
    // the seed still goes in, so the demo works; the row is put in again on the next access
    console.error("[demo] workspace row:", e);
    return config.defaultBranch;
  }
}

/** A new demo object: the seed in its (empty) in-memory store. */
export async function openDemo(store: GitStore, db: Db) {
  await seedDemoRepo(store, await demoBranch(db));
}

/** Back to the seed: open rooms thrown away (every socket closed with 1013, clients reload), the repo reseeded. */
export async function resetDemoWorkspace(o: { store: GitStore; rooms: RoomManager; db: Db; sockets: Iterable<WebSocket> }) {
  const branch = await demoBranch(o.db);
  await o.rooms.discardRepo(DEMO_ID);
  for (const ws of o.sockets) {
    try {
      ws.close(1013, "reset");
    } catch {}
  }
  await seedDemoRepo(o.store, branch);
  emit({ type: "tree", repo: DEMO_ID });
}

/** Once per isolate, before a request that names the demo: its D1 row, so /app/demo works on a fresh deploy. */
let rowReady: Promise<void> | null = null;

export function ensureDemoRowOnce(db: Db): Promise<void> {
  return (rowReady ??= ensureDemoRow(db).catch((e) => {
    rowReady = null;
    console.error("[demo] workspace row:", e);
  }));
}

const DEMO_API = new RegExp(`^/api/(?:repos|workspaces)/${DEMO_ID}(?:/|$)`);

/** Whether a request is about the demo workspace (its API, its sockets). */
export function namesDemo(url: URL): boolean {
  return DEMO_API.test(url.pathname) || (url.pathname === "/ws" && url.searchParams.get("repo") === DEMO_ID);
}
