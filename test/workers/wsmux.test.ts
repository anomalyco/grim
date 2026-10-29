// Protocol v2 on Workers (CF-42): one WebSocket per workspace per tab, hosted by the WorkspaceDO behind the production
// router (configured from wrangler.jsonc) over an in-memory Git store (test/workers/wsmux.worker.js). Channels on one
// socket, mixed with a second v2 socket and a v1 socket in the same rooms; hibernation (the socket table from the
// attachments, rooms woken per channel, 0 store calls and fetches); heartbeats answered without waking the object;
// attachments with long paths; errors as messages; reconnect with `sv`; workspace events; the idle alarm cadence and
// the wakes of one idle tab per hour.
//
// Every wait is on an event (a frame arriving, a document changing), never on a timer.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { unstable_getMiniflareWorkerOptions, unstable_readConfig } from "wrangler";
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { sha256 } from "../../src/server/ids.ts";
import { decodeControl, decodeFrame, encodeControl, encodeSv, withChannel } from "../../src/shared/wsmux.ts";
import { migrationStatements, localConfig } from "./miniflare.ts";

const ROOT = join(import.meta.dir, "../..");
const WORKER = "grim-wsmux";
const SEED: Array<[string, string]> = [
  ["a.md", "# A\n"],
  ["b.md", "# B\n"],
  ["c.md", "# C\n"],
];

// evictions wait for the objects' timers (quiet commit, blame, the head writer's trailing write)
setDefaultTimeout(60_000);

let outdir: string;
let script: string;

beforeAll(async () => {
  outdir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "grim-wsmux-"));
  const alias = unstable_readConfig({ config: join(ROOT, "wrangler.jsonc") }).alias ?? {};
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "wsmux.worker.js")],
    outdir,
    target: "browser",
    format: "esm",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:*", "node:*"],
    plugins: [
      {
        name: "wrangler-alias",
        setup(b) {
          const keys = Object.keys(alias).map((k) => k.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"));
          b.onResolve({ filter: new RegExp(`^(?:${keys.join("|")})$`) }, (a) => ({ path: resolve(ROOT, alias[a.path]!) }));
        },
      },
    ],
  });
  if (!built.success) throw new AggregateError(built.logs, "bundling the wsmux test Worker failed");
  script = built.outputs[0]!.path;
}, 60_000);

afterAll(() => {
  if (outdir) rmSync(outdir, { recursive: true, force: true });
});

const USERS = { alice: "u1", bob: "u2", carol: "u3", long: "u4" } as const;
type Who = keyof typeof USERS;

// ---- event-driven waits: every frame or document change re-checks the pending conditions ----

const waiters = new Set<{ check: () => boolean; resolve: () => void; what: string }>();

function notify() {
  for (const w of [...waiters]) {
    if (w.check()) {
      waiters.delete(w);
      w.resolve();
    }
  }
}

/** Resolves when `check` holds, re-checked on every frame any client receives (`what` names it in a test timeout). */
function when(check: () => boolean, what = "condition"): Promise<void> {
  if (check()) return Promise.resolve();
  return new Promise<void>((resolve) => waiters.add({ check, resolve, what }));
}

class Instance {
  mf!: Miniflare;
  base = "";

  constructor(private vars: Record<string, string>) {}

