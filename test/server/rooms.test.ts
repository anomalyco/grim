import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

// One directory of our own inside the preload's DATA_DIR (shared by every file in the test process).
const dir = mkdtempSync(join(process.env.DATA_DIR!, "rooms-"));
process.env.QUIET_MS = "50";

const { LocalGitStore } = await import("../../src/server/store/localgit.ts");
const { RoomManager } = await import("../../src/server/rooms.ts");
const { diffText, applySplices } = await import("../../src/server/textdiff.ts");

const store = new LocalGitStore(join(dir, "git"));
const alice = { id: "u1", name: "Alice", email: "alice@example.com", kind: "human" as const, color: "#f00" };
const bot = { id: "a1", name: "Bot", email: "bot@example.com", kind: "agent" as const, color: "#0f0" };

async function seed(repo: string, files: Record<string, string>) {
  await store.createRepo(repo, { branch: "main" });
  const head = await store.head(repo, "main");
  const r = await store.commit({
    repo,
    branch: "main",
    expectedHead: head,
    changes: Object.entries(files).map(([path, content]) => ({ path, content })),
    message: "seed",
    author: alice,
  });
  if (!r.ok) throw new Error("seed failed");
  return r.sha;
}

describe("textdiff", () => {
  test("round trips", () => {
    const cases = [
      ["", "abc"],
      ["abc", ""],
      ["a\nb\nc\n", "a\nB\nc\nd\n"],
      ["one\ntwo\nthree", "zero\none\nthree\nfour"],
      ["same", "same"],
      ["x\ny\nz\n", "y\nx\nz\n"],
    ];
    for (const [a, b] of cases) expect(applySplices(a!, diffText(a!, b!))).toBe(b!);
  });
  test("random", () => {
    const alphabet = ["a", "b", "\n", "c"];
    for (let i = 0; i < 300; i++) {
      const rnd = (n: number) => Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
      const a = rnd(Math.floor(Math.random() * 30));
      const b = rnd(Math.floor(Math.random() * 30));
      expect(applySplices(a, diffText(a, b))).toBe(b);
    }
  });
});

describe("rooms", () => {
  let rooms: InstanceType<typeof RoomManager>;
  beforeAll(() => {
    rooms = new RoomManager(store);
  });

  test("edit then flush commits to main", async () => {
    await seed("r1", { "a.md": "hello\n" });
    const room = await rooms.get("r1", "a.md", "main");
    room.agentEdit(bot, (t) => {
      t.insert(5, " world");
    });
    expect(room.dirty).toBe(true);
    await room.flush();
    expect(room.dirty).toBe(false);
    const head = await store.head("r1", "main");
    expect(await store.readFile("r1", "a.md", head!)).toBe("hello world\n");
    const hist = await store.history("r1", "main", "a.md", 5);
    expect(hist[0]!.authorName).toBe("Bot");
    expect(hist[0]!.message).toBe("Update a.md");
  });

  test("outside push is merged into live text with local edits kept", async () => {
    await seed("r2", { "b.md": "line one\nline two\nline three\n" });
    const room = await rooms.get("r2", "b.md", "main");
    // Local unsaved edit at the top.
    room.agentEdit(bot, (t) => {
      t.insert(0, "LOCAL ");
    });
    // Someone pushes a change to the bottom line.
    const head = await store.head("r2", "main");
    const r = await store.commit({
      repo: "r2",
      branch: "main",
      expectedHead: head,
      changes: [{ path: "b.md", content: "line one\nline two\nline three changed\n" }],
      message: "outside",
      author: alice,
    });
    expect(r.ok).toBe(true);
    await room.checkRemote();
    expect(room.text.toString()).toBe("LOCAL line one\nline two\nline three changed\n");
    await room.flush();
    const h2 = await store.head("r2", "main");
    expect(await store.readFile("r2", "b.md", h2!)).toBe("LOCAL line one\nline two\nline three changed\n");
    // A second outside change after our commit also merges.
    await store.commit({ repo: "r2", branch: "main", expectedHead: h2, changes: [{ path: "b.md", content: "LOCAL line one\nline two\nline three changed\nend\n" }], message: "o2", author: alice });
    room.agentEdit(bot, (t) => {
      t.insert(t.length - 1, "!");
    });
    await room.flush();
    expect(room.text.toString()).toBe("LOCAL line one\nline two\nline three changed!\nend\n");
  });

  test("flush retries when the branch moved because of another file", async () => {
    await seed("r3", { "c.md": "c\n", "d.md": "d\n" });
    const room = await rooms.get("r3", "c.md", "main");
    room.agentEdit(bot, (t) => {
      t.insert(1, "c");
    });
    const head = await store.head("r3", "main");
    await store.commit({ repo: "r3", branch: "main", expectedHead: head, changes: [{ path: "d.md", content: "dd\n" }], message: "other", author: alice });
    await room.flush();
    const h = await store.head("r3", "main");
    expect(await store.readFile("r3", "c.md", h!)).toBe("cc\n");
    expect(await store.readFile("r3", "d.md", h!)).toBe("dd\n");
  });

  test("new file is created on first flush", async () => {
    await seed("r4", { "x.md": "x\n" });
    const room = await rooms.get("r4", "new/note.md", "main", "# New\n");
    await room.flush();
    const h = await store.head("r4", "main");
    expect(await store.readFile("r4", "new/note.md", h!)).toBe("# New\n");
    expect((await store.history("r4", "main", "new/note.md", 1))[0]!.message).toBe("Create new/note.md");
  });

  test("crash recovery restores unsaved edits", async () => {
    await seed("r5", { "e.md": "base\n" });
    const room = await rooms.get("r5", "e.md", "main");
    room.agentEdit(bot, (t) => {
      t.insert(0, "unsaved ");
    });
    room.destroy(false); // simulate a crash: the log is kept
    const fresh = new RoomManager(store);
    const again = await fresh.get("r5", "e.md", "main");
    expect(again.text.toString()).toBe("unsaved base\n");
    expect(again.dirty).toBe(true);
    await again.flush();
    const h = await store.head("r5", "main");
    expect(await store.readFile("r5", "e.md", h!)).toBe("unsaved base\n");
  });
});

