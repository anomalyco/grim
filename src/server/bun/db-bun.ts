import type { Database, SQLQueryBindings } from "bun:sqlite";
import { db as defaultDb } from "../db.ts";
import type { Db } from "../seams/db.ts";

type Params = SQLQueryBindings[];

/** The `Db` seam over bun:sqlite (by default the server's own database from db.ts). */
export function bunDb(database: Database = defaultDb): Db {
  return {
    async get<T>(sql: string, ...params: unknown[]) {
      return (database.query(sql).get(...(params as Params)) as T | null) ?? null;
    },
    async all<T>(sql: string, ...params: unknown[]) {
      return database.query(sql).all(...(params as Params)) as T[];
    },
    async run(sql: string, ...params: unknown[]) {
      return { changes: database.query(sql).run(...(params as Params)).changes };
    },
    async batch(statements) {
      database.transaction(() => {
        for (const [sql, ...params] of statements) database.query(sql).run(...(params as Params));
      })();
    },
  };
}