  async start(workspaces: string[]) {
    const cfg = localConfig();
    const { compatibilityDate, compatibilityFlags, bindings, d1Databases, durableObjects } = unstable_getMiniflareWorkerOptions(cfg).workerOptions as Record<string, unknown>;
    this.mf = new Miniflare(
      convertV4MiniflareOptions({
        port: 0,
        workers: [{ compatibilityDate, compatibilityFlags, bindings: { ...(bindings as object), ...this.vars }, d1Databases, durableObjects, name: WORKER, modules: true, scriptPath: script, modulesRoot: outdir }],
      } as never),
    );
    this.base = (await this.mf.ready).toString().replace(/\/$/, "");
    const db = await this.mf.getD1Database("DB");
    await db.batch(migrationStatements().map((s) => db.prepare(s)));
    const now = Date.now();
    const stmts = Object.entries(USERS).flatMap(([who, id]) => {
      const long = who === "long";
      const name = long ? "N".repeat(3000) : who[0]!.toUpperCase() + who.slice(1);
      return [
        db
          .prepare("INSERT INTO users (id, login, name, email, avatar, created_at) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(id, who, name, long ? `${"e".repeat(1000)}@example.com` : `${who}@example.com`, long ? `https://example.com/${"a".repeat(1500)}.png` : null, now),
        db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").bind(sha256(`tok-${who}`), id, now + 3_600_000),
      ];
    });
    for (const id of workspaces) stmts.push(db.prepare("INSERT INTO repos (id, title, kind, branch, status, created_at) VALUES (?, ?, 'notes', 'main', 'ready', ?)").bind(id, id, now));
    await db.batch(stmts);
    for (const id of workspaces) expect((await this.post(`/__test/seed?repo=${id}`, SEED)).status).toBe(200);
  }

  headers(who: Who) {
    return { origin: this.base, cookie: `np_session=tok-${who}` };
  }

  get(path: string, who?: Who) {
    return fetch(this.base + path, { headers: who ? this.headers(who) : {} });
  }

  post(path: string, body: unknown, who: Who = "alice") {
    return fetch(this.base + path, { method: "POST", headers: { ...this.headers(who), "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  async json<T = any>(path: string, who?: Who): Promise<T> {
    return (await (await this.get(path, who)).json()) as T;
  }

  counts(reset = false) {
    return this.json<Counts>(`/__test/counts${reset ? "?reset=1" : ""}`);
  }

  state(repo: string) {
    return this.json<DoState>(`/__test/state?repo=${repo}`);
  }

  async gitFile(repo: string, path: string) {
    return (await this.json<{ content: string | null }>(`/__test/git?repo=${repo}&path=${encodeURIComponent(path)}`)).content;
  }

  evict(name: string, webSockets: "hibernate" | "close") {
    return this.mf.unsafeEvictDurableObject(WORKER, "WorkspaceDO", { name, webSockets });
  }

  v2(repo: string, who: Who) {
    return new V2(this.base, repo, this.headers(who));
  }

  v1(repo: string, path: string, who: Who) {
    return new V1(this.base, repo, path, this.headers(who));
  }

  async dispose() {
    for (const c of sockets.splice(0)) c.close();
    await this.mf?.dispose();
  }
}

type Counts = { store: number; fetch: number; calls: string[]; constructs: Record<string, number>; messages: Record<string, number>; alarms: number; wakes: Array<{ repo: string; store: number; fetch: number; calls: string[] }> };
type MuxState = { v: 2; u: { name: string; email: string; avatar?: string }; c: Array<[number, string, string, number]>; aw: unknown[] };
type DoState = { sockets: Array<{ tags: string[]; att: any; json: number }>; paths: Array<{ hash: string; path: string }>; logs: string[]; alarm: number | null; now: number };

const sockets: Array<{ close(): void }> = [];

/** One note's document on a socket: a Yjs doc and awareness, synced over a v2 channel or a v1 socket. */
class Note {
  text: Y.Text;
  awareness: awarenessProtocol.Awareness;
  controls: any[] = [];

  constructor(
    public doc: Y.Doc,
    private out: (body: Uint8Array) => void,
  ) {
    this.text = doc.getText("md");
    this.awareness = new awarenessProtocol.Awareness(doc);
    doc.on("update", this.onUpdate);
    this.awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin === "remote") return;
      this.sendAwareness(awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...added, ...updated, ...removed]));
    });
  }

  onUpdate = (u: Uint8Array, origin: unknown) => {
    if (origin === "remote") return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeUpdate(enc, u);
    this.out(encoding.toUint8Array(enc));
  };

  sendAwareness(update: Uint8Array) {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 1);
    encoding.writeVarUint8Array(enc, update);
    this.out(encoding.toUint8Array(enc));
  }

  /** A v1 frame (type · payload) from the server. */
  receive(body: Uint8Array) {
    const dec = decoding.createDecoder(body);
    const type = decoding.readVarUint(dec);
    if (type === 0) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.readSyncMessage(dec, enc, this.doc, "remote");
      if (encoding.length(enc) > 1) this.out(encoding.toUint8Array(enc));
    } else if (type === 1) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), "remote");
    } else if (type === 2) {
      this.controls.push(JSON.parse(decoding.readVarString(dec)));
    }
  }

  stop() {
    this.doc.off("update", this.onUpdate);
    this.awareness.destroy();
  }

  hello() {
    return this.controls.find((m) => m.t === "hello") as { generation: string } | undefined;
  }

  others(): Map<number, any> {
    return new Map([...this.awareness.getStates().entries()].filter(([id]) => id !== this.doc.clientID));
  }

  flush() {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 2);
    encoding.writeVarString(enc, JSON.stringify({ t: "flush" }));
    this.out(encoding.toUint8Array(enc));
  }
}

