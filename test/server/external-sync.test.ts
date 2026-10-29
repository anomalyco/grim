// EXTERNAL_SYNC (config.externalSync): commits made outside Grimoire (straight to Code Storage or to the local Git
// repo) are picked up only when it's on. Off (the default): the webhook answers 404 and does nothing, nothing polls
// heads, and a commit that meets an outside change still merges it in rather than losing either side.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

const dir = mkdtempSync(join(process.env.DATA_DIR!, "external-sync-"));
process.env.QUIET_MS = "600000";

const { config } = await import("../../src/server/config.ts");
const { LocalGitStore } = await import("../../src/server/store/localgit.ts");
const { CachedHeadStore } = await import("../../src/server/store/cached-head.ts");
const { RoomManager } = await import("../../src/server/rooms.ts");
const { RepoService } = await import("../../src/server/repos.ts");
const { LocalWorkspaceHost } = await import("../../src/server/bun/workspace-host-local.ts");
const { bunDb } = await import("../../src/server/bun/db-bun.ts");
const { bunRoomStorage } = await import("../../src/server/bun/room-storage-bun.ts");
const { handleWebhook } = await import("../../src/server/api.ts");

// The outsider commits to `base` directly, the way a push to Code Storage or to the local repo bypasses the head cache.
const base = new LocalGitStore(join(dir, "git"));
/** Head reads that reached the backing store (the cache answers the rest). */
const heads: string[] = [];
const counted = new Proxy(base, {
  get(target, key) {
    const v = Reflect.get(target, key);
    if (key !== "head" || typeof v !== "function") return typeof v === "function" ? v.bind(target) : v;
    return (repo: string, branch: string) => {
      heads.push(repo);
      return v.call(target, repo, branch);
    };
  },
});
const store = new CachedHeadStore(counted);
const rooms = new RoomManager(store, { storage: bunRoomStorage(), db: bunDb() });
const host = new LocalWorkspaceHost(store, rooms);
const db = bunDb();
const repos = new RepoService(store, rooms, db, host);
const ctx = { store, rooms, repos };
const bot = { id: "agent1", name: "Robo", email: "robo@agents.grimoire", kind: "agent" as const, color: "#0f0" };
const author = { name: "Outsider", email: "o@example.com" };

const saved = { externalSync: config.externalSync, secret: config.codeStorage.webhookSecret, org: config.codeStorage.org, prefix: config.codeStorage.repoPrefix };
afterEach(() => {
  config.externalSync = saved.externalSync;
  config.codeStorage.webhookSecret = saved.secret;
  config.codeStorage.org = saved.org;
  config.codeStorage.repoPrefix = saved.prefix;
});

async function seed(id: string, files: Record<string, string>) {
  await store.createRepo(id, { branch: "main" });
  const r = await store.commit({ repo: id, branch: "main", expectedHead: await store.head(id, "main"), changes: Object.entries(files).map(([path, content]) => ({ path, content })), message: "seed", author });
  if (!r.ok) throw new Error("seed failed");
  await db.run("INSERT OR REPLACE INTO repos (id, title, kind, branch, status, created_at) VALUES (?, ?, 'notes', 'main', 'ready', 0)", id, id);
}

/** A commit from outside Grimoire: on the backing store, so Grimoire's head cache doesn't know. */
async function outside(id: string, files: Record<string, string>) {
  const r = await base.commit({ repo: id, branch: "main", expectedHead: await base.head(id, "main"), changes: Object.entries(files).map(([path, content]) => ({ path, content })), message: "outside", author });
  if (!r.ok) throw new Error("outside commit failed");
}

async function committed(id: string, path: string) {
  const head = await base.head(id, "main");
  return head ? base.readFile(id, path, head) : null;
}

/** Start the pollers with setInterval captured, run each tick once, stop them; the head reads they made on xs*. */
async function pollOnce(): Promise<{ delays: number[]; reads: number }> {
  const ticks: Array<{ fn: () => unknown; ms: number }> = [];
  const real = globalThis.setInterval;
  globalThis.setInterval = ((fn: () => unknown, ms: number) => (ticks.push({ fn, ms }), real(() => {}, 1 << 30))) as typeof setInterval;
  let stop: () => void;
  try {
    stop = repos.startPolling();
  } finally {
    globalThis.setInterval = real;
  }
  heads.length = 0;
  for (const t of ticks) await t.fn();
  // the poller fires onPush without waiting for it
  await Bun.sleep(0);
  // and what POST /api/repos/:id/refresh does for a notes workspace
  for (const r of await repos.list()) if (r.id.startsWith("xs")) await host.get(r.id).refresh(r, Infinity).catch(() => {});
  stop();
  return { delays: ticks.map((t) => t.ms), reads: heads.filter((r) => r.startsWith("xs")).length };
}

