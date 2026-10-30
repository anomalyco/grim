// scheduled() in workerd (Miniflare 5): the */5 cron refreshes ready read-only GitHub copies through their
// WorkspaceDO (a stand-in here), and resets the demo in its WorkspaceDO on a DEMO_RESET_MINUTES boundary; the 6-hourly cron prunes expired sessions in D1.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startWorker, type StartedWorker } from "./miniflare.ts";

const REFRESH = "*/5 * * * *";
const RESET = "0 */6 * * *";

let w: StartedWorker;
let db: Awaited<ReturnType<StartedWorker["mf"]["getD1Database"]>>;

beforeAll(async () => {
  w = await startWorker({
    entry: join(import.meta.dir, "cron.worker.js"),
    durableObjects: { WORKSPACE: "WorkspaceDO" },
    // the refresh only runs where GitHub copies are on (they're off by default)
    bindings: { GITHUB_COPIES: "on" },
  });
  db = await w.mf.getD1Database("DB");
  const repo = (id: string, kind: string, readOnly: number, status: string) =>
    db.prepare("INSERT INTO repos (id, title, kind, gh_owner, gh_name, read_only, branch, status, created_at) VALUES (?, ?, ?, 'acme', ?, ?, 'main', ?, 0)").bind(id, id, kind, id, readOnly, status);
  const now = Date.now();
  await db.batch([
    repo("gh-acme-docs", "github", 1, "ready"),
    repo("gh-acme-wiki", "github", 1, "ready"),
    repo("gh-acme-broken", "github", 1, "ready"),
    repo("gh-acme-later", "github", 1, "importing"),
    repo("gh-acme-mine", "github", 0, "ready"),
    repo("notes", "notes", 0, "ready"),
    db.prepare("INSERT INTO users (id, login, name, email, created_at) VALUES ('u1', 'ada', 'Ada', 'ada@example.com', 0)"),
    db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES ('old', 'u1', ?), ('live', 'u1', ?)").bind(now - 1000, now + 3_600_000),
  ]);
}, 60_000);

afterAll(async () => {
  await w?.dispose();
});

async function fire(cron: string, scheduledTime?: Date) {
  const worker = await w.mf.getWorker(w.name);
  return (await worker.scheduled({ cron, scheduledTime })) as { outcome: string };
}

const calls = async (id: string) => (await (await w.fetch(`/calls?id=${id}`)).json()) as Array<{ name: string; id?: string; minIntervalMs?: number; reset?: boolean }>;

describe("scheduled()", () => {
  test("wrangler.jsonc triggers exactly the two crons, none every minute", () => {
    const m = readFileSync(join(import.meta.dir, "../../wrangler.jsonc"), "utf8").match(/"crons"\s*:\s*(\[[^\]]*\])/);
    expect(JSON.parse(m![1]!)).toEqual([REFRESH, RESET]);
  });

  test(`${REFRESH}: every ready read-only GitHub copy is refreshed in its WorkspaceDO; one failing doesn't stop the rest`, async () => {
    // :05 is not a 15-minute boundary: no demo reset
    expect((await fire(REFRESH, new Date("2026-10-29T12:05:00Z"))).outcome).toBe("ok");
    expect(await calls("demo")).toEqual([]);
    for (const id of ["gh-acme-docs", "gh-acme-wiki", "gh-acme-broken"]) expect(await calls(id)).toEqual([{ name: id, id, minIntervalMs: 150_000 }]);
    for (const id of ["gh-acme-later", "gh-acme-mine", "notes"]) expect(await calls(id)).toEqual([]);
    // the sessions are untouched by this one
    expect((await db.prepare("SELECT count(*) AS n FROM sessions").first<{ n: number }>())!.n).toBe(2);
  });

  test(`${RESET}: expired sessions are pruned in D1`, async () => {
    expect((await fire(RESET)).outcome).toBe("ok");
    expect((await db.prepare("SELECT token FROM sessions").all<{ token: string }>()).results).toEqual([{ token: "live" }]);
    expect(await calls("gh-acme-docs")).toHaveLength(1);
    expect(await calls("demo")).toEqual([]);
  });

  test(`${REFRESH} at :15 (DEMO_RESET_MINUTES 15): the demo is reset in its WorkspaceDO`, async () => {
    expect((await fire(REFRESH, new Date("2026-10-29T12:15:00Z"))).outcome).toBe("ok");
    expect(await calls("demo")).toEqual([{ name: "demo", reset: true }]);
  });

  test("an unknown cron does nothing", async () => {
    expect((await fire("* * * * *")).outcome).toBe("ok");
    expect(await calls("gh-acme-docs")).toHaveLength(1);
  });
});
