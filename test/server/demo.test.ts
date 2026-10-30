// The demo: a guest's demo room ("demo.<room>", from POST /api/demo/room), public, nobody's, kept in memory (routed to
// a MemoryStore; the configured store never sees it), seeded when made and back to the seed after a reset (a restart
// drops every room); no crash log; size caps; history, diffs and the agent shell work on it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { isolate, waitFor } from "./helpers.ts";
import { seedNotebook, withLinkId } from "./helpers.ts";

process.env.POLL_MS = "60000";
const { config } = await import("../../src/server/config.ts");
const { db } = await import("../../src/server/db.ts");
const restore = isolate(config, db);
Object.assign(config, { storage: "local", allowDevLogin: true, signIn: true, quietMs: 100, demoResetMinutes: 0 });
config.github.clientId = "";
config.github.appSlug = "";
const { startServer } = await import("../../src/server/index.ts");
const { DEMO_FULL, DEMO_SEED, startDemoResets } = await import("../../src/server/demo.ts");
const { StoreFullError } = await import("../../src/server/store/types.ts");

let app: Awaited<ReturnType<typeof startServer>>;
let base = "";
let alice = "";

async function start() {
  app = await startServer({ port: 0, quiet: true });
  await seedNotebook(app.ctx, "demo-test-notes");
  base = `http://localhost:${app.server.port}`;
}

async function api(cookie: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, { method, headers: { cookie, origin: base, "content-type": "application/json", ...(cookie ? {} : GUEST), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, data: withLinkId(data) };
}

const GUEST = { "x-grimoire-guest": "demoGuest01", "x-grimoire-guest-name": "lumpy-llama" };
/** The demo room the guests are in (POST /api/demo/room: demo-rooms.ts). */
let D = "";
async function demoRoom(): Promise<string> {
  const res = await fetch(`${base}/api/demo/room`, { method: "POST", headers: { origin: base, ...GUEST } });
  return ((await res.json()) as { workspace: string }).workspace;
}

/** A guest room client on a demo note. */
function guest(path: string) {
  const doc = new Y.Doc();
  const ws = new WebSocket(`${base.replace("http", "ws")}/ws?${new URLSearchParams({ repo: D, path, anon: "demoGuest01", name: "sassy-sock" })}`, { headers: { origin: base } } as any);
  ws.binaryType = "arraybuffer";
  const c = { doc, text: doc.getText("md"), controls: [] as any[], closeCode: null as number | null, synced: false, close: () => ws.close() };
  const send = (enc: encoding.Encoder) => ws.readyState === 1 && ws.send(encoding.toUint8Array(enc));
  ws.addEventListener("open", () => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeSyncStep1(enc, doc);
    send(enc);
  });
  ws.addEventListener("close", (e) => (c.closeCode = e.code));
  ws.addEventListener("message", (e) => {
    const dec = decoding.createDecoder(new Uint8Array(e.data as ArrayBuffer));
    const type = decoding.readVarUint(dec);
    if (type === 0) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      if (syncProtocol.readSyncMessage(dec, enc, doc, "remote") === 1) c.synced = true;
      if (encoding.length(enc) > 1) send(enc);
    } else if (type === 2) c.controls.push(JSON.parse(decoding.readVarString(dec)));
  });
  doc.on("update", (u: Uint8Array, origin: unknown) => {
    if (origin === "remote") return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeUpdate(enc, u);
    send(enc);
  });
  return c;
}

const demoLog = () => [
  (db.query("SELECT count(*) AS n FROM room_updates WHERE room LIKE 'demo.%'").get() as { n: number }).n,
  (db.query("SELECT count(*) AS n FROM room_meta WHERE room LIKE 'demo.%'").get() as { n: number }).n,
];
const welcome = DEMO_SEED.find((f) => f.path === "Welcome.md")!.content as string;

beforeAll(async () => {
  await start();
  const res = await fetch(`${base}/auth/dev`, { method: "POST", headers: { origin: base }, body: new URLSearchParams({ name: "Alice" }), redirect: "manual" });
  alice = res.headers.getSetCookie().find((s) => s.startsWith("np_session="))!.split(";")[0]!;
  D = await demoRoom();
});

afterAll(async () => {
  await app?.stop();
  restore();
});

