// The production router (src/workers/router.ts) with an in-memory Git store and the WorkspaceDO over the same store
// (API ops go to it by RPC), whose socket upgrade is replaced by one that reports what the Worker forwarded, plus a
// few test-only routes. Bundled by test/workers/router.test.ts.
import { createRouter, readAdmission } from "../../src/workers/router.ts";
import { WorkspaceDO as RealWorkspaceDO, useWorkspaceStore } from "../../src/workers/workspace-do.ts";
import { MemoryStore } from "../../src/server/store/memory.ts";

export { HubDO, HomeDO, ShellDO } from "../../src/workers/index.ts";

const store = new MemoryStore();
const router = createRouter({ store: () => store });
useWorkspaceStore(() => store);

/** Accepts the forwarded upgrade and sends back, as its first message, the admission it received. */
export class WorkspaceDO extends RealWorkspaceDO {
  async fetch(req) {
    const pair = new WebSocketPair();
    pair[1].accept();
    pair[1].send(JSON.stringify({ name: this.ctx.id.name ?? null, url: req.url, admission: readAdmission(req) }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/api/__test/hub") return Response.json(await env.HUB.getByName("hub").stats());
    // a home room's stats (?room= from its "hi"; no version binding here, so the version is "dev")
    if (url.pathname === "/api/__test/home") return Response.json(await env.HOME.getByName(`home:dev:${url.searchParams.get("room")}`).stats());
    if (url.pathname === "/api/__test/seed") {
      // a workspace in the Git store with one image; its row goes in D1 from the test
      const repo = url.searchParams.get("repo");
      await store.createRepo(repo, { branch: "main" });
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
      const author = { name: "T", email: "t@example.com" };
      const out = await store.writeBlob({ repo, branch: "main", expectedHead: null, path: "img.png", bytes, message: "img", author });
      return Response.json(out);
    }
    if (url.pathname === "/api/__test/unseed") {
      await store.deleteRepo(url.searchParams.get("repo"));
      return new Response("ok");
    }
    return router.fetch(req, env, ctx);
  },
  async scheduled() {},
};