const { RepoService, cleanPath } = await import("../../src/server/repos.ts");
const { db } = await import("../../src/server/db.ts");
const { agentClientId, MSG_AWARENESS } = await import("../../src/server/rooms.ts");
const encoding = await import("lib0/encoding");

async function push(repo: string, files: Record<string, string>) {
  const head = await store.head(repo, "main");
  const r = await store.commit({ repo, branch: "main", expectedHead: head, changes: Object.entries(files).map(([path, content]) => ({ path, content })), message: "outside", author: alice });
  if (!r.ok) throw new Error("push failed");
  return r.sha;
}

async function fileAtHead(repo: string, path: string) {
  return store.readFile(repo, path, (await store.head(repo, "main"))!);
}

function fakeConn(user: typeof alice, readOnly = false) {
  const sent: Uint8Array[] = [];
  return { user, readOnly, awarenessIds: new Set<number>(), sent, send: (m: Uint8Array) => void sent.push(m), close() {} };
}

function awarenessMsg(entries: Array<[number, number, unknown]>) {
  const u = encoding.createEncoder();
  encoding.writeVarUint(u, entries.length);
  for (const [id, clock, state] of entries) {
    encoding.writeVarUint(u, id);
    encoding.writeVarUint(u, clock);
    encoding.writeVarString(u, JSON.stringify(state));
  }
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_AWARENESS);
  encoding.writeVarUint8Array(enc, encoding.toUint8Array(u));
  return encoding.toUint8Array(enc);
}

const splitsPair = (s: string, i: number) => i > 0 && i < s.length && /[\ud800-\udbff]/.test(s[i - 1]!) && /[\udc00-\udfff]/.test(s[i]!);

describe("textdiff details", () => {
  test("never splits surrogate pairs", () => {
    const alphabet = ["😀", "😃", "a", "\n", "🎉"];
    const rnd = (n: number) => Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
    for (let i = 0; i < 300; i++) {
      const a = rnd(Math.floor(Math.random() * 12));
      const b = rnd(Math.floor(Math.random() * 12));
      const splices = diffText(a, b);
      expect(applySplices(a, splices)).toBe(b);
      for (const s of splices) {
        expect(splitsPair(a, s.pos)).toBe(false);
        expect(splitsPair(a, s.pos + s.del)).toBe(false);
        expect(/^[\udc00-\udfff]|[\ud800-\udbff]$/.test(s.ins)).toBe(false);
      }
    }
    expect(diffText("a😀b", "a😃b")).toEqual([{ pos: 1, del: 2, ins: "😃" }]);
  });

  test("long files with a small change diff quickly", () => {
    const a = Array.from({ length: 50_000 }, (_, i) => `line ${i}\n`).join("");
    const b = a.replace("line 25000\n", "line 25000!\n");
    const t = performance.now();
    const splices = diffText(a, b);
    expect(performance.now() - t).toBeLessThan(500);
    expect(splices.length).toBe(1);
    expect(applySplices(a, splices)).toBe(b);
  });
});

