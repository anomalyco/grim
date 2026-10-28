// With config.repoCache (Workers), workspace rows read by id are cached per process/isolate for REPO_CACHE_MS, so a
// note open, tree or file read doesn't cost a D1 round trip for the same row each time. Only ready workspaces are
// cached (an import finishing elsewhere must show up at once), and never a missing one (a workspace created in
// another isolate must be found at once).
//
// The cache sits in front of the Db: repoCacheDb(db) answers getRepo's statement from it, and any statement that
// writes to `repos` (create, delete, status/import changes, branch, read-only, owner, head) through it empties the
// cache before it runs and again after, so this process never serves a row older than its own writes. Writes made
// in another isolate (or a Durable Object with its own Db) show up here within REPO_CACHE_MS.
import { config } from "./config.ts";
import type { RepoRow } from "./repos.ts";
import type { Db } from "./seams/db.ts";
import { TtlCache } from "./ttl-cache.ts";

export const REPO_CACHE_MS = 10_000;

/** The statement getRepo (repos.ts) reads a workspace row with. */
export const GET_REPO_SQL = "SELECT * FROM repos WHERE id = ?";

const WRITES_REPOS = /^\s*(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["`[]?repos\b/i;

let cache = new TtlCache<string, RepoRow>({ max: 10_000 });
// Bumped by every write, so a read that started before a write doesn't store the row it read.
let generation = 0;

/** Drop every cached row (tests can pass a clock). */
export function resetRepoCache(now?: () => number) {
  cache = new TtlCache<string, RepoRow>({ max: 10_000, now });
  generation++;
}

/** Forget one workspace's row in this process. */
export function forgetRepo(id: string) {
  cache.delete(id);
  generation++;
}

function forgetAll() {
  cache.clear();
  generation++;
}

/** Whether `sql` changes rows of the repos table. */
export function writesRepos(sql: string): boolean {
  return WRITES_REPOS.test(sql);
}

/** A workspace row by id, from the cache when config.repoCache is on. */
export async function cachedRepo(db: Db, id: string): Promise<RepoRow | null> {
  if (!config.repoCache) return db.get<RepoRow>(GET_REPO_SQL, id);
  const hit = cache.get(id);
  if (hit) return { ...hit };
  const gen = generation;
  const row = await db.get<RepoRow>(GET_REPO_SQL, id);
  if (row && row.status === "ready" && gen === generation) cache.set(id, { ...row }, REPO_CACHE_MS);
  return row;
}

/** `db` with workspace rows read through the cache and the cache emptied by writes to repos. */
export function repoCacheDb(db: Db): Db {
  async function write<T>(sqls: string[], fn: () => Promise<T>): Promise<T> {
    if (!sqls.some(writesRepos)) return fn();
    forgetAll();
    try {
      return await fn();
    } finally {
      forgetAll();
    }
  }
  return {
    get<T>(sql: string, ...params: unknown[]) {
      if (sql === GET_REPO_SQL && params.length === 1 && typeof params[0] === "string") return cachedRepo(db, params[0]) as Promise<T | null>;
      // INSERT/UPDATE/DELETE … RETURNING come through get too.
      return write([sql], () => db.get<T>(sql, ...params));
    },
    all: <T>(sql: string, ...params: unknown[]) => write([sql], () => db.all<T>(sql, ...params)),
    run: (sql, ...params) => write([sql], () => db.run(sql, ...params)),
    batch: (statements) => write(statements.map((s) => s[0]), () => db.batch(statements)),
  };
}
