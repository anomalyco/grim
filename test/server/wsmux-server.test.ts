// Protocol v2 on the Bun server (docs/07-workspace-socket.md): one socket per workspace at /ws?repo=, sharing rooms
// with v1 sockets (/ws?repo&path). Every wait is on a frame or a close: no sleeps, no polling.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { isolate } from "./helpers.ts";

process.env.POLL_MS = "60000";
const { config } = await import("../../src/server/config.ts");
const { db } = await import("../../src/server/db.ts");
const restore = isolate(config, db);
Object.assign(config, { storage: "local", allowDevLogin: true, quietMs: 60_000, pollMs: 60000, notesRepo: "wsmux-notes" });
config.github.clientId = "";
config.github.appSlug = "";
const { startServer } = await import("../../src/server/index.ts");
const mux = await import("../../src/shared/wsmux.ts");
const { emit } = await import("../../src/server/events.ts");

let app: Awaited<ReturnType<typeof startServer>>;
let base = "";
let alice = "";
let bob = "";
let ws = "";

async function login(name: string): Promise<string> {
  const res = await fetch(`${base}/auth/dev`, { method: "POST", headers: { origin: base }, body: new URLSearchParams({ name }), redirect: "manual" });
  return res.headers.getSetCookie().find((s) => s.startsWith("np_session="))!.split(";")[0]!;
}

async function api(cookie: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, headers: { cookie, origin: base, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

/** Resolves when `cond()` holds, re-checked after every event `bump()` reports (frames, closes). */
class Events {
  private waiters: Array<{ cond: () => boolean; resolve: () => void }> = [];
  bump() {
    const ready = this.waiters.filter((w) => w.cond());
    this.waiters = this.waiters.filter((w) => !ready.includes(w));
    for (const w of ready) w.resolve();
  }
  when(cond: () => boolean): Promise<void> {
    if (cond()) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ cond, resolve }));
  }
}

const syncFrame = (write: (enc: encoding.Encoder) => void) => {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, mux.FRAME_SYNC);
  write(enc);
  return encoding.toUint8Array(enc);
};

/** A v2 client: one socket, a Y.Doc per path, and every channel-0 message it got. */
class V2 {
  sock: WebSocket;
  ev = new Events();
  ctl: any[] = [];
  /** Control messages per channel. */
  chCtl = new Map<number, any[]>();
  docs = new Map<string, Y.Doc>();
  chOf = new Map<string, number>();
  pathOf = new Map<number, string>();
  closeCode: number | null = null;
  texts: string[] = [];
  /** Binary frames sent (to count round trips), and their channels. */
  sent = 0;
  sentOn: number[] = [];
  open$: Promise<void>;

  constructor(query: Record<string, string>, headers: Record<string, string> = { cookie: alice, origin: base }) {
    this.sock = new WebSocket(`${base.replace("http", "ws")}/ws?${new URLSearchParams({ repo: ws, ...query })}`, { headers } as any);
    this.sock.binaryType = "arraybuffer";
    this.open$ = new Promise((r) => this.sock.addEventListener("open", () => r()));
    this.sock.addEventListener("close", (e) => {
      this.closeCode = e.code;
      this.ev.bump();
    });
    this.sock.addEventListener("message", (e) => {
      if (typeof e.data === "string") this.texts.push(e.data);
      else this.frame(new Uint8Array(e.data as ArrayBuffer));
      this.ev.bump();
    });
  }

  private frame(data: Uint8Array) {
    const f = mux.decodeFrame(data)!;
    if (f.ch === 0) {
      const m = mux.decodeControl(f.payload)!;
      if (m.t === "opened") {
        this.chOf.set(m.path as string, m.ch as number);
        this.pathOf.set(m.ch as number, m.path as string);
      }
      this.ctl.push(m);
      return;
    }
    const path = this.pathOf.get(f.ch);
    if (!path) return;
    if (f.type === mux.FRAME_CONTROL) {
      const m = mux.decodeControl(f.payload)!;
      if (!this.chCtl.has(f.ch)) this.chCtl.set(f.ch, []);
      this.chCtl.get(f.ch)!.push(m);
      if (m.t === "end") {
        this.chOf.delete(path);
        this.pathOf.delete(f.ch);
      }
    } else if (f.type === mux.FRAME_SYNC) {
      const dec = decoding.createDecoder(f.payload);
      const reply = syncFrame((enc) => syncProtocol.readSyncMessage(dec, enc, this.doc(path), "remote"));
      if (reply.length > 1) this.send(mux.withChannel(f.ch, reply));
    }
  }