describe("rooms: merging and saving", () => {
  let rooms: InstanceType<typeof RoomManager>;
  beforeAll(() => {
    rooms = new RoomManager(store);
  });

  test("emoji edits merge through absorb without broken characters", async () => {
    await seed("m1", { "e.md": "smile 😀 here\n" });
    const room = await rooms.get("m1", "e.md", "main");
    room.agentEdit(bot, (t) => {
      t.insert(0, "X ");
    });
    await push("m1", { "e.md": "smile 😃 here 🎉\n" });
    await room.checkRemote();
    expect(room.text.toString()).toBe("X smile 😃 here 🎉\n");
    await room.flush();
    expect(await fileAtHead("m1", "e.md")).toBe("X smile 😃 here 🎉\n");
  });

  test("delete and retype the same text, then an outside push merges", async () => {
    await seed("m2", { "f.md": "hello world\n" });
    const room = await rooms.get("m2", "f.md", "main");
    room.agentEdit(bot, (t) => {
      t.delete(0, t.length);
      t.insert(0, "hello world\n");
    });
    await room.flush(); // nothing to commit, but the base must now point at the retyped text
    expect(room.dirty).toBe(false);
    await push("m2", { "f.md": "hello World\n" });
    await room.checkRemote();
    expect(room.text.toString()).toBe("hello World\n");
    expect(room.dirty).toBe(false);
  });

  test("a new file created empty is dirty and gets committed", async () => {
    await seed("m3", { "x.md": "x\n" });
    const room = await rooms.get("m3", "empty.md", "main", "");
    expect(room.dirty).toBe(true);
    await room.flush();
    expect(room.dirty).toBe(false);
    expect(await fileAtHead("m3", "empty.md")).toBe("");
  });

  test("the crash log is compacted to one row on save", async () => {
    await seed("m4", { "g.md": "g\n" });
    const room = await rooms.get("m4", "g.md", "main");
    for (let i = 0; i < 5; i++) room.agentEdit(bot, (t) => void t.insert(0, `${i}`));
    await room.flush();
    const { n } = db.query("SELECT COUNT(*) AS n FROM room_updates WHERE room = ?").get(room.key) as { n: number };
    expect(n).toBe(1);
    // ...and it still reproduces the document.
    room.destroy(false);
    const again = await new RoomManager(store).get("m4", "g.md", "main");
    expect(again.text.toString()).toBe("43210g\n");
    expect(again.dirty).toBe(false);
    again.destroy(true);
  });

  test("an outside push leaving local edits gets committed without another edit", async () => {
    await seed("m5", { "h.md": "one\ntwo\n" });
    const room = await rooms.get("m5", "h.md", "main");
    room.agentEdit(bot, (t) => void t.insert(0, "zero\n"));
    await push("m5", { "h.md": "one\ntwo\nthree\n" });
    await room.checkRemote();
    expect(room.dirty).toBe(true);
    await Bun.sleep(300);
    expect(room.dirty).toBe(false);
    expect(await fileAtHead("m5", "h.md")).toBe("zero\none\ntwo\nthree\n");
  });

  test("outside push touching two open files: both absorb even if one flushes first", async () => {
    await seed("m6", { "a.md": "a\n", "b.md": "b\n" });
    db.query("INSERT OR REPLACE INTO repos (id, title, kind, branch, status, created_at) VALUES ('m6', 'm6', 'notes', 'main', 'ready', 0)").run();
    const repos = new RepoService(store, rooms);
    const ra = await rooms.get("m6", "a.md", "main");
    const rb = await rooms.get("m6", "b.md", "main");
    await repos.onPush("m6");
    ra.agentEdit(bot, (t) => void t.insert(0, "local "));
    await push("m6", { "a.md": "a2\n", "b.md": "b2\n" });
    await ra.flush(); // absorbs the push for a.md and commits on top of it
    expect(await fileAtHead("m6", "a.md")).toBe("local a2\n");
    await repos.onPush("m6");
    expect(rb.text.toString()).toBe("b2\n");
    expect(rb.dirty).toBe(false);
  });

  test("flushAll commits and closes rooms; a closed room ignores late calls", async () => {
    const mgr = new RoomManager(store);
    await seed("m7", { "k.md": "k\n" });
    const room = await mgr.get("m7", "k.md", "main");
    const conn = fakeConn(alice);
    room.addConn(conn);
    room.agentEdit(bot, (t) => void t.insert(0, "k"));
    await mgr.flushAll();
    expect(room.closed).toBe(true);
    expect(mgr.list().length).toBe(0);
    expect(await fileAtHead("m7", "k.md")).toBe("kk\n");
    room.removeConn(conn);
    expect(db.query("SELECT COUNT(*) AS n FROM room_meta WHERE room = ?").get(room.key)).toEqual({ n: 0 });
  });
});

