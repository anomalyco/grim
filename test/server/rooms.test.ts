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
    rooms = new RoomManager(store, { storage: bunRoomStorage(), db: bunDb() });
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
    const fresh = new RoomManager(store, { storage: bunRoomStorage(), db: bunDb() });
    const again = await fresh.get("r5", "e.md", "main");
    expect(again.text.toString()).toBe("unsaved base\n");
    expect(again.dirty).toBe(true);
    await again.flush();
    const h = await store.head("r5", "main");
    expect(await store.readFile("r5", "e.md", h!)).toBe("unsaved base\n");
  });
});

const { RepoService, cleanPath } = await import("../../src/server/repos.ts");
const { bunDb } = await import("../../src/server/bun/db-bun.ts");
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
    rooms = new RoomManager(store, { storage: bunRoomStorage(), db: bunDb() });
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
    const again = await new RoomManager(store, { storage: bunRoomStorage(), db: bunDb() }).get("m4", "g.md", "main");
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
    const repos = new RepoService(store, rooms, bunDb());
    const ra = await rooms.get("m6", "a.md", "main");
    const rb = await rooms.get("m6", "b.md", "main");
    await repos.host.get("m6").onPush((await repos.get("m6"))!);
    ra.agentEdit(bot, (t) => void t.insert(0, "local "));
    await push("m6", { "a.md": "a2\n", "b.md": "b2\n" });
    await ra.flush(); // absorbs the push for a.md and commits on top of it
    expect(await fileAtHead("m6", "a.md")).toBe("local a2\n");
    await repos.host.get("m6").onPush((await repos.get("m6"))!);
    expect(rb.text.toString()).toBe("b2\n");
    expect(rb.dirty).toBe(false);
    // m6 has a repos row in the shared database: leave no crash log for a later startServer to recover
    await ra.flush();
    ra.destroy(true);
    rb.destroy(true);
    db.query("DELETE FROM repos WHERE id = 'm6'").run();
  });

  test("flushAll commits and closes rooms; a closed room ignores late calls", async () => {
    const mgr = new RoomManager(store, { storage: bunRoomStorage(), db: bunDb() });
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
    rooms = new RoomManager(store, { storage: bunRoomStorage(), db: bunDb() });
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
    const mgr = new RoomManager(store, { storage: bunRoomStorage(), db: bunDb() });
    const rooms = await Promise.all(Array.from({ length: 12 }, (_, i) => mgr.get("many", `n${i}.md`, "main", "")));
    rooms.forEach((r, i) => r.agentEdit(bot, (t) => void t.insert(0, `note ${i}\n`)));
    await Promise.all(rooms.map((r) => r.flush()));
    const head = await store.head("many", "main");
    for (let i = 0; i < 12; i++) expect(await store.readFile("many", `n${i}.md`, head!)).toBe(`note ${i}\n`);
    for (const r of rooms) r.destroy(true);
  });
});

const { Database } = await import("bun:sqlite");
const { BunRoomStorage, bunRoomStorage } = await import("../../src/server/bun/room-storage-bun.ts");

/** A storage over its own database (the room tables as db.ts makes them, before rooms upgrade them), counting statements. */
function ownStorage() {
  const own = new Database(":memory:");
  own.exec(`CREATE TABLE room_meta (room TEXT PRIMARY KEY, generation TEXT NOT NULL, base_commit TEXT, base_content TEXT NOT NULL,
    base_snapshot BLOB NOT NULL, blame TEXT, blame_people TEXT);
    CREATE TABLE room_updates (seq INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, data BLOB NOT NULL, author INTEGER);
    CREATE INDEX room_updates_room ON room_updates(room, seq);`);
  const storage = new BunRoomStorage(own);
  const sql: string[] = [];
  const exec = storage.exec.bind(storage);
  storage.exec = <T,>(q: string, ...params: unknown[]) => (sql.push(q), exec<T>(q, ...params));
  return { storage, sql, own };
}

