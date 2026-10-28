// The production router and WorkspaceDO over an in-memory Git store (shared by the Worker and the Durable Objects:
// one isolate under Miniflare), with test hooks for test/workers/hibernation.test.ts:
// - counts: the Durable Objects' store calls and fetches, constructions (wakes), socket messages, alarm runs;
// - a virtual clock (Date.now + offset; the alarm is set in real time) so idle/awareness timeouts pass at once;
// - hanging commits, a crash right after a socket message (ctx.abort: the 250 ms batch is lost), and a GitHub copy
//   that shows up after a few head polls (for imports driven by the alarm);
// - what the object keeps in storage: crash logs, the alarm, the import state, socket tags and attachments.
import { WorkspaceDO as Base, useWorkspaceStore } from "../../src/workers/workspace-do.ts";
import { createRouter } from "../../src/workers/router.ts";
import { MemoryStore } from "../../src/server/store/memory.ts";

export { HubDO, HomeDO, ShellDO } from "../../src/workers/index.ts";

const realNow = Date.now.bind(Date);
let offset = 0;
Date.now = () => realNow() + offset;

const store = new MemoryStore();
const counts = { store: 0, fetch: 0, calls: [], constructs: 0, messages: 0, alarms: [], wakes: [], built: [] };
let hang = null;
const hung = [];
/** GitHub copies (repo → head polls left before the copy has commits). */
const copies = new Map();
/** Abort the object right after it handled the next socket message of this workspace. */
let crashAfter = null;

const AUTHOR = { name: "T", email: "t@example.com" };

const counted = new Proxy(store, {
  get(target, key) {
    const v = target[key];
    if (typeof v !== "function") return v;
    return (...args) => {
      counts.store++;
      counts.calls.push(String(key));
      if (hang && (key === "commit" || key === "writeBlob") && args[0]?.repo === hang) return new Promise((_, reject) => hung.push(reject));
      if (key === "createRepo" && args[1]?.github) {
        // a GitHub copy: empty for the first head poll (Code Storage copies in the background)
        copies.set(args[0], 1);
        return target.createRepo(args[0], args[1]);
      }
      if (key === "head" && copies.has(args[0])) {
        const left = copies.get(args[0]);
        if (left > 0) {
          copies.set(args[0], left - 1);
          return Promise.resolve(null);
        }
        copies.delete(args[0]);
        const changes = [{ path: "README.md", content: "# Imported\n" }];
        return target.commit({ repo: args[0], branch: args[1], expectedHead: null, changes, message: "import", author: AUTHOR }).then(() => v.apply(target, args));
      }
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
    counts.constructs++;
    counts.built.push({ at: realNow(), repo: ctx.id.name });
    // the alarm is kept in real time while the clock is ahead
    const storage = ctx.storage;
    const [setAlarm, getAlarm] = [storage.setAlarm.bind(storage), storage.getAlarm.bind(storage)];
    storage.setAlarm = (at, ...rest) => setAlarm(Number(at) - offset, ...rest);
    storage.getAlarm = async (...rest) => {
      const at = await getAlarm(...rest);
      return at === null ? null : at + offset;
    };
  }

  webSocketMessage(ws, msg) {
    counts.messages++;
    const first = !this.#woke;
    this.#woke = true;
    const [store, fetches, calls] = [counts.store, counts.fetch, counts.calls.length];
    const out = super.webSocketMessage(ws, msg);
    // the first frame of a new instance with sockets it didn't accept: a wake
    if (first && this.ctx.getWebSockets().length) counts.wakes.push({ at: realNow(), store: counts.store - store, fetch: counts.fetch - fetches, calls: counts.calls.slice(calls) });
    if (crashAfter === this.ctx.id.name) {
      crashAfter = null;
      this.ctx.abort(new Error("crash for the test"));
    }
    return out;
  }

  async alarm(...args) {
    counts.alarms.push({ at: realNow(), repo: this.ctx.id.name, woke: !this.#woke });
    this.#woke = true;
    return super.alarm(...args);
  }

  /** What the object keeps: crash logs, the alarm (virtual time), the import state, its sockets. */
  async testState() {
    const sql = this.ctx.storage.sql;
    const rooms = sql.exec("SELECT room FROM room_meta").toArray().map((r) => r.room.split("\u0000")[1]);
    const updates = sql.exec("SELECT count(*) AS n FROM room_updates").one().n;
    const presence = sql.exec("SELECT path FROM presence_files").toArray().map((r) => r.path);
    const sockets = this.ctx.getWebSockets().map((ws) => {
      const att = ws.deserializeAttachment();
      return { tags: this.ctx.getTags(ws), att, json: new TextEncoder().encode(JSON.stringify(att)).length };
    });
    return { rooms, updates, presence, alarm: await this.ctx.storage.getAlarm(), import: (await this.ctx.storage.get("import")) ?? null, sockets };
  }

  async testStartImport(state) {
    return this.startImport(state);
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
      if (q("reset") === "1") Object.assign(counts, { store: 0, fetch: 0, calls: [], messages: 0, alarms: [], wakes: [], built: [] });
      return Response.json(out);
    }
    if (url.pathname === "/__test/state") return Response.json(await env.WORKSPACE.getByName(q("repo")).testState());
    if (url.pathname === "/__test/import") return Response.json((await env.WORKSPACE.getByName(q("repo")).testStartImport(await req.json())) ?? null);
    if (url.pathname === "/__test/clock") {
      offset += Number(q("add") ?? 0);
      return Response.json({ offset });
    }
    if (url.pathname === "/__test/crash") {
      crashAfter = q("repo");
      return new Response("ok");
    }
    if (url.pathname === "/__test/hang") {
      hang = q("repo");
      if (!hang) for (const reject of hung.splice(0)) reject(new Error("the connection was lost"));
      return new Response("ok");
    }
    if (url.pathname === "/__test/hub") return Response.json(await env.HUB.getByName("hub").stats());
    return router.fetch(req, env, ctx);
  },
  async scheduled() {},
};
