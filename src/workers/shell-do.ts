// The agent shell on Workers: one Durable Object per share link ("share:<id>") or MCP caller ("user:<id>": an
// account, or sign-in off's MCP visitor), running its ShellSessions (just-bash, browser build).
//
// - The Worker authenticates and forwards: share links after checking the link exists, /mcp with the caller in a
//   header the Worker always overwrites (SHELL_CALLER_HEADER). The full checks, the rate limits and the concurrency
//   caps run here, where one object sees every call of a link or caller, so they are strict.
// - Per command the shell reads only the workspace rows it touches: from the isolate's repo-row cache (REPO_CACHE,
//   10 s) or a nearby D1 replica, and from the primary when the replica doesn't have the row ready (just created) and
//   right before a write (lost access is seen at once). The link's own row is kept ≤ SHARE_CACHE_MS here, and
//   `close()` (sent on revoke) drops it. It reaches each workspace's WorkspaceDO by RPC (snapshot, applyWrites, save,
//   who, status, liveDiff, waitForChange…).
// - Sessions are checkpointed to this object's SQLite after every command (cwd, variables, the scratch space up to
//   4 MB), so they outlive an eviction; MCP sessions are shell sessions, so they do too. An alarm drops idle ones.
// - `close()` (RPC): a link was revoked or its notebook removed; running commands stop and the sessions are dropped.
import { DurableObject } from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";
import { McpServer, type McpCaller } from "../server/mcp.ts";
import { GET_REPO_SQL, repoCacheDb } from "../server/repo-cache.ts";
import { getRepo, type RepoRow } from "../server/repos.ts";
import type { Db } from "../server/seams/db.ts";
import type { WorkspaceApi, WorkspaceHost } from "../server/seams/workspace-host.ts";
import { GET_SHARE_SQL, handleShareLink, shareActorId, type ShareCtx, type ShareRow } from "../server/shares.ts";
import type { ScratchEntry } from "../server/shell/fs.ts";
import { ShellSessions, type SessionState, type SessionStore } from "../server/shell/session.ts";
import { d1Db } from "./db-d1.ts";
import { useWorkersDemoGate } from "./demo.ts";
import type { Env } from "./index.ts";
import { LOCATION } from "./router.ts";
import { Timing, timedDb, withServerTiming } from "./timing.ts";

/** The request being handled, for its Server-Timing (D1 statements and WorkspaceDO calls). */
const timing = new AsyncLocalStorage<Timing>();

/** Header on /mcp requests the Worker forwards: the caller (`ShellCaller`) as encodeURIComponent(JSON). */
export const SHELL_CALLER_HEADER = "X-Grim-Shell-Caller";

export interface ShellCaller {
  caller: McpCaller;
  /** what the answer carries (CORS) */
  headers: Record<string, string>;
}

/** The ShellDO name of an MCP caller (share links use shareActorId: "share:<id>"). */
export const userShellName = (userId: string) => `user:${userId}`;

export function readCaller(req: Request): ShellCaller | null {
  const v = req.headers.get(SHELL_CALLER_HEADER);
  if (!v) return null;
  try {
    const c = JSON.parse(decodeURIComponent(v)) as ShellCaller;
    return c && typeof c.caller?.userId === "string" && c.headers && typeof c.headers === "object" ? c : null;
  } catch {
    return null;
  }
}

/** How often idle sessions are dropped while any are kept (sessions expire after 30 min unused). */
const SWEEP_MS = 10 * 60_000;
/** DO SQLite rows hold at most 2 MB: scratch files are stored in parts of this size. */
const PART_BYTES = 1024 * 1024;
/** How long a share link's row is reused (revoking it also drops it at once, through `close()`). */
export const SHARE_CACHE_MS = 5000;