describe("rooms: RoomStorage seam", () => {

  test("blobs round-trip and overwrite", () => {
    const { storage } = ownStorage();
    expect(storage.getBlob("k")).toBeNull();
    storage.putBlob("k", new Uint8Array([1, 2, 3]));
    expect(storage.getBlob("k")).toEqual(new Uint8Array([1, 2, 3]));
    storage.putBlob("k", new Uint8Array([4]));
    expect(storage.getBlob("k")).toEqual(new Uint8Array([4]));
  });

  test("transaction returns its value and rolls back on throw", () => {
    const { storage } = ownStorage();
    expect(storage.transaction(() => 7)).toBe(7);
    expect(() =>
      storage.transaction(() => {
        storage.exec("INSERT INTO room_updates (room, data) VALUES (?, ?)", "x", new Uint8Array([1]));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(storage.exec("SELECT COUNT(*) AS n FROM room_updates")).toEqual([{ n: 0 }]);
  });

  test("rooms keep their crash log in the given storage: recovery, compaction and blame people", async () => {
    const { storage, sql } = ownStorage();
    await seed("s1", { "a.md": "a\n" });
    const room = await new RoomManager(store, { storage, db: bunDb() }).get("s1", "a.md", "main");
    room.agentEdit(bot, (t) => void t.insert(0, "1"));
    room.agentEdit(bot, (t) => void t.insert(0, "2"));
    expect(sql.some((q) => q.startsWith("INSERT INTO room_updates"))).toBe(true);
    expect(db.query("SELECT COUNT(*) AS n FROM room_meta WHERE room = ?").get(room.key)).toEqual({ n: 0 });
    room.destroy(false); // crash
    const people = storage.exec<{ blame_people: string }>("SELECT blame_people FROM room_meta WHERE room = ?", room.key)[0]!;
    expect(JSON.parse(people.blame_people).map((p: { id: string }) => p.id)).toEqual(["a1"]);

    // a restart: recover() finds the room in this storage and commits its edits
    const mgr = new RoomManager(store, { storage, db: bunDb() });
    await mgr.recover((repo) => (repo === "s1" ? "main" : undefined));
    const again = mgr.peek("s1", "a.md")!;
    expect(again.text.toString()).toBe("21a\n");
    const b = again.blame();
    expect(b.authors[b.lines[0]!]?.name).toBe("Bot");
    await again.flush();
    expect(await fileAtHead("s1", "a.md")).toBe("21a\n");
    expect(storage.exec("SELECT COUNT(*) AS n FROM room_updates WHERE room = ?", again.key)).toEqual([{ n: 1 }]);
    await mgr.flushAll();
    expect(storage.exec("SELECT COUNT(*) AS n FROM room_meta")).toEqual([{ n: 0 }]);
  });

  test("recover drops crash logs of workspaces that are gone", async () => {
    const { storage } = ownStorage();
    await seed("s2", { "b.md": "b\n" });
    const room = await new RoomManager(store, { storage, db: bunDb() }).get("s2", "b.md", "main");
    room.agentEdit(bot, (t) => void t.insert(0, "x"));
    room.destroy(false);
    await new RoomManager(store, { storage, db: bunDb() }).recover(() => undefined);
    expect(storage.exec("SELECT COUNT(*) AS n FROM room_meta")).toEqual([{ n: 0 }]);
    expect(storage.exec("SELECT COUNT(*) AS n FROM room_updates")).toEqual([{ n: 0 }]);
  });
});

const { Room, BATCH_MS, AWARENESS_TIMEOUT_MS } = await import("../../src/server/rooms.ts");
const { config } = await import("../../src/server/config.ts");
type AnyRoom = InstanceType<typeof Room>;

/** A store or Db that records (and refuses) every call. */
function spy<T>() {
  const calls: string[] = [];
  const obj = new Proxy(
    {},
    {
      get: (_t, k) => {
        if (k === "then") return undefined;
        calls.push(String(k));
        return () => {
          throw new Error(`${String(k)} called`);
        };
      },
    },
  ) as T;
  return { obj, calls };
}

/** Everything wake() restores, as plain data. */
function state(r: AnyRoom) {
  const p = r as unknown as { contributors: Map<string, unknown>; people: unknown[]; lineValues: number[]; originCommit: string | null };
  return {
    text: r.text.toString(),
    generation: r.generation,
    baseCommit: r.baseCommit,
    baseContent: r.baseContent,
    inBase: r.inBase,
    status: r.status(),
    contributors: [...p.contributors.values()],
    people: p.people,
    lineValues: p.lineValues,
    originCommit: p.originCommit,
    blame: r.blame(),
  };
}

async function until(fn: () => boolean, ms = 3000) {
  for (let t = 0; t < ms && !fn(); t += 20) await Bun.sleep(20);
  expect(fn()).toBe(true);
}

const blameLoaded = (r: AnyRoom) => (r as unknown as { originAuthors: unknown }).originAuthors !== null;

describe("rooms: open, wake and the batched crash log", () => {
  let quiet = config.quietMs;
  beforeAll(() => {
    // nothing commits by itself here: the crash log is what's tested
    quiet = config.quietMs;
    config.quietMs = 60_000;
  });
  const done = () => (config.quietMs = quiet);

  test("wake() restores what open() does after edits and a commit, with no store or Db calls", async () => {
    const { storage } = ownStorage();
    await seed("k1", { "a.md": "one\ntwo\n" });
    const room = await new RoomManager(store, { storage, db: bunDb() }).get("k1", "a.md", "main");
    await until(() => blameLoaded(room));
    room.agentEdit(bot, (t) => void t.insert(0, "bot\n"));
    await room.flush();
    expect(room.savedAt).not.toBeNull();
    room.agentEdit(alice, (t) => void t.insert(t.length, "alice\n"));
    room.agentEdit(bot, (t) => void t.insert(0, "x"));
    await Bun.sleep(BATCH_MS + 100);
    const expected = state(room);
    expect(expected.status.dirty).toBe(true);
    expect(expected.contributors.length).toBe(2);
    // a crash (the room is just left behind): a woken room gets everything from the storage alone
    const s = spy<ConstructorParameters<typeof Room>[3]>();
    const d = spy<ConstructorParameters<typeof Room>[5]>();
    const woke = new Room("k1", "a.md", "main", s.obj, storage, d.obj, () => {});
    expect(woke.wake()).toBe(true);
    expect(s.calls).toEqual([]);
    expect(d.calls).toEqual([]);
    expect(state(woke)).toEqual(expected);
    expect(s.calls).toEqual([]);
    // ...the same as open() from the crash log
    const opened = await new RoomManager(store, { storage, db: bunDb() }).get("k1", "a.md", "main");
    expect(state(opened)).toEqual(expected);
    // and it still commits what the crash left
    await opened.flush();
    expect(await fileAtHead("k1", "a.md")).toBe("xbot\none\ntwo\nalice\n");
    const [last] = await store.history("k1", "main", "a.md", 1);
    expect(last!.authorName).toBe("Alice");
    room.destroy(false);
    woke.destroy(false);
    opened.destroy(true);
  });

  test("catchUpLater: reopening from a crash log doesn't wait for the head check; what landed meanwhile arrives after", async () => {
    const { storage } = ownStorage();
    await seed("k9", { "a.md": "one\n" });
    const first = await new RoomManager(store, { storage, db: bunDb() }).get("k9", "a.md", "main");
    first.agentEdit(bot, (t) => void t.insert(0, "local "));
    first.destroy(false); // a crash: the log stays
    // someone else commits while the room is gone
    const head = await store.head("k9", "main");
    await store.commit({ repo: "k9", branch: "main", expectedHead: head, changes: [{ path: "a.md", content: "one\nremote\n" }], message: "m", author: alice });
    /** The store with head() held until released. */
    const held = () => {
      let release!: () => void;
      let asked!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const wasAsked = new Promise<void>((r) => (asked = r));
      const gated = new Proxy(store, {
        get: (t, p, r) => (p === "head" ? async (...a: [string, string]) => (asked(), await gate, t.head(...a)) : Reflect.get(t, p, r)),
      });
      return { gated, release, wasAsked };
    };
    // default (Bun): open waits for the check
    const a = held();
    let opened = false;
    const pa = new RoomManager(a.gated, { storage, db: bunDb() }).get("k9", "a.md", "main").then((r) => ((opened = true), r));
    await a.wasAsked;
    await Promise.resolve();
    expect(opened).toBe(false);
    a.release();
    const ra = await pa;
    expect(ra.text.toString()).toBe("local one\nremote\n");
    ra.destroy(false);
    // catchUpLater (Workers): open returns with the crash log's text, the remote change follows
    const { storage: s2 } = ownStorage();
    const second = await new RoomManager(store, { storage: s2, db: bunDb() }).get("k9", "a.md", "main");
    second.agentEdit(bot, (t) => void t.insert(0, "mine "));
    second.destroy(false);
    await store.commit({ repo: "k9", branch: "main", expectedHead: await store.head("k9", "main"), changes: [{ path: "a.md", content: "one\nremote\nmore\n" }], message: "m", author: alice });
    const b = held();
    const rb = await new RoomManager(b.gated, { storage: s2, db: bunDb(), room: { catchUpLater: true } }).get("k9", "a.md", "main");
    expect(rb.text.toString()).toBe("mine one\nremote\n");
    const changed = new Promise<void>((r) => rb.text.observe(() => r()));
    b.release();
    await changed;
    expect(rb.text.toString()).toBe("mine one\nremote\nmore\n");
    rb.destroy(true);
  });

  test("wake() without a crash log changes nothing", async () => {
    const { storage } = ownStorage();
    const room = new Room("k0", "none.md", "main", store, storage, bunDb(), () => {});
    const generation = room.generation;
    expect(room.wake()).toBe(false);
    expect(room.generation).toBe(generation);
    expect(room.text.toString()).toBe("");
    room.destroy(true);
  });

  test("a burst by one author is one crash-log row; another author's edit writes the batch first", async () => {
    const { storage } = ownStorage();
    await seed("k2", { "b.md": "b\n" });
    const room = await new RoomManager(store, { storage, db: bunDb() }).get("k2", "b.md", "main");
    const rows = () => storage.exec<{ author: number | null }>("SELECT author FROM room_updates WHERE room = ? ORDER BY seq", room.key).map((r) => r.author);
    expect(rows()).toEqual([null]);
    for (let i = 0; i < 5; i++) room.agentEdit(bot, (t) => void t.insert(0, "b"));
    expect(rows()).toEqual([null]);
    room.agentEdit(alice, (t) => void t.insert(t.length, "a\n"));
    expect(rows()).toEqual([null, 0]);
    await Bun.sleep(BATCH_MS + 100);
    expect(rows()).toEqual([null, 0, 1]);
    const b = room.blame();
    expect(b.authors[b.lines[0]!]?.name).toBe("Bot");
    expect(b.authors[b.lines[1]!]?.name).toBe("Alice");

    // a crash now loses nothing
    const after = new Room("k2", "b.md", "main", store, storage, bunDb(), () => {});
    expect(after.wake()).toBe(true);
    expect(after.text.toString()).toBe("bbbbbb\na\n");
    expect(after.blame()).toEqual(b);
    after.destroy(false);
    // edits younger than BATCH_MS are what a crash can lose
    room.agentEdit(bot, (t) => void t.insert(0, "z"));
    const early = new Room("k2", "b.md", "main", store, storage, bunDb(), () => {});
    expect(early.wake()).toBe(true);
    expect(early.text.toString()).toBe("bbbbbb\na\n");
    early.destroy(false);
    // ...and a save writes them first, then compacts
    await room.flush();
    expect(rows()).toEqual([null]);
    expect(await fileAtHead("k2", "b.md")).toBe("zbbbbbb\na\n");
    room.destroy(true);
  });

  test("closing, leaving and blame write the buffered updates", async () => {
    const { storage } = ownStorage();
    await seed("k3", { "c.md": "c\n" });
    const room = await new RoomManager(store, { storage, db: bunDb() }).get("k3", "c.md", "main");
    const n = () => storage.exec<{ n: number }>("SELECT COUNT(*) AS n FROM room_updates WHERE room = ?", room.key)[0]!.n;
    const conn = fakeConn(alice);
    room.addConn(conn);
    room.agentEdit(bot, (t) => void t.insert(0, "1"));
    room.removeConn(conn);
    expect(n()).toBe(2);
    room.agentEdit(bot, (t) => void t.insert(0, "2"));
    room.blame();
    expect(n()).toBe(3);
    room.agentEdit(bot, (t) => void t.insert(0, "3"));
    room.destroy(false);
    expect(n()).toBe(4);
    const again = new Room("k3", "c.md", "main", store, storage, bunDb(), () => {});
    expect(again.wake()).toBe(true);
    expect(again.text.toString()).toBe("321c\n");
    again.destroy(true);
  });

  test("old crash-log tables are upgraded in place and a log without state still recovers", async () => {
    const { storage, own } = ownStorage();
    await seed("k4", { "d.md": "d\n" });
    const room = await new RoomManager(store, { storage, db: bunDb() }).get("k4", "d.md", "main");
    room.agentEdit(bot, (t) => void t.insert(0, "x"));
    room.destroy(false);
    // the upgraded shape: (room, seq) primary key without rowid, a state column, no extra index
    expect(() => own.query("SELECT rowid FROM room_updates").all()).toThrow();
    expect(own.query("SELECT name FROM sqlite_master WHERE name = 'room_updates_room'").all()).toEqual([]);
    const meta = own.query("SELECT * FROM room_meta").get() as Record<string, unknown>;
    expect(JSON.parse(meta.state as string).inBase).toBe(true);
    const updates = own.query("SELECT seq, data, author FROM room_updates ORDER BY seq").all() as Array<{ seq: number; data: Uint8Array; author: number | null }>;

    // the same log, written by an older server into the old tables (global seq, no state)
    const old = ownStorage();
    const { state: _state, ...legacy } = meta;
    old.own.query(`INSERT INTO room_meta (${Object.keys(legacy).join(", ")}) VALUES (${Object.keys(legacy).map(() => "?").join(", ")})`).run(...(Object.values(legacy) as never[]));
    old.own.query("INSERT INTO room_updates (seq, room, data, author) VALUES (7, 'other', x'00', NULL)").run();
    for (const [i, u] of updates.entries()) old.own.query("INSERT INTO room_updates (seq, room, data, author) VALUES (?, ?, ?, ?)").run(10 + i, room.key, u.data, u.author);
    const again = await new RoomManager(store, { storage: old.storage, db: bunDb() }).get("k4", "d.md", "main");
    expect(again.text.toString()).toBe("xd\n");
    expect(again.inBase).toBe(true);
    expect(again.dirty).toBe(true);
    expect(old.own.query("SELECT room, seq FROM room_updates ORDER BY room, seq").all()).toEqual([
      { room: "k4\u0000d.md", seq: 10 },
      { room: "k4\u0000d.md", seq: 11 },
      { room: "other", seq: 7 },
    ]);
    // new rows continue after the old ones
    again.agentEdit(bot, (t) => void t.insert(0, "y"));
    again.blame();
    expect((old.own.query("SELECT MAX(seq) AS s FROM room_updates WHERE room = ?").get(again.key) as { s: number }).s).toBe(12);
    await again.flush();
    expect(await fileAtHead("k4", "d.md")).toBe("yxd\n");
    again.destroy(true);
    done();
  });
});

describe("rooms: timers", () => {
  test("awareness runs no interval; sweepAwareness removes outdated states", async () => {
    const { storage } = ownStorage();
    await seed("t1", { "a.md": "a\n" });
    const room = new Room("t1", "a.md", "main", store, storage, bunDb(), () => {}, false, { sweepTimer: false, closeTimer: false });
    await room.open(null);
    expect((room.awareness as unknown as { _checkInterval: unknown })._checkInterval).toBeUndefined();
    room.agentEdit(bot, (t) => {
      t.insert(0, "hi ");
      return 3;
    });
    const id = agentClientId(bot.id);
    expect(room.awareness.getStates().has(id)).toBe(true);
    expect((room as unknown as { sweepTimer: unknown }).sweepTimer).toBeNull();
    expect(room.sweepAwareness()).toBe(0);
    room.awareness.meta.get(id)!.lastUpdated = Date.now() - AWARENESS_TIMEOUT_MS - 1000;
    expect(room.sweepAwareness()).toBe(1);
    expect(room.awareness.getStates().has(id)).toBe(false);
    // an outdated state also goes on the next message
    room.agentEdit(bot, () => 0);
    room.awareness.meta.get(id)!.lastUpdated = Date.now() - AWARENESS_TIMEOUT_MS - 1000;
    (room as unknown as { lastSweep: number }).lastSweep = 0;
    const conn = fakeConn(alice);
    room.addConn(conn);
    room.onMessage(conn, awarenessMsg([[301, 1, { cursor: null }]]));
    expect(room.awareness.getStates().has(id)).toBe(false);
    expect(room.awareness.getStates().has(301)).toBe(true);
    room.destroy(true);
  });

  test("the close timer is optional; closeIfIdle commits and closes an idle room", async () => {
    const { storage } = ownStorage();
    await seed("t2", { "b.md": "b\n" });
    const timer = (r: AnyRoom) => (r as unknown as { closeTimer: unknown }).closeTimer;
    const withTimer = new Room("t2", "b.md", "main", store, storage, bunDb(), () => {});
    await withTimer.open(null);
    const c1 = fakeConn(alice);
    withTimer.addConn(c1);
    withTimer.removeConn(c1);
    expect(timer(withTimer)).not.toBeNull();
    withTimer.destroy(true);

    const room = new Room("t2", "b.md", "main", store, storage, bunDb(), () => {}, false, { closeTimer: false });
    await room.open(null);
    const c2 = fakeConn(alice);
    room.addConn(c2);
    room.agentEdit(bot, (t) => void t.insert(0, "b"));
    room.removeConn(c2);
    expect(timer(room)).toBeNull();
    expect(room.idle()).toBe(false);
    expect(await room.closeIfIdle()).toBe(false);
    expect(room.closed).toBe(false);
    expect(await room.closeIfIdle(0)).toBe(true);
    expect(room.closed).toBe(true);
    expect(await fileAtHead("t2", "b.md")).toBe("bb\n");
    expect(storage.exec("SELECT COUNT(*) AS n FROM room_meta")).toEqual([{ n: 0 }]);
  });
});
