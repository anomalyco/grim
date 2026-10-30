// Visitors who aren't signed in ("guests"): no account; they read everything, join rooms under a made-up name (kind
// "guest", always decided by the server) and edit existing notes freely (commits "<name> (guest)"). Creating, renaming
// and deleting notes and folders and uploading images need an account (401 "Sign in to …"), except in workspaces open
// to guests (the demo: demo.test.ts); so do workspaces, agent links and the account. Agents and users write freely.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { isolate, waitFor } from "./helpers.ts";
import { seedNotebook, withLinkId } from "./helpers.ts";

process.env.POLL_MS = "60000";
const { config } = await import("../../src/server/config.ts");
const { db } = await import("../../src/server/db.ts");
const restore = isolate(config, db);
Object.assign(config, { storage: "local", allowDevLogin: true, signIn: true, quietMs: 3000 });
config.github.clientId = "";
config.github.appSlug = "";
const { startServer } = await import("../../src/server/index.ts");

let app: Awaited<ReturnType<typeof startServer>>;
let base = "";
let alice = "";
let ws = "";


async function login(name: string): Promise<string> {
  const res = await fetch(`${base}/auth/dev`, { method: "POST", headers: { origin: base }, body: new URLSearchParams({ name }), redirect: "manual" });
  return res.headers.getSetCookie().find((s) => s.startsWith("np_session="))!.split(";")[0]!;
}

const GUEST = { "x-grimoire-guest": "restGuest01", "x-grimoire-guest-name": encodeURIComponent("soggy-turnip"), "x-grimoire-guest-color": "#7c4d3a" };
async function api(cookie: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, { method, headers: { cookie, origin: base, "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, data: withLinkId(data) };
}

interface Client {
  doc: Y.Doc;
  text: Y.Text;
  awareness: awarenessProtocol.Awareness;
  controls: any[];
  closeCode: number | null;
  synced: Promise<void>;
  close(): void;
}

/** A room client: `query` adds to repo/path (anon, name, color), `cookie` is the browser's cookies. */
function client(cookie: string, path: string, query: Record<string, string> = {}): Client {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  const sock = new WebSocket(`${base.replace("http", "ws")}/ws?${new URLSearchParams({ repo: ws, path, ...query })}`, { headers: { cookie, origin: base } } as any);
  sock.binaryType = "arraybuffer";
  let synced = () => {};
  const c: Client = { doc, text: doc.getText("md"), awareness, controls: [], closeCode: null, synced: new Promise((r) => (synced = r)), close: () => sock.close() };
  const send = (enc: encoding.Encoder) => sock.readyState === 1 && sock.send(encoding.toUint8Array(enc));
  sock.addEventListener("open", () => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeSyncStep1(enc, doc);
    send(enc);
  });
  sock.addEventListener("close", (e) => (c.closeCode = e.code));
  sock.addEventListener("message", (e) => {
    const dec = decoding.createDecoder(new Uint8Array(e.data as ArrayBuffer));
    const type = decoding.readVarUint(dec);
    if (type === 0) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      const sub = syncProtocol.readSyncMessage(dec, enc, doc, "remote");
      if (encoding.length(enc) > 1) send(enc);
      if (sub === 1) synced();
    } else if (type === 1) {
      awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(dec), "remote");
    } else if (type === 2) {
      c.controls.push(JSON.parse(decoding.readVarString(dec)));
    }
  });
  doc.on("update", (u: Uint8Array, origin: unknown) => {
    if (origin === "remote") return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeUpdate(enc, u);
    send(enc);
  });
  awareness.on("update", ({ added, updated, removed }: any, origin: unknown) => {
    if (origin === "remote") return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 1);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]));
    send(enc);
  });
  return c;
}

const guestQuery = (name = "moist-noodle", anon = "abcDEF123456") => ({ anon, name, color: "#2b6a54" });
const roomText = (path: string) => app.ctx.rooms.peek(ws, path)?.text.toString();

/** Append `s` at the end and wait for the room to have it. */
async function edit(c: Client, s: string, path: string) {
  c.text.insert(c.text.length, s);
  await waitFor(() => roomText(path)?.includes(s) ?? false);
}

async function note(path: string, content = "# Note\n") {
  const r = await api(alice, "POST", `/api/workspace/${ws}/files`, { path, content });
  expect(r.status).toBe(201);
}

