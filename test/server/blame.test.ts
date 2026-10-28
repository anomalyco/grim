// Line authors: Git blame in the stores, live attribution in rooms (people, guests, agents, outside pushes, a
// restart from the crash log) and the {t:"blame"} control message.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

const dir = mkdtempSync(join(process.env.DATA_DIR!, "blame-"));
process.env.QUIET_MS = "60000";

const { LocalGitStore } = await import("../../src/server/store/localgit.ts");
const { MemoryStore } = await import("../../src/server/store/memory.ts");
const { blameFromVersions } = await import("../../src/server/store/blame.ts");
const { RoomManager, MSG_CONTROL, MSG_SYNC, BLAME_MS, authorOf, TEXT_NAME } = await import("../../src/server/rooms.ts");
const { attribute, rebase, originLines, UNKNOWN, baseLine } = await import("../../src/server/blame.ts");
const { guestParticipant, GUEST_EMAIL } = await import("../../src/server/anon.ts");
const { db } = await import("../../src/server/db.ts");
const { bunDb } = await import("../../src/server/bun/db-bun.ts");
const { bunRoomStorage } = await import("../../src/server/bun/room-storage-bun.ts");
const { CodeStorageStore } = await import("../../src/server/store/codestorage.ts");
const { REMOTE_BLAME_DEPTH, REMOTE_BLAME_PARALLEL } = await import("../../src/server/store/blame.ts");
type Db = import("../../src/server/seams/db.ts").Db;
type Store = InstanceType<typeof LocalGitStore> | InstanceType<typeof MemoryStore>;
type Participant = Parameters<typeof authorOf>[0];

const alice: Participant = { id: "u-alice", name: "Alice", email: "alice@example.com", kind: "human", color: "#a00000" };
const bob: Participant = { id: "u-bob", name: "Bob", email: "bob@example.com", kind: "human", color: "#00b000" };
const bot: Participant = { id: "ag-1", name: "Claude", email: "claude@agents.grimoire", kind: "agent", color: "#0000c0" };

async function commit(store: Store, repo: string, path: string, content: string, who: { name: string; email: string }) {
  const head = await store.head(repo, "main");
  const r = await store.commit({ repo, branch: "main", expectedHead: head, changes: [{ path, content }], message: "x", author: who });
  if (!r.ok) throw new Error("commit failed");
  return r.sha;
}

/** A history with three authors: a.md ends as "one (Alice) / two (Bob) / three (Alice) / four (Carol)". */
async function threeAuthors(store: Store, repo: string) {
  await store.createRepo(repo, { branch: "main" });
  await commit(store, repo, "a.md", "one\nTWO\nthree\n", { name: "Alice", email: "alice@example.com" });
  await commit(store, repo, "other.md", "unrelated\n", { name: "Dave", email: "dave@example.com" });
  await commit(store, repo, "a.md", "one\ntwo\nthree\n", { name: "Bob", email: "bob@example.com" });
  return commit(store, repo, "a.md", "one\ntwo\nthree\nfour", { name: "Carol (guest)", email: GUEST_EMAIL });
}

describe("store blame", () => {
  test("local git: git blame --porcelain, per line, at any ref", async () => {
    const store = new LocalGitStore(join(dir, "git1"));
    const head = await threeAuthors(store, "b1");
    const names = (await store.blame("b1", "a.md", head))!.map((a) => a.name);
    expect(names).toEqual(["Alice", "Bob", "Alice", "Carol (guest)"]);
    expect((await store.blame("b1", "a.md", head))![1]).toEqual({ name: "Bob", email: "bob@example.com" });
    const first = (await store.history("b1", "main", "a.md", 10)).at(-1)!.sha;
    expect((await store.blame("b1", "a.md", first))!.map((a) => a.name)).toEqual(["Alice", "Alice", "Alice"]);
    expect(await store.blame("b1", "missing.md", head)).toBeNull();
  });

  test("memory store: computed from its snapshots, same answer", async () => {
    const store = new MemoryStore();
    const head = await threeAuthors(store, "m1");
    expect((await store.blame("m1", "a.md", head))!.map((a) => a.name)).toEqual(["Alice", "Bob", "Alice", "Carol (guest)"]);
    expect(await store.blame("m1", "nope.md", head)).toBeNull();
  });

  test("blameFromVersions keeps unchanged lines' authors through moves and inserts", () => {
    const A = { name: "A", email: "a@x" };
    const B = { name: "B", email: "b@x" };
    const C = { name: "C", email: "c@x" };
    const got = blameFromVersions([
      { text: "1\n2\n3\n", author: A },
      { text: "0\n1\n2\n3\n", author: B },
      { text: "0\n1\n2x\n3", author: C },
    ]);
    expect(got.map((a) => a.name)).toEqual(["B", "A", "C", "C"]);
  });
});

