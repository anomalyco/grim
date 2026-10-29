// WorkspaceSocket (protocol v2, src/server/wsmux.ts) against a fake host: real rooms over a local Git store, frames
// captured as the host's `send` gets them.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

const dir = mkdtempSync(join(process.env.DATA_DIR!, "wsmux-"));

const { LocalGitStore } = await import("../../src/server/store/localgit.ts");
const { RoomManager } = await import("../../src/server/rooms.ts");
const { bunRoomStorage } = await import("../../src/server/bun/room-storage-bun.ts");
const { bunDb } = await import("../../src/server/bun/db-bun.ts");
const { admitFile } = await import("../../src/server/workspace.ts");
const mux = await import("../../src/server/wsmux.ts");
type Conn = import("../../src/server/room.ts").Conn;
type MuxHost = import("../../src/server/wsmux.ts").MuxHost;
type MuxState = import("../../src/server/wsmux.ts").MuxState;

const store = new LocalGitStore(join(dir, "git"));
const rooms = new RoomManager(store, { storage: bunRoomStorage(), db: bunDb() });
const alice = { id: "u1", name: "Alice", email: "alice@example.com", kind: "human" as const, color: "#f00" };
const bob = { id: "u2", name: "Bob", email: "bob@example.com", kind: "human" as const, color: "#00f" };

let repoN = 0;
async function seed(files: Record<string, string>) {
  const repo = `mux${++repoN}`;
  await store.createRepo(repo, { branch: "main" });
  const r = await store.commit({ repo, branch: "main", expectedHead: await store.head(repo, "main"), changes: Object.entries(files).map(([path, content]) => ({ path, content })), message: "seed", author: alice });
  if (!r.ok) throw new Error("seed failed");
  return repo;
}

interface Out {
  ch: number;
  type: number;
  msg?: any;
  body: Uint8Array;
}

/** A socket on a fake host: `out` is every frame sent; `next` waits for the next one matching (an event, no polling). */
function socket(repo: string, opts: { user?: typeof alice; readOnly?: boolean; now?: () => number; wakeRoom?: MuxHost["wakeRoom"]; restore?: MuxState; status?: "ready" | "importing" } = {}) {
  const out: Out[] = [];
  const texts: string[] = [];
  const persisted: MuxState[] = [];
  const presence: string[][] = [];
  const closes: number[] = [];
  let waiters: Array<{ pred: (o: Out) => boolean; resolve: (o: Out) => void }> = [];
  const host: MuxHost = {
    async openRoom(path) {
      if (opts.status === "importing") return { reject: { code: 1013, reason: "repo importing" } };
      const d = await admitFile(rooms, { repoId: repo, branch: "main", path, participant: opts.user ?? alice, readOnly: false });
      return "reject" in d ? { reject: d.reject as any } : { room: d.room };
    },
    send(data) {
      if (typeof data === "string") return void texts.push(data);
      const f = mux.decodeFrame(data)!;
      const o: Out = { ch: f.ch, type: f.type, body: f.body.slice(), msg: f.type === mux.FRAME_CONTROL ? mux.decodeControl(f.payload) : undefined };
      out.push(o);
      const hit = waiters.filter((w) => w.pred(o));
      waiters = waiters.filter((w) => !w.pred(o));
      for (const w of hit) w.resolve(o);
    },
    closeSocket: (code) => void closes.push(code),
    persist: (s) => void persisted.push(s),
    presenceChanged: (p) => void presence.push(p),
    wakeRoom: opts.wakeRoom,
    now: opts.now,
  };
  const sock = mux.createWorkspaceSocket(host, opts.restore ? { restore: opts.restore } : { admission: { v: 2, repoId: repo, branch: "main", status: "ready", participant: opts.user ?? alice, readOnly: !!opts.readOnly } });
  const next = (pred: (o: Out) => boolean) => {
    const seen = out.find(pred);
    return seen ? Promise.resolve(seen) : new Promise<Out>((resolve) => waiters.push({ pred, resolve }));
  };
  const control = (msg: object) => sock.onMessage(mux.encodeControl(0, msg));
  const isCtl = (ch: number, t: string, f: (m: any) => boolean = () => true) => (o: Out) => o.ch === ch && o.msg?.t === t && f(o.msg);
  /** Open and wait for the reply (opened or error). */
  const open = async (path: string, extra: object = {}) => {
    const from = out.length;
    control({ t: "open", path, ...extra });
    const o = await next((o) => out.indexOf(o) >= from && o.ch === 0 && (o.msg?.t === "opened" || o.msg?.t === "error") && o.msg.req === path);
    return o.msg;
  };
  return { sock, host, out, texts, persisted, presence, closes, next, control, open, isCtl };
}

