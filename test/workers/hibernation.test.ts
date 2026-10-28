// WorkspaceDO hibernation and eviction in Miniflare 5, behind the production router (configured from wrangler.jsonc)
// over an in-memory Git store (test/workers/hibernation.worker.js): a 431-character path, attachments over the cap,
// repeated hibernate/wake cycles with three clients, a crash in the 250 ms batch window, an eviction that closes the
// sockets mid-edit, the safety alarm (flush, sweep, idle close, presence, alarm-driven GitHub import) and how often
// one idle tab wakes its Durable Object.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
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
import { migrationStatements } from "./miniflare.ts";

const ROOT = join(import.meta.dir, "../..");
const WORKER = "grim-hibernation";
const SEED: Array<[string, string]> = [
  ["a.md", "# A\n"],
  ["b.md", "# B\n"],
];

// evictions wait for the object's timers; the idle-tab measurement watches for 40 s
setDefaultTimeout(90_000);

let outdir: string;
let script: string;

beforeAll(async () => {
  outdir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "grim-hibernation-"));
  const alias = unstable_readConfig({ config: join(ROOT, "wrangler.jsonc") }).alias ?? {};
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "hibernation.worker.js")],
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
  if (!built.success) throw new AggregateError(built.logs, "bundling the hibernation test Worker failed");
  script = built.outputs[0]!.path;
}, 60_000);

afterAll(() => {
  if (outdir) rmSync(outdir, { recursive: true, force: true });
});

const USERS = { alice: "u1", bob: "u2", carol: "u3", long: "u4" } as const;
type Who = keyof typeof USERS;

/** One Miniflare running the test Worker with these vars, D1 migrated, users signed in and workspaces seeded. */
class Instance {
  mf!: Miniflare;
  base = "";

  constructor(private vars: Record<string, string>) {}