describe("rooms: awareness", () => {
  let rooms: InstanceType<typeof RoomManager>;
  beforeAll(async () => {
    rooms = new RoomManager(store);
    await seed("w1", { "p.md": "presence\n" });
  });

  test("connections can only set their own awareness, under their own name", async () => {
    const room = await rooms.get("w1", "p.md", "main");
    const bob = { ...alice, id: "u2", name: "Bob" };
    const a = fakeConn(alice);
    const b = fakeConn(bob, true);
    room.addConn(a);
    room.addConn(b);
    room.onMessage(a, awarenessMsg([[101, 1, { user: { id: "u2", name: "Bob", color: "#000", kind: "human" }, cursor: null }]]));
    expect((room.awareness.getStates().get(101) as { user: { id: string } }).user.id).toBe("u1");
    // Bob may not overwrite or remove Alice's client, nor pose as an agent.
    room.onMessage(b, awarenessMsg([[101, 2, { user: { id: "u2" }, cursor: null }]]));
    room.onMessage(b, awarenessMsg([[101, 3, null]]));
    room.onMessage(b, awarenessMsg([[agentClientId("a1"), 1, { cursor: null }]]));
    expect((room.awareness.getStates().get(101) as { user: { id: string } }).user.id).toBe("u1");
    expect(room.awareness.getStates().has(agentClientId("a1"))).toBe(false);
    // Read-only Bob may publish his own cursor, but only for a couple of client ids.
    room.onMessage(b, awarenessMsg([[201, 1, { cursor: null }], [202, 1, { cursor: null }], [203, 1, { cursor: null }]]));
    expect((room.awareness.getStates().get(201) as { user: { name: string } }).user.name).toBe("Bob");
    expect(room.awareness.getStates().has(202)).toBe(true);
    expect(room.awareness.getStates().has(203)).toBe(false);
    room.removeConn(b);
    expect(room.awareness.getStates().has(201)).toBe(false);
    expect(room.awareness.getStates().has(101)).toBe(true);
    room.removeConn(a);
  });

  test("agent cursors live in the room's awareness and expire", async () => {
    const room = await rooms.get("w1", "p.md", "main");
    const a = fakeConn(alice);
    room.addConn(a);
    const before = a.sent.length;
    room.agentEdit(bot, (t) => {
      t.insert(0, "hi ");
      return 3;
    });
    const id = agentClientId(bot.id);
    expect((room.awareness.getStates().get(id) as { user: { name: string } }).user.name).toBe("Bot");
    expect(a.sent.slice(before).some((m) => m[0] === MSG_AWARENESS)).toBe(true);
    expect(room.participants().some((p) => p.id === bot.id)).toBe(true);
    // Pretend the last edit was 31 s ago; awareness's outdated check (every 3 s) removes it.
    room.awareness.meta.get(id)!.lastUpdated = Date.now() - 31_000;
    await Bun.sleep(3500);
    expect(room.awareness.getStates().has(id)).toBe(false);
    room.removeConn(a);
  }, 8000);
});

describe("stores and paths", () => {
  test("local git rejects option-like refs and lists unicode paths verbatim", async () => {
    await seed("s1", { "ünï code.md": "needle\n" });
    await expect(store.readFile("s1", "x.md", "--output=/tmp/x")).rejects.toThrow();
    const head = (await store.head("s1", "main"))!;
    expect(await store.search("s1", head, "needle", 10)).toEqual({ hits: [{ path: "ünï code.md", line: 1, text: "needle" }] });
    expect(await store.search("s1", head, " ", 10)).toEqual({ hits: [] });
  });

  test("cleanPath rejects control characters and .git in any case", () => {
    expect(cleanPath("a\u0000b")).toBeNull();
    expect(cleanPath("x/.GIT/config")).toBeNull();
    expect(cleanPath("notes/today")).toBe("notes/today.md");
  });

  test("code storage: a lost compare-and-swap is a conflict", async () => {
    const { CodeStorageStore } = await import("../../src/server/store/codestorage.ts");
    const { RefUpdateError } = await import("@pierre/storage");
    const cs = new CodeStorageStore({ org: "test", key: "test" });
    const builder = {
      addFileFromString: () => builder,
      deletePath: () => builder,
      send: async () => {
        throw new RefUpdateError("expected head mismatch", { status: "precondition_failed" });
      },
    };
    (cs as unknown as { repo: () => unknown }).repo = () => ({ createCommit: () => builder });
    const res = await cs.commit({ repo: "r", branch: "main", expectedHead: "abc", changes: [{ path: "a.md", content: "a" }], message: "m", author: alice });
    expect(res).toEqual({ ok: false, reason: "conflict" });
  });
});

