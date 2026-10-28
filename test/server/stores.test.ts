// The GitStore contract, run against the local Git store and the in-memory store (the demo folder's), plus the
// memory store's own limits and persistence, and the RoutedStore (demo → memory, everything else → the configured store).
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";

const { LocalGitStore } = await import("../../src/server/store/localgit.ts");
const { MapPersistence, MemoryStore } = await import("../../src/server/store/memory.ts");
type MemoryPersistence = import("../../src/server/store/memory.ts").MemoryPersistence;
type MemCommit = import("../../src/server/store/memory.ts").MemCommit;
const { RoutedStore } = await import("../../src/server/store/routed.ts");
const { FileTooLargeError, MAX_FILE_BYTES, StoreFullError } = await import("../../src/server/store/types.ts");
type GitStore = import("../../src/server/store/types.ts").GitStore;

const author = { name: "Ann", email: "ann@example.com" };
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
let n = 0;

function suite(name: string, make: () => GitStore) {
  describe(`GitStore contract: ${name}`, () => {
    const setup = async () => {
      const store = make();
      const repo = `r${++n}`;
      await store.createRepo(repo, { branch: "main" });
      return { store, repo };
    };
    const commit = (store: GitStore, repo: string, expectedHead: string | null, changes: any[], message = "change", who = author) => store.commit({ repo, branch: "main", expectedHead, changes, message, author: who });

    test("first commit, compare-and-swap on the head", async () => {
      const { store, repo } = await setup();
      expect(await store.head(repo, "main")).toBeNull();
      const a = await commit(store, repo, null, [{ path: "a.md", content: "one\n" }]);
      expect(a.ok).toBe(true);
      const sha = (a as { sha: string }).sha;
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      expect(await store.head(repo, "main")).toBe(sha);
      expect(await commit(store, repo, null, [{ path: "b.md", content: "x" }])).toEqual({ ok: false, reason: "conflict" });
      expect((await commit(store, repo, sha, [{ path: "b.md", content: "x" }])).ok).toBe(true);
      // a stale head
      expect(await commit(store, repo, sha, [{ path: "c.md", content: "x" }])).toEqual({ ok: false, reason: "conflict" });
    });

    test("files at refs: branch, full and short ids; deletes; listings with sizes", async () => {
      const { store, repo } = await setup();
      const a = (await commit(store, repo, null, [{ path: "a.md", content: "one\n" }, { path: "dir/b.md", content: "bee\n" }])) as { sha: string };
      const b = (await commit(store, repo, a.sha, [{ path: "a.md", content: "two\n" }, { path: "dir/b.md", delete: true }])) as { sha: string };
      expect(await store.readFile(repo, "a.md", "main")).toBe("two\n");
      expect(await store.readFile(repo, "a.md", a.sha)).toBe("one\n");
      expect(await store.readFile(repo, "a.md", a.sha.slice(0, 7))).toBe("one\n");
      expect(await store.readFile(repo, "dir/b.md", b.sha)).toBeNull();
      expect(await store.readFile(repo, "dir/b.md", a.sha)).toBe("bee\n");
      expect(await store.readFile(repo, "nope.md", "main")).toBeNull();
      expect(await store.listFiles(repo, a.sha)).toEqual(["a.md", "dir/b.md"]);
      expect(await store.listFiles(repo, "main")).toEqual(["a.md"]);
      expect(await store.listFilesWithMetadata!(repo, a.sha)).toEqual([{ path: "a.md", size: 4 }, { path: "dir/b.md", size: 4 }]);
    });

    test("binary files: write and read bytes, size caps", async () => {
      const { store, repo } = await setup();
      const a = (await commit(store, repo, null, [{ path: "n.md", content: "x" }])) as { sha: string };
      const w = await store.writeBlob({ repo, branch: "main", expectedHead: a.sha, path: "images/p.png", bytes: PNG, message: "Add images/p.png", author });
      expect(w.ok).toBe(true);
      expect([...(await store.readBlob(repo, "images/p.png", "main", 1000))!]).toEqual([...PNG]);
      expect(await store.readBlob(repo, "images/none.png", "main", 1000)).toBeNull();
      await expect(store.readBlob(repo, "images/p.png", "main", 4)).rejects.toBeInstanceOf(FileTooLargeError);
      const big = (await commit(store, repo, (w as { sha: string }).sha, [{ path: "big.md", content: "x".repeat(MAX_FILE_BYTES + 1) }])) as { sha: string };
      await expect(store.readFile(repo, "big.md", big.sha)).rejects.toBeInstanceOf(FileTooLargeError);
    });

    test("history: newest first, the whole folder or one path, with authors", async () => {
      const { store, repo } = await setup();
      const a = (await commit(store, repo, null, [{ path: "a.md", content: "1" }], "Create a.md")) as { sha: string };
      const b = (await commit(store, repo, a.sha, [{ path: "b.md", content: "1" }], "Create b.md", { name: "Bob", email: "bob@example.com" })) as { sha: string };
      const c = (await commit(store, repo, b.sha, [{ path: "a.md", content: "2" }], "Update a.md\n\nCo-authored-by: X <x@example.com>")) as { sha: string };
      const all = await store.history(repo, "main", undefined, 10);
      expect(all.map((h) => [h.sha, h.message])).toEqual([[c.sha, "Update a.md"], [b.sha, "Create b.md"], [a.sha, "Create a.md"]]);
      expect(all[1]).toMatchObject({ authorName: "Bob", authorEmail: "bob@example.com" });
      expect(Number.isNaN(Date.parse(all[0]!.date))).toBe(false);
      expect((await store.history(repo, "main", "a.md", 10)).map((h) => h.sha)).toEqual([c.sha, a.sha]);
      expect((await store.history(repo, "main", undefined, 2)).length).toBe(2);
      expect(await store.history(repo, "main", "none.md", 10)).toEqual([]);
    });

    test("diff of a commit against its parent (Markdown, or one path)", async () => {
      const { store, repo } = await setup();
      const a = (await commit(store, repo, null, [{ path: "a.md", content: "keep\nold\n" }, { path: "x.txt", content: "t" }])) as { sha: string };
      const b = (await commit(store, repo, a.sha, [{ path: "a.md", content: "keep\nnew\n" }, { path: "x.txt", content: "u" }, { path: "c.md", content: "sea\n" }])) as { sha: string };
      const d = await store.diff(repo, b.sha);
      expect(d).toContain("diff --git a/a.md b/a.md");
      expect(d).toContain("-old");
      expect(d).toContain("+new");
      expect(d).toContain("+sea");
      expect(d).not.toContain("x.txt");
      const one = await store.diff(repo, b.sha.slice(0, 8), "a.md");
      expect(one).toContain("+new");
      expect(one).not.toContain("c.md");
      // the first commit: everything is new
      expect(await store.diff(repo, a.sha)).toContain("+old");
    });

    test("search: Markdown only, case-insensitive, line numbers, limit", async () => {
      const { store, repo } = await setup();
      await commit(store, repo, null, [{ path: "a.md", content: "Hello\nworld\nhello again\n" }, { path: "b.txt", content: "hello" }, { path: "c.md", content: "nothing" }]);
      expect((await store.search(repo, "main", "HELLO", 10)).hits).toEqual([{ path: "a.md", line: 1, text: "Hello" }, { path: "a.md", line: 3, text: "hello again" }]);
      expect((await store.search(repo, "main", "hello", 1)).hits.length).toBe(1);
      expect((await store.search(repo, "main", "", 10)).hits).toEqual([]);
    });

    test("deleteRepo", async () => {
      const { store, repo } = await setup();
      await commit(store, repo, null, [{ path: "a.md", content: "1" }]);
      await store.deleteRepo(repo);
      await store.createRepo(repo, { branch: "main" });
      expect(await store.head(repo, "main")).toBeNull();
    });
  });
}

