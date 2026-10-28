// Server-Timing for the /ws path: the Worker's admission (and its D1 statements) and the WorkspaceDO's file step are
// sent as a Server-Timing header on the 101 (curl and tools/bench see it; browsers don't expose it on sockets).
import type { Db } from "../server/seams/db.ts";

export class Timing {
  private entries: string[] = [];

  add(name: string, ms: number, desc?: string) {
    this.entries.push(`${name};dur=${ms.toFixed(1)}${desc ? `;desc="${desc.replace(/["\\]/g, "")}"` : ""}`);
  }

  /** Time `fn` as `name`. */
  async time<T>(name: string, fn: () => Promise<T>, desc?: string): Promise<T> {
    const t = performance.now();
    try {
      return await fn();
    } finally {
      this.add(name, performance.now() - t, desc);
    }
  }

  header(): string {
    return this.entries.join(", ");
  }
}

/** A `Db` that adds one `d1` entry per statement to `t` (desc = the statement's first words). */
export function timedDb(db: Db, t: Timing): Db {
  const wrap =
    <A extends unknown[], R>(fn: (sql: string, ...a: A) => Promise<R>) =>
    (sql: string, ...a: A) =>
      t.time("d1", () => fn(sql, ...a), sql.replace(/\s+/g, " ").slice(0, 40));
  return {
    get: wrap((sql, ...p) => db.get(sql, ...p)),
    all: wrap((sql, ...p) => db.all(sql, ...p)),
    run: wrap((sql, ...p) => db.run(sql, ...p)),
    batch: (stmts) => t.time("d1", () => db.batch(stmts), "batch"),
  } as Db;
}

/** The same 101 (or any response) with `entries` added in front of its Server-Timing. */
export function withServerTiming(res: Response, entries: string): Response {
  if (!entries) return res;
  const headers = new Headers(res.headers);
  const prev = headers.get("server-timing");
  headers.set("server-timing", prev ? `${entries}, ${prev}` : entries);
  if (res.webSocket) return new Response(null, { status: 101, webSocket: res.webSocket, headers });
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** The store calls a Durable Object made lately (name, start, duration), for the Server-Timing of the request that waited on them. */
export class StoreCalls {
  private calls: Array<{ name: string; at: number; ms: number }> = [];

  /** `store` with each method call recorded (as `cs-<method>`). */
  wrap<T extends object>(store: T): T {
    const calls = this.calls;
    return new Proxy(store, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (typeof v !== "function" || typeof prop !== "string") return v;
        return (...args: unknown[]) => {
          const at = performance.now();
          const out = v.apply(target, args);
          if (!(out instanceof Promise)) return out;
          return out.finally(() => {
            calls.push({ name: `cs-${prop}`, at, ms: performance.now() - at });
            if (calls.length > 32) calls.splice(0, calls.length - 32);
          });
        };
      },
    });
  }

  /** Calls that started at or after `t` (and have finished). */
  since(t: number) {
    return this.calls.filter((c) => c.at >= t);
  }
}