/** A tab's workspace socket (protocol v2). */
class V2 {
  ws: WebSocket;
  events: any[] = [];
  closeCode: number | null = null;
  pongs = 0;
  notes = new Map<string, Note>();
  pending = new Map<string, Note>();
  byCh = new Map<number, Note>();
  replies: any[] = [];
  opened = false;

  constructor(base: string, repo: string, headers: Record<string, string>) {
    sockets.push(this);
    this.ws = new WebSocket(`${base.replace("http", "ws")}/ws?${new URLSearchParams({ repo })}`, { headers } as never);
    this.ws.binaryType = "arraybuffer";
    this.ws.addEventListener("open", () => {
      this.opened = true;
      notify();
    });
    this.ws.addEventListener("close", (e) => {
      this.closeCode = e.code;
      notify();
    });
    this.ws.addEventListener("message", (e) => {
      if (typeof e.data === "string") {
        if (e.data === "pong") this.pongs++;
        return notify();
      }
      const f = decodeFrame(new Uint8Array(e.data as ArrayBuffer))!;
      if (f.ch === 0) {
        const m = decodeControl(f.payload)!;
        if (m.t === "opened" || m.t === "error") this.replies.push(m);
        else this.events.push(m);
        // (an open of a note already open on this socket keeps its channel and its document)
        if (m.t === "opened" && !this.byCh.has(m.ch as number)) {
          const note = this.pending.get(m.req as string);
          if (note) this.byCh.set(m.ch as number, note);
        }
      } else {
        this.byCh.get(f.ch)?.receive(f.body);
      }
      notify();
    });
  }

  welcome() {
    return this.events.find((m) => m.t === "welcome");
  }

  async ready() {
    await when(() => this.closeCode !== null || !!this.welcome(), "welcome");
    expect(this.closeCode).toBeNull();
    return this.welcome();
  }

  control(msg: object) {
    this.ws.send(encodeControl(0, msg) as Uint8Array<ArrayBuffer>);
  }

  /** Opens a note (with `doc`: the document it had, sent as `sv`); resolves with the reply. */
  async open(path: string, opts: { doc?: Y.Doc; hidden?: boolean } = {}) {
    const doc = opts.doc ?? new Y.Doc();
    const note = new Note(doc, (body) => {
      const ch = this.chOf(note);
      if (ch !== null && this.ws.readyState === 1) this.ws.send(withChannel(ch, body) as Uint8Array<ArrayBuffer>);
    });
    this.pending.set(path, note);
    const before = this.replies.length;
    this.control({ t: "open", path, ...(opts.doc ? { sv: encodeSv(Y.encodeStateVector(doc)) } : {}), ...(opts.hidden ? { hidden: true } : {}) });
    await when(() => this.replies.slice(before).some((r) => r.req === path), `reply to open ${path}`);
    this.pending.delete(path);
    const reply = this.replies.slice(before).find((r) => r.req === path);
    if (reply.t !== "opened") return { reply, note };
    const open = this.byCh.get(reply.ch)!;
    if (open !== note) return { reply, note: open };
    this.notes.set(path, note);
    await when(() => !!note.hello(), `hello on ${path}`);
    return { reply, note };
  }

  chOf(note: Note): number | null {
    for (const [ch, n] of this.byCh) if (n === note) return ch;
    return null;
  }

  note(path: string) {
    return this.notes.get(path)!;
  }

  ping() {
    this.ws.send("ping");
  }

  /** Everything sent before has reached the object: a heartbeat round trip (frames on a socket stay in order). */
  async sent() {
    const n = this.pongs + 1;
    this.ping();
    await when(() => this.pongs >= n, "pong");
  }