suite("LocalGitStore", () => new LocalGitStore(mkdtempSync(join(process.env.DATA_DIR!, "stores-"))));
suite("MemoryStore", () => new MemoryStore());
suite("MemoryStore (async persistence)", () => new MemoryStore(null, new Recording()));

/** A persistence that answers asynchronously (like a remote one) and records every write. */
class Recording implements MemoryPersistence {
  inner = new MapPersistence();
  writes: string[] = [];
  createRepo = async (repo: string) => this.inner.createRepo(repo);
  hasRepo = async (repo: string) => this.inner.hasRepo(repo);
  deleteRepo = async (repo: string) => (this.writes.push(`deleteRepo ${repo}`), this.inner.deleteRepo(repo));
  getBlob = async (repo: string, sha: string) => this.inner.getBlob(repo, sha);
  putBlob = async (repo: string, sha: string, bytes: Uint8Array) => (this.writes.push(`putBlob ${sha} ${bytes.byteLength}`), this.inner.putBlob(repo, sha, bytes));
  deleteBlob = async (repo: string, sha: string) => (this.writes.push(`deleteBlob ${sha}`), this.inner.deleteBlob(repo, sha));
  getCommit = async (repo: string, sha: string) => this.inner.getCommit(repo, sha);
  putCommit = async (repo: string, c: MemCommit) => (this.writes.push(`putCommit ${c.sha}`), this.inner.putCommit(repo, structuredClone(c)));
  deleteCommit = async (repo: string, sha: string) => (this.writes.push(`deleteCommit ${sha}`), this.inner.deleteCommit(repo, sha));
  listCommits = async (repo: string) => this.inner.listCommits(repo);
  getHead = async (repo: string, branch: string) => this.inner.getHead(repo, branch);
  setHead = async (repo: string, branch: string, sha: string) => (this.writes.push(`setHead ${branch} ${sha}`), this.inner.setHead(repo, branch, sha));
  listHeads = async (repo: string) => this.inner.listHeads(repo);
}