describe("attribute", () => {
  test("typing on a line takes it; other lines keep theirs", () => {
    expect(attribute("a\nb\nc", "a\nbX\nc", [0, 1, 2], 7)).toEqual([0, 7, 2]);
  });
  test("Enter at a line's end: only the new empty line is new", () => {
    expect(attribute("abc\ndef", "abc\n\ndef", [0, 1], 7)).toEqual([0, 7, 1]);
    expect(attribute("abc\ndef", "abc\ndef\n", [0, 1], 7)).toEqual([0, 1, 7]);
  });
  test("Enter at the very start, splitting, joining, deleting lines", () => {
    expect(attribute("\nx", "\n\nx", [0, 1], 7)).toEqual([0, 7, 1]);
    expect(attribute("abcdef", "abc\ndef", [3], 7)).toEqual([7, 7]);
    expect(attribute("ab\ncd\nef", "abcd\nef", [0, 1, 2], 7)).toEqual([7, 2]);
    expect(attribute("ab\ncd\nef", "ab\nef", [0, 1, 2], 7)).toEqual([0, 2]);
  });
  test("a pasted block, an emptied document", () => {
    expect(attribute("a\nb", "a\nx\ny\nb", [0, 1], 7)).toEqual([0, 7, 7, 1]);
    expect(attribute("a\nb", "", [0, 1], 7)).toEqual([7]);
  });
  test("rebase re-points everything but people at the new origin", () => {
    expect(rebase([0, baseLine(0), UNKNOWN, baseLine(1)], "mine\nx\ny\nz", "x\ny\nz")).toEqual([0, baseLine(0), baseLine(1), baseLine(2)]);
    expect(rebase([0, baseLine(0)], "mine\nx", null)).toEqual([0, UNKNOWN]);
    expect(originLines("a\nb\n")).toEqual([baseLine(0), baseLine(1), baseLine(2)]);
  });
});

// ---- rooms ----

type Conn = { user: Participant; readOnly: boolean; awarenessIds: Set<number>; sent: Uint8Array[]; send(m: Uint8Array): void; close(): void };
function fakeConn(user: Participant, readOnly = false): Conn {
  const sent: Uint8Array[] = [];
  return { user, readOnly, awarenessIds: new Set(), sent, send: (m) => void sent.push(m), close() {} };
}

function controls(c: Conn): Array<{ t: string; [k: string]: unknown }> {
  return c.sent
    .filter((m) => m[0] === MSG_CONTROL)
    .map((m) => {
      const d = decoding.createDecoder(m);
      decoding.readVarUint(d);
      return JSON.parse(decoding.readVarString(d));
    });
}
type Blame = { t: "blame"; authors: Array<{ id: string; name: string; kind: string; color: string }>; lines: number[] };
const blames = (c: Conn) => controls(c).filter((m) => m.t === "blame") as unknown as Blame[];
/** Who wrote each line, by name ("" = unknown). */
const names = (b: Blame) => b.lines.map((i) => (i < 0 ? "" : b.authors[i]!.name));

/** A browser: its own Y.Doc synced with the room; edits go to the room as sync updates from its connection. */
function client(room: { doc: Y.Doc; onMessage(c: never, d: Uint8Array): void }, conn: Conn) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(room.doc));
  const text = doc.getText(TEXT_NAME);
  return {
    doc,
    text,
    edit(fn: (t: Y.Text) => void) {
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(room.doc));
      const before = Y.encodeStateVector(doc);
      doc.transact(() => fn(text));
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(doc, before));
      room.onMessage(conn as never, encoding.toUint8Array(enc));
    },
  };
}

const lineStart = (t: Y.Text, n: number) => {
  const s = t.toString();
  let i = 0;
  for (let k = 0; k < n; k++) i = s.indexOf("\n", i) + 1;
  return i;
};
const lineEndOf = (t: Y.Text, n: number) => {
  const s = t.toString();
  const e = s.indexOf("\n", lineStart(t, n));
  return e < 0 ? s.length : e;
};

