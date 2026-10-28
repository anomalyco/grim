// The production router, WorkspaceDO and cron handler, for test/workers/demo.test.ts. The demo workspace lives in its
// WorkspaceDO (src/workers/demo.ts), so nothing is stubbed; /api/__test/sql shows what the demo object kept in its SQLite.
import { WorkspaceDO as Base } from "../../src/workers/workspace-do.ts";
import { createRouter } from "../../src/workers/router.ts";
import { scheduled } from "../../src/workers/cron.ts";
import { MemoryStore } from "../../src/server/store/memory.ts";

export { HubDO, HomeDO, ShellDO } from "../../src/workers/index.ts";

export class WorkspaceDO extends Base {
  /** The object's tables, and its crash-log rows. */
  testSql() {
    const sql = this.ctx.storage.sql;
    const tables = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map((r) => r.name);
    const count = (t) => (tables.includes(t) ? sql.exec(`SELECT count(*) AS n FROM ${t}`).one().n : 0);
    return { tables, meta: count("room_meta"), updates: count("room_updates") };
  }
}

const router = createRouter({ store: () => new MemoryStore() });

export default {
  async fetch(req, env, ctx) {
    if (new URL(req.url).pathname === "/api/__test/sql") return Response.json(await env.WORKSPACE.getByName("demo").testSql());
    return router.fetch(req, env, ctx);
  },
  scheduled,
};