/** Applies a channel's sync frames to a doc (what a client does); returns the replies it would send. */
function applySync(doc: Y.Doc, body: Uint8Array): Uint8Array | null {
  const dec = decoding.createDecoder(body);
  if (decoding.readVarUint(dec) !== mux.FRAME_SYNC) return null;
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, mux.FRAME_SYNC);
  syncProtocol.readSyncMessage(dec, enc, doc, "server");
  return encoding.length(enc) > 1 ? encoding.toUint8Array(enc) : null;
}

function syncUpdate(update: Uint8Array) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, mux.FRAME_SYNC);
  syncProtocol.writeUpdate(enc, update);
  return encoding.toUint8Array(enc);
}

function awarenessFrame(clientId: number, clock: number, state: object | null) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 1);
  encoding.writeVarUint(enc, clientId);
  encoding.writeVarUint(enc, clock);
  encoding.writeVarString(enc, JSON.stringify(state));
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, mux.FRAME_AWARENESS);
  encoding.writeVarUint8Array(e, encoding.toUint8Array(enc));
  return encoding.toUint8Array(e);
}

/** A v1 connection (no `renew`). */
function v1Conn(user = bob): Conn & { controls: any[] } {
  const controls: any[] = [];
  return {
    user,
    readOnly: false,
    awarenessIds: new Set(),
    controls,
    send(data) {
      const dec = decoding.createDecoder(data);
      if (decoding.readVarUint(dec) === 2) controls.push(JSON.parse(decoding.readVarString(dec)));
    },
    close() {},
  };
}