describe("rooms: live line authors", () => {
  const store = new LocalGitStore(join(dir, "git2"));

  async function seedRepo(repo: string, text: string, who = { name: "Dave", email: "dave@example.com" }) {
    await store.createRepo(repo, { branch: "main" });
    return commit(store, repo, "n.md", text, who);
  }

  test("two people and an agent on different lines; Git blame for the rest; join message first", async () => {
    await seedRepo("live1", "one\ntwo\nthree\nfour\n");
    const rooms = new RoomManager(store, { storage: bunRoomStorage(), db: bunDb() });
    const room = await rooms.get("live1", "n.md", "main");
    const a = fakeConn(alice);
    const b = fakeConn(bob);
    await Bun.sleep(100); // Git blame loads in the background
    room.addConn(a as never);
    room.addConn(b as never);
    expect(controls(a).map((m) => m.t).slice(0, 2)).toEqual(["hello", "blame"]);
    const joined = blames(a)[0]!;
    expect(names(joined)).toEqual(["Dave", "Dave", "Dave", "Dave", ""]);
    expect(joined.authors).toEqual([{ id: "git:dave@example.com", name: "Dave", kind: "human", color: expect.stringMatching(/^#[0-9a-f]{6}$/) }]);

    const ca = client(room, a);
    const cb = client(room, b);
    ca.edit((t) => t.insert(lineEndOf(t, 0), " (alice)"));
    cb.edit((t) => t.insert(lineEndOf(t, 2), " (bob)"));
    room.agentEdit(bot, (t) => t.insert(lineEndOf(t, 3), " (bot)"));
    expect(names(room.blame())).toEqual(["Alice", "Dave", "Bob", "Claude", ""]);
    const msg = room.blame();
    expect(msg.authors.find((x) => x.name === "Claude")).toEqual({ id: "ag-1", name: "Claude", kind: "agent", color: "#0000c0" });
    expect(msg.authors.find((x) => x.name === "Alice")).toEqual({ id: "u-alice", name: "Alice", kind: "human", color: "#a00000" });

    // Enter at the end of Alice's line, then Bob types a new line under it: the lines below keep their authors
    ca.edit((t) => t.insert(lineEndOf(t, 0), "\n"));
    cb.edit((t) => t.insert(lineStart(t, 1), "bob's new line"));
    expect(names(room.blame())).toEqual(["Alice", "Bob", "Dave", "Bob", "Claude", ""]);

    // the last message reaches both within BLAME_MS, once (edits in between are batched)
    const before = blames(a).length;
    await Bun.sleep(BLAME_MS + 300);
    const after = blames(a);
    expect(after.length).toBe(before + 1);
    expect(names(after.at(-1)!)).toEqual(["Alice", "Bob", "Dave", "Bob", "Claude", ""]);
    expect(names(blames(b).at(-1)!)).toEqual(["Alice", "Bob", "Dave", "Bob", "Claude", ""]);

    // committed: still the same authors while the room is open (not the commit's single author)
    await room.flush();
    expect(names(room.blame())).toEqual(["Alice", "Bob", "Dave", "Bob", "Claude", ""]);
    // and Git blame of that commit names its author for everything changed
    const head = (await store.head("live1", "main"))!;
    const git = (await store.blame("live1", "n.md", head))!.map((x) => x.name);
    expect(git[2]).toBe("Dave");
    expect(new Set([git[0], git[1], git[3], git[4]]).size).toBe(1);
    room.destroy(true);
  });

  test("a stream of edits sends at most one message per BLAME_MS", async () => {
    await seedRepo("live2", "x\n");
    const rooms = new RoomManager(store, { storage: bunRoomStorage(), db: bunDb() });
    const room = await rooms.get("live2", "n.md", "main");
    await Bun.sleep(100);
    const a = fakeConn(alice);
    room.addConn(a as never);
    const ca = client(room, a);
    const start = blames(a).length;
    const t0 = Date.now();
    while (Date.now() - t0 < BLAME_MS * 2.5) {
      // (a new line each time, so every message says something new)
      ca.edit((t) => t.insert(t.length, "y\n"));
      await Bun.sleep(50);
    }
    await Bun.sleep(BLAME_MS + 200);
    const sent = blames(a).length - start;
    expect(sent).toBeGreaterThanOrEqual(2);
    expect(sent).toBeLessThanOrEqual(4);
    room.destroy(true);
  });

  test("guests by their name; Git blame of a guest's commit shows the name without (guest)", async () => {
    await seedRepo("live3", "from a guest\nplain\n", { name: "moist-noodle (guest)", email: GUEST_EMAIL });
    const rooms = new RoomManager(store, { storage: bunRoomStorage(), db: bunDb() });
    const room = await rooms.get("live3", "n.md", "main");
    await Bun.sleep(100);
    const guest = guestParticipant("abcdef123", "fuzzy-otter", "#123456")!;
    const g = fakeConn(guest);
    room.addConn(g as never);
    const cg = client(room, g);
    cg.edit((t) => t.insert(lineEndOf(t, 1), "!"));
    const msg = room.blame();
    expect(names(msg)).toEqual(["moist-noodle", "fuzzy-otter", ""]);
    expect(msg.authors.map((x) => x.kind)).toEqual(["guest", "guest"]);
    expect(msg.authors[1]).toEqual({ id: "guest:abcdef123", name: "fuzzy-otter", kind: "guest", color: "#123456" });
    room.destroy(true);
  });

  test("Git authors who are users show as those users (same id and colour as when they're live)", async () => {
    db.query("INSERT OR IGNORE INTO users (id, login, name, email, created_at) VALUES ('u-erin', 'erin', 'Erin E', 'erin@example.com', 0)").run();
    await seedRepo("live4", "by erin\n", { name: "Erin E", email: "erin@example.com" });
    const rooms = new RoomManager(store, { storage: bunRoomStorage(), db: bunDb() });
    const room = await rooms.get("live4", "n.md", "main");
    await Bun.sleep(100);
    const { colorFor } = await import("../../src/server/auth.ts");
    expect(room.blame().authors).toEqual([{ id: "u-erin", name: "Erin E", kind: "human", color: colorFor("u-erin") }]);
    room.destroy(true);
  });

  test("an outside push: its lines are its author's, live lines stay", async () => {
    await seedRepo("live5", "one\ntwo\nthree\n");
    const rooms = new RoomManager(store, { storage: bunRoomStorage(), db: bunDb() });
    const room = await rooms.get("live5", "n.md", "main");
    await Bun.sleep(100);
    room.agentEdit(alice, (t) => t.insert(0, "alice was here "));
    await commit(store, "live5", "n.md", "one\ntwo\nthree\nfrom outside\n", { name: "Frank", email: "frank@example.com" });
    await room.checkRemote();
    expect(room.text.toString()).toBe("alice was here one\ntwo\nthree\nfrom outside\n");
    await Bun.sleep(150);
    expect(names(room.blame())).toEqual(["Alice", "Dave", "Dave", "Frank", ""]);
    room.destroy(true);
  });

  test("a restart from the crash log keeps who wrote what (before and after a compaction)", async () => {
    await seedRepo("live6", "a\nb\nc\n");
    const rooms = new RoomManager(store, { storage: bunRoomStorage(), db: bunDb() });
    const room = await rooms.get("live6", "n.md", "main");
    await Bun.sleep(100);
    const cb = client(room, fakeConn(bob));
    cb.edit((t) => t.insert(lineEndOf(t, 1), " bob"));
    room.agentEdit(bot, (t) => t.insert(lineEndOf(t, 2), " bot"));
    await room.flush(); // compacts the log: the line values are saved with the state
    room.agentEdit(alice, (t) => t.insert(0, "new top line\n"));
    cb.edit((t) => t.insert(lineEndOf(t, 3), "!"));
    const want = ["Alice", "Dave", "Bob", "Bob", ""];
    expect(names(room.blame())).toEqual(want);
    room.destroy(false); // a crash: the log stays

    const again = await new RoomManager(store, { storage: bunRoomStorage(), db: bunDb() }).get("live6", "n.md", "main");
    expect(again.text.toString()).toBe("new top line\na\nb bob\nc bot!\n");
    await Bun.sleep(150);
    expect(names(again.blame())).toEqual(want);
    again.destroy(true);
  });

  test("the demo's memory store: computed Git blame, nothing persisted", async () => {
    const mem = new MemoryStore();
    await mem.createRepo("demo", { branch: "main" });
    await commit(mem, "demo", "n.md", "seed line\n", { name: "Grimoire", email: "grimoire@users.noreply.code.storage" });
    const rooms = new RoomManager(mem, { storage: bunRoomStorage(), db: bunDb(), ephemeral: () => true });
    const room = await rooms.get("demo", "n.md", "main");
    await Bun.sleep(50);
    room.agentEdit(guestParticipant("zzzzzz1", "busy-bee", null)!, (t) => t.insert(0, "hi\n"));
    expect(names(room.blame())).toEqual(["busy-bee", "Grimoire", ""]);
    room.destroy(true);
  });
});

describe("rooms: resolving Git authors", () => {
  const store = new LocalGitStore(join(dir, "git3"));

  /** bunDb, recording every statement. */
  function countingDb() {
    const inner = bunDb();
    const sql: string[] = [];
    const wrap: Db = {
      get: (q, ...p) => (sql.push(q), inner.get(q, ...p)),
      all: (q, ...p) => (sql.push(q), inner.all(q, ...p)),
      run: (q, ...p) => (sql.push(q), inner.run(q, ...p)),
      batch: (s) => (sql.push(...s.map((x) => x[0])), inner.batch(s)),
    };
    return { db: wrap, sql };
  }

  test("one users query for all of a file's authors, none while blame messages go out, none on reopening", async () => {
    db.query("INSERT OR IGNORE INTO users (id, login, name, email, created_at) VALUES ('u-gina', 'gina', 'Gina G', 'Gina@Example.com', 0)").run();
    db.query("INSERT OR IGNORE INTO users (id, login, name, email, created_at) VALUES ('u-hal', 'hal', '', 'hal@example.com', 0)").run();
    await store.createRepo("res1", { branch: "main" });
    await commit(store, "res1", "n.md", "g\n", { name: "Gina", email: "gina@example.com" });
    await commit(store, "res1", "n.md", "g\nh\n", { name: "Hal", email: "HAL@example.com" });
    await commit(store, "res1", "n.md", "g\nh\ni\n", { name: "Ivan", email: "ivan@example.com" });
    await commit(store, "res1", "n.md", "g\nh\ni\nguest\n", { name: "Kim (guest)", email: GUEST_EMAIL });
    await commit(store, "res1", "n.md", "g\nh\ni\nguest\nbot\n", { name: "Claude", email: "claude@agents.grimoire" });

    const counting = countingDb();
    const rooms = new RoomManager(store, { storage: bunRoomStorage(), db: counting.db });
    const room = await rooms.get("res1", "n.md", "main");
    await Bun.sleep(150);
    expect(counting.sql).toHaveLength(1);
    expect(counting.sql[0]).toContain("lower(email) IN (?, ?, ?)");
    const { colorFor } = await import("../../src/server/auth.ts");
    expect(room.blame().authors).toEqual([
      { id: "u-gina", name: "Gina G", kind: "human", color: colorFor("u-gina") },
      { id: "u-hal", name: "hal", kind: "human", color: colorFor("u-hal") },
      { id: "git:ivan@example.com", name: "Ivan", kind: "human", color: colorFor("git:ivan@example.com") },
      { id: "guest-name:Kim", name: "Kim", kind: "guest", color: colorFor("guest-name:Kim") },
      { id: "agent-name:Claude", name: "Claude", kind: "agent", color: colorFor("agent-name:Claude") },
    ]);

    room.destroy(true);

    // the resolved authors are cached for that commit: reopening needs no store blame and no query
    const again = countingDb();
    const blame = store.blame.bind(store);
    let blamed = 0;
    store.blame = (...args: Parameters<typeof store.blame>) => (blamed++, blame(...args));
    try {
      const room2 = await new RoomManager(store, { storage: bunRoomStorage(), db: again.db }).get("res1", "n.md", "main");
      const b = fakeConn(bob);
      room2.addConn(b as never);
      expect(names(blames(b)[0]!)).toEqual(["Gina G", "hal", "Ivan", "Kim", "Claude", ""]);
      expect(blamed).toBe(0);

      // edits and the blame messages they cause: no queries either
      const cb = client(room2, b);
      cb.edit((t) => t.insert(0, "top\n"));
      room2.agentEdit(bot, (t) => t.insert(t.length, "end\n"));
      await Bun.sleep(BLAME_MS + 300);
      expect(names(blames(b).at(-1)!)).toEqual(["Bob", "Gina G", "hal", "Ivan", "Kim", "Claude", "Claude", ""]);
      expect(again.sql).toHaveLength(0);
      expect(counting.sql).toHaveLength(1);
      room2.destroy(true);
    } finally {
      store.blame = blame;
    }
  });

  test("a failing lookup shows Git names", async () => {
    await store.createRepo("res2", { branch: "main" });
    await commit(store, "res2", "n.md", "x\n", { name: "Gina", email: "gina@example.com" });
    const broken: Db = { ...bunDb(), all: () => Promise.reject(new Error("db down")) };
    const error = console.error;
    const logged: unknown[] = [];
    console.error = (...a: unknown[]) => void logged.push(a);
    try {
      const room = await new RoomManager(store, { storage: bunRoomStorage(), db: broken, ephemeral: () => true }).get("res2", "n.md", "main");
      await Bun.sleep(150);
      expect(room.blame().authors.map((x) => x.id)).toEqual(["git:gina@example.com"]);
      expect(logged).toHaveLength(1);
      room.destroy(true);
    } finally {
      console.error = error;
    }
  });

  test("blame goes out only when lines or authors changed", async () => {
    await store.createRepo("res3", { branch: "main" });
    await commit(store, "res3", "n.md", "one\ntwo\n", { name: "Dave", email: "dave@example.com" });
    const room = await new RoomManager(store, { storage: bunRoomStorage(), db: bunDb() }).get("res3", "n.md", "main");
    await Bun.sleep(150);
    const a = fakeConn(alice);
    room.addConn(a as never);
    const ca = client(room, a);
    ca.edit((t) => t.insert(lineEndOf(t, 0), "!"));
    await Bun.sleep(BLAME_MS + 300);
    expect(blames(a)).toHaveLength(2);
    // more typing on her own line: same authors, nothing new to say
    ca.edit((t) => t.insert(lineEndOf(t, 0), "!"));
    ca.edit((t) => t.insert(lineEndOf(t, 0), "?"));
    await Bun.sleep(BLAME_MS + 300);
    expect(blames(a)).toHaveLength(2);
    // a line of Dave's becomes Alice's
    ca.edit((t) => t.insert(lineEndOf(t, 1), "!"));
    await Bun.sleep(BLAME_MS + 300);
    expect(blames(a)).toHaveLength(3);
    expect(names(blames(a)[2]!)).toEqual(["Alice", "Alice", ""]);
    room.destroy(true);
  });
});

describe("code storage blame fallback", () => {
  test("reads at most REMOTE_BLAME_DEPTH versions, REMOTE_BLAME_PARALLEL at a time", async () => {
    expect([REMOTE_BLAME_DEPTH, REMOTE_BLAME_PARALLEL]).toEqual([50, 4]);
    const cs = new CodeStorageStore({ org: "test", key: "test" });
    const commits = Array.from({ length: 80 }, (_, i) => ({ sha: `c${i}`, authorName: `A${i}`, authorEmail: `a${i}@x` }));
    let limit = 0;
    (cs as unknown as { repo: () => unknown }).repo = () => ({
      getBlame: () => Promise.reject(new Error("no blame here")),
      // a server that ignores the limit
      listCommits: (o: { limit: number }) => ((limit = o.limit), Promise.resolve({ commits })),
    });
    let inFlight = 0;
    let most = 0;
    const read: string[] = [];
    cs.readFile = async (_repo: string, _path: string, sha: string) => {
      read.push(sha);
      most = Math.max(most, ++inFlight);
      await Bun.sleep(2);
      inFlight--;
      // newest first: version i has lines i..79 (one more line, at the top, per version)
      const i = Number(sha.slice(1));
      return commits.slice(i).map((c) => c.sha).join("\n");
    };
    const warn = console.warn;
    console.warn = () => {};
    try {
      const authors = (await cs.blame("r", "n.md", "main"))!;
      expect(limit).toBe(50);
      expect(read).toHaveLength(50);
      expect(new Set(read)).toEqual(new Set(commits.slice(0, 50).map((c) => c.sha)));
      expect(most).toBe(4);
      expect(authors[0]!.name).toBe("A0");
      // older lines go to the oldest version seen
      expect(authors.at(-1)!.name).toBe("A49");

      // stops reading past a version where the file didn't exist
      const plain = cs.readFile;
      const missing: string[] = [];
      cs.readFile = async (r: string, p: string, sha: string) => (Number(sha.slice(1)) >= 6 ? (missing.push(sha), null) : plain(r, p, sha));
      const short = (await cs.blame("r", "n.md", "main"))!;
      expect(short.map((a) => a.name).slice(0, 7)).toEqual(["A0", "A1", "A2", "A3", "A4", "A5", "A5"]);
      expect(short.at(-1)!.name).toBe("A5");
      expect(missing.length).toBeLessThanOrEqual(REMOTE_BLAME_PARALLEL);
    } finally {
      console.warn = warn;
    }
  });
});
