// The demo's MemoryStore persisted through a RoomStorage (Bun's, over an in-memory bun:sqlite database): the seed and
// later commits survive a "restart" (a new store over the same storage), large blobs are split into parts, and
// deleteRepo leaves no rows behind.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

const { BunRoomStorage } = await import("../../src/server/bun/room-storage-bun.ts");
const { MemoryStore } = await import("../../src/server/store/memory.ts");
const { BLOB_PART_BYTES, RoomStoragePersistence } = await import("../../src/server/store/memory-persist.ts");
const { DEMO_ID, DEMO_SEED, demoLimits } = await import("../../src/server/demo.ts");

const TABLES = ["demo_repos", "demo_blobs", "demo_commits", "demo_heads"];
const grimoire = { name: "Grimoire", email: "grimoire@users.noreply.code.storage" };
const ann = { name: "Ann", email: "ann@example.com" };
const bob = { name: "Bob", email: "bob@example.com" };

function fresh() {
  const db = new Database(":memory:");
  const storage = new BunRoomStorage(db);
  return { db, storage, store: () => new MemoryStore(demoLimits, new RoomStoragePersistence(storage)) };
}

const tables = (db: Database) => (db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
const rows = (db: Database, table: string, repo: string) => (db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE repo = ?`).get(repo) as { n: number }).n;

/** The demo seed (as seedDemo commits it), then a few edits by two people, a 2 MiB image and a deletion. */
async function seedAndEdit(store: InstanceType<typeof MemoryStore>) {
  let t = Date.UTC(2026, 9, 28, 12);
  store.now = () => (t += 1000);
  await store.createRepo(DEMO_ID, { branch: "main" });
  const commit = async (changes: Array<{ path: string; content?: string | Uint8Array; delete?: boolean }>, author: typeof ann, message: string) => {
    const res = await store.commit({ repo: DEMO_ID, branch: "main", expectedHead: await store.head(DEMO_ID, "main"), changes, message, author });
    if (!res.ok) throw new Error("conflict");
    return res.sha;
  };
  await commit(DEMO_SEED, grimoire, "Start the demo");
  const welcome = DEMO_SEED.find((f) => f.path === "Welcome.md")!.content;
  await commit([{ path: "Welcome.md", content: `${welcome}\nAnn was here\n` }], ann, "Ann edits");
  await commit([{ path: "Welcome.md", content: `${welcome}\nAnn was here\nBob too\n` }, { path: "Bob.md", content: "# Bob\n" }], bob, "Bob edits");
  const big = new Uint8Array(demoLimits.imageBytes).map((_, i) => (i * 7) & 0xff);
  await commit([{ path: "images/big.png", content: big }], ann, "A big image");
  await commit([{ path: "tour/Ideas.md", delete: true }], bob, "Drop ideas");
  return big;
}

/** Everything a client can see of the demo repo. */
async function snapshot(store: InstanceType<typeof MemoryStore>) {
  const head = (await store.head(DEMO_ID, "main"))!;
  const files = await store.listFilesWithMetadata(DEMO_ID, head);
  const contents: Record<string, string> = {};
  for (const f of files) if (f.path.endsWith(".md") || f.path.endsWith(".svg")) contents[f.path] = (await store.readFile(DEMO_ID, f.path, head))!;
  return {
    head,
    files,
    contents,
    history: await store.history(DEMO_ID, "main", undefined, 50),
    welcomeHistory: await store.history(DEMO_ID, "main", "Welcome.md", 50),
    blame: await store.blame(DEMO_ID, "Welcome.md", head),
    diff: await store.diff(DEMO_ID, (await store.history(DEMO_ID, "main", undefined, 50))[2]!.sha),
    search: await store.search(DEMO_ID, head, "bob", 20),
  };
}

describe("RoomStoragePersistence", () => {
  test("tables are made on first use only", () => {
    const { db, storage } = fresh();
    const p = new RoomStoragePersistence(storage);
    expect(tables(db)).toEqual([]);
    expect(p.hasRepo("x")).toBe(false);
    expect(tables(db)).toEqual([...TABLES].sort());
  });

  test("the demo seed and later commits survive a restart", async () => {
    const { storage, store } = fresh();
    const first = store();
    const big = await seedAndEdit(first);
    const before = await snapshot(first);
    expect(before.history.map((c) => c.message)).toEqual(["Drop ideas", "A big image", "Bob edits", "Ann edits", "Start the demo"]);
    expect(before.files.map((f) => f.path)).toContain("images/grimoire.svg");
    expect(before.files.map((f) => f.path)).not.toContain("tour/Ideas.md");
    expect(before.blame!.at(-1)).toEqual(bob);
    expect(before.blame!.at(-2)).toEqual(ann);
    expect(before.blame![0]).toEqual(grimoire);

    const second = store();
    expect(await snapshot(second)).toEqual(before);
    expect(await second.readBlob(DEMO_ID, "images/big.png", before.head, demoLimits.imageBytes)).toEqual(big);
    expect(await new RoomStoragePersistence(storage).listHeads(DEMO_ID)).toEqual({ main: before.head });

    // and the restarted store keeps going from there
    const res = await second.commit({ repo: DEMO_ID, branch: "main", expectedHead: before.head, changes: [{ path: "After.md", content: "later\n" }], message: "After", author: ann });
    expect(res.ok).toBe(true);
    expect((await store().history(DEMO_ID, "main", undefined, 1))[0]!.message).toBe("After");
  });

  test("large blobs are split into parts no bigger than a part", async () => {
    const { db, storage } = fresh();
    const p = new RoomStoragePersistence(storage);
    p.createRepo("r");
    const bytes = new Uint8Array(BLOB_PART_BYTES * 2 + 5).map((_, i) => i & 0xff);
    p.putBlob("r", "big", bytes);
    p.putBlob("r", "empty", new Uint8Array());
    const parts = db.query("SELECT part, length(data) AS n FROM demo_blobs WHERE sha = 'big' ORDER BY part").all();
    expect(parts).toEqual([{ part: 0, n: BLOB_PART_BYTES }, { part: 1, n: BLOB_PART_BYTES }, { part: 2, n: 5 }]);
    expect(p.getBlob("r", "big")).toEqual(bytes);
    expect(p.getBlob("r", "empty")).toEqual(new Uint8Array());
    expect(p.getBlob("r", "missing")).toBeNull();
    p.putBlob("r", "big", Uint8Array.of(1, 2));
    expect(p.getBlob("r", "big")).toEqual(Uint8Array.of(1, 2));
    p.deleteBlob("r", "big");
    expect(p.getBlob("r", "big")).toBeNull();
  });

  test("commits list in putCommit order; putting one again keeps its place", () => {
    const { storage } = fresh();
    const p = new RoomStoragePersistence(storage);
    p.createRepo("r");
    const c = (sha: string) => ({ sha, parent: null, tree: {}, message: sha, authorName: "A", authorEmail: "a@x", date: "2026-10-28T00:00:00Z" });
    for (const sha of ["c", "a", "b"]) p.putCommit("r", c(sha));
    p.putCommit("r", { ...c("c"), message: "again" });
    expect(p.listCommits("r")).toEqual(["c", "a", "b"]);
    expect(p.getCommit("r", "c")!.message).toBe("again");
    p.deleteCommit("r", "c");
    p.putCommit("r", c("d"));
    expect(p.listCommits("r")).toEqual(["a", "b", "d"]);
  });

  test("retention drops old commits and their blob rows", async () => {
    const { db, storage } = fresh();
    const store = new MemoryStore({ ...demoLimits, commits: 2 }, new RoomStoragePersistence(storage));
    await store.createRepo("r", { branch: "main" });
    let head: string | null = null;
    for (let i = 0; i < 4; i++) {
      const res = await store.commit({ repo: "r", branch: "main", expectedHead: head, changes: [{ path: "a.md", content: `v${i}\n` }], message: `v${i}`, author: ann });
      if (!res.ok) throw new Error("conflict");
      head = res.sha;
    }
    expect(rows(db, "demo_commits", "r")).toBe(2);
    expect(rows(db, "demo_blobs", "r")).toBe(2);
  });

  test("deleteRepo removes all of its rows and nothing else", async () => {
    const { db, storage, store } = fresh();
    await seedAndEdit(store());
    const other = store();
    await other.createRepo("other", { branch: "main" });
    await other.commit({ repo: "other", branch: "main", expectedHead: null, changes: [{ path: "x.md", content: "x\n" }], message: "x", author: ann });
    for (const t of TABLES) expect(rows(db, t, DEMO_ID)).toBeGreaterThan(0);

    await store().deleteRepo(DEMO_ID);
    for (const t of TABLES) expect(rows(db, t, DEMO_ID)).toBe(0);
    for (const t of TABLES) expect(rows(db, t, "other")).toBeGreaterThan(0);
    const after = store();
    expect(await after.head(DEMO_ID, "main")).toBeNull();
    expect(await new RoomStoragePersistence(storage).hasRepo(DEMO_ID)).toBe(false);
    expect(await after.readFile("other", "x.md", "main")).toBe("x\n");
  });
});
