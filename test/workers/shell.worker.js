// The production router, WorkspaceDO and ShellDO over an in-memory Git store shared by the Worker and the Durable
// Objects (one isolate under Miniflare), plus test-only routes. Bundled by test/workers/shell.test.ts.
import { useWorkspaceStore } from "../../src/workers/workspace-do.ts";
import { createRouter } from "../../src/workers/router.ts";
import { MemoryStore } from "../../src/server/store/memory.ts";

export { WorkspaceDO, HubDO, HomeDO, ShellDO } from "../../src/workers/index.ts";

const store = new MemoryStore();
useWorkspaceStore(() => store);
const router = createRouter({ store: () => store });

const AUTHOR = { name: "Alice", email: "alice@example.com" };

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const q = (k) => url.searchParams.get(k);
    if (url.pathname === "/__test/seed") {
      const repo = q("repo");
      await store.createRepo(repo, { branch: "main" });
      const changes = [
        { path: "Welcome.md", content: "# Welcome to Grim\n\nHello.\n" },
        { path: "todo.md", content: "# Todo\n\n- milk\n- eggs\n- bread\n" },
        { path: "projects/alpha.md", content: "# Alpha\n\nStatus: planning\n" },
        { path: "projects/beta.md", content: "# Beta\n\nStatus: done\n" },
        { path: "image.png", content: "not markdown" },
      ];
      return Response.json(await store.commit({ repo, branch: "main", expectedHead: null, changes, message: "seed", author: AUTHOR }));
    }
    if (url.pathname === "/__test/git") {
      const repo = q("repo");
      const head = await store.head(repo, "main");
      return Response.json({ head, content: head ? await store.readFile(repo, q("path"), head) : null });
    }
    if (url.pathname === "/__test/shell") return Response.json(await env.SHELL.getByName(q("name")).stats());
    return router.fetch(req, env, ctx);
  },
  async scheduled() {},
};
