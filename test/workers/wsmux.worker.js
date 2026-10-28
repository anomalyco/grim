// The production router and WorkspaceDO over an in-memory Git store, for test/workers/wsmux.test.ts (protocol v2):
// counts the Durable Objects' store calls, fetches, constructions and socket messages, and shows what the object
// keeps (socket tags and attachments, channel_paths, crash logs, the alarm).
import { WorkspaceDO as Base, useWorkspaceStore } from "../../src/workers/workspace-do.ts";
import { createRouter } from "../../src/workers/router.ts";
import { MemoryStore } from "../../src/server/store/memory.ts";

export { HubDO, HomeDO, ShellDO } from "../../src/workers/index.ts";

const store = new MemoryStore();
const counts = { store: 0, fetch: 0, calls: [], constructs: {}, messages: {}, alarms: 0, wakes: [] };
const AUTHOR = { name: "T", email: "t@example.com" };

const counted = new Proxy(store, {
  get(target, key) {
    const v = target[key];
    if (typeof v !== "function") return v;
    return (...args) => {
      counts.store++;
      counts.calls.push(String(key));
      return v.apply(target, args);
    };
  },
});
useWorkspaceStore(() => counted);

const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => {
  counts.fetch++;
  return realFetch(...args);
};

const router = createRouter({ store: () => store });

export class WorkspaceDO extends Base {
  #woke = false;

  constructor(ctx, env) {
    super(ctx, env);
    const repo = ctx.id.name;
    counts.constructs[repo] = (counts.constructs[repo] ?? 0) + 1;
  }

  webSocketMessage(ws, msg) {
    const repo = this.ctx.id.name;
    counts.messages[repo] = (counts.messages[repo] ?? 0) + 1;
    const first = !this.#woke;
    this.#woke = true;
    const [store, fetches, calls] = [counts.store, counts.fetch, counts.calls.length];
    const out = super.webSocketMessage(ws, msg);
    // the first frame of an instance holding sockets it didn't accept: a wake
    if (first && this.ctx.getWebSockets().length) counts.wakes.push({ repo, store: counts.store - store, fetch: counts.fetch - fetches, calls: counts.calls.slice(calls) });
    return out;
  }

  async alarm(...args) {
    counts.alarms++;
    this.#woke = true;
    return super.alarm(...args);
  }

  async testState() {
    const sql = this.ctx.storage.sql;
    const sockets = this.ctx.getWebSockets().map((ws) => {
      const att = ws.deserializeAttachment();
      return { tags: this.ctx.getTags(ws), att, json: new TextEncoder().encode(JSON.stringify(att)).length };
    });
    const paths = sql.exec("SELECT hash, path FROM channel_paths").toArray();
    const logs = sql.exec("SELECT room FROM room_meta").toArray().map((r) => r.room.split("\u0000")[1]);
    return { sockets, paths, logs, alarm: await this.ctx.storage.getAlarm(), now: Date.now() };
  }

  /** Runs the safety alarm now; what it set next, and the rooms left in memory. */
  async testAlarm() {
    await this.ctx.storage.deleteAlarm();
    await this.alarm();
    return { alarm: await this.ctx.storage.getAlarm(), now: Date.now() };
  }

  async testRemove() {
    return this.remove();
  }
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const q = (k) => url.searchParams.get(k);
    if (url.pathname === "/__test/seed") {
      const repo = q("repo");
      await store.createRepo(repo, { branch: "main" });
      const changes = (await req.json()).map(([path, content]) => ({ path, content }));
      return Response.json(await store.commit({ repo, branch: "main", expectedHead: null, changes, message: "seed", author: AUTHOR }));
    }
    if (url.pathname === "/__test/git") {
      const repo = q("repo");
      const head = await store.head(repo, "main");
      return Response.json({ head, content: head ? await store.readFile(repo, q("path"), head) : null });
    }
    if (url.pathname === "/__test/counts") {
      const out = structuredClone(counts);
      if (q("reset") === "1") Object.assign(counts, { store: 0, fetch: 0, calls: [], messages: {}, alarms: 0, wakes: [] });
      return Response.json(out);
    }
    if (url.pathname === "/__test/state") return Response.json(await env.WORKSPACE.getByName(q("repo")).testState());
    if (url.pathname === "/__test/alarm") return Response.json(await env.WORKSPACE.getByName(q("repo")).testAlarm());
    if (url.pathname === "/__test/remove") return Response.json((await env.WORKSPACE.getByName(q("repo")).testRemove()) ?? null);
    return router.fetch(req, env, ctx);
  },
  async scheduled() {},
};