describe("WorkspaceSocket", () => {
  test("start: welcome with the policy, then the presence snapshot", () => {
    const s = socket("x");
    s.sock.start("importing", undefined, { t: "presence", files: [] });
    expect(s.out.map((o) => o.msg.t)).toEqual(["welcome", "presence"]);
    expect(s.out[0]!.msg).toMatchObject({ v: 2, user: { id: "u1", name: "Alice", kind: "human" }, readOnly: false, status: "importing", maxChannels: 8, renewMs: 300_000, awarenessTimeoutMs: 720_000, pingMs: 30_000 });
  });

  test("open: opened, then hello, blame, step 2 with the text, step 1 and awareness, in that order", async () => {
    const repo = await seed({ "a.md": "hello\n" });
    const s = socket(repo);
    const opened = await s.open("a");
    expect(opened).toMatchObject({ t: "opened", req: "a", path: "a.md", ch: 1, readOnly: false });
    const room = rooms.peek(repo, "a.md")!;
    expect(opened.generation).toBe(room.generation);
    const after = s.out.slice(s.out.findIndex((o) => o.msg?.t === "opened") + 1);
    expect(after.every((o) => o.ch === 1)).toBe(true);
    expect(after[0]!.msg).toMatchObject({ t: "hello", generation: room.generation });
    // the text is in the first flight: no step 1 from the client needed
    const doc = new Y.Doc();
    const syncs = after.filter((o) => o.type === mux.FRAME_SYNC);
    expect(syncs.length).toBe(2);
    const reply = applySync(doc, syncs[0]!.body);
    expect(reply).toBeNull();
    expect(doc.getText("md").toString()).toBe("hello\n");
    // the second is the server's step 1: answering it with step 2 sends what the client has
    expect(applySync(doc, syncs[1]!.body)).not.toBeNull();
    expect(room.conns.size).toBe(1);
  });

  test("open with sv: step 2 carries only what the client lacks; its edits flow both ways", async () => {
    const repo = await seed({ "b.md": "one\n" });
    const s1 = socket(repo);
    await s1.open("b.md");
    const doc = new Y.Doc();
    for (const o of s1.out.filter((o) => o.ch === 1 && o.type === mux.FRAME_SYNC)) applySync(doc, o.body);
    expect(doc.getText("md").toString()).toBe("one\n");
    s1.control({ t: "close", ch: 1 });
    // offline edit, then reopen with the state vector
    doc.getText("md").insert(4, "two\n");
    const room = rooms.peek(repo, "b.md")!;
    room.agentEdit(bob, (t) => void t.insert(0, "zero\n"));
    const s2 = socket(repo);
    const opened = await s2.open("b.md", { sv: mux.encodeSv(Y.encodeStateVector(doc)) });
    const syncs = s2.out.filter((o) => o.ch === opened.ch && o.type === mux.FRAME_SYNC);
    applySync(doc, syncs[0]!.body);
    expect(doc.getText("md").toString()).toBe("zero\none\ntwo\n");
    const reply = applySync(doc, syncs[1]!.body)!;
    s2.sock.onMessage(mux.withChannel(opened.ch, reply));
    expect(room.text.toString()).toBe(doc.getText("md").toString());
    expect(room.text.toString()).toContain("two\n");
  });

  test("open is idempotent (also while the first is in flight); channel ids are never reused", async () => {
    const repo = await seed({ "c.md": "c\n", "d.md": "d\n" });
    const s = socket(repo);
    s.control({ t: "open", path: "c" });
    s.control({ t: "open", path: "c.md" });
    await s.next((o) => o.msg?.t === "opened" && o.msg.req === "c.md");
    await s.next((o) => o.msg?.t === "opened" && o.msg.req === "c");
    const opened = s.out.filter((o) => o.msg?.t === "opened").map((o) => o.msg.ch);
    expect(opened).toEqual([1, 1]);
    expect(s.out.filter((o) => o.msg?.t === "hello").length).toBe(1);
    expect(rooms.peek(repo, "c.md")!.conns.size).toBe(1);
    s.control({ t: "close", ch: 1 });
    expect(rooms.peek(repo, "c.md")!.conns.size).toBe(0);
    expect((await s.open("c")).ch).toBe(2);
    expect((await s.open("d")).ch).toBe(3);
    expect([...s.sock.channels.keys()]).toEqual([2, 3]);
  });

  test("a reopen while the first open is in flight (prefetch, close, click): the repeat's hidden and its step 2 apply", async () => {
    const repo = await seed({ "p.md": "prefetched\n" });
    // a doc that already has the note: the prefetch's sv, so its first flight's step 2 carries nothing
    const s0 = socket(repo);
    await s0.open("p.md");
    const warm = new Y.Doc();
    for (const o of s0.out.filter((o) => o.ch === 1 && o.type === mux.FRAME_SYNC)) applySync(warm, o.body);
    s0.control({ t: "close", ch: 1 });
    const s = socket(repo);
    s.control({ t: "open", path: "p.md", hidden: true, sv: mux.encodeSv(Y.encodeStateVector(warm)) });
    // the client closed it before `opened` (it has no id to send), then the user clicks it, with a fresh document
    const fresh = new Y.Doc();
    s.control({ t: "open", path: "p.md", sv: mux.encodeSv(Y.encodeStateVector(fresh)) });
    await s.next((o) => o.msg?.t === "opened" && s.out.filter((x) => x.msg?.t === "opened").length === 2);
    const openedAt = s.out.flatMap((o, i) => (o.msg?.t === "opened" ? [i] : []));
    expect(openedAt.map((i) => s.out[i]!.msg.ch)).toEqual([1, 1]);
    const room = rooms.peek(repo, "p.md")!;
    expect(room.conns.size).toBe(1);
    // shown: presence, and not hidden in the attachment
    expect(room.participants().map((u) => u.id)).toEqual(["u1"]);
    expect(s.sock.state().c).toEqual([[1, "p.md", room.generation, 0]]);
    // the repeat's step 2 answers its own sv: the fresh document gets the text
    const after = s.out.slice(openedAt[1]! + 1).filter((o) => o.ch === 1 && o.type === mux.FRAME_SYNC);
    expect(after.length).toBe(1);
    expect(applySync(fresh, after[0]!.body)).toBeNull();
    expect(fresh.getText("md").toString()).toBe("prefetched\n");
    expect(s.out.filter((o) => o.msg?.t === "hello").length).toBe(1);
    // a repeat asking hidden hides it again; one without sv sends no sync
    const n = s.out.length;
    expect((await s.open("p.md", { hidden: true })).ch).toBe(1);
    expect(room.participants()).toEqual([]);
    expect(s.out.slice(n).filter((o) => o.ch === 1).length).toBe(0);
  });

  test("errors are messages: 4400, 4404, 1013 while importing; the socket stays", async () => {
    const repo = await seed({ "e.md": "e\n" });
    const s = socket(repo);
    expect(await s.open("../x")).toMatchObject({ t: "error", req: "../x", code: 4400 });
    expect(await s.open("nope")).toMatchObject({ t: "error", req: "nope", path: "nope.md", code: 4404 });
    expect((await s.open("e")).t).toBe("opened");
    const imp = socket(repo, { status: "importing" });
    expect(await imp.open("e")).toMatchObject({ t: "error", code: 1013 });
    expect(s.closes).toEqual([]);
  });

  test("the 9th channel gets 4429; closing one makes room", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 9; i++) files[`n${i}.md`] = `${i}\n`;
    const repo = await seed(files);
    const s = socket(repo);
    const replies = await Promise.all(Array.from({ length: 9 }, (_, i) => s.open(`n${i}`)));
    expect(replies.filter((r) => r.t === "opened").length).toBe(8);
    expect(replies.filter((r) => r.t === "error")).toEqual([{ t: "error", req: "n8", path: "n8.md", code: 4429, reason: "too many channels" }]);
    s.control({ t: "close", ch: 1 });
    expect((await s.open("n8")).t).toBe("opened");
  });

  test("open rate: at most 32 per 10 s; reopening a note closed in the last minute is free", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 34; i++) files[`r${i}.md`] = `${i}\n`;
    const repo = await seed(files);
    let now = 1_000_000;
    const s = socket(repo, { now: () => now });
    for (let i = 0; i < 32; i++) {
      const r = await s.open(`r${i}`);
      expect(r.t).toBe("opened");
      s.control({ t: "close", ch: r.ch });
    }
    expect(await s.open("r32")).toMatchObject({ t: "error", code: 4429, reason: "too many opens" });
    // going back to notes closed on this socket isn't counted, again and again
    for (let k = 0; k < 3; k++) {
      for (const p of ["r0", "r1"]) {
        const r = await s.open(p);
        expect(r.t).toBe("opened");
        s.control({ t: "close", ch: r.ch });
      }
    }
    now += 10_000;
    const r32 = await s.open("r32");
    expect(r32.t).toBe("opened");
    s.control({ t: "close", ch: r32.ch });
    // a minute after its close, a reopen counts again
    now += 60_000;
    for (let i = 2; i < 34; i++) {
      const r = await s.open(`r${i}`);
      expect(r.t).toBe("opened");
      s.control({ t: "close", ch: r.ch });
    }
    expect(await s.open("r0")).toMatchObject({ t: "error", code: 4429, reason: "too many opens" });
  });

  test("view: hidden channels aren't presence until shown", async () => {
    const repo = await seed({ "v.md": "v\n" });
    const s = socket(repo);
    const r = await s.open("v", { hidden: true });
    const room = rooms.peek(repo, "v.md")!;
    expect(room.participants()).toEqual([]);
    s.presence.length = 0;
    s.control({ t: "view", ch: r.ch, hidden: false });
    expect(room.participants().map((u) => u.id)).toEqual(["u1"]);
    expect(s.presence).toEqual([["v.md"]]);
    s.control({ t: "view", ch: r.ch, hidden: true });
    expect(room.participants()).toEqual([]);
    expect(s.sock.state().c).toEqual([[r.ch, "v.md", room.generation, mux.CH_HIDDEN]]);
  });

  test("a deleted note ends its channel (closed, end 4000); the socket and other channels carry on", async () => {
    const repo = await seed({ "f.md": "f\n", "g.md": "g\n" });
    const s = socket(repo);
    const f = await s.open("f");
    const g = await s.open("g");
    rooms.peek(repo, "f.md")!.closeWith("deleted");
    const closed = s.out.findIndex(s.isCtl(f.ch, "closed"));
    const end = s.out.findIndex(s.isCtl(f.ch, "end"));
    expect(closed).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(closed);
    expect(s.out[end]!.msg).toEqual({ t: "end", code: 4000, reason: "deleted" });
    expect(s.closes).toEqual([]);
    expect([...s.sock.channels.keys()]).toEqual([g.ch]);
    // frames for the ended channel are dropped
    const n = s.out.length;
    s.sock.onMessage(mux.withChannel(f.ch, syncUpdate(new Uint8Array([0, 0]))));
    expect(s.out.length).toBe(n);
  });

  test("a reset (discardRepo) ends channels with 1013 reset", async () => {
    const repo = await seed({ "h.md": "h\n" });
    const s = socket(repo);
    const h = await s.open("h");
    await rooms.discardRepo(repo);
    expect(s.out.find(s.isCtl(h.ch, "end"))!.msg).toEqual({ t: "end", code: 1013, reason: "reset" });
    expect(s.sock.channels.size).toBe(0);
  });

  test("renew 15 s while a v1 connection is in the room, back to 5 min when it leaves", async () => {
    const repo = await seed({ "i.md": "i\n" });
    const s = socket(repo);
    const r = await s.open("i");
    const room = rooms.peek(repo, "i.md")!;
    const v1 = v1Conn();
    room.addConn(v1);
    expect(s.out.filter(s.isCtl(r.ch, "renew")).map((o) => o.msg.ms)).toEqual([15_000]);
    // a v2 channel joining a mixed room is told at once
    const s2 = socket(repo, { user: bob });
    const r2 = await s2.open("i");
    expect(s2.out.filter(s2.isCtl(r2.ch, "renew")).map((o) => o.msg.ms)).toEqual([15_000]);
    room.removeConn(v1);
    expect(s.out.filter(s.isCtl(r.ch, "renew")).map((o) => o.msg.ms)).toEqual([15_000, 300_000]);
  });

  test("awareness timeouts by owner: v2 channels 12 min, v1 connections 30 s", async () => {
    const repo = await seed({ "j.md": "j\n" });
    const s = socket(repo);
    const r = await s.open("j");
    const room = rooms.peek(repo, "j.md")!;
    s.sock.onMessage(mux.withChannel(r.ch, awarenessFrame(1001, 1, { cursor: null })));
    const v1 = v1Conn();
    room.addConn(v1);
    room.onMessage(v1, awarenessFrame(2002, 1, { cursor: null }));
    expect([...room.awareness.getStates().keys()].sort()).toEqual([1001, 2002]);
    // the state got the channel's user, and the attachment state has it
    expect((room.awareness.getStates().get(1001) as any).user.id).toBe("u1");
    expect(s.persisted.at(-1)!.aw.map((a) => a.slice(0, 3))).toEqual([[r.ch, 1001, 1]]);
    const t0 = Date.now();
    room.sweepAwareness(t0 + 31_000);
    expect([...room.awareness.getStates().keys()]).toEqual([1001]);
    room.sweepAwareness(t0 + 721_000);
    expect([...room.awareness.getStates().keys()]).toEqual([]);
  });

  test("closing the socket takes every channel out of its room", async () => {
    const repo = await seed({ "k.md": "k\n", "l.md": "l\n" });
    const s = socket(repo);
    await s.open("k");
    await s.open("l");
    s.sock.closed();
    expect(rooms.peek(repo, "k.md")!.conns.size).toBe(0);
    expect(rooms.peek(repo, "l.md")!.conns.size).toBe(0);
    expect(s.presence.at(-1)!.sort()).toEqual(["k.md", "l.md"]);
  });

  test("ping → pong; other text and bad frames are ignored", () => {
    const s = socket("x");
    s.sock.onMessage("ping");
    s.sock.onMessage("hello");
    s.sock.onMessage(new Uint8Array([0x80]));
    s.sock.onMessage(mux.encodeFrame(0, mux.FRAME_SYNC, new Uint8Array([1])));
    s.control({ t: "dance" });
    expect(s.texts).toEqual(["pong"]);
    expect(s.out).toEqual([]);
  });

  test("restore: no rooms touched; a frame wakes the room (reattach with awareness); another generation ends 1013", async () => {
    const repo = await seed({ "m.md": "m\n", "o.md": "o\n" });
    const s = socket(repo);
    const m = await s.open("m");
    const o = await s.open("o", { readOnly: true });
    s.sock.onMessage(mux.withChannel(m.ch, awarenessFrame(3003, 4, { cursor: null })));
    const st = s.sock.state();
    expect(st).toMatchObject({ v: 2, b: "main", ro: false, n: 3 });
    expect(st.c.map((c) => c.slice(0, 2).concat(c[3]))).toEqual([[m.ch, "m.md", 0], [o.ch, "o.md", mux.CH_READ_ONLY]]);
    expect(st.aw.map((a) => a.slice(0, 3))).toEqual([[m.ch, 3003, 4]]);
    // the "hibernation": the old socket's connections go away silently, the rooms stay in memory
    const mRoom = rooms.peek(repo, "m.md")!;
    const oRoom = rooms.peek(repo, "o.md")!;
    for (const r of [mRoom, oRoom]) r.conns.clear();
    oRoom.generation = "other";
    const woke: string[] = [];
    const r = socket(repo, { restore: JSON.parse(JSON.stringify(st)), wakeRoom: (p) => (woke.push(p), rooms.peek(repo, p) ?? null) });
    expect(r.sock.state()).toEqual(st);
    expect(woke).toEqual([]);
    expect(r.sock.roomOf(m.ch)).toBeNull();
    expect(r.sock.reattach(o.ch, oRoom)).toBe(false);
    const doc = new Y.Doc();
    doc.getText("md").insert(0, "x");
    r.sock.onMessage(mux.withChannel(m.ch, syncUpdate(Y.encodeStateAsUpdate(doc))));
    expect(woke).toEqual(["m.md"]);
    expect(mRoom.conns.size).toBe(1);
    expect(mRoom.text.toString()).toContain("x");
    expect(mRoom.awareness.getStates().has(3003)).toBe(true);
    expect(r.sock.roomOf(m.ch)).toBe(mRoom);
    expect(r.sock.reattach(m.ch, mRoom)).toBe(false);
    r.sock.onMessage(mux.withChannel(o.ch, syncUpdate(Y.encodeStateAsUpdate(doc))));
    expect(r.out.find(r.isCtl(o.ch, "end"))!.msg).toEqual({ t: "end", code: 1013, reason: "generation changed" });
    expect(oRoom.text.toString()).toBe("o\n");
    // a new channel gets the next id
    expect((await r.open("o")).ch).toBe(3);
  });

  test("read-only channels: updates ignored", async () => {
    const repo = await seed({ "p.md": "p\n" });
    const s = socket(repo, { readOnly: true });
    const r = await s.open("p");
    expect(r.readOnly).toBe(true);
    const doc = new Y.Doc();
    doc.getText("md").insert(0, "x");
    s.sock.onMessage(mux.withChannel(r.ch, syncUpdate(Y.encodeStateAsUpdate(doc))));
    expect(rooms.peek(repo, "p.md")!.text.toString()).toBe("p\n");
  });
});

