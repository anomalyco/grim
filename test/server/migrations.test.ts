// D1 migration files as wrangler applies them: it appends its own INSERT INTO d1_migrations to each file, so a
// file whose last statement has no ";" fails remotely with `near "INSERT": syntax error` (the local harness splits
// on ";" and wouldn't notice).
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "../../migrations");

test("every migration ends its last statement with a semicolon", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".sql"));
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) {
    const sql = readFileSync(join(DIR, f), "utf8").replace(/--[^\n]*/g, "").trim();
    expect({ f, end: sql.slice(-1) }).toEqual({ f, end: ";" });
  }
});