  doc(path: string) {
    let d = this.docs.get(path);
    if (!d) {
      const doc = (d = new Y.Doc());
      this.docs.set(path, doc);
      doc.on("update", (u: Uint8Array, origin: unknown) => {
        const ch = this.chOf.get(path);
        if (origin === "remote" || ch === undefined) return;
        this.send(mux.withChannel(ch, syncFrame((enc) => syncProtocol.writeUpdate(enc, u))));
      });
    }
    return d;
  }

  text(path: string) {
    return this.doc(path).getText("md").toString();
  }

  send(data: Uint8Array | string) {
    if (this.sock.readyState !== 1) return;
    if (typeof data !== "string") {
      this.sent++;
      this.sentOn.push(mux.decodeFrame(data)!.ch);
    }
    this.sock.send(data as string | Uint8Array<ArrayBuffer>);
  }

  control(msg: object) {
    this.send(mux.encodeControl(0, msg));
  }

  /** Sends `open` and waits for its reply (opened or error). */
  async open(path: string, extra: { sv?: string; hidden?: boolean; readOnly?: boolean } = {}): Promise<any> {
    const from = this.ctl.length;
    this.control({ t: "open", path, ...extra });
    let reply: any;
    await this.ev.when(() => !!(reply = this.ctl.slice(from).find((m) => (m.t === "opened" || m.t === "error") && m.req === path)));
    return reply;
  }

  /** The first channel-0 message from index `from` on that matches. */
  async wait(pred: (m: any) => boolean, from = 0): Promise<any> {
    let hit: any;
    await this.ev.when(() => !!(hit = this.ctl.slice(from).find(pred)));
    return hit;
  }

  close() {
    this.sock.close();
  }
}

/** A v1 client on one note (as the web app was before v2). */
class V1 {
  sock: WebSocket;
  ev = new Events();
  doc = new Y.Doc();
  controls: any[] = [];
  closeCode: number | null = null;

  constructor(path: string, cookie = bob) {
    this.sock = new WebSocket(`${base.replace("http", "ws")}/ws?${new URLSearchParams({ repo: ws, path })}`, { headers: { cookie, origin: base } } as any);
    this.sock.binaryType = "arraybuffer";
    this.sock.addEventListener("open", () => this.send(syncFrame((enc) => syncProtocol.writeSyncStep1(enc, this.doc))));
    this.sock.addEventListener("close", (e) => {
      this.closeCode = e.code;
      this.ev.bump();
    });
    this.sock.addEventListener("message", (e) => {
      const dec = decoding.createDecoder(new Uint8Array(e.data as ArrayBuffer));
      const type = decoding.readVarUint(dec);
      if (type === mux.FRAME_SYNC) {
        const reply = syncFrame((enc) => syncProtocol.readSyncMessage(dec, enc, this.doc, "remote"));
        if (reply.length > 1) this.send(reply);
      } else if (type === mux.FRAME_CONTROL) this.controls.push(JSON.parse(decoding.readVarString(dec)));
      this.ev.bump();
    });
    this.doc.on("update", (u: Uint8Array, origin: unknown) => {
      if (origin !== "remote") this.send(syncFrame((enc) => syncProtocol.writeUpdate(enc, u)));
    });
  }

  get text() {
    return this.doc.getText("md");
  }

  send(b: Uint8Array) {
    if (this.sock.readyState === 1) this.sock.send(b as Uint8Array<ArrayBuffer>);
  }

  close() {
    this.sock.close();
  }
}

async function note(path: string, content: string) {
  const r = await api(alice, "POST", `/api/repos/${ws}/files`, { path, content });
  expect(r.status).toBe(201);
}

async function welcomed(c: V2) {
  return c.wait((m) => m.t === "welcome");
}

beforeAll(async () => {
  app = await startServer({ port: 0, quiet: true });
  base = `http://localhost:${app.server.port}`;
  alice = await login("Alice");
  bob = await login("Bob");
  ws = (await api(alice, "POST", "/api/workspaces", { title: "Mux" })).data.id;
  for (const [p, c] of Object.entries({ "a.md": "alpha\n", "b.md": "beta\n", "c.md": "gamma\n" })) await note(p, c);
});

afterAll(async () => {
  await app?.stop();
  restore();
});

