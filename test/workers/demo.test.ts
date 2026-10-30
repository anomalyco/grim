// The demo workspace on Workers (Miniflare 5, configured from wrangler.jsonc: the production router, WorkspaceDO,
// cron handler and static assets). It's all in memory, as on Bun. A fresh instance serves /app/demo with no setup.
// Two clients edit, and a long idle gap with sockets open loses nothing (the sockets aren't hibernatable). After
// everyone leaves and the object is evicted, the next client gets the seed. Bun's limits answer with the same
// message. The 5-minute cron resets it every DEMO_RESET_MINUTES: the seed comes back and every socket is closed with 1013.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { unstable_getMiniflareWorkerOptions } from "wrangler";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { DEMO_FULL, DEMO_SEED } from "../../src/server/demo.ts";
import { sha256 } from "../../src/server/ids.ts";
import { migrationStatements, localConfig } from "./miniflare.ts";

const ROOT = join(import.meta.dir, "../..");
const WORKER = "grim-demo";
// the */5 cron at a DEMO_RESET_MINUTES boundary (the epoch is one for any interval)
const RESET = "*/5 * * * *";
const ALICE = { origin: "", cookie: "np_session=tok-alice" };
const BOB = { origin: "", cookie: "np_session=tok-bob" };
const WELCOME = DEMO_SEED.find((f) => f.path === "Welcome.md")!.content;
const SEED_TREE = ["Agents.md", "Welcome.md", "tour/Ideas.md", "tour/Markdown cheatsheet.md"];

// the idle gap is 20 s; evictions wait for the object's timers
setDefaultTimeout(90_000);

let mf: Miniflare;
let base: string;
let outdir: string;

beforeAll(async () => {
  const cfg = localConfig();
  // the client build and wrangler's build step (stages .wrangler/assets), as `wrangler dev` would run them
  if (!existsSync(join(ROOT, "dist/index.html")) || !existsSync(join(ROOT, "dist/main.js"))) run(["bun", "run", "build:client"]);
  run(["sh", "-c", cfg.build.command!]);
  outdir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "grim-demo-"));
  const alias = cfg.alias ?? {};
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "demo.worker.js")],
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
  if (!built.success) throw new AggregateError(built.logs, "bundling the demo test Worker failed");
  const { compatibilityDate, compatibilityFlags, bindings, d1Databases, durableObjects, assets } = unstable_getMiniflareWorkerOptions(cfg).workerOptions as Record<string, unknown>;
  mf = new Miniflare(
    convertV4MiniflareOptions({
      port: 0,
      workers: [
        {
          compatibilityDate,
          compatibilityFlags,
          bindings: { ...(bindings as object), QUIET_MS: "1000", WORKSPACE_ALARM_MS: "600000" },
          d1Databases,
          durableObjects,
          assets,
          name: WORKER,
          modules: true,
          scriptPath: built.outputs[0]!.path,
          modulesRoot: outdir,
        },
      ],
    } as never),
  );
  base = (await mf.ready).toString().replace(/\/$/, "");
  ALICE.origin = BOB.origin = base;
  // a D1 database as a deploy leaves it, but from before the migration that adds the demo's row: the Worker puts it in
  const db = await mf.getD1Database("DB");
  await db.batch(migrationStatements().map((s) => db.prepare(s)));
  await db.prepare("DELETE FROM repos WHERE id = 'demo'").run();
  const now = Date.now();
  await db.batch([
    db.prepare("INSERT INTO users (id, login, name, email, created_at) VALUES ('u1', 'alice', 'Alice', 'alice@example.com', ?)").bind(now),
    db.prepare("INSERT INTO users (id, login, name, email, created_at) VALUES ('u2', 'bob', 'Bob', 'bob@example.com', ?)").bind(now),
    db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, 'u1', ?)").bind(sha256("tok-alice"), now + 3_600_000),
    db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, 'u2', ?)").bind(sha256("tok-bob"), now + 3_600_000),
  ]);
}, 120_000);

