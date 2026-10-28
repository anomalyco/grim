// The production router and WorkspaceDO over an in-memory Git store shared by the Worker and the Durable Objects
// (one isolate under Miniflare), with the Durable Objects' store calls and fetches counted, plus test-only routes.
// Bundled by test/workers/workspace.test.ts.
import { WorkspaceDO as Base, useWorkspaceStore } from "../../src/workers/workspace-do.ts";
import { createRouter } from "../../src/workers/router.ts";
import { MemoryStore } from "../../src/server/store/memory.ts";

export { HubDO, HomeDO, ShellDO } from "../../src/workers/index.ts";

const store = new MemoryStore();
const counts = { store: 0, fetch: 0, calls: [], constructs: 0, wake: null };
/** For this workspace (?repo=), the Durable Objects' commits hang (in flight when the object is evicted); they fail when it's unset. */
let hang = null;
const hung = [];

const counted = new Proxy(store, {
  get(target, key) {
    const v = target[key];
    if (typeof v !== "function") return v;
    return (...args) => {
      counts.store++;
      counts.calls.push(String(key));
      if (hang && (key === "commit" || key === "writeBlob") && args[0]?.repo === hang) return new Promise((_, reject) => hung.push(reject));
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
    counts.wake = null;
  }

  /** The first socket message of a new instance (a wake) records what it asked the store and the network. */
  webSocketMessage(ws, msg) {
    if (this.#woke) return super.webSocketMessage(ws, msg);
    this.#woke = true;
    const [store, fetches, calls] = [counts.store, counts.fetch, counts.calls.length];
    super.webSocketMessage(ws, msg);
    counts.wake = { store: counts.store - store, fetch: counts.fetch - fetches, calls: counts.calls.slice(calls) };
  }

  /** What the Durable Object asked the store and the network since the last reset. */
  testCounts(reset = false) {
    const out = { store: counts.store, fetch: counts.fetch, calls: [...counts.calls], constructs: counts.constructs, wake: counts.wake };
    if (reset) Object.assign(counts, { store: 0, fetch: 0, calls: [] });
    return out;
  }
}

const AUTHOR = { name: "T", email: "t@example.com" };

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const q = (k) => url.searchParams.get(k);
    if (url.pathname === "/__test/seed") {
      const repo = q("repo");
      await store.createRepo(repo, { branch: "main" });
      const changes = [{ path: "a.md", content: "# A\n" }, { path: "docs/b.md", content: "# B\n" }];
      return Response.json(await store.commit({ repo, branch: "main", expectedHead: null, changes, message: "seed", author: AUTHOR }));
    }
    if (url.pathname === "/__test/git") {
      // a file as Git has it (no rooms)
      const repo = q("repo");
      const head = await store.head(repo, "main");
      return Response.json({ head, content: head ? await store.readFile(repo, q("path"), head) : null });
    }
    if (url.pathname === "/__test/push") {
      // a commit from elsewhere (no webhook)
      const repo = q("repo");
      const head = await store.head(repo, "main");
      const changes = [{ path: q("path"), content: await req.text() }];
      return Response.json(await store.commit({ repo, branch: "main", expectedHead: head, changes, message: "push", author: AUTHOR }));
    }
    if (url.pathname === "/__test/counts") return Response.json(await env.WORKSPACE.getByName(q("repo")).testCounts(q("reset") === "1"));
    if (url.pathname === "/__test/hang") {
      hang = q("repo");
      if (!hang) for (const reject of hung.splice(0)) reject(new Error("the connection was lost"));
      return new Response("ok");
    }
    if (url.pathname === "/__test/hub") return Response.json(await env.HUB.getByName("hub").stats());
    if (url.pathname === "/__test/rpc") {
      // a WorkspaceApi call straight on the stub: the result, or the error as it arrived (name, message, own fields)
      const { repo, method, args } = await req.json();
      try {
        const out = await env.WORKSPACE.getByName(repo)[method](...args);
        return Response.json({ ok: out instanceof Uint8Array ? { bytes: out.length } : (out ?? null) });
      } catch (e) {
        return Response.json({ error: { name: e.name, message: e.message, status: e.status, proto: Object.getPrototypeOf(e) === Error.prototype } });
      }
    }
    return router.fetch(req, env, ctx);
  },
  async scheduled() {},
};
