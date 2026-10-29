// WorkspaceDO in Miniflare 5, behind the production router (configured from wrangler.jsonc: compat flags, aliases,
// Durable Objects, D1) over an in-memory Git store: people co-editing a note through the Worker → DO, WorkspaceApi
// ops over RPC with named errors, a forced hibernation (sockets kept, the room rebuilt with 0 store calls and 0
// fetches), an eviction that closes the sockets (the crash log brings back the unsaved edits) and file-level 4404.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { unstable_getMiniflareWorkerOptions } from "wrangler";
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { sha256 } from "../../src/server/ids.ts";
import { migrationStatements, localConfig } from "./miniflare.ts";

const ROOT = join(import.meta.dir, "../..");
const WORKER = "grim-workspace";
// same-origin requests (the origin is set once Miniflare has its port)
const ALICE = { origin: "", cookie: "np_session=tok-alice" };
const BOB = { origin: "", cookie: "np_session=tok-bob" };

// evictions wait for the object's timers (quiet commit, head writer) to finish
setDefaultTimeout(60_000);

let mf: Miniflare;
let base: string;
let outdir: string;

beforeAll(async () => {
  const cfg = localConfig();
  outdir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "grim-workspace-"));
  const alias = cfg.alias ?? {};
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "workspace.worker.js")],
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
  if (!built.success) throw new AggregateError(built.logs, "bundling the workspace test Worker failed");
  const { compatibilityDate, compatibilityFlags, bindings, d1Databases, durableObjects } = unstable_getMiniflareWorkerOptions(cfg).workerOptions as Record<string, unknown>;
  mf = new Miniflare(
    convertV4MiniflareOptions({
      port: 0,
      workers: [
        {
          compatibilityDate,
          compatibilityFlags,
          // a pending timer keeps Miniflare from evicting, so notes are committed soon; no alarm during the test
          bindings: { ...(bindings as object), QUIET_MS: "2000", WORKSPACE_ALARM_MS: "600000" },
          d1Databases,
          durableObjects,
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
  const db = await mf.getD1Database("DB");
  await db.batch(migrationStatements().map((s) => db.prepare(s)));
  const now = Date.now();
  const stmts = [
    db.prepare("INSERT INTO users (id, login, name, email, created_at) VALUES ('u1', 'alice', 'Alice', 'alice@example.com', ?)").bind(now),
    db.prepare("INSERT INTO users (id, login, name, email, created_at) VALUES ('u2', 'bob', 'Bob', 'bob@example.com', ?)").bind(now),
    db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, 'u1', ?)").bind(sha256("tok-alice"), now + 3_600_000),
    db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, 'u2', ?)").bind(sha256("tok-bob"), now + 3_600_000),
  ];
  for (const id of ["ws1", "ws2", "ws3"]) {
    stmts.push(db.prepare("INSERT INTO repos (id, title, kind, branch, status, created_at) VALUES (?, ?, 'notes', 'main', 'ready', ?)").bind(id, id, now));
  }
  await db.batch(stmts);
  for (const id of ["ws1", "ws2", "ws3"]) expect((await get(`/__test/seed?repo=${id}`)).status).toBe(200);
}, 60_000);

afterAll(async () => {
  for (const c of clients) c.close();
  await mf?.dispose();
  if (outdir) rmSync(outdir, { recursive: true, force: true });
});

const get = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers });
const post = (path: string, body: unknown, headers: Record<string, string> = ALICE) =>
  fetch(base + path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });

async function until(fn: () => boolean | Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

const REPO = (id: string) => ({ id, title: id, kind: "notes", branch: "main", status: "ready", read_only: 0, owner_id: null, created_at: 0 });
const ACTOR = { id: "agent-1", name: "Agent", email: "agent@example.com", kind: "agent", color: "#123456" };

/** A WorkspaceApi call on the stub, from inside the Worker: `{ ok }` or the error as it arrived. */
async function rpc(repo: string, method: string, ...args: unknown[]) {
  return (await (await post("/__test/rpc", { repo, method, args })).json()) as { ok?: any; error?: { name: string; message: string; status?: number } };
}

type Counts = { store: number; fetch: number; calls: string[] };
const counts = async (repo: string, reset = false) =>
  (await (await get(`/__test/counts?repo=${repo}${reset ? "&reset=1" : ""}`)).json()) as Counts & { constructs: number; wake: Counts | null };

const clients: Client[] = [];

/** A browser-like Yjs client on /ws: document, awareness and control messages. */
class Client {
  doc = new Y.Doc();
  text = this.doc.getText("md");
  awareness = new awarenessProtocol.Awareness(this.doc);
  controls: any[] = [];
  closeCode: number | null = null;
  ws: WebSocket;

  constructor(repo: string, path: string, headers: Record<string, string>) {
    clients.push(this);
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
    this.doc.on("update", (u: Uint8Array, origin: unknown) => {
      if (origin === "remote") return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeUpdate(enc, u);
      this.send(enc);
    });
    this.awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin === "remote") return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 1);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...added, ...updated, ...removed]));
      this.send(enc);
    });
  }

  send(enc: encoding.Encoder) {
    if (this.ws.readyState === 1) this.ws.send(encoding.toUint8Array(enc));
  }

  hello() {
    return this.controls.find((m) => m.t === "hello") as { generation: string; readOnly: boolean } | undefined;
  }

  async ready() {
    await until(() => this.closeCode !== null || !!this.hello());
    expect(this.closeCode).toBeNull();
    return this.hello()!;
  }

  flush() {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 2);
    encoding.writeVarString(enc, JSON.stringify({ t: "flush" }));
    this.send(enc);
  }

  /** The users other clients' awareness states show. */
  others(): string[] {
    return [...this.awareness.getStates().entries()].filter(([id]) => id !== this.doc.clientID).map(([, s]) => (s as { user?: { name: string } }).user?.name ?? "?").sort();
  }

  close() {
    if (this.ws.readyState <= 1) this.ws.close();
  }
}

async function gitFile(repo: string, path: string) {
  return ((await (await get(`/__test/git?repo=${repo}&path=${encodeURIComponent(path)}`)).json()) as { content: string | null }).content;
}

/** /api/events for `repos` from the start: everything it has said so far. */
function events(repos: string) {
  const abort = new AbortController();
  let text = "";
  void fetch(`${base}/api/events?repos=${repos}`, { signal: abort.signal })
    .then(async (res) => {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) text += new TextDecoder().decode(chunk);
    })
    .catch(() => {});
  return { text: () => text, close: () => abort.abort() };
}