  async start(workspaces: string[]) {
    const cfg = unstable_readConfig({ config: join(ROOT, "wrangler.jsonc") });
    const { compatibilityDate, compatibilityFlags, bindings, d1Databases, durableObjects } = unstable_getMiniflareWorkerOptions(cfg).workerOptions as Record<string, unknown>;
    this.mf = new Miniflare(
      convertV4MiniflareOptions({
        port: 0,
        workers: [
          {
            compatibilityDate,
            compatibilityFlags,
            bindings: { ...(bindings as object), ...this.vars },
            d1Databases,
            durableObjects,
            name: WORKER,
            modules: true,
            scriptPath: script,
            modulesRoot: outdir,
          },
        ],
      } as never),
    );
    this.base = (await this.mf.ready).toString().replace(/\/$/, "");
    const db = await this.db();
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

  db() {
    return this.mf.getD1Database("DB");
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

  async liveFile(repo: string, path: string) {
    return (await this.json<{ content: string }>(`/api/repos/${repo}/file?path=${encodeURIComponent(path)}`, "alice")).content;
  }

  /** Move the Durable Objects' clock ahead (their alarm stays in real time). */
  clock(ms: number) {
    return this.get(`/__test/clock?add=${ms}`);
  }

  evict(name: string, webSockets: "hibernate" | "close") {
    return this.mf.unsafeEvictDurableObject(WORKER, "WorkspaceDO", { name, webSockets });
  }

  client(repo: string, path: string, who: Who, doc?: Y.Doc) {
    return new Client(this.base, repo, path, this.headers(who), doc);
  }

  /** /api/events from now on. */
  events() {
    const abort = new AbortController();
    let text = "";
    void fetch(`${this.base}/api/events`, { signal: abort.signal })
      .then(async (res) => {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) text += new TextDecoder().decode(chunk);
      })
      .catch(() => {});
    return { text: () => text, close: () => abort.abort() };
  }

  async dispose() {
    for (const c of clients.splice(0)) c.close();
    await this.mf?.dispose();
  }
}

type Wake = { at: number; store: number; fetch: number; calls: string[] };
type Counts = { store: number; fetch: number; calls: string[]; constructs: number; built: Array<{ at: number; repo: string }>; messages: number; alarms: Array<{ at: number; repo: string; woke: boolean }>; wakes: Wake[] };
type Attachment = { path: string; branch: string; user: { name: string; email: string; avatar?: string }; generation: string; aw: Array<[number, number, string]> };
type DoState = { rooms: string[]; updates: number; presence: string[]; alarm: number | null; import: unknown; sockets: Array<{ tags: string[]; att: Attachment | null; json: number }> };

async function until(fn: () => boolean | Promise<boolean>, ms = 10_000, what = "condition") {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

const clients: Client[] = [];

/** A browser-like Yjs client on /ws (binaryType arraybuffer); pass `doc` to reconnect with the document it had. */
class Client {
  text: Y.Text;
  awareness: awarenessProtocol.Awareness;
  controls: any[] = [];
  closeCode: number | null = null;
  ws: WebSocket;

  constructor(
    base: string,
    repo: string,
    path: string,
    headers: Record<string, string>,
    public doc = new Y.Doc(),
  ) {
    clients.push(this);
    this.text = doc.getText("md");
    this.awareness = new awarenessProtocol.Awareness(doc);
    this.ws = new WebSocket(`${base.replace("http", "ws")}/ws?${new URLSearchParams({ repo, path })}`, { headers } as never);
    this.ws.binaryType = "arraybuffer";
    this.ws.addEventListener("open", () => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeSyncStep1(enc, this.doc);
      this.send(enc);
    });
    this.ws.addEventListener("close", (e) => {
      this.closeCode = e.code;
      this.doc.off("update", this.onUpdate);
      this.awareness.destroy();
    });
    this.ws.addEventListener("message", (e) => {
      const dec = decoding.createDecoder(new Uint8Array(e.data as ArrayBuffer));
      const type = decoding.readVarUint(dec);
      if (type === 0) {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, 0);
        syncProtocol.readSyncMessage(dec, enc, this.doc, "remote");
        if (encoding.length(enc) > 1) this.send(enc);
      } else if (type === 1) {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), "remote");
      } else if (type === 2) {
        this.controls.push(JSON.parse(decoding.readVarString(dec)));
      }
    });
    this.doc.on("update", this.onUpdate);
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
    this.send(enc);
  };

  sendAwareness(update: Uint8Array) {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 1);
    encoding.writeVarUint8Array(enc, update);
    this.send(enc);
  }

  send(enc: encoding.Encoder) {
    if (this.ws.readyState === 1) this.ws.send(encoding.toUint8Array(enc));
  }

  hello() {
    return this.controls.find((m) => m.t === "hello") as { generation: string } | undefined;
  }

  async ready() {
    await until(() => this.closeCode !== null || !!this.hello(), 10_000, "hello");
    expect(this.closeCode).toBeNull();
    return this.hello()!;
  }

  flush() {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 2);
    encoding.writeVarString(enc, JSON.stringify({ t: "flush" }));
    this.send(enc);
  }

  /** The other clients' awareness states, by client id. */
  others(): Map<number, any> {
    return new Map([...this.awareness.getStates().entries()].filter(([id]) => id !== this.doc.clientID));
  }

  close() {
    if (this.ws.readyState <= 1) this.ws.close();
    this.awareness.destroy();
  }
}

/** An awareness update for a client id that isn't the socket's own (a second editor in the same tab, an agent). */
function foreignAwareness(clientId: number, clock: number, state: unknown) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 1);
  encoding.writeVarUint(enc, clientId);
  encoding.writeVarUint(enc, clock);
  encoding.writeVarString(enc, JSON.stringify(state));
  return encoding.toUint8Array(enc);
}

/** Wait until the object has no timers left (quiet commit, 250 ms batch, blame, head writer), so it can be evicted. */
async function settle(mf: Instance, repo: string, path: string, text: () => string) {
  await until(async () => (await mf.gitFile(repo, path)) === text(), 15_000, "the quiet commit");
  // blame (≤ 1 s) and the head writer's trailing write (5 s from the previous one) are timers too
  await Bun.sleep(1200);
}

