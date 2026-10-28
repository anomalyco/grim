// The WorkspaceHost seam: ops run through host.get(repo) with every argument, result and error passed through
// structuredClone, the way a Durable Object RPC call would carry them.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

const dir = mkdtempSync(join(process.env.DATA_DIR!, "workspace-"));
process.env.QUIET_MS = "50";

const { LocalGitStore } = await import("../../src/server/store/localgit.ts");
const { CachedHeadStore } = await import("../../src/server/store/cached-head.ts");
const { RoomManager } = await import("../../src/server/rooms.ts");
const { RepoService } = await import("../../src/server/repos.ts");
const { LocalWorkspaceHost } = await import("../../src/server/bun/workspace-host-local.ts");
const { bunDb } = await import("../../src/server/bun/db-bun.ts");
const { errStatus, isErr } = await import("../../src/server/errors.ts");
const ops = await import("../../src/server/ops.ts");
import type { RepoRow } from "../../src/server/repos.ts";
import type { WorkspaceApi } from "../../src/server/seams/workspace-host.ts";

const store = new CachedHeadStore(new LocalGitStore(join(dir, "git")));
const rooms = new RoomManager(store);
const host = new LocalWorkspaceHost(store, rooms);
const db = bunDb();
const repos = new RepoService(store, rooms, db, host);
const ctx = { store, rooms, repos };

const alice = { id: "u1", name: "Alice", email: "alice@example.com", kind: "human" as const, color: "#f00" };
const bot = { id: "agent1", name: "Robo", email: "robo@agents.grimoire", kind: "agent" as const, color: "#0f0" };

const row = (id: string, over: Partial<RepoRow> = {}): RepoRow => ({
  id,
  title: id,
  kind: "notes",
  gh_owner: null,
  gh_name: null,
  read_only: 0,
  branch: "main",
  status: "ready",
  error: null,
  created_by: null,
  created_at: 0,
  owner_id: null,
  ...over,
});

async function seed(id: string, files: Record<string, string>) {
  await store.createRepo(id, { branch: "main" });
  const r = await store.commit({ repo: id, branch: "main", expectedHead: await store.head(id, "main"), changes: Object.entries(files).map(([path, content]) => ({ path, content })), message: "seed", author: alice });
  if (!r.ok) throw new Error("seed failed");
  await db.run("INSERT OR REPLACE INTO repos (id, title, kind, branch, status, created_at) VALUES (?, ?, 'notes', 'main', 'ready', 0)", id, id);
  return r.sha;
}

/** Workers RPC keeps an error's name, message and own fields but not its prototype; Bun's structuredClone keeps only the message. */
const overRpc = (e: unknown): unknown => (e instanceof Error ? Object.assign(structuredClone(e), { ...e, name: e.name }) : structuredClone(e));

/** host.get(id) as a DO stub would see it: arguments, results and errors all structured-cloned. */
function stub(id: string): WorkspaceApi {
  const api = host.get(id);
  return new Proxy(api, {
    get(target, key) {
      const fn = (target as any)[key];
      if (typeof fn !== "function") return fn;
      return async (...args: unknown[]) => {
        try {
          return structuredClone(await fn.apply(target, structuredClone(args)));
        } catch (e) {
          throw overRpc(e);
        }
      };
    },
  });
}