  close() {
    if (this.ws.readyState <= 1) this.ws.close();
    for (const n of this.notes.values()) n.stop();
  }
}

/** A v1 per-note socket (/ws?repo&path). */
class V1 {
  ws: WebSocket;
  note: Note;
  closeCode: number | null = null;
  pongs = 0;

  constructor(base: string, repo: string, path: string, headers: Record<string, string>, doc = new Y.Doc()) {
    sockets.push(this);
    this.note = new Note(doc, (body) => {
      if (this.ws.readyState === 1) this.ws.send(body as Uint8Array<ArrayBuffer>);
    });
    this.ws = new WebSocket(`${base.replace("http", "ws")}/ws?${new URLSearchParams({ repo, path })}`, { headers } as never);
    this.ws.binaryType = "arraybuffer";
    this.ws.addEventListener("open", () => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeSyncStep1(enc, doc);
      this.ws.send(encoding.toUint8Array(enc));
    });
    this.ws.addEventListener("close", (e) => {
      this.closeCode = e.code;
      notify();
    });
    this.ws.addEventListener("message", (e) => {
      if (typeof e.data === "string") {
        if (e.data === "pong") this.pongs++;
      } else {
        this.note.receive(new Uint8Array(e.data as ArrayBuffer));
      }
      notify();
    });
  }

  async ready() {
    await when(() => this.closeCode !== null || !!this.note.hello(), "v1 hello");
    expect(this.closeCode).toBeNull();
  }

  async sent() {
    const n = this.pongs + 1;
    this.ws.send("ping");
    await when(() => this.pongs >= n, "pong");
  }

  close() {
    if (this.ws.readyState <= 1) this.ws.close();
    this.note.stop();
  }
}

// a test that timed out names what it was waiting for
afterEach(() => {
  for (const w of waiters) console.error(`[wsmux] still waiting for ${w.what}`);
  waiters.clear();
});

const same = (...texts: Array<() => string>) => () => texts.every((t) => t() === texts[0]!());

