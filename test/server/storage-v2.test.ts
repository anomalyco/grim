// Storage v2 (docs/storage-v2.md): the NoteStore, rooms with stable epochs (the reset/data-loss bug), acks, versions,
// search, and the single-note agent shell.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { BunRoomStorage } from "../../src/server/bun/room-storage-bun.ts";
import { NoteStore, VERSION_IDLE_MS } from "../../src/server/notes/store.ts";
import { MemoryBlobs } from "../../src/server/notes/blobs-memory.ts";
import { RoomManager, type Conn, type Participant } from "../../src/server/rooms.ts";
import { WorkspaceRuntime } from "../../src/server/workspace.ts";
import type { RepoRow } from "../../src/server/repos.ts";

const repo: RepoRow = { id: "ws1", title: "Test", kind: "notes", read_only: 0, status: "ready", error: null, created_by: null, created_at: 0, owner_id: null };
const alice: Participant = { id: "u:alice", name: "Alice", email: "alice@example.com", kind: "human", color: "#f00" };
const agent: Participant = { id: "agent:x", name: "Bot", email: "bot@agents.grimoire", kind: "agent", color: "#0f0" };

function setup() {
  const storage = new BunRoomStorage(new Database(":memory:"));
  const store = new NoteStore(storage, repo.id);
  const rooms = new RoomManager({ store: () => store, room: { closeTimer: false, sweepTimer: false } });
  const rt = new WorkspaceRuntime(repo.id, rooms, new MemoryBlobs());
  return { storage, store, rooms, rt };
}

/** A Yjs client attached to a room as a Conn: it keeps its doc across disconnects, like the editor engine. */
class Client {
  doc = new Y.Doc();
  text = this.doc.getText("md");
  controls: Array<Record<string, unknown>> = [];
  conn: Conn | null = null;
  outbox: Uint8Array[] = [];
  private onUpdate = (u: Uint8Array, origin: unknown) => {
    if (origin === "server") return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeUpdate(enc, u);
    this.outbox.push(encoding.toUint8Array(enc));
  };
  constructor() {
    this.doc.on("update", this.onUpdate);
  }
  /** Connect: hello, then v2 open with our state vector (the server sends step2 with what we lack, then its step1). */
  connect(rooms: RoomManager, path: string) {
    const room = rooms.getSync(repo.id, path)!;
    const conn: Conn = {
      user: alice,
      readOnly: false,
      awarenessIds: new Set(),
      send: (m) => this.receive(room, conn, m),
      close: () => {},
    };
    this.conn = conn;
    this.outbox = [];
    room.addConn(conn, Y.encodeStateVector(this.doc));
    return room;
  }
  private receive(room: { onMessage(c: Conn, d: Uint8Array): void }, conn: Conn, m: Uint8Array) {
    const dec = decoding.createDecoder(m);
    const type = decoding.readVarUint(dec);
    if (type === 2) this.controls.push(JSON.parse(decoding.readVarString(dec)));
    if (type !== 0) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.readSyncMessage(dec, enc, this.doc, "server");
    // our step2 answer (what the server lacks: offline edits) goes back
    if (encoding.length(enc) > 1) queueMicrotask(() => room.onMessage(conn, encoding.toUint8Array(enc)));
  }
  flush(room: { onMessage(c: Conn, d: Uint8Array): void }) {
    for (const m of this.outbox.splice(0)) room.onMessage(this.conn!, m);
  }
  hello() {
    return this.controls.filter((c) => c.t === "hello").at(-1) as { generation: string } | undefined;
  }
}

describe("NoteStore", () => {
  test("create, list, rename, delete, search", () => {
    const { store } = setup();
    store.create("a.md", "# A\nhello world\n");
    store.create("f/b.md", "# B\nHello again\n");
    expect(store.paths()).toEqual(["a.md", "f/b.md"]);
    expect(() => store.create("a.md", "x")).toThrow();
    expect(store.search("hello").map((h) => h.path)).toEqual(["a.md", "f/b.md"]);
    expect(store.search("lo w")).toEqual([{ path: "a.md", line: 2, text: "hello world" }]);
    expect(store.search("B")).toEqual([{ path: "f/b.md", line: 1, text: "# B" }]);
    const b = store.byPath("f/b.md")!;
    store.rename(b.id, "g/b.md");
    expect(store.paths()).toEqual(["a.md", "g/b.md"]);
    expect(store.search("again")[0]!.path).toBe("g/b.md");
    store.softDelete(b.id);
    expect(store.paths()).toEqual(["a.md"]);
    expect(store.search("again")).toEqual([]);
    expect(store.anyByPath("g/b.md")?.id).toBe(b.id);
  });
});