describe("v2 admission", () => {
  test("welcome, then the presence snapshot; rejections are upgrade-then-close", async () => {
    const c = new V2({});
    const w = await welcomed(c);
    expect(w).toMatchObject({ t: "welcome", v: 2, user: { name: "Alice", kind: "human" }, readOnly: false, status: "ready", maxChannels: 8, renewMs: 300_000, awarenessTimeoutMs: 720_000, pingMs: 30_000 });
    await c.wait((m) => m.t === "presence" && Array.isArray(m.files));
    expect(c.ctl.map((m) => m.t).slice(0, 2)).toEqual(["welcome", "presence"]);
    c.close();

    const guest = new V2({ anon: "abcDEF123456", name: "moist-noodle", color: "#2b6a54" }, { origin: base });
    expect((await welcomed(guest)).user).toMatchObject({ name: "moist-noodle", kind: "guest" });
    guest.close();

    const cases: Array<[Record<string, string>, Record<string, string>, number]> = [
      [{}, { origin: base }, 4401],
      [{}, { cookie: alice, origin: "https://evil.example" }, 4403],
      [{ repo: "nope" }, { cookie: alice, origin: base }, 4404],
    ];
    for (const [q, h, code] of cases) {
      const r = new V2(q, h);
      await r.ev.when(() => r.closeCode !== null);
      expect(r.closeCode).toBe(code);
    }
  });

  test("ping → pong", async () => {
    const c = new V2({});
    await welcomed(c);
    c.send("ping");
    await c.ev.when(() => c.texts.length > 0);
    expect(c.texts).toEqual(["pong"]);
    c.close();
  });

  test("/api/server advertises ws [1, 2]", async () => {
    expect((await api("", "GET", "/api/server")).data.ws).toEqual([1, 2]);
  });
});

