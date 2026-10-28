import type { Db } from "../server/seams/db.ts";

/** A `Db` that also hands out the D1 Sessions API bookmark of what it has seen (for a client to pass on next time). */
export interface D1Db extends Db {
  bookmark(): string | null;
}

/**
 * The `Db` seam over D1. Every statement of one `d1Db()` goes through one D1 session (`withSession()`):
 * reads may be served by a nearby read replica, writes are always sent to the primary, and the session keeps
 * them sequentially consistent: a read sees every write made earlier through the same `d1Db()`, and replicas
 * never go back in time within it. Make one per request (or per unit of work); different requests may see
 * slightly stale reads from a replica until it catches up.
 *
 * `constraint` picks where the first query goes: "first-unconstrained" (default; any replica, fastest),
 * "first-primary" (read-your-latest-writes from other requests too), or a bookmark from an earlier session.
 */
export function d1Db(d1: D1Database, constraint: D1SessionConstraint | D1SessionBookmark = "first-unconstrained"): D1Db {
  const session = d1.withSession(constraint);
  const prepare = (sql: string, params: unknown[]) => session.prepare(sql).bind(...params.map(bindable));
  return {
    async get<T>(sql: string, ...params: unknown[]) {
      return (await prepare(sql, params).first<T>()) ?? null;
    },
    async all<T>(sql: string, ...params: unknown[]) {
      return (await prepare(sql, params).all<T>()).results;
    },
    async run(sql: string, ...params: unknown[]) {
      return { changes: (await prepare(sql, params).run()).meta.changes };
    },
    async batch(statements) {
      if (statements.length === 0) return;
      // D1 runs a batch as one transaction: if a statement fails, none of them apply.
      await session.batch(statements.map(([sql, ...params]) => prepare(sql, params)));
    },
    bookmark() {
      return session.getBookmark();
    },
  };
}

/** Values as bun:sqlite binds them: undefined → NULL, booleans → 0/1 (D1 rejects undefined). */
function bindable(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}