describe("rooms", () => {
  test("the generation is stable across close and reopen: offline edits after a close merge (the old data-loss bug)", async () => {
    const { rooms, rt } = setup();
    await rt.createFile(repo, "n.md", "line one\n", alice);
    const c = new Client();
    let room = c.connect(rooms, "n.md");
    await Bun.sleep(0);
    expect(c.text.toString()).toBe("line one\n");
    const gen1 = c.hello()!.generation;
    // the client goes offline; the room closes (55 s idle: compacted, gone from memory) …
    room.removeConn(c.conn!);
    room.destroy();
    expect(rooms.peek(repo.id, "n.md")).toBeUndefined();
    // … while the client keeps typing
    c.text.insert(c.text.length, "typed offline\n");
    // someone else edits meanwhile, through a fresh room
    await rt.appendText(repo, "n.md", "server side\n", agent);
    rooms.peek(repo.id, "n.md")!.destroy();
    // reconnect: the same generation (Git-era rooms got a new one here, and clients dropped their edits)
    room = c.connect(rooms, "n.md");
    await Bun.sleep(0);
    expect(c.hello()!.generation).toBe(gen1);
    await Bun.sleep(5);
    expect(room.text.toString()).toContain("typed offline\n");
    expect(room.text.toString()).toContain("server side\n");
    expect(c.text.toString()).toBe(room.text.toString());
    // and it's durable: a fresh room from the store has it
    room.removeConn(c.conn!);
    room.destroy();
    expect((await rt.readFile(repo, "n.md")).content).toContain("typed offline");
  });

  test("updates are acked after the durable write", async () => {
    const { rooms, rt, store } = setup();
    await rt.createFile(repo, "n.md", "x\n", alice);
    const c = new Client();
    const room = c.connect(rooms, "n.md");
    await Bun.sleep(0);
    await Bun.sleep(5);
    const acks = () => c.controls.filter((m) => m.t === "ack") as Array<{ n: number }>;
    const before = acks().length;
    c.text.insert(0, "hi ");
    c.flush(room);
    // buffered (250 ms): not durable yet, not acked
    expect(acks().length).toBe(before);
    await Bun.sleep(300);
    expect(acks().length).toBe(before + 1);
    expect(acks().at(-1)!.n).toBe(c.conn!.received!);
    // written: the tail (or the compacted text) has it before any close
    const note = store.byPath("n.md")!;
    const tail = store.tail(note.id, note.epoch);
    expect(tail.length > 0 || note.text.startsWith("hi ")).toBe(true);
  });

  test("line authors survive a close", async () => {
    const { rooms, rt } = setup();
    await rt.createFile(repo, "n.md", "a\nb\n", alice);
    await rt.appendText(repo, "n.md", "c\n", agent);
    rooms.peek(repo.id, "n.md")!.destroy();
    const room = rooms.getSync(repo.id, "n.md")!;
    const b = room.blame();
    expect(b.lines.map((i) => (i >= 0 ? b.authors[i]!.name : null))).toEqual(["Alice", "Alice", "Bot", "Alice"]);
  });
});

describe("versions", () => {
  test("an agent's write is its own version, people's pending edits are cut first, idle versions are cut", async () => {
    const { rooms, rt, store } = setup();
    await rt.createFile(repo, "n.md", "# N\n", alice);
    // alice's creation is an open version; the agent's command cuts it, then its own
    const r = await rt.noteCommand(repo, "n.md", { command: "echo '- from bot' >> n.md", timeoutMs: 10_000, create: false, limitKey: "k" }, agent);
    expect(r.exitCode).toBe(0);
    let h = await rt.history(repo, "n.md");
    expect(h.map((v) => [v.kind, v.authorName])).toEqual([
      ["agent", "Bot"],
      ["edit", "Alice"],
    ]);
    // people's edits: one version, cut once idle
    await rt.appendText(repo, "n.md", "more\n", alice);
    rooms.cutDue(repo.id, Date.now() + 1000);
    expect((await rt.history(repo, "n.md")).length).toBe(2);
    rooms.cutDue(repo.id, Date.now() + VERSION_IDLE_MS + 1000);
    h = await rt.history(repo, "n.md");
    expect(h.length).toBe(3);
    expect(h[0]!.authorName).toBe("Alice");
    // diff and file?ref
    expect(await rt.diff(repo, h[0]!.sha)).toContain("+more");
    expect((await rt.readFile(repo, "n.md", h[1]!.sha)).content).toBe("# N\n- from bot\n");
    // restore: a minimal edit and a restore version
    await rt.restoreFile(repo, "n.md", h[2]!.sha, alice);
    expect((await rt.readFile(repo, "n.md")).content).toBe("# N\n");
    h = await rt.history(repo, "n.md");
    expect(h[0]!.kind).toBe("restore");
    // rename keeps the history; delete records a version
    await rt.renameFile(repo, "n.md", "m.md", alice);
    expect((await rt.history(repo, "m.md")).length).toBe(5);
    await rt.deleteFile(repo, "m.md", alice);
    expect(await rt.tree(repo)).toEqual([]);
    expect((await rt.history(repo, "m.md"))[0]!.kind).toBe("delete");
    expect(store.hasPending()).toBe(false);
  });
});