describe("code storage readBlob", () => {
  async function store(file: () => Promise<Response>, entries: Array<{ path: string; type: string; mode: string }> = []) {
    const { CodeStorageStore } = await import("../../src/server/store/codestorage.ts");
    const cs = new CodeStorageStore({ org: "test", key: "test" });
    (cs as unknown as { repo: () => unknown }).repo = () => ({
      getFileStream: file,
      listFiles: async () => ({ paths: [], ref: "main", entries, hasMore: false }),
    });
    return cs;
  }
  const apiError = async (status: number) => {
    const { ApiError } = await import("@pierre/storage");
    return new ApiError({ message: `status ${status}`, status, statusText: "", method: "GET", url: "x" });
  };
  const body = (chunks: number[], headers: Record<string, string> = {}) =>
    new Response(
      new ReadableStream({
        start(c) {
          for (const n of chunks) c.enqueue(new Uint8Array(n).fill(7));
          c.close();
        },
      }),
      { headers },
    );

  test("reads chunks into one buffer, with or without content-length, and enforces the cap while reading", async () => {
    expect(await (await store(async () => body([3, 4], { "content-length": "7" }))).readBlob("r", "a.png", "main", 10)).toEqual(new Uint8Array(7).fill(7));
    expect(await (await store(async () => body([3, 4, 2]))).readBlob("r", "a.png", "main", 10)).toEqual(new Uint8Array(9).fill(7));
    expect(await (await store(async () => body([]))).readBlob("r", "a.png", "main", 10)).toEqual(new Uint8Array(0));
    await expect((await store(async () => body([6, 6]))).readBlob("r", "a.png", "main", 10)).rejects.toThrow("too large");
    await expect((await store(async () => body([1], { "content-length": "11" }))).readBlob("r", "a.png", "main", 10)).rejects.toThrow("too large");
    // a server that sends more than its content-length still can't pass the cap
    await expect((await store(async () => body([5, 6], { "content-length": "5" }))).readBlob("r", "a.png", "main", 10)).rejects.toThrow("too large");
  });

  test("symlinks and submodules are null, like missing files; outages are StoreUnavailableError", async () => {
    const { StoreUnavailableError } = await import("../../src/server/store/types.ts");
    const link = [{ path: "img/a.png", type: "blob", mode: "120000" }];
    expect(await (await store(async () => body([3]), link)).readBlob("r", "img/a.png", "main", 10)).toBeNull();
    expect(await (await store(async () => body([3]), [{ path: "a.png", type: "commit", mode: "160000" }])).readBlob("r", "img/a.png", "main", 10)).toBeNull();
    expect(await (await store(async () => body([3]), [{ path: "a.png", type: "blob", mode: "100755" }])).readBlob("r", "img/a.png", "main", 10)).toEqual(new Uint8Array(3).fill(7));
    for (const status of [400, 404]) {
      const e = await apiError(status);
      expect(await (await store(async () => Promise.reject(e))).readBlob("r", "a.png", "main", 10)).toBeNull();
    }
    const e500 = await apiError(502);
    await expect((await store(async () => Promise.reject(e500))).readBlob("r", "a.png", "main", 10)).rejects.toBeInstanceOf(StoreUnavailableError);
    await expect((await store(async () => Promise.reject(new TypeError("fetch failed")))).readBlob("r", "a.png", "main", 10)).rejects.toBeInstanceOf(StoreUnavailableError);
  });
});

describe("many rooms in one repo", () => {
  test("concurrent flushes in the same repo all commit (no self-conflicts)", async () => {
    await seed("many", { "seed.md": "x\n" });
    const mgr = new RoomManager(store);
    const rooms = await Promise.all(Array.from({ length: 12 }, (_, i) => mgr.get("many", `n${i}.md`, "main", "")));
    rooms.forEach((r, i) => r.agentEdit(bot, (t) => void t.insert(0, `note ${i}\n`)));
    await Promise.all(rooms.map((r) => r.flush()));
    const head = await store.head("many", "main");
    for (let i = 0; i < 12; i++) expect(await store.readFile("many", `n${i}.md`, head!)).toBe(`note ${i}\n`);
    for (const r of rooms) r.destroy(true);
  });
});