async function rejection(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

describe("WorkspaceHost (Bun, in-process)", () => {
  test("ops through the host return plain, cloneable data", async () => {
    await seed("ws1", { "a.md": "# A\nhello\n", "notes/b.md": "b\n" });
    const repo = row("ws1");
    const ws = stub("ws1");

    expect(await ws.tree(repo)).toEqual(["a.md", "notes/b.md"]);
    const read = await ws.readFile(repo, "a.md");
    expect(read).toMatchObject({ path: "a.md", content: "# A\nhello\n", live: false });

    expect(await ws.createFile(repo, "c", "see\n", bot)).toMatchObject({ path: "c.md" });
    expect(await ws.tree(repo)).toEqual(["a.md", "c.md", "notes/b.md"]);
    await ws.patchFile(repo, "c.md", "see\n", "saw\n", bot);
    await ws.appendText(repo, "c.md", "more\n", bot);
    expect(await ws.readFile(repo, "c.md")).toMatchObject({ content: "saw\nmore\n", live: true });
    await rooms.peek("ws1", "c.md")!.flush();

    const hist = await ws.history(repo, "c.md");
    expect(hist[0]!.message).toContain("c.md");
    expect(await ws.diff(repo, hist[0]!.sha, "c.md")).toContain("+saw");
    expect((await ws.search(repo, "hello")).hits.map((h) => h.path)).toEqual(["a.md"]);
    expect(await ws.head(repo)).toBe(hist[0]!.sha);

    expect(await ws.renameFile(repo, "c.md", "d.md", bot)).toEqual({ path: "d.md" });
    expect(await ws.renameFolder(repo, "notes", "docs", bot)).toEqual({ path: "docs" });
    expect(await ws.tree(repo)).toEqual(["a.md", "d.md", "docs/b.md"]);

    const seedSha = hist.at(-1)!.sha;
    await ws.restoreFile(repo, "a.md", seedSha, bot);
    expect(await ws.deleteFile(repo, "d.md", bot)).toEqual({ ok: true });
    expect(await ws.deleteFolder(repo, "docs", bot)).toEqual({ ok: true });
    expect(await ws.tree(repo)).toEqual(["a.md"]);

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const up = await ws.uploadImage(repo, "a.md", "shot.png", png, alice);
    expect(up).toEqual({ path: "images/shot.png", markdownPath: "images/shot.png", markdown: "![shot](images/shot.png)", reused: false });
    const raw = await ws.readRaw(repo, "images/shot.png");
    expect(raw.type).toBe("image/png");
    expect([...raw.bytes]).toEqual([...png]);
    expect((await ws.uploadImage(repo, "a.md", "shot.png", png, alice)).reused).toBe(true);
  });

  test("errors keep their name and status across the boundary", async () => {
    await seed("ws2", { "a.md": "a\n" });
    const repo = row("ws2");
    const ws = stub("ws2");
    const cases: [() => Promise<unknown>, string, number][] = [
      [() => ws.readFile(repo, "missing.md"), "OpError", 404],
      [() => ws.readFile(repo, "../x"), "OpError", 400],
      [() => ws.readFile(repo, "a.md", "-bad"), "OpError", 400],
      [() => ws.createFile(repo, "a.md", "x", bot), "OpError", 409],
      [() => ws.createFile(row("ws2", { read_only: 1 }), "b.md", "x", bot), "OpError", 403],
      [() => ws.createFile(row("ws2", { status: "importing" }), "b.md", "x", bot), "OpError", 409],
      [() => ws.patchFile(repo, "nope.md", "", "x", bot), "OpError", 404],
      [() => ws.diff(repo, "zz"), "OpError", 400],
      [() => ws.readRaw(repo, "a.txt"), "OpError", 415],
      [() => ws.renameFolder(repo, "nowhere", "else", bot), "OpError", 404],
    ];
    for (const [p, name, status] of cases) {
      const e = await rejection(p());
      expect(isErr(e, name)).toBe(true);
      expect(Object.getPrototypeOf(e)).toBe(Error.prototype);
      expect(errStatus(e)).toBe(status);
    }
  });

  test("the (ctx, repo, …) entry points, the tree and pushes go through the host", async () => {
    await seed("ws3", { "a.md": "a\n" });
    const repo = (await repos.get("ws3"))!;
    const runtime = host.get("ws3");
    expect(host.get("ws3")).toBe(runtime);
    const calls: string[] = [];
    for (const m of ["createFile", "tree", "onPush", "renameFile"] as const) {
      const orig = (runtime as any)[m].bind(runtime);
      (runtime as any)[m] = (...a: unknown[]) => (calls.push(m), orig(...a));
    }
    await ops.createFile(ctx, repo, "b.md", "b\n", bot);
    expect(await repos.tree(repo)).toEqual(["a.md", "b.md"]);
    await ops.renameFile(ctx, repo, "b.md", "c.md", bot);
    await repos.pushed("ws3");
    expect(calls).toEqual(["createFile", "tree", "renameFile", "onPush", "onPush"]);

    // an outside commit is picked up by onPush (the cached head is dropped by pushed())
    const head = await store.head("ws3", "main");
    await store.commit({ repo: "ws3", branch: "main", expectedHead: head, changes: [{ path: "z.md", content: "z\n" }], message: "outside", author: alice });
    const changed = runtime.waitForChange(undefined, 2000);
    await repos.pushed("ws3");
    expect(await changed).toBe(true);
    expect(await repos.tree(repo)).toContain("z.md");

    await repos.removeRepo("ws3");
    expect(host.get("ws3")).not.toBe(runtime);
  });

  test("file-level WebSocket admission runs in the runtime", async () => {
    await seed("ws4", { "a.md": "a\n" });
    const a = { repoId: "ws4", branch: "main", participant: alice, readOnly: false };
    const ok = await host.admitFile({ ...a, path: "a.md" });
    expect("room" in ok && ok.room.text.toString()).toBe("a\n");
    expect(await host.admitFile({ ...a, path: "missing.md" })).toEqual({ reject: { code: 4404, reason: "file not found" } });
    await rooms.flushAll();
  });
});