export class ShellDO extends DurableObject<Env> {
  #name: string;
  #shells: ShellSessions;
  #mcp: McpServer;
  #ctx: ShareCtx;
  #sweepAt: number | null | undefined = undefined;
  /** This object's share link as last read, while fresh (share:<id> objects only). */
  #share: { id: string; row: ShareRow | null; at: number } | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#name = ctx.id.name ?? "";
    // an MCP caller opens only the demo room it's in
    useWorkersDemoGate(env);
    const session = (constraint: D1SessionConstraint) => {
      const db = d1Db(env.DB, constraint);
      const t = timing.getStore();
      return t ? timedDb(db, t) : db;
    };
    // Statements on their own primary session (writes, listings, checks before a write): they see what was done a
    // moment ago elsewhere. (The D1 primary may be a region away from this object; a replica is usually in its colo.)
    const primary: Db = {
      get: (sql, ...params) => session("first-primary").get(sql, ...params),
      all: (sql, ...params) => session("first-primary").all(sql, ...params),
      run: (sql, ...params) => session("first-primary").run(sql, ...params),
      batch: (stmts) => session("first-primary").batch(stmts),
    };
    // Workspace rows from a replica (the primary when it doesn't have the row ready yet), through the isolate's row
    // cache; the link's row from this object's short cache.
    const db: Db = repoCacheDb({
      ...primary,
      get: <T>(sql: string, ...params: unknown[]): Promise<T | null> => {
        if (sql === GET_REPO_SQL) return replicaRepo(session, String(params[0])) as Promise<T | null>;
        if (sql === GET_SHARE_SQL) return this.#shareRow(primary, String(params[0])) as Promise<T | null>;
        return primary.get<T>(sql, ...params);
      },
    });
    const host: WorkspaceHost = { get: (id) => timedRpc(env.WORKSPACE.getByName(id, LOCATION) as unknown as WorkspaceApi) };
    this.#ctx = {
      repos: {
        db,
        host,
        get: (id) => getRepo(db, id),
        getFresh: (id) => getRepo(primary, id),
        tree: (repo) => host.get(repo.id).tree(repo),
      },
    };
    this.#shells = new ShellSessions(this.#ctx, { sweepTimer: false }, new SqlSessionStore(ctx.storage));
    this.#mcp = new McpServer(this.#shells, this.#ctx);
  }

  async fetch(req: Request): Promise<Response> {
    const t = new Timing();
    const res = await timing.run(t, () => t.time("shell-do", () => this.#fetch(req)));
    return withServerTiming(res, t.header());
  }

  async #fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    this.#shells.sweep();
    try {
      if (p.startsWith("/a/")) {
        const m = /^\/a\/([^/]+?)(?:\/changes)?\/?$/.exec(p);
        if (!m || shareActorId(m[1]!.toLowerCase()) !== this.#name) return new Response("Wrong shell", { status: 400 });
        return await handleShareLink(req, url, this.#ctx, this.#shells);
      }
      const c = readCaller(req);
      if (!c || userShellName(c.caller.userId) !== this.#name) return new Response("Wrong shell", { status: 400 });
      if (p === "/mcp") return await this.#mcp.handle(req, c.caller, c.headers);
      return new Response("Not found", { status: 404 });
    } finally {
      await this.#armSweep();
    }
  }

  /** The link was revoked or its notebook is going away: stop what its sessions run and drop them. */
  async close() {
    this.#share = null;
    this.#shells.closeActor(this.#name);
  }

  /** A share link's row (null: unknown or revoked), read again after SHARE_CACHE_MS; `close()` forgets it. */
  async #shareRow(primary: Db, id: string): Promise<ShareRow | null> {
    const c = this.#share;
    if (c && c.id === id && Date.now() - c.at < SHARE_CACHE_MS) return c.row;
    const at = Date.now();
    const row = await primary.get<ShareRow>(GET_SHARE_SQL, id);
    // Unless close() came while it was read.
    if (this.#share === c) this.#share = { id, row, at };
    return row;
  }

  async alarm() {
    this.#sweepAt = null;
    this.#shells.sweep();
    await this.#armSweep();
  }

  /** An alarm while checkpoints are kept, so idle sessions are dropped even when no call comes. */
  async #armSweep() {
    const kept = this.ctx.storage.sql.exec("SELECT 1 FROM shell_sessions LIMIT 1").toArray().length > 0;
    if (this.#sweepAt === undefined) this.#sweepAt = await this.ctx.storage.getAlarm();
    if (!kept || this.#sweepAt) return;
    this.#sweepAt = Date.now() + SWEEP_MS;
    await this.ctx.storage.setAlarm(this.#sweepAt);
  }

  /** Sessions in memory (tests). */
  async stats() {
    return { sessions: this.#shells.size, kept: this.ctx.storage.sql.exec("SELECT count(*) AS n FROM shell_sessions").one().n as number };
  }
}

/** A workspace row from a nearby replica, or from the primary when the replica lacks it or it isn't ready there. */
async function replicaRepo(session: (c: D1SessionConstraint) => Db, id: string): Promise<RepoRow | null> {
  const row = await session("first-unconstrained").get<RepoRow>(GET_REPO_SQL, id);
  if (row?.status === "ready") return row;
  return session("first-primary").get<RepoRow>(GET_REPO_SQL, id);
}

/** A WorkspaceDO stub whose calls add an `rpc` entry (desc = the method) to the current request's Server-Timing. */
function timedRpc(api: WorkspaceApi): WorkspaceApi {
  return new Proxy(api, {
    get(target, prop) {
      const v = Reflect.get(target, prop) as unknown;
      if (typeof v !== "function" || typeof prop !== "string") return v;
      return (...args: unknown[]) => {
        const t = timing.getStore();
        // (Reflect.apply: on an RPC stub, `.apply` itself would be a remote method)
        const call = () => Reflect.apply(v as (...a: unknown[]) => Promise<unknown>, target, args) as Promise<unknown>;
        return t ? t.time("rpc", call, prop) : call();
      };
    },
  });
}

/**
 * Session checkpoints in the object's SQLite: the state as JSON (scratch entries without their bytes), and the
 * scratch files' bytes concatenated, in parts of up to 1 MB.
 */
class SqlSessionStore implements SessionStore {
  constructor(private storage: DurableObjectStorage) {
    const sql = storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS shell_sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL, scratch TEXT, last_used INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS shell_scratch (id TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (id, part))");
  }

  load(id: string): SessionState | null {
    const row = this.storage.sql.exec<{ state: string; scratch: string | null }>("SELECT state, scratch FROM shell_sessions WHERE id = ?", id).toArray()[0];
    if (!row) return null;
    const state = JSON.parse(row.state) as SessionState;
    if (row.scratch) {
      const parts = this.storage.sql.exec<{ data: ArrayBuffer }>("SELECT data FROM shell_scratch WHERE id = ? ORDER BY part", id).toArray();
      const bytes = concat(parts.map((r) => new Uint8Array(r.data)));
      let at = 0;
      state.scratch = (JSON.parse(row.scratch) as Array<Omit<ScratchEntry, "data"> & { size?: number }>).map(({ size, ...e }) => {
        if (e.kind !== "file") return e;
        const data = bytes.slice(at, at + (size ?? 0));
        at += size ?? 0;
        return { ...e, data };
      });
    }
    return state;
  }

  save(id: string, state: SessionState) {
    const { scratch, ...rest } = state;
    this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      if (scratch === undefined) {
        // Scratch unchanged: keep what's stored.
        const n = sql.exec("UPDATE shell_sessions SET state = ?, last_used = ? WHERE id = ?", JSON.stringify(rest), rest.lastUsed, id).rowsWritten;
        if (n) return;
      }
      sql.exec("DELETE FROM shell_scratch WHERE id = ?", id);
      let meta: string | null = null;
      if (scratch) {
        meta = JSON.stringify(scratch.map(({ data, ...e }) => (e.kind === "file" ? { ...e, size: data?.byteLength ?? 0 } : e)));
        const bytes = concat(scratch.flatMap((e) => (e.data ? [e.data] : [])));
        for (let part = 0; part * PART_BYTES < bytes.length; part++) {
          const chunk = bytes.slice(part * PART_BYTES, (part + 1) * PART_BYTES);
          sql.exec("INSERT INTO shell_scratch (id, part, data) VALUES (?, ?, ?)", id, part, chunk.buffer as ArrayBuffer);
        }
      }
      sql.exec(
        "INSERT INTO shell_sessions (id, state, scratch, last_used) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET state = excluded.state, scratch = excluded.scratch, last_used = excluded.last_used",
        id,
        JSON.stringify(rest),
        meta,
        rest.lastUsed,
      );
    });
  }

  delete(id: string) {
    this.storage.transactionSync(() => {
      this.storage.sql.exec("DELETE FROM shell_sessions WHERE id = ?", id);
      this.storage.sql.exec("DELETE FROM shell_scratch WHERE id = ?", id);
    });
  }

  deletePrefix(prefix: string) {
    // (ids hold a NUL, which SQLite's string functions stop at: compared here)
    for (const { id } of this.storage.sql.exec<{ id: string }>("SELECT id FROM shell_sessions").toArray()) if (id.startsWith(prefix)) this.delete(id);
  }

  deleteIdle(before: number) {
    for (const { id } of this.storage.sql.exec<{ id: string }>("SELECT id FROM shell_sessions WHERE last_used < ?", before).toArray()) this.delete(id);
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}