describe("protocol v2 in the WorkspaceDO", () => {
  // a short quiet commit so evictions don't wait long; the alarm stays out of the way unless a test runs it
  const mf = new Instance({ QUIET_MS: "300", WORKSPACE_ALARM_MS: "600000", WORKSPACE_IDLE_ALARM_MS: "600000" });
  beforeAll(() => mf.start(["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9"]), 60_000);
  afterAll(() => mf.dispose());

  test("admission: the Worker admits the socket once; rejections close with their code after the upgrade", async () => {
    expect((await mf.json<{ ws: number[] }>("/api/server")).ws).toEqual([1, 2]);
    const cases: Array<[Record<string, string>, string, number]> = [
      [{ origin: mf.base }, "m1", 4401],
      [{ origin: "http://evil.example", cookie: "np_session=tok-alice" }, "m1", 4403],
      [mf.headers("alice"), "nope", 4404],
    ];
    for (const [headers, repo, code] of cases) {
      const s = new V2(mf.base, repo, headers);
      await when(() => s.closeCode !== null, `close ${code}`);
      expect(s.closeCode).toBe(code);
      expect(s.welcome()).toBeUndefined();
    }
  });

  test("one socket opens 3 notes; edits converge with a second v2 socket and a v1 socket", async () => {
    const a = mf.v2("m1", "alice");
    const w = await a.ready();
    expect(w).toMatchObject({ t: "welcome", v: 2, user: { id: "u1", name: "Alice" }, readOnly: false, status: "ready", maxChannels: 8 });
    const opened = await Promise.all(["a.md", "b.md", "c"].map((p) => a.open(p)));
    expect(opened.map((o) => o.reply.t)).toEqual(["opened", "opened", "opened"]);
    expect(opened[2]!.reply).toMatchObject({ req: "c", path: "c.md" });
    expect(new Set(opened.map((o) => o.reply.ch)).size).toBe(3);
    await when(() => a.note("a.md").text.toString() === "# A\n" && a.note("b.md").text.toString() === "# B\n" && a.note("c").text.toString() === "# C\n", "the three texts");

    const b = mf.v2("m1", "bob");
    await b.ready();
    await b.open("a.md");
    await b.open("b.md");
    const c = mf.v1("m1", "a.md", "carol");
    await c.ready();
    expect(c.note.hello()!.generation).toBe(opened[0]!.reply.generation);
    await when(() => c.note.text.toString() === "# A\n", "v1 text");

    a.note("a.md").text.insert(4, "alice\n");
    a.note("b.md").text.insert(4, "alice b\n");
    a.note("c").text.insert(4, "alice c\n");
    b.note("a.md").text.insert(0, "bob ");
    c.note.text.insert(0, "carol ");
    const ta = () => a.note("a.md").text.toString();
    await when(same(ta, () => b.note("a.md").text.toString(), () => c.note.text.toString()), "a.md converges");
    expect(ta()).toContain("alice\n");
    expect(ta()).toContain("bob ");
    expect(ta()).toContain("carol ");
    await when(same(() => a.note("b.md").text.toString(), () => b.note("b.md").text.toString()), "b.md converges");
    expect(b.note("b.md").text.toString()).toBe("# B\nalice b\n");

    // cursors across v2 channels and the v1 socket
    a.note("a.md").awareness.setLocalState({ cursor: null });
    c.note.awareness.setLocalState({ cursor: null });
    await when(() => b.note("a.md").others().size === 2 && c.note.others().size === 1 && a.note("a.md").others().size === 1, "cursors");

    // a commit holds everyone's edits (`saved` on channel 0 says when)
    const from = a.events.length;
    a.note("a.md").flush();
    await when(() => a.events.slice(from).some((m) => m.t === "saved" && m.path === "a.md"), "saved");
    expect(await mf.gitFile("m1", "a.md")).toBe(ta());
  });

  test("errors are messages: the socket and its other channels carry on", async () => {
    for (let i = 0; i < 6; i++) expect((await mf.post("/api/repos/m2/files", { path: `n${i}.md`, content: `n${i}\n` })).status).toBe(201);
    const a = mf.v2("m2", "alice");
    await a.ready();
    const { note } = await a.open("a.md");
    expect((await a.open("missing.md")).reply).toMatchObject({ t: "error", req: "missing.md", path: "missing.md", code: 4404 });
    expect((await a.open("../x")).reply).toMatchObject({ t: "error", req: "../x", code: 4400 });
    // open is idempotent: the same channel again
    const again = await a.open("a.md");
    expect(again.reply.t).toBe("opened");
    for (const p of ["b.md", "c.md"]) expect((await a.open(p)).reply.t).toBe("opened");
    for (let i = 0; i < 5; i++) expect((await a.open(`n${i}.md`)).reply.t).toBe("opened");
    expect((await a.open("n5.md")).reply).toMatchObject({ t: "error", code: 4429 });
    expect(a.closeCode).toBeNull();
    // the first channel still works
    const b = mf.v2("m2", "bob");
    await b.ready();
    const bn = (await b.open("a.md")).note;
    note.text.insert(0, "still ");
    await when(() => bn.text.toString() === "still # A\n", "edit after errors");
  });

  test("workspace events: the presence snapshot after welcome, presence, tree and saved on channel 0", async () => {
    const a = mf.v2("m3", "alice");
    await a.ready();
    const an = (await a.open("a.md")).note;
    await a.open("b.md", { hidden: true });
    const b = mf.v2("m3", "bob");
    await b.ready();
    // the snapshot: alice in a.md; b.md is hidden (a prefetch), so not presence
    await when(() => b.events.some((m) => m.t === "presence" && m.files), "presence snapshot");
    const snap = b.events.find((m) => m.t === "presence" && m.files);
    expect(snap.files).toEqual([{ path: "a.md", users: [expect.objectContaining({ id: "u1", name: "Alice" })] }]);
    const from = b.events.length;
    await a.open("c.md");
    await when(() => b.events.slice(from).some((m) => m.t === "presence" && m.path === "c.md" && m.users.some((u: any) => u.id === "u1")), "presence for c.md");
    expect((await mf.post("/api/repos/m3/files", { path: "new.md", content: "new\n" })).status).toBe(201);
    await when(() => b.events.slice(from).some((m) => m.t === "tree" && typeof m.head === "string"), "tree");
    an.text.insert(0, "saved ");
    an.flush();
    await when(() => b.events.slice(from).some((m) => m.t === "saved" && m.path === "a.md" && typeof m.sha === "string"), "saved");
    // closing the channel: presence for a.md empties
    a.control({ t: "close", ch: a.chOf(an) });
    await when(() => b.events.slice(from).some((m) => m.t === "presence" && m.path === "a.md" && m.users.length === 0), "presence gone");
    // removing the workspace: `workspace removed`, then the socket closes 4404
    await mf.get("/__test/remove?repo=m3");
    await when(() => b.closeCode !== null, "close after removal");
    expect(b.events.some((m) => m.t === "workspace" && m.status === "removed")).toBe(true);
    expect(b.closeCode).toBe(4404);
  });

  test("forced hibernation: frames on two channels after the wake make 0 store calls and 0 fetches; v1 and v2 share the room", async () => {
    const a = mf.v2("m4", "alice");
    await a.ready();
    const [na, nb] = [(await a.open("a.md")).note, (await a.open("b.md")).note];
    const b = mf.v2("m4", "bob");
    await b.ready();
    const ba = (await b.open("a.md")).note;
    const c = mf.v1("m4", "a.md", "carol");
    await c.ready();
    na.awareness.setLocalState({ cursor: null });
    await when(() => ba.others().size === 1 && c.note.others().size === 1, "cursor before");
    na.text.insert(0, "1 ");
    nb.text.insert(0, "1 ");
    await when(same(() => na.text.toString(), () => ba.text.toString(), () => c.note.text.toString()), "converge before");
    const generation = na.hello()!.generation;
    await Promise.all([a.sent(), b.sent(), c.sent()]);
    await mf.evict("m4", "hibernate");
    const before = await mf.counts(true);
    na.text.insert(0, "2 ");
    nb.text.insert(0, "2 ");
    await when(same(() => na.text.toString(), () => ba.text.toString(), () => c.note.text.toString()), "converge after the wake");
    expect(ba.text.toString()).toBe("2 1 # A\n");
    const after = await mf.counts();
    expect(after.constructs.m4).toBe(before.constructs.m4! + 1);
    expect(after.wakes.filter((w) => w.repo === "m4").length).toBe(1);
    expect(after.wakes[0]).toMatchObject({ store: 0, fetch: 0 });
    // the cursor survived in the attachment: the v1 client and bob still see alice
    expect(c.note.others().size).toBe(1);
    // the v1 client's frame reaches the v2 channels of the woken room
    c.note.text.insert(0, "v1 ");
    await when(() => ba.text.toString() === "v1 2 1 # A\n" && na.text.toString() === "v1 2 1 # A\n", "v1 → v2 after wake");
    // b.md was woken by its own frame, with the same generation
    const late = mf.v2("m4", "carol");
    await late.ready();
    const lb = await late.open("b.md");
    expect(lb.reply.generation).toBe(nb.hello()!.generation);
    await when(() => lb.note.text.toString() === "2 1 # B\n", "b.md for a late joiner");
    expect(na.hello()!.generation).toBe(generation);
  });

  test("heartbeats are auto-responses: pings to a hibernated object don't wake it", async () => {
    const a = mf.v2("m5", "alice");
    await a.ready();
    await a.open("a.md");
    await a.sent();
    await mf.evict("m5", "hibernate");
    const before = await mf.counts(true);
    for (let i = 0; i < 20; i++) a.ping();
    await when(() => a.pongs === 20, "20 pongs");
    const after = await mf.counts();
    expect(after.constructs.m5).toBe(before.constructs.m5!);
    expect(after.messages.m5 ?? 0).toBe(0);
  });

  test("attachments: 8 channels of 431-character paths fit, the paths go to channel_paths, and the wake finds them", async () => {
    const DEEP = (i: number) => Array.from({ length: 8 }, (_, j) => `folder-${j}-${"x".repeat(38)}/`).join("") + `deep-${i}-${"é".repeat(37)}.md`;
    for (let i = 0; i < 8; i++) {
      expect(DEEP(i).length).toBe(431);
      expect((await mf.post("/api/repos/m6/files", { path: DEEP(i), content: `deep ${i}\n` })).status).toBe(201);
    }
    const a = mf.v2("m6", "long");
    await a.ready();
    for (let i = 0; i < 8; i++) expect((await a.open(DEEP(i))).reply.t).toBe("opened");
    a.note(DEEP(7)).awareness.setLocalState({ cursor: { anchor: 1, head: 1 } });
    const b = mf.v2("m6", "bob");
    await b.ready();
    const b7 = (await b.open(DEEP(7))).note;
    await when(() => b7.others().size === 1, "the long user's cursor");
    const st = await mf.state("m6");
    const att = st.sockets.find((s) => s.att?.u?.email?.startsWith("eee"))!;
    expect(att.tags).toEqual(["w2"]);
    expect(att.json).toBeLessThanOrEqual(1800);
    const state = att.att as MuxState;
    expect(state.u.avatar).toBeUndefined();
    expect(state.u.name.length).toBe(100);
    expect(state.u.email.length).toBe(200);
    expect(state.c.length).toBe(8);
    for (const [, p] of state.c) expect(p).toMatch(/^#[0-9a-f]{16}$/);
    expect(st.paths.map((r) => r.path).sort()).toEqual(Array.from({ length: 8 }, (_, i) => DEEP(i)).sort());
    // bob's attachment has a short user: his one long path fits as it is
    const bobs = st.sockets.find((s) => s.att?.u?.name === "Bob")!.att as MuxState;
    expect(bobs.c[0]![1]).toBe(DEEP(7));
    await Promise.all([a.sent(), b.sent()]);
    await mf.evict("m6", "hibernate");
    const before = await mf.counts(true);
    a.note(DEEP(7)).text.insert(0, "woke ");
    await when(() => b7.text.toString() === "woke deep 7\n", "edit on a hashed path after the wake");
    const after = await mf.counts();
    expect(after.wakes.find((w) => w.repo === "m6")).toMatchObject({ store: 0, fetch: 0 });
    // the long user's channels close: the alarm drops channel_paths rows nobody refers to
    a.close();
    await when(() => a.closeCode !== null, "close");
    await mf.json("/__test/alarm?repo=m6");
    expect((await mf.state("m6")).paths.map((r) => r.path)).toEqual([]);
  });

  test("reconnect with sv: edits made while away are kept, both ways (also after an eviction that closed the socket)", async () => {
    const a = mf.v2("m7", "alice");
    await a.ready();
    const na = (await a.open("a.md")).note;
    const b = mf.v2("m7", "bob");
    await b.ready();
    const nb = (await b.open("a.md")).note;
    await when(() => na.text.toString() === "# A\n" && nb.text.toString() === "# A\n", "both synced");
    const generation = na.hello()!.generation;
    a.close();
    await when(() => a.closeCode !== null, "a closed");
    // alice types offline (her document only); bob types online
    const doc = na.doc;
    const offline = new Y.Doc();
    Y.applyUpdate(offline, Y.encodeStateAsUpdate(doc));
    offline.getText("md").insert(0, "offline ");
    nb.text.insert(nb.text.length, "online\n");
    const a2 = mf.v2("m7", "alice");
    await a2.ready();
    const r = await a2.open("a.md", { doc: offline });
    expect(r.reply.generation).toBe(generation);
    await when(same(() => r.note.text.toString(), () => nb.text.toString()), "converge after reconnect");
    expect(nb.text.toString()).toBe("offline # A\nonline\n");

    // the object is evicted with the socket closed mid-edit: reopen with sv
    r.note.text.insert(0, "x ");
    await when(() => nb.text.toString().startsWith("x "), "edit before the eviction");
    await mf.evict("m7", "close");
    await when(() => a2.closeCode !== null && b.closeCode !== null, "sockets closed by the eviction");
    const kept = r.note.doc;
    kept.getText("md").insert(0, "during ");
    const a3 = mf.v2("m7", "alice");
    await a3.ready();
    const r3 = await a3.open("a.md", { doc: kept });
    expect(r3.reply.generation).toBe(generation);
    const b3 = mf.v2("m7", "bob");
    await b3.ready();
    const n3 = (await b3.open("a.md")).note;
    await when(same(() => r3.note.text.toString(), () => n3.text.toString()), "converge after the eviction");
    expect(n3.text.toString()).toBe("during x offline # A\nonline\n");
  });

  test("one idle tab: pings are free, renewals are its only wakes, the alarm runs every 10 min (wakes per idle hour)", async () => {
    const a = mf.v2("m8", "alice");
    await a.ready();
    const na = (await a.open("a.md")).note;
    const b = mf.v2("m8", "bob");
    await b.ready();
    const nb = (await b.open("a.md")).note;
    na.awareness.setLocalState({ cursor: null });
    await when(() => nb.others().size === 1, "cursor");
    await Promise.all([a.sent(), b.sent()]);
    // the idle tab's hour, event by event: 120 pings (30 s) and 12 awareness renewals (5 min) on a hibernated object
    await mf.evict("m8", "hibernate");
    const before = await mf.counts(true);
    let renewals = 0;
    for (let minute = 0; minute < 60; minute++) {
      a.ping();
      a.ping();
      if (minute % 5 === 0) {
        const seen = nb.awareness.meta.get(na.doc.clientID)!.clock;
        na.awareness.setLocalState({ cursor: null });
        await when(() => (nb.awareness.meta.get(na.doc.clientID)?.clock ?? 0) > seen, "renewal relayed");
        renewals++;
        // the next renewal finds the object hibernated again
        await b.sent();
        await mf.evict("m8", "hibernate");
      }
    }
    await when(() => a.pongs >= 120, "120 pongs");
    const after = await mf.counts();
    const wakes = after.constructs.m8! - before.constructs.m8!;
    expect(renewals).toBe(12);
    expect(after.messages.m8).toBe(12);
    expect(wakes).toBe(12);
    for (const w of after.wakes.filter((w) => w.repo === "m8")) expect(w).toMatchObject({ store: 0, fetch: 0 });
    // the alarm with only idle v2 sockets: next in 10 min, and it woke no room
    const run = await mf.json<{ alarm: number; now: number }>("/__test/alarm?repo=m8");
    const every = run.alarm - run.now;
    expect(every).toBeGreaterThan(590_000);
    expect(every).toBeLessThanOrEqual(600_000);
    const alarms = Math.round(3_600_000 / every);
    console.log(`[wsmux] one idle tab per hour: ${wakes} renewal wakes + ${alarms} alarms = ${wakes + alarms} wakes; 120 pings, 0 wakes`);
    expect(wakes + alarms).toBeLessThanOrEqual(20);
  });

  test("RPCs after hibernation see rooms held by v2 channels: rename keeps unsaved edits, delete of an uncommitted note works, both tell the channel `closed`", async () => {
    const a = mf.v2("m9", "alice");
    await a.ready();
    const na = (await a.open("a.md")).note;
    na.text.insert(0, "unsaved ");
    await a.sent();
    await mf.evict("m9", "hibernate");
    // no frame since the wake: the room is asleep, its edits only in the crash log
    expect((await mf.post("/api/repos/m9/rename", { from: "a.md", to: "renamed.md" })).status).toBe(200);
    await when(() => na.controls.some((m) => m.t === "closed"), "closed after the rename");
    expect(na.controls.find((m) => m.t === "closed")).toMatchObject({ reason: "renamed", to: "renamed.md" });
    expect(await mf.gitFile("m9", "renamed.md")).toBe("unsaved # A\n");
    expect(await mf.gitFile("m9", "a.md")).toBeNull();
    expect((await mf.state("m9")).logs).not.toContain("a.md");

    // a new note, not committed yet, open on a channel: deleted after a hibernation
    expect((await mf.post("/api/repos/m9/files", { path: "new.md", content: "draft\n" })).status).toBe(201);
    const nn = (await a.open("new.md")).note;
    await when(() => nn.text.toString() === "draft\n", "new.md synced");
    await a.sent();
    await mf.evict("m9", "hibernate");
    const del = await fetch(`${mf.base}/api/repos/m9/files?path=new.md`, { method: "DELETE", headers: mf.headers("alice") });
    expect(del.status).toBe(200);
    await when(() => nn.controls.some((m) => m.t === "closed"), "closed after the delete");
    expect(nn.controls.find((m) => m.t === "closed")).toMatchObject({ reason: "deleted" });
    expect((await mf.state("m9")).logs).not.toContain("new.md");
    expect(await mf.gitFile("m9", "new.md")).toBeNull();
  });
});