beforeAll(async () => {
  app = await startServer({ port: 0, quiet: true });
  await seedNotebook(app.ctx, "anon-notes");
  base = `http://localhost:${app.server.port}`;
  alice = await login("Alice");
  ws = (await api(alice, "POST", "/api/workspaces", { title: "Anon" })).data.id;
});

afterAll(async () => {
  await app?.stop();
  restore();
});

describe("guests", () => {
  test("read without an account", async () => {
    await note("read.md", "# Read\nhello\n");
    await app.ctx.rooms.peek(ws, "read.md")?.flush();
    expect((await api("", "GET", "/api/me")).status).toBe(401);
    expect((await api("", "GET", `/api/workspace/${ws}`)).status).toBe(200);
    expect((await api("", "GET", `/api/workspace/${ws}/tree`)).data.files).toContain("read.md");
    expect((await api("", "GET", `/api/workspace/${ws}/file?path=read.md`)).data.content).toContain("hello");
    expect((await api("", "GET", `/api/workspace/${ws}/history?path=read.md`)).status).toBe(200);
    expect((await api("", "GET", `/api/workspace/${ws}/search?q=hello`)).data.hits.length).toBe(1);
    expect((await api("", "GET", "/api/anon")).status).toBe(401);
  });

  test("edit notes and restore versions as '<name> (guest)'; creating, renaming, deleting and uploading need an account", async () => {
    await note("g.md", "# G\n");
    await app.ctx.rooms.peek(ws, "g.md")!.flush();
    const g = (m: string, p: string, b?: unknown) => api("", m, p, b, GUEST);
    // restoring a version edits the existing note
    const first = (await api("", "GET", `/api/workspace/${ws}/history?path=g.md&limit=1`)).data[0].sha;
    const live = app.ctx.rooms.peek(ws, "g.md")!;
    live.agentEdit({ id: "x", name: "X", email: "x@example.com", kind: "agent", color: "#000" }, (t) => void t.insert(t.length, "more\n"));
    await live.flush();
    expect((await g("POST", `/api/workspace/${ws}/restore`, { path: "g.md", sha: first })).status).toBe(200);
    expect(roomText("g.md")).toBe("# G\n");
    await live.flush();
    expect((await api("", "GET", `/api/workspace/${ws}/history?path=g.md&limit=1`)).data[0]).toMatchObject({ authorName: "soggy-turnip (guest)", authorEmail: "guest@grimoire.invalid" });
    // structure and new files: "Sign in to …", nothing changes
    await note("keep.md", "# Keep\n");
    await note("dir/a.md", "# A\n");
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const upload = (headers: Record<string, string>) => fetch(`${base}/api/workspace/${ws}/images?note=g.md&name=pic.png`, { method: "POST", headers: { origin: base, "content-type": "image/png", ...headers }, body: png });
    const refusedWrites: Array<[string, string, unknown, string]> = [
      ["POST", `/api/workspace/${ws}/files`, { path: "by-guest.md", content: "# By a guest\n" }, "Sign in to create notes"],
      ["POST", `/api/workspace/${ws}/rename`, { from: "keep.md", to: "moved.md" }, "Sign in to rename notes"],
      ["POST", `/api/workspace/${ws}/rename`, { from: "dir", to: "dir2", folder: true }, "Sign in to rename folders"],
      ["DELETE", `/api/workspace/${ws}/files?path=keep.md`, undefined, "Sign in to delete notes"],
      ["DELETE", `/api/workspace/${ws}/files?folder=dir`, undefined, "Sign in to delete folders"],
      ["POST", `/api/workspace/${ws}/rename`, { from: "keep.md", to: "x.md", ifUntitled: true }, "Sign in to rename notes"],
    ];
    for (const [m, p, b, msg] of refusedWrites) expect([m, p, await g(m, p, b)]).toEqual([m, p, { status: 401, data: { error: msg } }]);
    const up = await upload(GUEST);
    expect(up.status).toBe(401);
    expect(await up.json()).toEqual({ error: "Sign in to upload images" });
    const files = (await api("", "GET", `/api/workspace/${ws}/tree`)).data.files;
    expect(files).toEqual(expect.arrayContaining(["keep.md", "dir/a.md"]));
    expect(files).not.toContain("by-guest.md");
    expect(files.some((f: string) => f.startsWith("images/"))).toBe(false);
    // signed in, the same requests work
    expect((await api(alice, "POST", `/api/workspace/${ws}/files`, { path: "by-alice.md" })).status).toBe(201);
    expect((await api(alice, "POST", `/api/workspace/${ws}/rename`, { from: "keep.md", to: "moved.md" })).data).toEqual({ path: "moved.md" });
    expect((await api(alice, "DELETE", `/api/workspace/${ws}/files?path=moved.md`)).status).toBe(200);
    expect((await upload({ cookie: alice })).status).toBe(201);
    // cross-origin is refused like for everyone
    expect((await fetch(`${base}/api/workspace/${ws}/restore`, { method: "POST", headers: { origin: "https://evil.example", ...GUEST }, body: JSON.stringify({ path: "g.md", sha: first }) })).status).toBe(403);
    // without the guest headers (or with bad ones): 401
    expect((await api("", "POST", `/api/workspace/${ws}/restore`, { path: "g.md", sha: first })).status).toBe(401);
    expect((await api("", "POST", `/api/workspace/${ws}/restore`, { path: "g.md", sha: first }, { ...GUEST, "x-grimoire-guest-name": "%3Cscript%3E" })).status).toBe(401);
    // the repo JSON tells clients which workspaces guests may create in
    expect((await api("", "GET", `/api/workspace/${ws}`)).data.guestCreate).toBe(false);
    // account only
    const refused: Array<[string, string, unknown?]> = [
      ["POST", "/api/workspaces", { title: "Nope" }],
      ["GET", "/api/workspaces"],
      ["POST", "/api/workspaces", { title: "Nope" }],
      ["POST", "/api/workspaces", { github: "octocat/hello-world" }],
      ["POST", `/api/workspace/${ws}/agent-link`, {}],
      ["DELETE", `/api/workspace/${ws}`],
      ["PATCH", "/api/me", { name: "x" }],
      ["DELETE", `/api/workspace/${ws}/join`],
    ];
    for (const [m, p, b] of refused) expect([m, p, (await g(m, p, b)).status]).toEqual([m, p, 401]);
  });

  test("join a room under their name; others see them as a guest", async () => {
    await note("join.md");
    const g = client("", "join.md", guestQuery("moist-noodle", "guestOne123"));
    await g.synced;
    expect(g.controls[0]).toMatchObject({ t: "hello", readOnly: false });
    // their cursor (the server stamps the user: it can't be someone else's)
    g.awareness.setLocalState({ user: { id: "u_alice", name: "Alice", color: "#000", kind: "human" }, cursor: null });
    const a = client(alice, "join.md");
    await a.synced;
    await waitFor(() => [...a.awareness.getStates().values()].some((s: any) => s.user?.kind === "guest"));
    const seen = [...a.awareness.getStates().values()].map((s: any) => s.user).find((u: any) => u?.kind === "guest");
    expect(seen).toEqual({ id: "guest:guestOne123", name: "moist-noodle", color: "#2b6a54", kind: "guest" });
    expect(app.ctx.rooms.peek(ws, "join.md")!.participants()).toContainEqual({ id: "guest:guestOne123", name: "moist-noodle", color: "#2b6a54", kind: "guest" });
    g.close();
    a.close();
  });

  test("bad or missing guest details, or a bad app token, are refused", async () => {
    await note("bad.md");
    for (const q of <Record<string, string>[]>[{}, { anon: "x", name: "ok" }, { anon: "abcdef123", name: "<script>" }, { anon: "abcdef123", name: "" }, { anon: "abcdef123", name: "a".repeat(41) }]) {
      const c = client("", "bad.md", q);
      await waitFor(() => c.closeCode !== null);
      expect(c.closeCode).toBe(4401);
    }
    const t = client("", "bad.md", { ...guestQuery(), token: "gmt_bad" });
    await waitFor(() => t.closeCode !== null);
    expect(t.closeCode).toBe(4401);
  });

  test("edit freely: no limit, no counting; commits authored as '<name> (guest)'", async () => {
    await note("free.md", "");
    await app.ctx.rooms.peek(ws, "free.md")?.flush();
    const g = client("", "free.md", guestQuery("crusty-waffle", "freeGuest1"));
    await g.synced;
    for (let i = 0; i < 25; i++) await edit(g, `${i} `, "free.md");
    expect(roomText("free.md")!.split(" ").length).toBe(26);
    expect(g.controls.every((m) => m.t === "hello" || m.t === "status" || m.t === "blame")).toBe(true);
    await app.ctx.rooms.peek(ws, "free.md")!.flush();
    const hist = (await api(alice, "GET", `/api/workspace/${ws}/history?path=free.md&limit=1`)).data;
    expect(hist[0]).toMatchObject({ authorName: "crusty-waffle (guest)", authorEmail: "guest@grimoire.invalid" });
    g.close();
  });

  test("agents write next to guests, as agents", async () => {
    await note("agent.md", "");
    const g = client("", "agent.md", guestQuery("feral-pigeon", "agentGuest1"));
    await g.synced;
    await edit(g, "guest ", "agent.md");
    const share = (await api(alice, "POST", `/api/workspace/${ws}/agent-link`, { label: "Helper" })).data;
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${base}/a/${share.id}`, { method: "POST", body: `echo 'agent ${i}' >> agent.md` });
      expect((await r.json()).exitCode).toBe(0);
    }
    await waitFor(() => g.text.toString().includes("agent 2"));
    expect(roomText("agent.md")).toBe("guest agent 0\nagent 1\nagent 2\n");
    await waitFor(() => app.ctx.rooms.peek(ws, "agent.md")!.participants().some((u) => u.kind === "agent"));
    expect(app.ctx.rooms.peek(ws, "agent.md")!.participants().find((u) => u.name === "Helper")?.kind).toBe("agent");
    g.close();
  });

  test("a guest can't pass for an agent (or a user): kind and identity come from how the request authenticated", async () => {
    await note("imp.md", "");
    await app.ctx.rooms.peek(ws, "imp.md")?.flush();
    const g = client("", "imp.md", { ...guestQuery("Helper", "impGuest01"), kind: "agent" });
    await g.synced;
    // an awareness state claiming to be an agent
    g.awareness.setLocalState({ user: { id: "share:x", name: "Helper", color: "#000", kind: "agent" }, cursor: null });
    const a = client(alice, "imp.md");
    await a.synced;
    await waitFor(() => [...a.awareness.getStates().values()].some((s: any) => s.user?.name === "Helper"));
    const users = [...a.awareness.getStates().values()].map((s: any) => s.user).filter(Boolean);
    expect(users).toEqual([{ id: "guest:impGuest01", name: "Helper", color: "#2b6a54", kind: "guest" }]);
    expect(app.ctx.rooms.peek(ws, "imp.md")!.participants().find((u) => u.name === "Helper")?.kind).toBe("guest");
    await edit(g, "x", "imp.md");
    await app.ctx.rooms.peek(ws, "imp.md")!.flush();
    expect((await api(alice, "GET", `/api/workspace/${ws}/history?path=imp.md&limit=1`)).data[0]).toMatchObject({ authorName: "Helper (guest)", authorEmail: "guest@grimoire.invalid" });
    // REST: a "kind" header changes nothing either
    const sha = (await api("", "GET", `/api/workspace/${ws}/history?path=imp.md&limit=1`)).data[0].sha;
    await edit(g, "y", "imp.md");
    await app.ctx.rooms.peek(ws, "imp.md")!.flush();
    const r = await api("", "POST", `/api/workspace/${ws}/restore`, { path: "imp.md", sha }, { "x-grimoire-guest": "impGuest02", "x-grimoire-guest-name": "Helper2", "x-grimoire-kind": "agent" });
    expect(r.status).toBe(200);
    await app.ctx.rooms.peek(ws, "imp.md")!.flush();
    expect((await api("", "GET", `/api/workspace/${ws}/history?path=imp.md&limit=1`)).data[0].authorName).toBe("Helper2 (guest)");
    g.close();
    a.close();
  });

  test("naming an untitled note after its heading (ifUntitled): once, even when two people trigger it at once", async () => {
    expect((await api(alice, "POST", `/api/workspace/${ws}/files`, { path: "Untitled.md", content: "# Trip plans\n" })).status).toBe(201);
    const bob = await login("Bob");
    const go = (who: string) => api(who, "POST", `/api/workspace/${ws}/rename`, { from: "Untitled.md", to: "Trip plans.md", ifUntitled: true });
    const [a, b] = await Promise.all([go(alice), go(bob)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const files = (await api("", "GET", `/api/workspace/${ws}/tree`)).data.files;
    expect(files).toContain("Trip plans.md");
    expect(files).not.toContain("Untitled.md");
    // not untitled: refused
    expect((await api(bob, "POST", `/api/workspace/${ws}/rename`, { from: "Trip plans.md", to: "Other.md", ifUntitled: true })).status).toBe(409);
    expect((await api("", "GET", `/api/workspace/${ws}/tree`)).data.files).toContain("Trip plans.md");
  });
});