describe("demo rooms", () => {
  test("ten people per room; the eleventh gets a new one and can't get into the full one", async () => {
    const ask = async (id: string) => (await (await fetch(`${base}/api/demo/room`, { method: "POST", headers: { origin: base, "x-grimoire-guest": id, "x-grimoire-guest-name": "p" } })).json()).workspace as string;
    // (the main guest is already in D: nine more fill it)
    for (let i = 0; i < 9; i++) expect(await ask(`roomPerson0${i}`)).toBe(D);
    const first = D;
    expect(await ask("roomPerson00")).toBe(first);
    const eleventh = await ask("roomPerson09");
    expect(eleventh).not.toBe(first);
    const forced = await fetch(`${base}/api/workspace/${first}/tree`, { headers: { origin: base, "x-grimoire-guest": "roomPerson09", "x-grimoire-guest-name": "p" } });
    expect(forced.status).toBe(409);
    expect((await fetch(`${base}/api/workspace/demo/tree`, { headers: { origin: base, ...GUEST } })).status).toBe(404);
  });
});

describe("demo folder", () => {
  test("seeded at startup: public, nobody's, in memory only", async () => {
    expect((await api("", "GET", `/api/workspace/${D}`)).data).toMatchObject({ id: D, title: "Demo", kind: "notes", readOnly: false, canRemove: false, status: "ready" });
    expect((await api("", "GET", `/api/workspace/${D}/tree`)).data.files).toEqual(["Welcome.md", "tour/Ideas.md", "tour/Markdown cheatsheet.md"]);
    expect((await api("", "GET", `/api/workspace/${D}/file?path=Welcome.md`)).data.content).toBe(welcome);
    expect(welcome).toContain("](images/banner.webp)");
    const img = await fetch(`${base}/api/workspace/${D}/raw?path=images/banner.webp`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/webp");
    // nobody can remove it
    // (an account isn't let into a demo room at all: the demo is for visitors)
    expect((await api(alice, "DELETE", `/api/workspace/${D}`)).status).toBe(409);
    // routed: the configured (local) store never has it; other folders are there
    expect(existsSync(join(config.dataDir, "git", `${D}.git`))).toBe(false);
    expect(existsSync(join(config.dataDir, "git", `demo-test-notes.git`))).toBe(true);
    expect(app.ctx.store.kind).toBe("local");
  });

  test("guests edit it (live and through the API); its rooms keep no crash log; other folders still do", async () => {
    const g = guest("Welcome.md");
    await waitFor(() => g.synced);
    g.text.insert(0, "Guest was here. ");
    await waitFor(() => app.ctx.rooms.peek(D, "Welcome.md")?.text.toString().startsWith("Guest was here.") ?? false);
    expect((await api("", "POST", `/api/workspace/${D}/files`, { path: "tour/New.md", content: "# New\n" }, GUEST)).status).toBe(201);
    // open to guests for creating, renaming and deleting too (elsewhere those need an account: anon.test.ts)
    expect((await api("", "GET", `/api/workspace/${D}`)).data.guestCreate).toBe(true);
    expect((await api("", "POST", `/api/workspace/${D}/files`, { path: "tmp/Gone.md", content: "x" }, GUEST)).status).toBe(201);
    expect((await api("", "POST", `/api/workspace/${D}/rename`, { from: "tmp/Gone.md", to: "tmp/Gone2.md" }, GUEST)).status).toBe(200);
    expect((await api("", "POST", `/api/workspace/${D}/rename`, { from: "tmp", to: "tmp2", folder: true }, GUEST)).status).toBe(200);
    expect((await api("", "DELETE", `/api/workspace/${D}/files?folder=tmp2`, undefined, GUEST)).status).toBe(200);
    await app.ctx.rooms.peek(D, "Welcome.md")!.flush();
    await app.ctx.rooms.peek(D, "tour/New.md")!.flush();
    expect(demoLog()).toEqual([0, 0]);
    const hist = (await api("", "GET", `/api/workspace/${D}/history?path=Welcome.md`)).data;
    expect(hist[0]).toMatchObject({ authorName: "sassy-sock (guest)", message: "Update Welcome.md" });
    expect(hist.at(-1).message).toBe("Start the demo");
    const diff = (await api("", "GET", `/api/workspace/${D}/diff?sha=${hist[0].sha}&path=Welcome.md`)).data.diff;
    expect(diff).toContain("+Guest was here. # Welcome to the demo");
    // another folder's room does use the crash log
    await api(alice, "POST", `/api/workspace/demo-test-notes/files`, { path: "logged.md", content: "x" });
    expect((db.query("SELECT count(*) AS n FROM room_meta WHERE room = ?").get(`demo-test-notes\0logged.md`) as { n: number }).n).toBe(1);
    g.close();
  });

  test("the agent shell: git log, git show, git diff, live edits", async () => {
    // agent links need an account, and accounts don't get demo rooms: a server without sign-in, whose visitors make them
    config.signIn = false;
    let share: any;
    try {
      share = (await api("", "POST", `/api/workspace/${D}/agent-link`, { label: "Bot" })).data;
    } finally {
      config.signIn = true;
    }
    const run = async (cmd: string) => (await (await fetch(`${base}/a/${share.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: cmd }) })).json()) as any;
    expect((await run("ls")).stdout).toContain("Welcome.md");
    expect((await run("git log --oneline")).stdout).toContain("Start the demo");
    expect((await run("echo '- agent idea' >> tour/Ideas.md && save tour/Ideas.md")).exitCode).toBe(0);
    const show = await run("git show HEAD");
    expect(show.stdout).toContain("+- agent idea");
    expect(show.stdout).toMatch(/Author: Bot/);
    expect((await run("git diff HEAD tour/Ideas.md")).stdout).toContain("+- agent idea");
    expect((await run("git log -n 1 tour/Ideas.md")).stdout).toContain("Update tour/Ideas.md");
  });

  test("accounts never have the demo: not joined on open or by join-many, not listed; their own workspace instead", async () => {
    const ids = async (path: string) => ((await api(alice, "GET", path)).data as Array<{ id: string }>).map((w) => w.id);
    // opening it (its tree) records no join, and join-many skips it
    expect((await api(alice, "GET", "/api/workspace/demo/tree")).status).toBe(404);
    const merged = (await api(alice, "POST", "/api/workspaces/join-many", { ids: ["demo"] })).data;
    expect(merged).toEqual({ joined: [], missing: [] });
    expect(await ids("/api/workspaces")).not.toContain("demo");
    expect(await ids("/api/workspaces")).not.toContain("demo");
    expect(db.query("SELECT count(*) AS n FROM joined WHERE workspace_id = 'demo'").get()).toEqual({ n: 0 });
    // the landing workspace: made once ("<First name>'s notes" with a welcome note), then the same one
    const before = await ids("/api/workspaces");
    const first = await api(alice, "POST", "/api/workspaces/personal");
    if (!before.length) {
      expect(first.status).toBe(201);
      expect(first.data.created).toBe(true);
      expect(first.data.title).toMatch(/'s notes$|^My notes$/);
      expect((await api(alice, "GET", `/api/workspace/${first.data.id}/file?path=README.md`)).data.content).toBe(
        "# Notes\n\nThis is your workspace. You aren't thinking of writing yourself are you? Why would you do that?\n\nShare these files with your agent by clicking \"Share\" at the bottom-left of the page. Your agent gets access to a full filesystem that it can edit with any bash command. It will write files like it normally does, and you can see them here.\n\nAll changes are tracked in git. You can write here too, and your agent will be able to see what you write.\n",
      );
    } else {
      expect(first.status).toBe(200);
      expect(first.data.created).toBe(false);
    }
    const again = await api(alice, "POST", "/api/workspaces/personal");
    expect(again.status).toBe(200);
    expect(again.data.created).toBe(false);
    expect(again.data.id).toBe(first.data.id);
    expect(await ids("/api/workspaces")).toContain(first.data.id);
  });

  test("caps: a note, an image, all images, everything; refused with a clear message, nothing breaks", async () => {
    const head = async () => (await app.ctx.store.head(D, "main"))!;
    const put = async (changes: any[]) => app.ctx.store.commit({ repo: D, branch: "main", expectedHead: await head(), changes, message: "m", author: { name: "x", email: "x@x" } });
    await expect(put([{ path: "big.md", content: "x".repeat(1024 * 1024 + 1) }])).rejects.toThrow(DEMO_FULL);
    // through the API: refused before any room has it, so nothing is left to retry
    expect((await api("", "POST", `/api/workspace/${D}/files`, { path: "huge.md", content: "x".repeat(1024 * 1024 + 1) }, GUEST)).status).toBe(413);
    expect(app.ctx.rooms.peek(D, "huge.md")).toBeUndefined();
    expect((await put([{ path: "ok.md", content: "x".repeat(1024 * 1024) }])).ok).toBe(true);
    // an image over 2 MB through the API: 413 with the message
    const png = new Uint8Array(2 * 1024 * 1024 + 10);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const up = await fetch(`${base}/api/workspace/${D}/images?note=Welcome.md&name=big.png`, { method: "POST", headers: { origin: base, "content-type": "image/png", ...GUEST }, body: png });
    expect(up.status).toBe(413);
    expect((await up.json()).error).toBe(DEMO_FULL);
    // images: 10 MB in all
    const img = (n: number) => {
      const b = new Uint8Array(n);
      b.set([0x89, 0x50, 0x4e, 0x47]);
      return b;
    };
    for (let i = 0; i < 5; i++) expect((await put([{ path: `images/i${i}.png`, content: img(2 * 1024 * 1024 - 1000) }])).ok).toBe(true);
    await expect(put([{ path: "images/i5.png", content: img(200_000) }])).rejects.toBeInstanceOf(StoreFullError);
    // everything: 20 MB (text included)
    for (let i = 0; i < 9; i++) await put([{ path: `filler${i}.md`, content: "y".repeat(1024 * 1024) }]);
    await expect(put([{ path: "filler9.md", content: "y".repeat(1024 * 1024) }])).rejects.toBeInstanceOf(StoreFullError);
    // the server is fine; a room whose commit is refused keeps its text live
    expect((await api("", "GET", `/api/workspace/${D}/tree`)).status).toBe(200);
    // …while someone is in it; with nobody in it, it is let go instead of being retried forever
    expect((await api("", "POST", `/api/workspace/${D}/files`, { path: "late.md", content: "z".repeat(1024 * 1024) }, GUEST)).status).toBe(201);
    const late = app.ctx.rooms.peek(D, "late.md")!;
    await expect(late.flush()).rejects.toBeInstanceOf(StoreFullError);
    expect(await late.closeIfIdle(0)).toBe(true);
    expect(app.ctx.rooms.peek(D, "late.md")).toBeUndefined();
  });

  test("keeps the last 200 commits", async () => {
    // (the previous test filled it: start from the seed)
    const { resetDemo } = await import("../../src/server/demo.ts");
    await resetDemo(app.ctx, D);
    for (let i = 0; i < 205; i++) {
      const h = await app.ctx.store.head(D, "main");
      expect((await app.ctx.store.commit({ repo: D, branch: "main", expectedHead: h, changes: [{ path: "count.md", content: String(i) }], message: `c${i}`, author: { name: "x", email: "x@x" } })).ok).toBe(true);
    }
    const hist = (await api("", "GET", `/api/workspace/${D}/history?limit=500`)).data;
    expect(hist.length).toBe(200);
    expect(hist[0].message).toBe("c204");
    expect(hist.at(-1).message).toBe("c5");
  });

  test("reset on a timer: back to the seed; open notes reload", async () => {
    const { resetDemo } = await import("../../src/server/demo.ts");
    await resetDemo(app.ctx, D);
    const g = guest("Welcome.md");
    await waitFor(() => g.synced);
    const gen = g.controls.find((m) => m.t === "hello").generation;
    g.text.insert(0, "Soon gone. ");
    await waitFor(() => app.ctx.rooms.peek(D, "Welcome.md")?.text.toString().startsWith("Soon gone.") ?? false);
    await api("", "POST", `/api/workspace/${D}/files`, { path: "temp.md", content: "temp" }, GUEST);
    const stop = startDemoResets(app.ctx, () => [D], 0.3 / 60);
    try {
      await waitFor(() => g.closeCode !== null, 3000);
      expect(g.closeCode).toBe(1013);
      expect((await api("", "GET", `/api/workspace/${D}/tree`)).data.files).not.toContain("temp.md");
      expect((await api("", "GET", `/api/workspace/${D}/file?path=Welcome.md`)).data.content).toBe(welcome);
      expect((await api("", "GET", `/api/workspace/${D}/history`)).data.map((c: any) => c.message)).toEqual(["Start the demo"]);
      // a reconnect gets a fresh room (another generation: the client reloads the note)
      const again = guest("Welcome.md");
      await waitFor(() => again.synced);
      expect(again.controls.find((m) => m.t === "hello").generation).not.toBe(gen);
      expect(again.text.toString()).toBe(welcome);
      again.close();
    } finally {
      stop();
    }
  });

  test("after a restart: the room is gone, a new one has the seed", async () => {
    await api("", "POST", `/api/workspace/${D}/files`, { path: "before-restart.md", content: "x" }, GUEST);
    await app.stop();
    await start();
    expect((await api("", "GET", `/api/workspace/${D}/tree`)).status).toBe(404);
    D = await demoRoom();
    expect((await api("", "GET", `/api/workspace/${D}/tree`)).data.files).toEqual(["Welcome.md", "tour/Ideas.md", "tour/Markdown cheatsheet.md"]);
    expect((await api("", "GET", `/api/workspace/${D}/history`)).data.length).toBe(1);
    expect(demoLog()).toEqual([0, 0]);
  });
});