afterAll(async () => {
  for (const c of clients) c.close();
  await mf?.dispose();
  if (outdir) rmSync(outdir, { recursive: true, force: true });
  rmSync(join(ROOT, ".wrangler/assets"), { recursive: true, force: true });
});

function run(cmd: string[]) {
  const p = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed: ${p.stderr.toString()}`);
}

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = ALICE) {
  const res = await fetch(base + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, data };
}

const tree = async () => (await api("GET", "/api/workspace/demo/tree")).data.files as string[];
const read = async (path: string) => (await api("GET", `/api/workspace/demo/file?path=${encodeURIComponent(path)}`)).data as { content: string; live: boolean };
const history = async () => ((await api("GET", "/api/workspace/demo/history")).data as Array<{ message: string }>).map((c) => c.message);

async function until(fn: () => boolean | Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

async function fire(cron: string) {
  const worker = await mf.getWorker(WORKER);
  return (await worker.scheduled({ cron, scheduledTime: new Date(0) })) as { outcome: string };
}

const clients: Client[] = [];

/** A browser-like Yjs client on a demo note. */
class Client {
  doc = new Y.Doc();
  text = this.doc.getText("md");
  controls: any[] = [];
  closeCode: number | null = null;
  ws: WebSocket;

  constructor(path: string, headers: Record<string, string> = ALICE) {
    clients.push(this);
    this.ws = new WebSocket(`${base.replace("http", "ws")}/ws?${new URLSearchParams({ repo: "demo", path })}`, { headers } as never);
    this.ws.binaryType = "arraybuffer";
    this.ws.addEventListener("open", () => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeSyncStep1(enc, this.doc);
      this.send(enc);
    });
    this.ws.addEventListener("close", (e) => (this.closeCode = e.code));
    this.ws.addEventListener("message", (e) => {
      const dec = decoding.createDecoder(new Uint8Array(e.data as ArrayBuffer));
      const type = decoding.readVarUint(dec);
      if (type === 0) {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, 0);
        syncProtocol.readSyncMessage(dec, enc, this.doc, "remote");
        if (encoding.length(enc) > 1) this.send(enc);
      } else if (type === 2) this.controls.push(JSON.parse(decoding.readVarString(dec)));
    });
    this.doc.on("update", (u: Uint8Array, origin: unknown) => {
      if (origin === "remote") return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeUpdate(enc, u);
      this.send(enc);
    });
  }

  send(enc: encoding.Encoder) {
    if (this.ws.readyState === 1) this.ws.send(encoding.toUint8Array(enc));
  }

  async ready() {
    await until(() => this.closeCode !== null || this.controls.some((m) => m.t === "hello"));
    expect(this.closeCode).toBeNull();
  }

  close() {
    if (this.ws.readyState <= 1) this.ws.close();
  }

  async closed() {
    this.close();
    await until(() => this.closeCode !== null);
  }
}

/** Evict the demo's object (Miniflare waits for its timers, so let the quiet commit and the head writer finish). */
async function evict() {
  await Bun.sleep(1500);
  await mf.unsafeEvictDurableObject(WORKER, "WorkspaceDO", { name: "demo", webSockets: "close" });
}

describe("the demo workspace on Workers", () => {
  test("a fresh instance: /app/demo works with no setup (the page, the row, the seed)", async () => {
    const page = await fetch(`${base}/app/demo`, { headers: { accept: "text/html" } });
    expect(page.status).toBe(200);
    expect(await page.text()).toMatch(/"\/dist\/main\.[0-9a-f]{12}\.js"/);
    // what the page asks for, without a sign-in
    expect((await api("GET", "/api/workspace/demo", undefined, {})).data).toMatchObject({ id: "demo", title: "Demo", kind: "notes", readOnly: false, canRemove: false, status: "ready" });
    expect(await tree()).toEqual(SEED_TREE);
    expect(await read("Welcome.md")).toMatchObject({ content: WELCOME, live: false });
    expect(await history()).toEqual(["Start the demo"]);
    expect((await api("DELETE", "/api/workspace/demo")).status).toBe(403);
    // nothing of it in the object's SQLite: no demo store tables, no crash log
    const sql = (await (await fetch(`${base}/api/__test/sql`)).json()) as { tables: string[] };
    expect(sql.tables.filter((t) => t.startsWith("demo_"))).toEqual([]);
  });

  test("two clients edit; a 20 s idle gap with sockets open loses nothing (no hibernation); no crash log", async () => {
    const a = new Client("Welcome.md", ALICE);
    const b = new Client("Welcome.md", BOB);
    await a.ready();
    await b.ready();
    await until(() => a.text.toString() === WELCOME && b.text.toString() === WELCOME);
    a.text.insert(0, "Alice. ");
    b.text.insert(b.text.length, "Bob.\n");
    const both = "Alice. " + WELCOME + "Bob.\n";
    await until(() => a.text.toString() === both && b.text.toString() === both);
    expect(((await (await fetch(`${base}/api/__test/sql`)).json()) as { meta: number; updates: number })).toMatchObject({ meta: 0, updates: 0 });
    await until(async () => (await history()).includes("Update Welcome.md"));

    await Bun.sleep(20_000);
    expect([a.ws.readyState, b.ws.readyState]).toEqual([1, 1]);
    b.text.insert(0, "after the gap ");
    await until(() => a.text.toString() === "after the gap " + both);
    expect((await read("Welcome.md")).content).toBe("after the gap " + both);
    await a.closed();
    await b.closed();
  });

  test("after everyone leaves and the object is evicted, the next client gets the seed", async () => {
    expect((await read("Welcome.md")).content.startsWith("after the gap ")).toBe(true);
    await evict();
    const c = new Client("Welcome.md");
    await c.ready();
    await until(() => c.text.toString() === WELCOME);
    expect(await tree()).toEqual(SEED_TREE);
    expect(await history()).toEqual(["Start the demo"]);
    await c.closed();
  });

  test("Bun's limits: too big is refused with the demo's message", async () => {
    const png = new Uint8Array(2 * 1024 * 1024 + 10);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const up = await fetch(`${base}/api/workspace/demo/images?note=Welcome.md&name=huge.png`, { method: "POST", headers: { ...ALICE, "content-type": "image/png" }, body: png });
    expect(up.status).toBe(413);
    expect(((await up.json()) as { error: string }).error).toBe(DEMO_FULL);
    expect((await api("GET", "/api/workspace/demo/tree")).status).toBe(200);
  });

  test("the cron resets it: the seed is back and the sockets get 1013", async () => {
    const a = new Client("Agents.md");
    const b = new Client("tour/Ideas.md", BOB);
    await a.ready();
    await b.ready();
    await until(() => a.text.length > 0 && b.text.length > 0);
    expect((await api("POST", "/api/workspace/demo/files", { path: "tour/New.md", content: "# New\n" })).status).toBe(201);
    a.text.insert(0, "unsaved ");
    await until(async () => (await read("Agents.md")).content.startsWith("unsaved "));

    expect((await fire(RESET)).outcome).toBe("ok");
    await until(() => a.closeCode !== null && b.closeCode !== null);
    expect([a.closeCode, b.closeCode]).toEqual([1013, 1013]);
    expect(await tree()).toEqual(SEED_TREE);
    expect(await read("Agents.md")).toMatchObject({ content: DEMO_SEED.find((f) => f.path === "Agents.md")!.content, live: false });
    expect(await history()).toEqual(["Start the demo"]);

    // clients reconnect (and reload) to the seed
    const again = new Client("Agents.md");
    await again.ready();
    await until(() => again.text.toString() === DEMO_SEED.find((f) => f.path === "Agents.md")!.content);
    await again.closed();
  });
});
