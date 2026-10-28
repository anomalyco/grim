/** Global tables: users, sessions, repos (= workspaces), joined, app_tokens, share_links.
 * Bun: bun:sqlite on $DATA_DIR/grimoire.sqlite (bun/db-bun.ts). Workers: D1. */
export interface Db {
  get<T>(sql: string, ...params: unknown[]): Promise<T | null>;
  all<T>(sql: string, ...params: unknown[]): Promise<T[]>;
  run(sql: string, ...params: unknown[]): Promise<{ changes: number }>;
  /** Runs every statement in one transaction: all of them apply, or none. */
  batch(statements: Array<[sql: string, ...params: unknown[]]>): Promise<void>;
}
