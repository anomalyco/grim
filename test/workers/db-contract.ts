// The `Db` contract as one scenario over a fresh migrations/0001_init.sql database. It returns a trace of
// every result, so the same run against bun:sqlite (bunDb) and D1 (d1Db, inside workerd) can be compared.
import type { Db } from "../../src/server/seams/db.ts";

export async function dbContract(d: Db): Promise<unknown[]> {
  const trace: unknown[] = [];
  const threw = async (p: Promise<unknown>) => {
    try {
      await p;
      return false;
    } catch {
      return true;
    }
  };

  trace.push(await d.run("INSERT INTO users (id, login, name, email, created_at) VALUES (?, ?, ?, ?, ?)", "u1", "ada", "Ada", "a@x", 1));
  trace.push(await d.get<{ login: string }>("SELECT login FROM users WHERE id = ?", "u1"));
  trace.push(await d.get("SELECT login FROM users WHERE id = ?", "nobody"));
  trace.push(await d.run("UPDATE users SET name = ? WHERE id = ?", "Ada L", "u1"));
  trace.push(await d.run("UPDATE users SET name = ? WHERE id = ?", "x", "nobody"));
  trace.push(await d.all("SELECT id FROM users WHERE id = ?", "nobody"));
  // NULL, undefined and booleans bind the way bun:sqlite binds them; integers come back as numbers.
  trace.push(await d.run("INSERT INTO users (id, login, name, email, avatar, created_at, email_verified) VALUES (?, ?, ?, ?, ?, ?, ?)", "u2", "bob", "Bob", "b@x", null, 2, true));
  trace.push(await d.run("UPDATE users SET avatar = ? WHERE id = ?", undefined, "u2"));
  trace.push(await d.all("SELECT id, avatar, email_verified, created_at FROM users ORDER BY id"));
  trace.push(await d.get("SELECT count(*) AS n FROM users"));

  await d.batch([
    ["INSERT INTO repos (id, title, kind, branch, status, created_at, owner_id) VALUES (?, ?, 'notes', 'main', 'ready', 1, ?)", "r1", "One", "u1"],
    ["UPDATE repos SET head = ? WHERE id = ?", "abc", "r1"],
  ]);
  trace.push(await d.all("SELECT id, head FROM repos"));
  await d.batch([]);

  // The second statement fails (duplicate key): the first must not apply.
  trace.push(
    await threw(
      d.batch([
        ["INSERT INTO repos (id, title, kind, branch, status, created_at) VALUES ('r2', 'Two', 'notes', 'main', 'ready', 1)"],
        ["INSERT INTO repos (id, title, kind, branch, status, created_at) VALUES ('r1', 'Dup', 'notes', 'main', 'ready', 1)"],
      ]),
    ),
  );
  trace.push(await d.all("SELECT id FROM repos ORDER BY id"));
  // A failing statement in the middle rolls back the updates before it too.
  trace.push(
    await threw(
      d.batch([
        ["UPDATE repos SET title = 'Changed' WHERE id = 'r1'"],
        ["INSERT INTO nope (x) VALUES (1)"],
        ["UPDATE repos SET head = 'def' WHERE id = 'r1'"],
      ]),
    ),
  );
  trace.push(await d.get("SELECT title, head FROM repos WHERE id = 'r1'"));
  // Foreign keys are enforced (D1 always; db.ts turns them on for Bun).
  trace.push(await threw(d.run("INSERT INTO sessions (token, user_id, expires_at) VALUES ('t', 'ghost', 1)")));
  trace.push(await threw(d.run("SELECT * FROM nope")));
  return trace;
}