async function hmacHex(secret: string, data: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data))).toString("hex");
}

async function webhook(repo: string) {
  config.codeStorage.webhookSecret = "whsec_test";
  config.codeStorage.org = "acme";
  config.codeStorage.repoPrefix = "";
  const body = JSON.stringify({ type: "push", repository: { repo_name: repo }, ref: "refs/heads/main", before: "a", after: "b", org: "acme" });
  const t = Math.floor(Date.now() / 1000);
  const headers = { "x-pierre-event": "push", "x-pierre-signature": `t=${t},sha256=${await hmacHex("whsec_test", `${t}.${body}`)}` };
  return handleWebhook(new Request("http://x/webhooks/codestorage", { method: "POST", headers, body }), ctx as never);
}

describe("external sync off (the default)", () => {
  test("is off unless EXTERNAL_SYNC=1", () => {
    expect(process.env.EXTERNAL_SYNC === "1").toBe(config.externalSync);
    config.externalSync = false;
  });

  test("the webhook answers 404 and touches nothing, even signed and valid", async () => {
    config.externalSync = false;
    await seed("xs1", { "a.md": "a\n" });
    const room = await rooms.get("xs1", "a.md", "main");
    await outside("xs1", { "a.md": "a2\n" });
    const pushed: string[] = [];
    const real = repos.pushed;
    repos.pushed = async (id: string) => void pushed.push(id);
    heads.length = 0;
    try {
      const res = await webhook("xs1");
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "external sync is disabled" });
      expect((await handleWebhook(new Request("http://x/webhooks/codestorage", { method: "POST", body: "{}" }), ctx as never)).status).toBe(404);
    } finally {
      repos.pushed = real;
    }
    expect(pushed).toEqual([]);
    expect(heads).toEqual([]);
    expect(room.text.toString()).toBe("a\n");
    room.destroy(true);
  });

  test("Bun's head poller isn't started and a notes workspace's refresh reads no head", async () => {
    config.externalSync = false;
    await seed("xs2", { "a.md": "a\n" });
    await rooms.get("xs2", "a.md", "main");
    const { delays, reads } = await pollOnce();
    expect(delays).not.toContain(config.pollMs);
    expect(delays).toContain(config.upstreamRefreshMs);
    expect(reads).toBe(0);
    rooms.peek("xs2", "a.md")?.destroy(true);
  });

  test("a commit after an outside change loses neither: the conflict merges it in, then commits", async () => {
    config.externalSync = false;
    await seed("xs3", { "n.md": "one\ntwo\n" });
    const room = await rooms.get("xs3", "n.md", "main");
    room.agentEdit(bot, (t) => void t.insert(0, "zero\n"));
    await outside("xs3", { "n.md": "one\ntwo\nthree\n" });
    // nobody notices the outside commit…
    await pollOnce();
    expect(room.text.toString()).toBe("zero\none\ntwo\n");
    // …until Grimoire's own commit meets the moved head
    await room.flush();
    expect(await committed("xs3", "n.md")).toBe("zero\none\ntwo\nthree\n");
    expect(room.text.toString()).toBe("zero\none\ntwo\nthree\n");
    expect(room.dirty).toBe(false);
    room.destroy(true);
  });
});

describe("external sync on (EXTERNAL_SYNC=1)", () => {
  test("the poller reads heads fresh and merges an outside commit into an open note", async () => {
    config.externalSync = true;
    await seed("xs4", { "a.md": "a\n" });
    const room = await rooms.get("xs4", "a.md", "main");
    await host.get("xs4").onPush((await repos.get("xs4"))!);
    await outside("xs4", { "a.md": "a2\n" });
    const { delays, reads } = await pollOnce();
    expect(delays).toContain(config.pollMs);
    expect(reads).toBeGreaterThan(0);
    for (let i = 0; i < 50 && room.text.toString() !== "a2\n"; i++) await Bun.sleep(10);
    expect(room.text.toString()).toBe("a2\n");
    room.destroy(true);
  });

  test("the webhook picks up an outside commit", async () => {
    config.externalSync = true;
    await seed("xs5", { "a.md": "a\n" });
    const room = await rooms.get("xs5", "a.md", "main");
    await host.get("xs5").onPush((await repos.get("xs5"))!);
    await outside("xs5", { "a.md": "a2\n" });
    const changed = host.get("xs5").waitForChange(undefined, 2000);
    expect((await webhook("xs5")).status).toBe(200);
    expect(await changed).toBe(true);
    expect(room.text.toString()).toBe("a2\n");
    room.destroy(true);
  });
});