describe("v2 channels with a v1 client in the room", () => {
  test("one socket opens 3 notes; edits flow to a v1 client and back; presence, renew, close/reopen", async () => {
    const c = new V2({});
    await welcomed(c);
    const replies = await Promise.all(["a", "b", "c"].map((p) => c.open(p)));
    expect(replies.map((r) => [r.t, r.path, r.ch])).toEqual([
      ["opened", "a.md", 1],
      ["opened", "b.md", 2],
      ["opened", "c.md", 3],
    ]);
    // the text came with the open
    await c.ev.when(() => c.text("a.md") === "alpha\n" && c.text("b.md") === "beta\n" && c.text("c.md") === "gamma\n");

    const from = c.ctl.length;
    const v1 = new V1("b.md");
    await v1.ev.when(() => v1.text.toString() === "beta\n");
    // Bob's presence on b.md reaches the socket; the v2 channel is asked to renew every 15 s while he's there
    const pres = await c.wait((m) => m.t === "presence" && m.path === "b.md" && m.users.some((u: any) => u.name === "Bob"), from);
    expect(pres.users.map((u: any) => u.name).sort()).toEqual(["Alice", "Bob"]);
    await c.ev.when(() => (c.chCtl.get(2) ?? []).some((m) => m.t === "renew" && m.ms === 15_000));

    // a second v2 socket (Bob's other tab) on the same note: all three converge
    const d = new V2({}, { cookie: bob, origin: base });
    await welcomed(d);
    await d.open("b.md");
    await d.ev.when(() => d.text("b.md") === "beta\n");
    c.doc("b.md").getText("md").insert(0, "v2 says hi\n");
    await v1.ev.when(() => v1.text.toString() === "v2 says hi\nbeta\n");
    v1.text.insert(v1.text.length, "v1 answers\n");
    await d.ev.when(() => d.text("b.md").startsWith("v2 says hi\n"));
    d.doc("b.md").getText("md").insert(0, ">");
    const all = ">v2 says hi\nbeta\nv1 answers\n";
    await c.ev.when(() => c.text("b.md") === all);
    await d.ev.when(() => d.text("b.md") === all);
    await v1.ev.when(() => v1.text.toString() === all);
    expect(app.ctx.rooms.peek(ws, "b.md")!.conns.size).toBe(3);
    d.close();

    v1.close();
    await c.ev.when(() => (c.chCtl.get(2) ?? []).some((m) => m.t === "renew" && m.ms === 300_000));

    // close leaves the room at once; reopening gets a new channel id with the live text
    c.control({ t: "close", ch: 1 });
    const reopened = await c.open("a.md");
    expect(reopened.ch).toBe(4);
    expect(app.ctx.rooms.peek(ws, "a.md")!.conns.size).toBe(1);
    c.close();
    await c.ev.when(() => c.closeCode !== null);
  });

  test("errors are messages (4404, 4400, too many channels, too many opens; a reopen is free); the socket stays", async () => {
    const files = Array.from({ length: 9 }, (_, i) => `many/n${i}.md`);
    for (const f of files) await note(f, `${f}\n`);
    const c = new V2({});
    await welcomed(c);
    expect(await c.open("missing")).toMatchObject({ t: "error", req: "missing", path: "missing.md", code: 4404 });
    expect(await c.open("../etc/passwd")).toMatchObject({ t: "error", code: 4400 });
    const replies = await Promise.all(files.map((f) => c.open(f)));
    expect(replies.filter((r) => r.t === "opened").length).toBe(8);
    expect(replies.filter((r) => r.t === "error").map((r) => r.code)).toEqual([4429]);
    // 1 failed (the invalid path isn't counted) + 9 = 10 opens so far: 22 more are allowed in this window (a missing
    // note counts too), the 23rd isn't
    c.control({ t: "close", ch: c.chOf.get(files[0]!)! });
    for (let i = 0; i < 22; i++) expect(await c.open(`gone${i}`)).toMatchObject({ t: "error", code: 4404 });
    expect(await c.open("gone22")).toMatchObject({ t: "error", code: 4429, reason: "too many opens" });
    // going back to a note closed on this socket a moment ago isn't counted
    expect(await c.open(files[0]!)).toMatchObject({ t: "opened" });
    expect(c.closeCode).toBeNull();
    c.close();
  });

  test("a reconnect re-opens with sv: edits made while away aren't lost", async () => {
    await note("away.md", "start\n");
    const c1 = new V2({});
    await welcomed(c1);
    const first = await c1.open("away.md");
    await c1.ev.when(() => c1.text("away.md") === "start\n");
    const doc = c1.doc("away.md");
    c1.close();
    await c1.ev.when(() => c1.closeCode !== null);
    // while away: the local doc gets an edit, and a v1 user edits the note
    doc.getText("md").insert(doc.getText("md").length, "offline\n");
    const v1 = new V1("away.md");
    await v1.ev.when(() => v1.text.toString() === "start\n");
    v1.text.insert(0, "meanwhile\n");
    // the new socket reopens with the same doc and its state vector
    const c2 = new V2({});
    c2.docs.set("away.md", doc);
    doc.on("update", (u: Uint8Array, origin: unknown) => {
      const ch = c2.chOf.get("away.md");
      if (origin !== "remote" && ch !== undefined) c2.send(mux.withChannel(ch, syncFrame((enc) => syncProtocol.writeUpdate(enc, u))));
    });
    await welcomed(c2);
    const again = await c2.open("away.md", { sv: mux.encodeSv(Y.encodeStateVector(doc)) });
    expect(again.generation).toBe(first.generation);
    await v1.ev.when(() => v1.text.toString() === "meanwhile\nstart\noffline\n");
    await c2.ev.when(() => c2.text("away.md") === "meanwhile\nstart\noffline\n");
    expect(app.ctx.rooms.peek(ws, "away.md")!.text.toString()).toBe("meanwhile\nstart\noffline\n");
    v1.close();
    c2.close();
  });

  test("a reset ends the channel 1013 (the socket stays); the reopen gets a new generation", async () => {
    await note("reset.md", "reset\n");
    const c = new V2({});
    await welcomed(c);
    const r = await c.open("reset.md");
    const v1 = new V1("reset.md");
    await v1.ev.when(() => v1.text.toString() === "reset\n");
    await app.ctx.rooms.discardRepo(ws);
    await c.ev.when(() => (c.chCtl.get(r.ch) ?? []).some((m) => m.t === "end"));
    expect(c.chCtl.get(r.ch)!.find((m) => m.t === "end")).toEqual({ t: "end", code: 1013, reason: "reset" });
    await v1.ev.when(() => v1.closeCode !== null);
    expect(v1.closeCode).toBe(1013);
    expect(c.closeCode).toBeNull();
    const again = await c.open("reset.md");
    expect(again.ch).not.toBe(r.ch);
    expect(again.generation).not.toBe(r.generation);
    c.close();
  });

    test("hidden channels aren't presence; view shows them", async () => {
    await note("hid.md", "hid\n");
    const watcher = new V2({}, { cookie: bob, origin: base });
    await welcomed(watcher);
    const c = new V2({});
    await welcomed(c);
    const from = watcher.ctl.length;
    const r = await c.open("hid.md", { hidden: true });
    expect(app.ctx.rooms.peek(ws, "hid.md")!.participants()).toEqual([]);
    c.control({ t: "view", ch: r.ch, hidden: false });
    const shown = await watcher.wait((m) => m.t === "presence" && m.path === "hid.md", from);
    expect(shown.users.map((u: any) => u.name)).toEqual(["Alice"]);
    // nothing was sent for the hidden open
    expect(watcher.ctl.slice(from).filter((m) => m.t === "presence" && m.path === "hid.md").length).toBe(1);
    c.close();
    await watcher.wait((m) => m.t === "presence" && m.path === "hid.md" && m.users.length === 0, from);
    watcher.close();
  });

  test("workspace events: tree (with the head) on a new note, saved on a commit, closed + end 4000 on a delete", async () => {
    await note("ev.md", "ev\n");
    const c = new V2({});
    await welcomed(c);
    const r = await c.open("ev.md");
    let from = c.ctl.length;
    await note("ev2.md", "two\n");
    const tree = await c.wait((m) => m.t === "tree", from);
    expect(tree.head).toMatch(/^[0-9a-f]{40}$/);

    from = c.ctl.length;
    const room = app.ctx.rooms.peek(ws, "ev.md")!;
    const applied = new Promise((r) => room.doc.once("update", r));
    c.doc("ev.md").getText("md").insert(0, "x");
    await applied;
    await room.flush();
    expect(await c.wait((m) => m.t === "saved" && m.path === "ev.md", from)).toMatchObject({ sha: expect.stringMatching(/^[0-9a-f]{40}$/) });

    expect((await api(alice, "DELETE", `/api/repos/${ws}/files?path=ev.md`)).status).toBe(200);
    await c.ev.when(() => (c.chCtl.get(r.ch) ?? []).some((m) => m.t === "end"));
    expect(c.chCtl.get(r.ch)!.filter((m) => m.t === "closed" || m.t === "end")).toEqual([
      { t: "closed", reason: "deleted" },
      { t: "end", code: 4000, reason: "deleted" },
    ]);
    expect(c.closeCode).toBeNull();
    c.close();
  });

  test("a note switch over an open socket takes one round trip", async () => {
    const files = ["sw1.md", "sw2.md", "sw3.md"];
    for (const f of files) await note(f, `text of ${f}\n`);
    const c = new V2({});
    await welcomed(c);
    for (const f of files) {
      const before = c.sentOn.length;
      let sentWhenText = -1;
      const t0 = performance.now();
      const reply = c.open(f);
      // checked after every frame: the moment the text is complete, the client has sent nothing but the open
      await c.ev.when(() => {
        if (c.text(f) !== `text of ${f}\n`) return false;
        // (a late answer to the previous note's step 1 may cross: only channel 0 and this note's channel count)
        sentWhenText = c.sentOn.slice(before).filter((ch) => ch === 0 || ch === c.chOf.get(f)).length;
        return true;
      });
      const ms = performance.now() - t0;
      expect((await reply).t).toBe("opened");
      expect(sentWhenText).toBe(1);
      console.log(`[timing] note switch over the socket (${f}, cold room): ${ms.toFixed(1)} ms, 1 round trip`);
      c.control({ t: "close", ch: (await reply).ch });
    }
    c.close();
  });

  test("workspace status events reach the socket; notes don't open while it isn't ready", async () => {
    await note("status.md", "status\n");
    const c = new V2({});
    await welcomed(c);
    const from = c.ctl.length;
    emit({ type: "workspace", repo: ws, status: "importing" });
    expect(await c.wait((m) => m.t === "workspace", from)).toEqual({ t: "workspace", status: "importing" });
    expect(await c.open("status.md")).toMatchObject({ t: "error", code: 1013, reason: "workspace importing" });
    emit({ type: "workspace", repo: ws, status: "ready" });
    await c.wait((m) => m.t === "workspace" && m.status === "ready", from);
    expect(await c.open("status.md")).toMatchObject({ t: "opened" });
    c.close();
  });

    test("removing the workspace: workspace removed, then a socket close 4404", async () => {
    const id = (await api(alice, "POST", "/api/workspaces", { title: "Doomed" })).data.id;
    const saved = ws;
    ws = id;
    const c = new V2({});
    await welcomed(c);
    ws = saved;
    expect((await api(alice, "DELETE", `/api/repos/${id}`)).status).toBe(200);
    await c.ev.when(() => c.closeCode !== null);
    expect(c.closeCode).toBe(4404);
    expect(c.ctl.some((m) => m.t === "workspace" && m.status === "removed")).toBe(true);
  });
});