describe("hibernation (sockets kept)", () => {
  // the quiet commit is soon so evictions don't wait long; the alarm stays out of the way
  const mf = new Instance({ QUIET_MS: "500", WORKSPACE_ALARM_MS: "600000" });
  beforeAll(() => mf.start(["h1", "h2", "h3", "h4", "h5", "h6"]), 60_000);
  afterAll(() => mf.dispose());

  // 431 characters: eight 47-character folders and a 47-character note name in two-byte characters
  const DEEP = Array.from({ length: 8 }, (_, i) => `folder-${i}-${"x".repeat(38)}/`).join("") + `deep-${"é".repeat(39)}.md`;

  test("a 431-character path: the socket tag is a short hash, the attachment keeps the path, the wake works", async () => {
    expect(DEEP.length).toBe(431);
    expect((await mf.post("/api/repos/h1/files", { path: DEEP, content: "deep\n" })).status).toBe(201);
    const a = mf.client("h1", DEEP, "alice");
    const b = mf.client("h1", DEEP, "bob");
    const generation = (await a.ready()).generation;
    expect((await b.ready()).generation).toBe(generation);
    await until(() => a.text.toString() === "deep\n" && b.text.toString() === "deep\n");
    a.awareness.setLocalState({ cursor: { anchor: 1, head: 1 } });
    b.awareness.setLocalState({ cursor: { anchor: 2, head: 2 } });
    await until(() => a.others().size === 1 && b.others().size === 1);
    a.text.insert(0, "alice ");
    await until(() => b.text.toString() === "alice deep\n");

    const st = await mf.state("h1");
    expect(st.sockets).toHaveLength(2);
    for (const s of st.sockets) {
      expect(s.tags).toEqual(["p:" + sha256(DEEP).slice(0, 32)]);
      expect(s.tags[0]!.length).toBeLessThanOrEqual(256);
      expect(s.att!.path).toBe(DEEP);
      expect(s.att!.aw).toHaveLength(1);
      expect(s.json).toBeLessThanOrEqual(1800);
    }

    await settle(mf, "h1", DEEP, () => a.text.toString());
    const before = await mf.counts(true);
    await mf.evict("h1", "hibernate");
    b.text.insert(b.text.length, "bob after the wake\n");
    await until(() => a.text.toString().endsWith("bob after the wake\n"));
    b.awareness.setLocalState({ cursor: { anchor: 3, head: 3 } });
    await until(() => a.others().get(b.doc.clientID)?.cursor?.anchor === 3);
    const after = await mf.counts();
    expect(after.constructs).toBe(before.constructs + 1);
    expect(after.wakes).toHaveLength(1);
    expect(after.wakes[0]).toMatchObject({ store: 0, fetch: 0, calls: [] });

    // a late joiner: same generation, the text, both cursors (alice's restored from her attachment)
    const c = mf.client("h1", DEEP, "carol");
    expect((await c.ready()).generation).toBe(generation);
    await until(() => c.text.toString() === a.text.toString());
    await until(() => c.others().size === 2);
    expect(c.others().get(a.doc.clientID)?.cursor?.anchor).toBe(1);
    for (const x of [a, b, c]) x.close();
  });

  test("attachments stay under the cap: big and extra awareness states are dropped, long names and avatars cut", async () => {
    const a = mf.client("h2", "a.md", "long");
    const b = mf.client("h2", "a.md", "bob");
    await a.ready();
    await b.ready();
    const sizes = async () => (await mf.state("h2")).sockets.map((s) => s.json);

    // the long user's attachment alone is over the cap: its avatar goes and the name and email are cut
    let st = await mf.state("h2");
    const mine = st.sockets.find((s) => s.att!.user.name.startsWith("N"))!;
    expect(mine.att!.user.avatar).toBeUndefined();
    expect(mine.att!.user.name).toBe("N".repeat(100));
    expect(mine.att!.user.email.length).toBe(200);

    // three states on one socket: the room keeps two; a small one fits, a 1.5 KB one doesn't
    b.awareness.setLocalState({ cursor: { anchor: 1, head: 1 }, user: { name: "Bob" } });
    b.sendAwareness(foreignAwareness(7001, 1, { cursor: { anchor: 2, head: 2 }, pad: "y".repeat(1500) }));
    b.sendAwareness(foreignAwareness(7002, 1, { cursor: { anchor: 3, head: 3 } }));
    await until(() => a.others().has(7001));
    expect(a.others().has(7002)).toBe(false);
    const bobAtt = async () => (await mf.state("h2")).sockets.find((s) => s.att!.user.name === "Bob")!;
    await until(async () => (await bobAtt()).att!.aw.length === 1);
    expect((await bobAtt()).att!.aw.map(([id]) => id)).toEqual([b.doc.clientID]);
    for (const n of await sizes()) expect(n).toBeLessThanOrEqual(1800);

    // the big state shrinks: now both fit
    b.sendAwareness(foreignAwareness(7001, 2, { cursor: { anchor: 4, head: 4 } }));
    await until(async () => (await bobAtt()).att!.aw.length === 2);

    // a state in two-byte characters: what is stored is always the latest (or dropped), never an older one
    b.awareness.setLocalState({ cursor: { anchor: 5, head: 5 }, user: { name: "Bob ✍️" }, pad: "z".repeat(1100) });
    await until(() => a.others().get(b.doc.clientID)?.cursor?.anchor === 5);
    await until(async () => !(await bobAtt()).att!.aw.some(([id, , s]) => id === b.doc.clientID && JSON.parse(s).cursor.anchor === 1), 3000, "the attachment to change");
    for (const n of await sizes()) expect(n).toBeLessThanOrEqual(1800);

    // after a wake, the states that were kept come back, the dropped ones don't
    await settle(mf, "h2", "a.md", () => a.text.toString());
    st = await mf.state("h2");
    const kept = new Set(st.sockets.flatMap((s) => s.att!.aw.map(([id]) => id)));
    await mf.evict("h2", "hibernate");
    a.text.insert(0, "wake ");
    await until(() => b.text.toString().startsWith("wake "));
    const c = mf.client("h2", "a.md", "carol");
    await c.ready();
    await until(() => c.text.toString() === a.text.toString());
    await until(() => [...kept].every((id) => c.others().has(id)), 5000, "restored awareness");
    expect([...c.others().keys()].filter((id) => !kept.has(id) && id !== a.doc.clientID)).toEqual([]);
    for (const x of [a, b, c]) x.close();
  });

  test("five hibernate/wake cycles with three clients: they converge every time, each wake makes 0 store calls and 0 fetches", async () => {
    const [a, b, c] = (["alice", "bob", "carol"] as const).map((who) => mf.client("h3", "a.md", who));
    const generation = (await a!.ready()).generation;
    await b!.ready();
    await c!.ready();
    const all = [a!, b!, c!];
    await until(() => all.every((x) => x.text.toString() === "# A\n"));
    all.forEach((x, i) => x.awareness.setLocalState({ cursor: { anchor: i, head: i } }));
    await until(() => all.every((x) => x.others().size === 2));
    const same = () => all.every((x) => x.text.toString() === a!.text.toString());

    for (let cycle = 1; cycle <= 5; cycle++) {
      await settle(mf, "h3", "a.md", () => a!.text.toString());
      const before = await mf.counts(true);
      await mf.evict("h3", "hibernate");
      expect(all.every((x) => x.ws.readyState === 1)).toBe(true);
      // all three type at once into the sleeping object
      all.forEach((x, i) => x.text.insert(i % 2 ? 0 : x.text.length, `${cycle}${"abc"[i]} `));
      await until(() => same() && (a!.text.toString().match(new RegExp(`${cycle}[abc] `, "g")) ?? []).length === 3, 10_000, `cycle ${cycle} to converge`);
      all.forEach((x, i) => x.awareness.setLocalState({ cursor: { anchor: cycle * 10 + i, head: cycle * 10 + i } }));
      await until(() => all.every((x) => [...x.others().values()].every((s) => Math.floor(s.cursor?.anchor / 10) === cycle)), 10_000, `cycle ${cycle} cursors`);
      const after = await mf.counts();
      expect(after.constructs).toBe(before.constructs + 1);
      expect(after.wakes).toHaveLength(1);
      expect(after.wakes[0]).toMatchObject({ store: 0, fetch: 0, calls: [] });
      // nothing since read the note from Git: at most the quiet commit (head + commit) has started
      expect(after.calls.filter((k) => k !== "head" && k !== "commit")).toEqual([]);
      expect(after.fetch).toBe(0);
    }
    const d = mf.client("h3", "a.md", "alice");
    expect((await d.ready()).generation).toBe(generation);
    await until(() => d.text.toString() === a!.text.toString());
    await settle(mf, "h3", "a.md", () => a!.text.toString());
    for (const x of [...all, d]) x.close();
  });

  test("a crash inside the 250 ms batch window loses at most that batch; the crash log has the rest and clients resend it", async () => {
    const a = mf.client("h4", "a.md", "alice");
    const b = mf.client("h4", "a.md", "bob");
    const generation = (await a.ready()).generation;
    await b.ready();
    await until(() => a.text.toString() === "# A\n" && b.text.toString() === "# A\n");
    // nothing reaches Git: only the crash log keeps what was typed
    await mf.get("/__test/hang?repo=h4");
    a.text.insert(a.text.length, "logged\n");
    await until(() => b.text.toString().endsWith("logged\n"));
    await Bun.sleep(400); // past the 250 ms batch: in the crash log
    const logged = (await mf.state("h4")).updates;
    await mf.get("/__test/crash?repo=h4");
    a.text.insert(a.text.length, "in flight\n");
    await until(() => a.closeCode !== null && b.closeCode !== null, 10_000, "the sockets to close");
    await mf.get("/__test/hang");

    // the object comes back from the crash log: the first line is there, the in-flight batch isn't
    const st = await mf.state("h4");
    expect(st.rooms).toEqual(["a.md"]);
    expect(st.updates).toBe(logged);
    expect(await mf.liveFile("h4", "a.md")).toBe("# A\nlogged\n");
    expect(await mf.gitFile("h4", "a.md")).toBe("# A\n");

    // alice reconnects with her document: same generation, and her sync brings the lost batch back
    const a2 = mf.client("h4", "a.md", "alice", a.doc);
    expect((await a2.ready()).generation).toBe(generation);
    await until(async () => (await mf.liveFile("h4", "a.md")) === "# A\nlogged\nin flight\n");
    const b2 = mf.client("h4", "a.md", "bob", b.doc);
    await b2.ready();
    await until(() => b2.text.toString() === "# A\nlogged\nin flight\n");
    a2.flush();
    await until(async () => (await mf.gitFile("h4", "a.md")) === "# A\nlogged\nin flight\n");
    a2.close();
    b2.close();
  });

  test("an eviction that closes the sockets right after a keystroke loses nothing (the batch is written first)", async () => {
    const a = mf.client("h5", "a.md", "alice");
    const generation = (await a.ready()).generation;
    await until(() => a.text.toString() === "# A\n");
    await mf.get("/__test/hang?repo=h5");
    a.text.insert(a.text.length, "one\n");
    await Bun.sleep(400);
    a.text.insert(a.text.length, "two\n");
    // within the batch window: Miniflare evicts once the object's timers ran (the batch, then the quiet commit, which hangs)
    await Bun.sleep(30);
    await mf.evict("h5", "close");
    await until(() => a.closeCode !== null);
    await mf.get("/__test/hang");
    expect(await mf.gitFile("h5", "a.md")).toBe("# A\n");
    expect(await mf.liveFile("h5", "a.md")).toBe("# A\none\ntwo\n");
    const b = mf.client("h5", "a.md", "bob");
    expect((await b.ready()).generation).toBe(generation);
    await until(() => b.text.toString() === "# A\none\ntwo\n");
    b.flush();
    await until(async () => (await mf.gitFile("h5", "a.md")) === "# A\none\ntwo\n");
    b.close();
  });

  test("one idle tab: how often its Durable Object wakes (awareness renewals every 15 s)", async () => {
    const a = mf.client("h6", "a.md", "alice");
    await a.ready();
    a.awareness.setLocalState({ cursor: { anchor: 0, head: 0 } });
    await until(async () => (await mf.state("h6")).sockets[0]?.att?.aw.length === 1);
    await settle(mf, "h6", "a.md", () => "# A\n");
    await mf.counts(true);
    // let workerd hibernate the object by itself when it's idle (no forced eviction)
    const WATCH = 40_000;
    const start = Date.now();
    await Bun.sleep(WATCH);
    const c = await mf.counts();
    const wakes = c.wakes.map((w) => Math.round((w.at - start) / 100) / 10);
    const intervals = wakes.slice(1).map((t, i) => Math.round((t - wakes[i]!) * 10) / 10);
    console.log(
      `[idle tab] ${WATCH / 1000} s: ${c.messages} messages, ${c.constructs} constructions, ${c.wakes.length} wakes at ${wakes.join(", ")} s (intervals ${intervals.join(", ")} s), store calls ${c.store}, fetches ${c.fetch}`, JSON.stringify(c.built.map((b) => [b.repo, Math.round((b.at - start) / 100) / 10]))
    );
    // each renewal (15–18 s apart) arrives at a hibernated object: a wake, with no store calls and no fetches
    expect(c.messages).toBeGreaterThanOrEqual(2);
    expect(c.wakes.length).toBe(c.messages);
    for (const w of c.wakes) expect(w).toMatchObject({ store: 0, fetch: 0 });
    for (const i of intervals) expect(i).toBeGreaterThanOrEqual(14);
    a.close();
  });
});