describe("MemoryStore", () => {
  const limits = { noteBytes: 100, imageBytes: 50, imagesBytes: 80, totalBytes: 200, commits: 5, fullMessage: "The demo is full — it resets every few hours" };
  const fresh = async (l: typeof limits | null = limits) => {
    const s = new MemoryStore(l);
    await s.createRepo("demo", { branch: "main" });
    return s;
  };
  const put = (s: InstanceType<typeof MemoryStore>, head: string | null, changes: any[]) => s.commit({ repo: "demo", branch: "main", expectedHead: head, changes, message: "m", author });

  test("commit ids hash the content: the same commits give the same ids", async () => {
    const one = await fresh(null);
    const two = await fresh(null);
    one.now = two.now = () => Date.parse("2026-10-28T12:00:00Z");
    const a1 = (await put(one, null, [{ path: "a.md", content: "x" }])) as { sha: string };
    const a2 = (await put(two, null, [{ path: "a.md", content: "x" }])) as { sha: string };
    expect(a1.sha).toBe(a2.sha);
    const b1 = (await put(one, a1.sha, [{ path: "a.md", content: "y" }])) as { sha: string };
    expect(b1.sha).not.toBe(a1.sha);
    expect((await one.history("demo", "main", undefined, 5))[0]!.date).toBe("2026-10-28T12:00:00Z");
  });

  test("limits: a note, an image, all images, the whole snapshot", async () => {
    const s = await fresh();
    const a = (await put(s, null, [{ path: "a.md", content: "x".repeat(100) }])) as { ok: boolean; sha: string };
    expect(a.ok).toBe(true);
    const full = (changes: any[]) => expect(put(s, a.sha, changes)).rejects.toThrow("The demo is full — it resets every few hours");
    await full([{ path: "b.md", content: "x".repeat(101) }]);
    await full([{ path: "p.png", content: new Uint8Array(51) }]);
    const p = (await put(s, a.sha, [{ path: "p.png", content: new Uint8Array(50) }])) as { sha: string };
    await expect(put(s, p.sha, [{ path: "q.png", content: new Uint8Array(31) }])).rejects.toBeInstanceOf(StoreFullError);
    const q = (await put(s, p.sha, [{ path: "q.png", content: new Uint8Array(30) }, { path: "c.md", content: "x".repeat(20) }])) as { sha: string };
    // 100 + 80 + 20 = 200: at the limit; one more byte isn't
    await expect(put(s, q.sha, [{ path: "d.md", content: "x" }])).rejects.toBeInstanceOf(StoreFullError);
    // refusing changed nothing; deleting makes room
    expect(await s.head("demo", "main")).toBe(q.sha);
    expect((await put(s, q.sha, [{ path: "q.png", delete: true }, { path: "d.md", content: "x" }])).ok).toBe(true);
  });

  test("keeps the newest commits only", async () => {
    const s = await fresh();
    let head: string | null = null;
    const shas: string[] = [];
    for (let i = 0; i < 8; i++) {
      head = ((await put(s, head, [{ path: "a.md", content: String(i) }])) as { sha: string }).sha;
      shas.push(head);
    }
    const hist = await s.history("demo", "main", undefined, 100);
    expect(hist.map((h) => h.sha)).toEqual(shas.slice(3).reverse());
    expect(await s.readFile("demo", "a.md", shas[0]!)).toBeNull();
    expect(await s.readFile("demo", "a.md", shas[3]!)).toBe("3");
    expect(await s.readFile("demo", "a.md", "main")).toBe("7");
    // the oldest kept commit diffs against nothing
    expect(await s.diff("demo", shas[3]!)).toContain("+3");
  });

  test("a custom persistence sees content-addressed blobs, commit records and heads", async () => {
    const p = new Recording();
    const s = new MemoryStore(limits, p);
    await s.createRepo("demo", { branch: "main" });
    const sha1 = (b: string | Uint8Array) => createHash("sha1").update(b).digest("hex");
    const a = (await put(s, null, [{ path: "a.md", content: "x" }, { path: "b.md", content: "x" }, { path: "p.png", content: PNG }])) as { sha: string };
    // two files with the same bytes share one blob
    expect(p.writes).toEqual([`putBlob ${sha1("x")} 1`, `putBlob ${sha1(PNG)} ${PNG.byteLength}`, `putCommit ${a.sha}`, `setHead main ${a.sha}`]);
    expect(await p.getCommit("demo", a.sha)).toMatchObject({
      parent: null,
      tree: { "a.md": { sha: sha1("x"), size: 1 }, "b.md": { sha: sha1("x"), size: 1 }, "p.png": { sha: sha1(PNG), size: PNG.byteLength } },
      message: "m",
      authorName: "Ann",
      authorEmail: "ann@example.com",
    });
    // an unchanged blob isn't written again; refused and conflicting commits write nothing
    p.writes = [];
    const b = (await put(s, a.sha, [{ path: "a.md", content: "x" }, { path: "c.md", content: "y" }])) as { sha: string };
    expect(p.writes).toEqual([`putBlob ${sha1("y")} 1`, `putCommit ${b.sha}`, `setHead main ${b.sha}`]);
    p.writes = [];
    await expect(put(s, b.sha, [{ path: "big.md", content: "z".repeat(101) }])).rejects.toBeInstanceOf(StoreFullError);
    expect(await put(s, a.sha, [{ path: "d.md", content: "z" }])).toEqual({ ok: false, reason: "conflict" });
    expect(p.writes).toEqual([]);

    // a new store over the same storage (a restart) sees everything
    const again = new MemoryStore(limits, p);
    expect(await again.head("demo", "main")).toBe(b.sha);
    expect(await again.readFile("demo", "c.md", b.sha.slice(0, 6))).toBe("y");
    expect([...(await again.readBlob("demo", "p.png", "main", 1000))!]).toEqual([...PNG]);
    expect((await again.history("demo", "main", undefined, 10)).map((h) => h.sha)).toEqual([b.sha, a.sha]);
    expect((await again.search("demo", "main", "y", 10)).hits).toEqual([{ path: "c.md", line: 1, text: "y" }]);

    await again.deleteRepo("demo");
    expect(p.writes.at(-1)).toBe("deleteRepo demo");
    expect(await s.head("demo", "main")).toBeNull();
  });

  test("dropping old commits drops the blobs only they used", async () => {
    const p = new Recording();
    const s = new MemoryStore({ ...limits, commits: 2 }, p);
    await s.createRepo("demo", { branch: "main" });
    const sha1 = (b: string) => createHash("sha1").update(b).digest("hex");
    const a = (await put(s, null, [{ path: "keep.md", content: "k" }, { path: "a.md", content: "old" }])) as { sha: string };
    const b = (await put(s, a.sha, [{ path: "a.md", content: "mid" }])) as { sha: string };
    p.writes = [];
    const c = (await put(s, b.sha, [{ path: "a.md", content: "new" }])) as { sha: string };
    expect(p.writes).toEqual([`putBlob ${sha1("new")} 3`, `putCommit ${c.sha}`, `setHead main ${c.sha}`, `deleteCommit ${a.sha}`, `deleteBlob ${sha1("old")}`]);
    expect(await p.getBlob("demo", sha1("k"))).not.toBeNull();
    expect(await p.listCommits("demo")).toEqual([b.sha, c.sha]);
  });

  test("concurrent commits on the same head: one wins", async () => {
    const s = new MemoryStore(null, new Recording());
    await s.createRepo("demo", { branch: "main" });
    const results = await Promise.all([1, 2, 3].map((i) => put(s, null, [{ path: "a.md", content: String(i) }])));
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(results.filter((r) => !r.ok).length).toBe(2);
  });
});

describe("RoutedStore", () => {
  test("routed repos go to their store, everything else to the base", async () => {
    const root = mkdtempSync(join(process.env.DATA_DIR!, "routed-"));
    const base = new LocalGitStore(root);
    const mem = new MemoryStore();
    const store = new RoutedStore(base, new Map([["demo", mem]]));
    expect(store.kind).toBe("local");
    for (const id of ["demo", "notes-x"]) {
      await store.createRepo(id, { branch: "main" });
      expect((await store.commit({ repo: id, branch: "main", expectedHead: null, changes: [{ path: "a.md", content: id }], message: "m", author })).ok).toBe(true);
    }
    expect(await mem.readFile("demo", "a.md", "main")).toBe("demo");
    expect(await base.readFile("notes-x", "a.md", "main")).toBe("notes-x");
    expect(await mem.head("notes-x", "main")).toBeNull();
    expect(existsSync(join(root, "demo.git"))).toBe(false);
    expect(await store.readFile("demo", "a.md", "main")).toBe("demo");
    expect(store.storeFor("demo")).toBe(mem);
    expect(store.storeFor("anything")).toBe(base);
  });
});