describe("WorkspaceSocketSet", () => {
  test("presence from rooms and visible channels; snapshot; changes sent once", async () => {
    const repo = await seed({ "q.md": "q\n", "s.md": "s\n" });
    const set = new mux.WorkspaceSocketSet({ room: (p) => rooms.peek(repo, p), rooms: () => rooms.inRepo(repo) });
    const a = socket(repo);
    const b = socket(repo, { user: bob });
    a.host.presenceChanged = (paths) => paths.forEach((p) => set.updatePresence(p));
    b.host.presenceChanged = a.host.presenceChanged;
    set.add(a.sock);
    set.add(b.sock);
    await a.open("q");
    await b.open("s", { hidden: true });
    expect(set.presenceSnapshot()).toEqual({ t: "presence", files: [{ path: "q.md", users: [{ id: "u1", name: "Alice", color: "#f00", kind: "human" }] }] });
    const events = (s: ReturnType<typeof socket>) => s.out.filter((o) => o.ch === 0 && o.msg.t === "presence").map((o) => o.msg);
    expect(events(b)).toEqual([{ t: "presence", path: "q.md", users: [{ id: "u1", name: "Alice", color: "#f00", kind: "human" }] }]);
    set.updatePresence("q.md");
    expect(events(b).length).toBe(1);
    expect(set.channelsOn("s.md").map(([s, i]) => [s === b.sock, i.hidden])).toEqual([[true, true]]);
    a.sock.closed();
    set.remove(a.sock);
    expect(events(b).at(-1)).toEqual({ t: "presence", path: "q.md", users: [] });
    set.broadcast({ t: "workspace", status: "error", error: "boom" });
    expect(set.status).toBe("error");
    expect(events(a).length).toBe(1);
  });
});