describe("the safety alarm", () => {
  // the quiet commit never comes by itself: only the alarm (every 1.5 s) flushes
  const mf = new Instance({ QUIET_MS: "600000", WORKSPACE_ALARM_MS: "1500" });
  beforeAll(() => mf.start(["al1", "al2", "al3"]), 60_000);
  afterAll(() => mf.dispose());

  const alarmsOf = async (repo: string) => (await mf.counts()).alarms.filter((x) => x.repo === repo).length;
  /** Wait for `n` more alarm runs of this workspace. */
  async function alarms(repo: string, n = 1) {
    const start = await alarmsOf(repo);
    await until(async () => (await alarmsOf(repo)) >= start + n, 15_000, `${n} alarm(s) of ${repo}`);
  }

  test("flushes a dirty note while people are editing, and keeps running while sockets are open", async () => {
    const a = mf.client("al1", "a.md", "alice");
    await a.ready();
    await until(() => a.text.toString() === "# A\n");
    a.text.insert(a.text.length, "flushed by the alarm\n");
    await until(async () => (await mf.gitFile("al1", "a.md")) === "# A\nflushed by the alarm\n", 10_000, "the alarm's flush");
    await alarms("al1", 2);
    expect((await mf.state("al1")).alarm).not.toBeNull();
    a.close();
  });

  test("sweeps awareness nobody renewed for 30 s, closes idle rooms, then stops", async () => {
    const ev = mf.events();
    const a = mf.client("al2", "a.md", "alice");
    const b = mf.client("al2", "a.md", "bob");
    await a.ready();
    await b.ready();
    await until(() => a.text.toString() === "# A\n" && b.text.toString() === "# A\n", 10_000, "al2 sync");
    a.awareness.setLocalState({ cursor: { anchor: 1, head: 1 } });
    b.awareness.setLocalState({ cursor: { anchor: 2, head: 2 } });
    await until(() => a.others().size === 1 && b.others().size === 1);
    await until(() => ev.text().includes('"repo":"al2","path":"a.md","users":[{'));

    // 31 s later for the object (the clients' renewals are 15 s away in real time): the alarm removes both states
    await mf.clock(31_000);
    await until(() => a.others().size === 0 && b.others().size === 0, 10_000, "the sweep");

    // both leave with an unsaved edit; 56 s later the idle room is committed and closed, and the alarm stops
    a.text.insert(0, "last words ");
    await until(() => b.text.toString().startsWith("last words "));
    a.close();
    b.close();
    await until(async () => (await mf.state("al2")).sockets.length === 0);
    expect((await mf.state("al2")).rooms).toEqual(["a.md"]);
    await until(() => ev.text().includes('"repo":"al2","path":"a.md","users":[]'));
    await mf.clock(56_000);
    await until(async () => (await mf.state("al2")).rooms.length === 0, 10_000, "the idle close");
    expect(await mf.gitFile("al2", "a.md")).toBe("last words # A\n");
    await until(async () => (await mf.state("al2")).alarm === null, 10_000, "the alarm to stop");
    const n = await alarmsOf("al2");
    await Bun.sleep(3000);
    expect(await alarmsOf("al2")).toBe(n);
    ev.close();
  });

  test("after an eviction that closes the sockets, the alarm reopens the note and clears its presence", async () => {
    const ev = mf.events();
    const a = mf.client("al3", "b.md", "alice");
    await a.ready();
    await until(() => a.text.toString() === "# B\n", 10_000, "al3 sync");
    a.awareness.setLocalState({ cursor: { anchor: 1, head: 1 } });
    await until(() => ev.text().includes('"repo":"al3","path":"b.md","users":[{'), 10_000, "al3 presence");
    a.text.insert(0, "kept ");
    await alarms("al3", 1);
    await until(async () => (await mf.gitFile("al3", "b.md")) === "kept # B\n", 20_000, "al3 flush").catch(async (e) => {
      const c = await mf.counts();
      throw new Error(`${e.message}: ${JSON.stringify({ state: await mf.state("al3"), alarms: c.alarms.filter((x) => x.repo === "al3").map((x) => x.at - Date.now()), git: await mf.gitFile("al3", "b.md"), text: a.text.toString(), calls: c.calls.slice(-30) })}`);
    });
    // the object goes without a webSocketClose: its presence and the room's log stay behind
    const evicted = Date.now();
    await mf.evict("al3", "close");
    await until(() => a.closeCode !== null, 10_000, "al3 close");
    expect(ev.text()).not.toContain('"repo":"al3","path":"b.md","users":[]');

    // the alarm alone brings the object back (nothing else calls it): it knows its name and reopens the logged room
    await until(async () => (await mf.counts()).alarms.some((x) => x.at > evicted && x.woke && x.repo !== "al1"), 15_000, "the alarm after the eviction");
    const c = await mf.counts();
    expect(c.alarms.filter((x) => x.at > evicted && x.repo !== "al1").map((x) => x.repo)).toContain("al3");
    expect(c.built.filter((x) => x.at > evicted).map((x) => x.repo)).toEqual(["al3"]);
    const st = await mf.state("al3");
    expect(st.presence).toEqual(["b.md"]);
    expect(st.rooms).toEqual(["b.md"]);

    // once it has been idle it's closed and the presence emptied
    await alarms("al3", 1);
    await mf.clock(56_000);
    await until(() => ev.text().includes('"repo":"al3","path":"b.md","users":[]'), 15_000, "presence cleared");
    await until(async () => {
      const st = await mf.state("al3");
      return st.rooms.length === 0 && st.presence.length === 0 && st.alarm === null;
    }, 15_000, "the object to go idle");
    expect(await mf.gitFile("al3", "b.md")).toBe("kept # B\n");
    ev.close();
  });

  test("runs a GitHub import step by step (startImport → runDueImport): copy, head polls, ready", async () => {
    const db = await mf.db();
    await db.prepare("INSERT INTO repos (id, title, kind, gh_owner, gh_name, read_only, branch, status, created_at) VALUES ('gh1', 'gh1', 'github', 'octo', 'notes', 1, 'main', 'importing', ?)").bind(Date.now()).run();
    await mf.counts(true);
    const now = Number((await (await mf.clock(0)).json()).offset) + Date.now();
    const state = { id: "gh1", owner: "octo", name: "notes", readOnly: true, branch: "main", phase: "create", polls: 0, head: null, at: now };
    expect((await mf.post("/__test/import?repo=gh1", state)).status).toBe(200);
    const status = async () => (await db.prepare("SELECT status, error FROM repos WHERE id = 'gh1'").first<{ status: string; error: string | null }>())!;
    // create, wait (empty: polls again 3 s later), wait (has commits), finish
    await until(async () => (await status()).status !== "importing", 20_000, "the import").catch(async (e) => {
      const c = await mf.counts();
      throw new Error(`${e.message}: ${JSON.stringify({ state: await mf.state("gh1"), alarms: c.alarms.filter((x) => x.repo === "gh1"), built: c.built, calls: c.calls, now: Date.now() })}`);
    });
    expect(await status()).toEqual({ status: "ready", error: null });
    const c = await mf.counts();
    expect(c.alarms.filter((x) => x.repo === "gh1").length).toBeGreaterThanOrEqual(4);
    expect(c.calls.filter((k) => k === "createRepo")).toHaveLength(1);
    expect((await mf.state("gh1")).import).toBeNull();
    expect(await mf.gitFile("gh1", "README.md")).toBe("# Imported\n");
    const tree = await mf.json<{ files: string[] }>("/api/repos/gh1/tree", "alice");
    expect(tree.files).toEqual(["README.md"]);
    // nothing is open there: the alarm isn't set again
    await until(async () => (await mf.state("gh1")).alarm === null, 10_000, "the alarm to stop");
  });
});
