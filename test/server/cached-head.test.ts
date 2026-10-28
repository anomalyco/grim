// CachedHeadStore over a MemoryStore: cache hits skip the inner head(), its own commits move the cache, conflicts,
// invalidate() and fresh reads re-read, plus the GitStore contract passed through.
import { describe, expect, test } from "bun:test";

const { CachedHeadStore } = await import("../../src/server/store/cached-head.ts");
const { MemoryStore } = await import("../../src/server/store/memory.ts");
const { FileTooLargeError } = await import("../../src/server/store/types.ts");
type GitStore = import("../../src/server/store/types.ts").GitStore;

const author = { name: "Ann", email: "ann@example.com" };
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);

/** A MemoryStore that counts head() calls. */
class Counting extends MemoryStore {
  heads = 0;
  override async head(repo: string, branch: string) {
    this.heads++;
    return super.head(repo, branch);
  }
}

async function setup(opts?: ConstructorParameters<typeof CachedHeadStore>[1]) {
  const inner = new Counting();
  const store = new CachedHeadStore(inner, opts);
  await store.createRepo("r", { branch: "main" });
  const commit = (expectedHead: string | null, path = "a.md", content = "x", s: GitStore = store) =>
    s.commit({ repo: "r", branch: "main", expectedHead, changes: [{ path, content }], message: "m", author });
  return { inner, store, commit };
}
const shaOf = (o: unknown) => (o as { sha: string }).sha;

