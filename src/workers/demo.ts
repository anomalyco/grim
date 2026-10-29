// The demo's rooms on Workers (src/server/demo-rooms.ts). Each room ("demo.<room>") is its own WorkspaceDO, kept in
// memory as on Bun: a plain MemoryStore with Bun's seed and limits (server/demo.ts), so a full room answers with the
// same StoreFullError message. Its rooms keep no crash log, and its sockets are standard (not hibernatable), so the
// object stays in memory while anyone is connected. Each new instance seeds itself: once everyone has left and the
// object is evicted, the next visitor (if the room still exists) gets the seed. While it has sockets it tells the
// lobby (HomeDO "demo-lobby") who is connected, every DEMO_REPORT_MS and when that changes. The 5-minute cron resets
// every room the lobby knows every DEMO_RESET_MINUTES (WorkspaceDO resetDemo): rooms discarded, sockets closed with
// 1013, the seed back. The Worker admits every REST call and socket on a room through the lobby (workersDemoGate).
import { config } from "../server/config.ts";
import { DEMO_ID, newDemoStore, seedDemoRepo } from "../server/demo.ts";
import { setDemoGate, type Admit, type DemoGate } from "../server/demo-rooms.ts";
import { emit } from "../server/events.ts";
import type { RoomManager } from "../server/rooms.ts";
import type { GitStore } from "../server/store/types.ts";
import { TtlCache } from "../server/ttl-cache.ts";
import { DEMO_LOBBY } from "./home-do.ts";
import type { Env } from "./index.ts";

export { DEMO_ID, newDemoStore };

const LOBBY_LOCATION = { locationHint: "enam" } as const;

/** The demo's lobby. */
export const demoLobby = (env: Env) => env.HOME.getByName(DEMO_LOBBY, LOBBY_LOCATION);

/** A new room's object: the seed in its (empty) in-memory store. */
export async function openDemo(store: GitStore, repo: string) {
  await seedDemoRepo(store, repo, config.defaultBranch);
}

/** Back to the seed: open rooms thrown away (every socket closed with 1013, clients reload), the repo reseeded. */
export async function resetDemoWorkspace(o: { repo: string; store: GitStore; rooms: RoomManager; sockets: Iterable<WebSocket> }) {
  await o.rooms.discardRepo(o.repo);
  for (const ws of o.sockets) {
    try {
      ws.close(1013, "reset");
    } catch {}
  }
  await seedDemoRepo(o.store, o.repo, config.defaultBranch);
  emit({ type: "tree", repo: o.repo });
}

/** Admissions the lobby granted lately, per isolate: a person's next calls in the same room don't ask it again. */
const admitted = new TtlCache<string, true>({ max: 20_000 });
const ADMITTED_MS = 10_000;

/** The lobby over RPC as the shared app's gate (set once per isolate, from the router and the Durable Objects). */
export function useWorkersDemoGate(env: Env) {
  if (gateSet) return;
  gateSet = true;
  const gate: DemoGate = {
    assign: (person, ip) => demoLobby(env).demoAssign(person, ip),
    async admit(workspace, person, ip): Promise<Admit> {
      const key = `${workspace}\0${person}`;
      if (admitted.lookup(key)) return "ok";
      const a = await demoLobby(env).demoAdmit(workspace, person, ip);
      if (a === "ok") admitted.set(key, true, ADMITTED_MS);
      return a;
    },
    roomOf: (person) => demoLobby(env).demoRoomOf(person),
  };
  setDemoGate(gate);
}
let gateSet = false;
