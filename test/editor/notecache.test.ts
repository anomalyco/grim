// The in-memory cache of recently seen note text (client notecache.ts): what a note shows the moment it's opened.
import { expect, test } from "bun:test";
import { NoteCache } from "../../src/client/notecache.ts";

function setup(max = 3, maxChars = 100) {
  let now = 0;
  const calls: string[] = [];
  const pending = new Map<string, { resolve: (t: string) => void; reject: (e: unknown) => void }>();
  const cache = new NoteCache({
    max,
    maxChars,
    now: () => now,
    fetch: (repo, path) =>
      new Promise((resolve, reject) => {
        calls.push(`${repo}/${path}`);
        pending.set(`${repo}/${path}`, { resolve, reject });
      }),
  });
  return { cache, calls, pending, tick: (ms: number) => (now += ms) };
}

test("keeps the most recently used notes, by count and by size", () => {
  const { cache } = setup(3, 100);
  cache.put("r", "a.md", "A");
  cache.put("r", "b.md", "B");
  cache.put("r", "c.md", "C");
  expect(cache.get("r", "a.md")?.text).toBe("A"); // a is now the most recent
  cache.put("r", "d.md", "D");
  expect(cache.get("r", "b.md")).toBeNull();
  expect(cache.get("r", "a.md")?.text).toBe("A");
  cache.put("r", "big.md", "x".repeat(99));
  expect(cache.get("r", "c.md")).toBeNull();
  expect(cache.get("r", "d.md")).toBeNull();
  expect(cache.get("r", "big.md")?.text.length).toBe(99);
  // larger than the whole cache: not kept (and nothing else is dropped for it)
  cache.put("r", "huge.md", "x".repeat(101));
  expect(cache.get("r", "huge.md")).toBeNull();
  expect(cache.get("r", "big.md")).not.toBeNull();
  // same path in another workspace is another note
  cache.put("s", "big.md", "S");
  expect(cache.get("s", "big.md")?.text).toBe("S");
});

test("prefetch: one request per note at a time, skipped while the copy is fresh, null on failure", async () => {
  const { cache, calls, pending, tick } = setup();
  const p1 = cache.prefetch("r", "a.md");
  const p2 = cache.prefetch("r", "a.md");
  expect(calls).toEqual(["r/a.md"]);
  pending.get("r/a.md")!.resolve("hello");
  expect(await p1).toBe("hello");
  expect(await p2).toBe("hello");
  expect(cache.get("r", "a.md")?.text).toBe("hello");
  tick(1000);
  expect(await cache.prefetch("r", "a.md", 5000)).toBe("hello");
  expect(calls.length).toBe(1);
  tick(5000);
  const p3 = cache.prefetch("r", "a.md", 5000);
  expect(calls.length).toBe(2);
  pending.get("r/a.md")!.reject(new Error("offline"));
  expect(await p3).toBeNull();
  expect(cache.get("r", "a.md")?.text).toBe("hello");
});

test("a copy stored while a prefetch was out (the note was open here) isn't overwritten by the older answer", async () => {
  const { cache, pending, tick } = setup();
  const p = cache.prefetch("r", "a.md");
  tick(10);
  cache.put("r", "a.md", "live text");
  pending.get("r/a.md")!.resolve("server text from before");
  expect(await p).toBe("live text");
  expect(cache.get("r", "a.md")?.text).toBe("live text");
});