describe("CachedHeadStore", () => {
  test("cache hits don't call the inner head()", async () => {
    const { inner, store, commit } = await setup();
    expect(await store.head("r", "main")).toBeNull();
    expect(inner.heads).toBe(1);
    expect(await store.head("r", "main")).toBeNull();
    const a = shaOf(await commit(null));
    for (let i = 0; i < 5; i++) expect(await store.head("r", "main")).toBe(a);
    expect(inner.heads).toBe(1);
    // per branch
    expect(await store.head("r", "other")).toBeNull();
    expect(inner.heads).toBe(2);
  });

  test("concurrent misses share one inner read", async () => {
    const { inner, store } = await setup();
    const all = await Promise.all([store.head("r", "main"), store.head("r", "main"), store.head("r", "main")]);
    expect(all).toEqual([null, null, null]);
    expect(inner.heads).toBe(1);
  });

  test("commit and writeBlob update the cache", async () => {
    const { inner, store, commit } = await setup();
    await store.head("r", "main");
    const a = shaOf(await commit(null));
    expect(await store.head("r", "main")).toBe(a);
    const b = shaOf(await store.writeBlob({ repo: "r", branch: "main", expectedHead: a, path: "p.png", bytes: PNG, message: "m", author }));
    expect(await store.head("r", "main")).toBe(b);
    expect(inner.heads).toBe(1);
  });

  test("a conflict drops the cached head", async () => {
    const { inner, store, commit } = await setup();
    const a = shaOf(await commit(null));
    // someone else commits behind the cache's back
    const b = shaOf(await commit(a, "b.md", "y", inner));
    expect(await store.head("r", "main")).toBe(a); // stale, as expected
    expect(await commit(a, "c.md")).toEqual({ ok: false, reason: "conflict" });
    const before = inner.heads;
    expect(await store.head("r", "main")).toBe(b);
    expect(inner.heads).toBe(before + 1);
    expect(await store.head("r", "main")).toBe(b);
    expect(inner.heads).toBe(before + 1);
  });

  test("invalidate(repo) and fresh reads", async () => {
    const { inner, store, commit } = await setup();
    const a = shaOf(await commit(null));
    const b = shaOf(await commit(a, "b.md", "y", inner));
    expect(await store.head("r", "main")).toBe(a);
    store.invalidate("r");
    expect(await store.head("r", "main")).toBe(b);
    const c = shaOf(await commit(b, "c.md", "z", inner));
    expect(await store.head("r", "main")).toBe(b);
    const before = inner.heads;
    // fresh bypasses the cache and refreshes it
    expect(await store.head("r", "main", { fresh: true })).toBe(c);
    expect(await store.head("r", "main", { fresh: true })).toBe(c);
    expect(inner.heads).toBe(before + 2);
    expect(await store.head("r", "main")).toBe(c);
    expect(inner.heads).toBe(before + 2);
  });

  test("a read that started before a commit doesn't overwrite it", async () => {
    const { inner, store, commit } = await setup();
    const orig = inner.head.bind(inner);
    inner.head = async (repo, branch) => {
      const sha = await orig(repo, branch);
      await Bun.sleep(20);
      return sha;
    };
    const slow = store.head("r", "main"); // reads null, answers after the commit
    const a = shaOf(await commit(null));
    expect(await slow).toBeNull();
    expect(await store.head("r", "main")).toBe(a);
  });

  test("createRepo and deleteRepo invalidate", async () => {
    const { inner, store, commit } = await setup();
    shaOf(await commit(null));
    await store.deleteRepo("r");
    await store.createRepo("r", { branch: "main" });
    const before = inner.heads;
    expect(await store.head("r", "main")).toBeNull();
    expect(inner.heads).toBe(before + 1);
  });

  test("onHeadChange reports changes once", async () => {
    const seen: [string, string, string | null][] = [];
    const { inner, store, commit } = await setup({ onHeadChange: (repo, branch, sha) => void seen.push([repo, branch, sha]) });
    await store.head("r", "main");
    const a = shaOf(await commit(null));
    store.invalidate("r");
    await store.head("r", "main"); // unchanged: not reported again
    const b = shaOf(await commit(a, "b.md", "y", inner));
    await store.head("r", "main", { fresh: true });
    expect(seen).toEqual([["r", "main", null], ["r", "main", a], ["r", "main", b]]);
  });

  test("a throwing onHeadChange doesn't break commits", async () => {
    const { store, commit } = await setup({
      onHeadChange: () => {
        throw new Error("db down");
      },
    });
    const a = shaOf(await commit(null));
    expect(await store.head("r", "main")).toBe(a);
    const async = await setup({ onHeadChange: () => Promise.reject(new Error("db down")) });
    expect((await async.commit(null)).ok).toBe(true);
  });

  test("maxAgeMs re-reads old heads", async () => {
    let t = 0;
    const { inner, store } = await setup({ maxAgeMs: 1000, now: () => t });
    await store.head("r", "main");
    t = 999;
    await store.head("r", "main");
    expect(inner.heads).toBe(1);
    t = 1000;
    await store.head("r", "main");
    expect(inner.heads).toBe(2);
  });

  test("head() errors aren't cached", async () => {
    const { inner, store } = await setup();
    let fail = true;
    const orig = inner.head.bind(inner);
    inner.head = async (repo, branch) => {
      if (fail) throw new Error("busy");
      return orig(repo, branch);
    };
    await expect(store.head("r", "main")).rejects.toThrow("busy");
    fail = false;
    expect(await store.head("r", "main")).toBeNull();
  });

  test("the GitStore contract passes through", async () => {
    const { store, commit } = await setup();
    expect(store.kind).toBe("memory");
    const a = shaOf(await store.commit({ repo: "r", branch: "main", expectedHead: null, changes: [{ path: "a.md", content: "keep\nold\n" }, { path: "dir/b.md", content: "Hello\n" }], message: "Create a.md", author }));
    expect(await commit(null)).toEqual({ ok: false, reason: "conflict" });
    const b = shaOf(await store.commit({ repo: "r", branch: "main", expectedHead: a, changes: [{ path: "a.md", content: "keep\nnew\n" }, { path: "dir/b.md", delete: true }], message: "Update a.md", author }));
    expect(await commit(a)).toEqual({ ok: false, reason: "conflict" });
    expect(await store.readFile("r", "a.md", "main")).toBe("keep\nnew\n");
    expect(await store.readFile("r", "a.md", a.slice(0, 7))).toBe("keep\nold\n");
    expect(await store.listFiles("r", a)).toEqual(["a.md", "dir/b.md"]);
    expect(await store.listFilesWithMetadata("r", "main")).toEqual([{ path: "a.md", size: 9 }]);
    expect((await store.history("r", "main", undefined, 10)).map((h) => [h.sha, h.message])).toEqual([[b, "Update a.md"], [a, "Create a.md"]]);
    expect(await store.diff("r", b, "a.md")).toContain("+new");
    expect((await store.search("r", a, "hello", 10)).hits).toEqual([{ path: "dir/b.md", line: 1, text: "Hello" }]);
    const w = shaOf(await store.writeBlob({ repo: "r", branch: "main", expectedHead: b, path: "images/p.png", bytes: PNG, message: "m", author }));
    expect(await store.head("r", "main")).toBe(w);
    expect([...(await store.readBlob("r", "images/p.png", "main", 1000))!]).toEqual([...PNG]);
    await expect(store.readBlob("r", "images/p.png", "main", 4)).rejects.toBeInstanceOf(FileTooLargeError);
    await store.pullUpstream("r", "main"); // MemoryStore has none: a no-op
    expect(await store.head("r", "main")).toBe(w);
  });
});