describe("co-editing through the Worker", () => {
  let alice: Client;
  let bob: Client;

  test("two clients on one note converge, and see each other's cursors", async () => {
    alice = new Client("ws1", "a.md", ALICE);
    bob = new Client("ws1", "a.md", BOB);
    const [ha, hb] = [await alice.ready(), await bob.ready()];
    expect(ha.generation).toBe(hb.generation);
    expect(ha.readOnly).toBe(false);
    await until(() => alice.text.toString() === "# A\n" && bob.text.toString() === "# A\n");
    alice.text.insert(alice.text.length, "alice was here\n");
    bob.text.insert(0, "bob: ");
    await until(() => alice.text.toString() === bob.text.toString() && alice.text.toString().includes("alice") && alice.text.toString().includes("bob"));
    expect(alice.text.toString()).toBe("bob: # A\nalice was here\n");
    alice.awareness.setLocalState({ cursor: { anchor: 1, head: 1 } });
    bob.awareness.setLocalState({ cursor: { anchor: 2, head: 2 } });
    await until(() => alice.others().join() === "Bob" && bob.others().join() === "Alice");
  });

  test("after a forced hibernation both keep editing; the wake makes no store calls and no fetches", async () => {
    // Miniflare evicts only an object with no pending timers, as a real hibernation needs: the quiet commit, the
    // 250 ms batch, the blame timer and the head writer's trailing write have to be done
    await until(async () => (await gitFile("ws1", "a.md")) === alice.text.toString());
    await Bun.sleep(1500);
    const before = await counts("ws1", true);
    await mf.unsafeEvictDurableObject(WORKER, "WorkspaceDO", { name: "ws1", webSockets: "hibernate" });
    expect(alice.ws.readyState).toBe(1);
    alice.text.insert(alice.text.length, "after the wake\n");
    await until(() => bob.text.toString().includes("after the wake"));
    bob.text.insert(bob.text.length, "bob too\n");
    await until(() => alice.text.toString().includes("bob too"));
    expect(alice.text.toString()).toBe(bob.text.toString());
    alice.awareness.setLocalState({ cursor: { anchor: 5, head: 5 } });
    await until(() => (bob.awareness.getStates().get(alice.doc.clientID) as { cursor?: { anchor: number } })?.cursor?.anchor === 5);
    const after = await counts("ws1");
    expect(after.constructs).toBe(before.constructs + 1);
    // the first frame after the wake: the room rebuilt from the crash log, the sockets put back, the edit applied
    expect(after.wake).toEqual({ store: 0, fetch: 0, calls: [] });
    // and nothing since read the note from Git (its quiet commit may have started: head + commit)
    expect(after.calls.filter((c) => c !== "head" && c !== "commit")).toEqual([]);
    expect(after.fetch).toBe(0);

    // a new client gets the text, the same generation and both cursors (restored from the attachments)
    const carol = new Client("ws1", "a.md", ALICE);
    expect((await carol.ready()).generation).toBe(alice.hello()!.generation);
    await until(() => carol.text.toString() === alice.text.toString());
    await until(() => carol.others().join() === "Alice,Bob");

    // the edits are committed when asked
    alice.flush();
    await until(async () => (await gitFile("ws1", "a.md")) === alice.text.toString());
    carol.close();
  });

  test("a second hibernation: a client leaving is seen by the other", async () => {
    await until(async () => (await gitFile("ws1", "a.md")) === alice.text.toString());
    await Bun.sleep(1500);
    await mf.unsafeEvictDurableObject(WORKER, "WorkspaceDO", { name: "ws1", webSockets: "hibernate" });
    bob.close();
    await until(() => alice.others().length === 0);
    alice.text.insert(0, "x");
    await until(async () => ((await (await get("/api/repos/ws1/file?path=a.md", ALICE)).json()) as { content: string }).content.startsWith("xbob"));
    alice.close();
  });
});

describe("WorkspaceApi over RPC", () => {
  test("tree, read, create and rename through the HTTP API (Worker → DO)", async () => {
    const tree = async () => ((await (await get("/api/repos/ws2/tree", ALICE)).json()) as { files: string[] }).files;
    expect(await tree()).toEqual(["a.md", "docs/b.md"]);
    const read = await get("/api/repos/ws2/file?path=a.md", ALICE);
    expect(((await read.json()) as { content: string }).content).toBe("# A\n");
    expect((await post("/api/repos/ws2/files", { path: "new.md", content: "hello\n" })).status).toBe(201);
    expect(await tree()).toEqual(["a.md", "docs/b.md", "new.md"]);
    const live = (await (await get("/api/repos/ws2/file?path=new.md", ALICE)).json()) as { content: string; live: boolean };
    expect(live).toMatchObject({ content: "hello\n", live: true });
    const renamed = await post("/api/repos/ws2/rename", { from: "new.md", to: "notes/renamed.md" });
    expect(renamed.status).toBe(200);
    expect(await tree()).toEqual(["a.md", "docs/b.md", "notes/renamed.md"]);
    expect(await gitFile("ws2", "notes/renamed.md")).toBe("hello\n");
    expect((await get("/api/repos/ws2/file?path=nope.md", ALICE)).status).toBe(404);
    expect((await post("/api/repos/ws2/files", { path: "a.md" })).status).toBe(409);
  });

  test("calls on the stub return plain data; errors keep their name and fields", async () => {
    expect((await rpc("ws2", "readFile", REPO("ws2"), "a.md")).ok).toMatchObject({ path: "a.md", content: "# A\n", live: false });
    expect((await rpc("ws2", "patchFile", REPO("ws2"), "a.md", "# A\n", "# A!\n", ACTOR)).ok).toMatchObject({ path: "a.md" });
    expect((await rpc("ws2", "readFile", REPO("ws2"), "a.md")).ok).toMatchObject({ content: "# A!\n", live: true });
    expect((await rpc("ws2", "appendText", REPO("ws2"), "a.md", "more\n", ACTOR)).ok).toMatchObject({ path: "a.md" });
    expect((await rpc("ws2", "tree", REPO("ws2"))).ok).toEqual(["a.md", "docs/b.md", "notes/renamed.md"]);
    expect(typeof (await rpc("ws2", "head", REPO("ws2"))).ok).toBe("string");
    expect((await rpc("ws2", "history", REPO("ws2"), undefined, 10)).ok.length).toBeGreaterThan(0);
    expect((await rpc("ws2", "renameFolder", REPO("ws2"), "docs", "papers", ACTOR)).ok).toEqual({ path: "papers" });
    expect((await rpc("ws2", "tree", REPO("ws2"))).ok).toEqual(["a.md", "notes/renamed.md", "papers/b.md"]);

    for (const [method, args, status] of [
      ["readFile", [REPO("ws2"), "nope.md"], 404],
      ["createFile", [REPO("ws2"), "a.md", "x", ACTOR], 409],
      ["diff", [REPO("ws2"), "not-a-sha"], 400],
      ["readFile", [REPO("ws2"), "a.md", "bad ref!"], 400],
      ["deleteFile", [{ ...REPO("ws2"), read_only: 1 }, "a.md", ACTOR], 403],
    ] as const) {
      const { error } = await rpc("ws2", method, ...args);
      expect(error).toMatchObject({ name: "OpError", status });
    }
    // a call for another workspace is refused
    expect((await rpc("ws2", "tree", REPO("ws1"))).error?.message).toContain("got a call for ws1");
  });
});