describe("the note shell", () => {
  test("sed -i lands live; other files and ../ see nothing; history; conflicts are refused", async () => {
    const { rooms, rt } = setup();
    await rt.createFile(repo, "todo.md", "# Todo\n- [ ] milk\n", alice);
    await rt.createFile(repo, "secret.md", "# Secret\nhunter2\n", alice);
    const run = (command: string, create = false, path = "todo.md") => rt.noteCommand(repo, path, { command, timeoutMs: 10_000, create, limitKey: "k" }, agent);
    let r = await run("sed -i 's/- \\[ \\] milk/- [x] milk/' todo.md && cat todo.md");
    expect(r.stdout).toBe("# Todo\n- [x] milk\n");
    expect(rooms.peek(repo.id, "todo.md")!.text.toString()).toBe("# Todo\n- [x] milk\n");
    r = await run("ls -a; ls ..; cat ../secret.md ../../secret.md 2>&1; find / -name '*.md'; grep -r hunter2 / ; echo $?");
    expect(r.stdout).not.toContain("hunter2");
    expect(r.stdout).not.toContain("# Secret");
    expect(r.stdout).not.toContain("secret.md\n");
    expect(r.stdout).toContain("todo.md");
    r = await run("echo x > other.md; echo ok");
    expect(r.stderr).toContain("discarded");
    r = await run("history");
    expect(r.stdout).toMatch(/^v\d+ .* agent +Bot/m);
    const id = r.stdout.split(" ")[0]!;
    r = await run(`history show ${id}`);
    expect(r.stdout).toBe("# Todo\n- [x] milk\n");
    r = await run(`history diff ${id}`);
    expect(r.stdout).toContain("+- [x] milk");
    r = await run("rm todo.md");
    expect(r.stderr).toContain("can't be deleted");
    // a conflicting write: someone edits the same line while the command runs
    const p = run("sleep 0.3; sed -i 's/milk/oat milk/' todo.md");
    await Bun.sleep(100);
    await rt.patchFile(repo, "todo.md", "# Todo\n- [x] milk\n", "# Todo\n- [x] whole milk\n", alice);
    r = await p;
    expect(r.stderr).toContain("changed by someone else");
    expect((await rt.readFile(repo, "todo.md")).content).toBe("# Todo\n- [x] whole milk\n");
    // creating a note needs `create`
    await expect(run("echo '# New' > new.md", false, "new.md")).rejects.toThrow(/doesn't exist/);
    r = await run("echo '# New' > new.md", true, "new.md");
    expect(r.exitCode).toBe(0);
    expect((await rt.readFile(repo, "new.md")).content).toBe("# New\n");
  });
});

describe("export and images", () => {
  test("upload, read raw, export zip", async () => {
    const { rt } = setup();
    await rt.createFile(repo, "a/n.md", "# N\n", alice);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const up = await rt.uploadImage(repo, "a/n.md", "pic.png", png, alice);
    expect(up.path).toBe("a/images/pic.png");
    expect((await rt.uploadImage(repo, "a/n.md", "pic.png", png, alice)).reused).toBe(true);
    expect((await rt.readRaw(repo, "a/images/pic.png")).bytes).toEqual(png);
    await rt.renameFolder(repo, "a", "b", alice);
    expect((await rt.readRaw(repo, "b/images/pic.png")).bytes).toEqual(png);
    const zip = await rt.exportZip(repo);
    const s = Buffer.from(zip).toString("latin1");
    expect(s.startsWith("PK")).toBe(true);
    expect(s).toContain("b/n.md");
    expect(s).toContain("b/images/pic.png");
    expect(s).toContain(".grim/versions.json");
  });
});
