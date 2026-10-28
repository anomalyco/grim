// The production Worker and Durable Objects with Code Storage configured (a sentinel private key, a fake Code Storage
// that refuses everything), plus test-only routes that read what the objects hold: RPC results, SQLite tables, KV and
// socket attachments. Workspace "jot" lives in a MemoryStore (so the app has real notes to serve); every other
// workspace goes to the real CodeStorageStore, which signs a JWT with the key on each call and fails.
// Bundled by test/workers/secrets.test.ts.
import { GitStorage } from "@pierre/storage";
import { WorkspaceDO as BaseWorkspace, useWorkspaceStore } from "../../src/workers/workspace-do.ts";
import { ShellDO as BaseShell } from "../../src/workers/shell-do.ts";
import { HubDO as BaseHub } from "../../src/workers/hub-do.ts";
import { HomeDO as BaseHome } from "../../src/workers/home-do.ts";
import { scheduled } from "../../src/workers/cron.ts";
import { createRouter, gitStore } from "../../src/workers/router.ts";
import { config } from "../../src/server/config.ts";
import { MemoryStore } from "../../src/server/store/memory.ts";
import { RoutedStore } from "../../src/server/store/routed.ts";

const memory = new MemoryStore();
let routed = null;
const store = () => (routed ??= new RoutedStore(gitStore(), new Map([["jot", memory]])));
useWorkspaceStore(() => store());
const router = createRouter({ store });

const decoder = new TextDecoder("utf-8", { fatal: false });
const latin1 = new TextDecoder("latin1");
/** Bytes as text twice (UTF-8 and Latin-1), so a key written in any byte form is still found by a text search. */
const text = (b) => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  return `${decoder.decode(u)}\n${latin1.decode(u)}`;
};

/** Everything a Durable Object keeps: every SQLite table (blobs as text), its KV entries and its sockets' attachments. */
async function dump(ctx) {
  const sql = ctx.storage.sql;
  const tables = {};
  for (const { name } of sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").toArray()) {
    tables[name] = sql
      .exec(`SELECT * FROM "${name}"`)
      .toArray()
      .map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof ArrayBuffer ? text(v) : v])));
  }
  const kv = Object.fromEntries([...(await ctx.storage.list())].map(([k, v]) => [k, v instanceof Uint8Array || v instanceof ArrayBuffer ? text(v) : v]));
  const attachments = ctx.getWebSockets().map((ws) => ws.deserializeAttachment());
  return { tables, kv, attachments };
}

export class WorkspaceDO extends BaseWorkspace {
  async testDump() {
    return dump(this.ctx);
  }
}
export class ShellDO extends BaseShell {
  async testDump() {
    return dump(this.ctx);
  }
}
export class HubDO extends BaseHub {
  async testDump() {
    return dump(this.ctx);
  }
}
export class HomeDO extends BaseHome {
  async testDump() {
    return dump(this.ctx);
  }
}

const AUTHOR = { name: "Alice", email: "alice@example.com" };

/** JSON for anything an RPC call may return: bytes as text, errors with every own field. */
function plain(v) {
  return JSON.parse(
    JSON.stringify(v ?? null, (_k, x) => {
      if (x instanceof Uint8Array || x instanceof ArrayBuffer) return { bytes: text(x) };
      if (x instanceof Error) return errorJson(x);
      return x;
    }),
  );
}

function errorJson(e) {
  const own = {};
  for (const k of Object.getOwnPropertyNames(e)) own[k] = k === "cause" && e.cause instanceof Error ? errorJson(e.cause) : e[k];
  return { name: e.name, message: e.message, stack: e.stack, string: String(e), own, cause: e.cause instanceof Error ? errorJson(e.cause) : String(e.cause ?? "") };
}

const NAMESPACES = { WORKSPACE: "WORKSPACE", SHELL: "SHELL", HUB: "HUB", HOME: "HOME" };

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const q = (k) => url.searchParams.get(k);
    if (url.pathname === "/__test/seed") {
      const repo = q("repo");
      await memory.createRepo(repo, { branch: "main" });
      const changes = [
        { path: "Welcome.md", content: "# Welcome\n\nHello.\n" },
        { path: "todo.md", content: "# Todo\n\n- milk\n" },
        { path: "projects/alpha.md", content: "# Alpha\n\nStatus: planning\n" },
        { path: "pic.png", content: "not really a png" },
      ];
      return Response.json(await memory.commit({ repo, branch: "main", expectedHead: null, changes, message: "seed", author: AUTHOR }));
    }
    if (url.pathname === "/__test/sentinel") {
      // the check's own control (never scanned): the key reached the Worker's config, and an unsealed SDK client
      // serialized here would leak it
      return Response.json({ storage: config.storage, store: store().base.kind, key: config.codeStorage.key, raw: JSON.stringify(new GitStorage({ name: "t", key: config.codeStorage.key })) });
    }
    if (url.pathname === "/__test/log") {
      console.log("[test] marker", q("m"));
      return new Response("ok");
    }
    if (url.pathname === "/__test/rpc") {
      // a method on a Durable Object stub, from inside the Worker: the result or the error as it arrived
      const { ns, name, method, args } = await req.json();
      const stub = env[NAMESPACES[ns]].getByName(name);
      const decoded = (args ?? []).map((a) => (a && typeof a === "object" && "$bytes" in a ? new TextEncoder().encode(a.$bytes) : a));
      try {
        return Response.json({ ok: plain(await stub[method](...decoded)) });
      } catch (e) {
        return Response.json({ error: errorJson(e) });
      }
    }
    if (url.pathname === "/__test/dump") return Response.json(plain(await env[NAMESPACES[q("ns")]].getByName(q("name")).testDump()));
    if (url.pathname === "/__test/d1") {
      const tables = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'").all()).results;
      const out = {};
      for (const { name } of tables) out[name] = (await env.DB.prepare(`SELECT * FROM "${name}"`).all()).results;
      return Response.json(plain(out));
    }
    return router.fetch(req, env, ctx);
  },
  scheduled: (controller, env, ctx) => scheduled(controller, env, ctx),
};
