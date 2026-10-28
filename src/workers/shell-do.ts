// The agent shell on Workers: one Durable Object per actor (a share link "share:<id>", or a signed-in person
// "user:<id>" for /api/shell and /mcp), running that actor's ShellSessions (just-bash, browser build).
//
// - The Worker authenticates and forwards: share links after checking the link exists (the full checks, the rate
//   limit and the concurrency cap run here, where one object sees every call of a link, so they are strict); /api/shell
//   and /mcp with the signed-in caller in a header the Worker always overwrites (SHELL_CALLER_HEADER).
// - The shell reads the workspace rows from D1 (the primary, so a revoked link or lost access is seen at once) and
//   reaches each workspace's WorkspaceDO by RPC (snapshot, applyWrites, save, who, status, liveDiff, waitForChange…).
// - Sessions are checkpointed to this object's SQLite after every command (cwd, variables, the scratch space up to
//   4 MB), so they outlive an eviction; MCP sessions are shell sessions, so they do too. An alarm drops idle ones.
// - `close()` (RPC): a link was revoked or its notebook removed; running commands stop and the sessions are dropped.
import { DurableObject } from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";
import { handleShell } from "../server/api.ts";
import { repoAccess } from "../server/auth.ts";
import { McpServer } from "../server/mcp.ts";
import { getRepo, listRepoRows } from "../server/repos.ts";
import type { Participant } from "../server/rooms.ts";
import type { Db } from "../server/seams/db.ts";
import type { WorkspaceApi, WorkspaceHost } from "../server/seams/workspace-host.ts";
import { handleShareLink, shareActorId, type ShareCtx } from "../server/shares.ts";
import type { ScratchEntry } from "../server/shell/fs.ts";
import { ShellSessions, type SessionState, type SessionStore } from "../server/shell/session.ts";
import { d1Db } from "./db-d1.ts";
import type { Env } from "./index.ts";
import { LOCATION } from "./router.ts";
import { Timing, timedDb, withServerTiming } from "./timing.ts";

/** The request being handled, for its Server-Timing (D1 statements and WorkspaceDO calls). */
const timing = new AsyncLocalStorage<Timing>();

/** Header on /api/shell and /mcp requests the Worker forwards: the signed-in caller (`ShellCaller`) as encodeURIComponent(JSON). */
export const SHELL_CALLER_HEADER = "X-Grim-Shell-Caller";

export interface ShellCaller {
  actor: Participant;
}

/** The ShellDO name of a signed-in person (share links use shareActorId: "share:<id>"). */
export const userShellName = (userId: string) => `user:${userId}`;

export function readCaller(req: Request): ShellCaller | null {
  const v = req.headers.get(SHELL_CALLER_HEADER);
  if (!v) return null;
  try {
    const c = JSON.parse(decodeURIComponent(v)) as ShellCaller;
    return c && typeof c.actor?.id === "string" ? c : null;
  } catch {
    return null;
  }
}

/** How often idle sessions are dropped while any are kept (sessions expire after 30 min unused). */
const SWEEP_MS = 10 * 60_000;
/** DO SQLite rows hold at most 2 MB: scratch files are stored in parts of this size. */
const PART_BYTES = 1024 * 1024;

export class ShellDO extends DurableObject<Env> {
  #name: string;
  #shells: ShellSessions;
  #mcp: McpServer;
  #ctx: ShareCtx;
  #sweepAt: number | null | undefined = undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#name = ctx.id.name ?? "";
    // Each statement on its own primary session: access checks must see a revocation made a moment ago elsewhere.
    const primary = () => {
      const db = d1Db(env.DB, "first-primary");
      const t = timing.getStore();
      return t ? timedDb(db, t) : db;
    };
    const db: Db = {
      get: (sql, ...params) => primary().get(sql, ...params),
      all: (sql, ...params) => primary().all(sql, ...params),
      run: (sql, ...params) => primary().run(sql, ...params),
      batch: (stmts) => primary().batch(stmts),
    };
    const host: WorkspaceHost = { get: (id) => timedRpc(env.WORKSPACE.getByName(id, LOCATION) as unknown as WorkspaceApi) };
    this.#ctx = {
      repos: { db, host, get: (id) => getRepo(db, id), list: () => listRepoRows(db), tree: (repo) => host.get(repo.id).tree(repo) },
    };
    this.#shells = new ShellSessions(this.#ctx, { sweepTimer: false }, new SqlSessionStore(ctx.storage));
    this.#mcp = new McpServer(this.#shells);
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
        const m = /^\/a\/([^/]+)\/?$/.exec(p);
        if (!m || shareActorId(m[1]!.toLowerCase()) !== this.#name) return new Response("Wrong shell", { status: 400 });
        return await handleShareLink(req, url, this.#ctx, this.#shells);
      }
      const caller = readCaller(req);
      if (!caller || userShellName(caller.actor.id) !== this.#name) return new Response("Wrong shell", { status: 400 });
      const access = async (repo: Parameters<typeof repoAccess>[0]) => repoAccess(repo);
      if (p === "/api/shell") return await handleShell(req, this.#shells, caller.actor, access);
      if (p === "/mcp") return await this.#mcp.handle(req, caller.actor, access);
      return new Response("Not found", { status: 404 });
    } finally {
      await this.#armSweep();
    }
  }

  /** The link was revoked or its notebook is going away: stop what its sessions run and drop them. */
  async close() {
    this.#shells.closeActor(this.#name);
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