describe("eviction and admission", () => {
  test("after an eviction that closes the sockets, the crash log brings back the unsaved edits", async () => {
    const a = new Client("ws3", "a.md", ALICE);
    const generation = (await a.ready()).generation;
    await until(() => a.text.toString() === "# A\n");
    await Bun.sleep(1200);
    await get("/__test/hang?repo=ws3");
    a.text.insert(a.text.length, "unsaved words\n");
    // the quiet commit starts and hangs: the edit is only in the crash log when the object goes
    await until(async () => (await counts("ws3")).calls.includes("commit"));
    await Bun.sleep(1200);
    expect(await gitFile("ws3", "a.md")).toBe("# A\n");
    await mf.unsafeEvictDurableObject(WORKER, "WorkspaceDO", { name: "ws3", webSockets: "close" });
    await get("/__test/hang");
    await until(() => a.closeCode !== null);

    const read = (await (await get("/api/repos/ws3/file?path=a.md", ALICE)).json()) as { content: string; live: boolean };
    expect(read).toEqual({ content: "# A\nunsaved words\n", version: expect.any(String), live: true } as never);
    const b = new Client("ws3", "a.md", BOB);
    expect((await b.ready()).generation).toBe(generation);
    await until(() => b.text.toString() === "# A\nunsaved words\n");
    b.flush();
    await until(async () => (await gitFile("ws3", "a.md")) === "# A\nunsaved words\n");
    b.close();
  });

  test("a missing note is refused with 4404 after the upgrade", async () => {
    const c = new Client("ws3", "missing.md", ALICE);
    await until(() => c.closeCode !== null);
    expect(c.closeCode).toBe(4404);
  });

  test("a deleted note's room closes its sockets and its presence is cleared", async () => {
    const ev = events("ws3");
    const c = new Client("ws3", "docs/b.md", ALICE);
    await c.ready();
    c.awareness.setLocalState({ cursor: null });
    await until(() => ev.text().includes('"path":"docs/b.md","users":[{'));
    const res = await fetch(`${base}/api/repos/ws3/files?path=docs/b.md`, { method: "DELETE", headers: ALICE });
    expect(res.status).toBe(200);
    await until(() => c.closeCode !== null);
    expect(c.controls.at(-1)).toMatchObject({ t: "closed", reason: "deleted" });
    await until(() => ev.text().includes('"path":"docs/b.md","users":[]'));
    ev.close();
  });
});
