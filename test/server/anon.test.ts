// Visitors who aren't signed in: no account, they read everything, join rooms under a made-up name (kind "guest"),
// and get ANON_EDIT_LIMIT edits (bursts with no 3 s pause) per browser (the grimoire_anon cookie) and
// ANON_EDITS_PER_IP_DAY per IP address per day; over that their room connection turns read-only.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { isolate, waitFor } from "./helpers.ts";

process.env.POLL_MS = "60000";
const { config } = await import("../../src/server/config.ts");
const { db } = await import("../../src/server/db.ts");
const restore = isolate(config, db);
Object.assign(config, { storage: "local", allowDevLogin: true, quietMs: 3000, pollMs: 60000, notesRepo: "anon-notes", anonEditLimit: 10, anonEditsPerIpDay: 1000 });
config.github.clientId = "";
config.github.appSlug = "";
const { startServer } = await import("../../src/server/index.ts");
const { anonClock } = await import("../../src/server/anon.ts");

let app: Awaited<ReturnType<typeof startServer>>;
let base = "";
let alice = "";
let ws = "";

/** The fake clock the edit counter reads (real time for everything else). */
let clock = 1_000_000;
const realNow = anonClock.now;

async function login(name: string): Promise<string> {
  const res = await fetch(`${base}/auth/dev`, { method: "POST", headers: { origin: base }, body: new URLSearchParams({ name }), redirect: "manual" });
  return res.headers.getSetCookie().find((s) => s.startsWith("np_session="))!.split(";")[0]!;
}

/** A new anonymous browser: its grimoire_anon cookie, from GET /api/anon. */
async function browser(): Promise<string> {
  const res = await fetch(`${base}/api/anon`);
  expect(res.status).toBe(200);
  const c = res.headers.getSetCookie().find((s) => s.startsWith("grimoire_anon="))!;
  expect(c).toContain("HttpOnly");
  return c.split(";")[0]!;
}

async function api(cookie: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, headers: { cookie, origin: base, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, data };
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
const lastAnon = (c: Client) => [...c.controls].reverse().find((m) => m.t === "anon");
const roomText = (path: string) => app.ctx.rooms.peek(ws, path)?.text.toString();

/** One edit: append `s` at the end (a burst of one change), at fake time `at`. */
async function edit(c: Client, s: string, path: string, at: number) {
  clock = at;
  c.text.insert(c.text.length, s);
  await waitFor(() => roomText(path)?.includes(s) || c.controls.some((m) => m.t === "anonLimit"));
}

async function note(path: string, content = "# Note\n") {
  const r = await api(alice, "POST", `/api/repos/${ws}/files`, { path, content });
  expect(r.status).toBe(201);
}

beforeAll(async () => {
  anonClock.now = () => clock;
  app = await startServer({ port: 0, quiet: true });
  base = `http://localhost:${app.server.port}`;
  alice = await login("Alice");
  ws = (await api(alice, "POST", "/api/workspaces", { title: "Anon" })).data.id;
});

beforeEach(() => {
  db.query("DELETE FROM anon_ip_days").run();
});

afterAll(async () => {
  anonClock.now = realNow;
  await app?.stop();
  restore();
});

describe("anonymous visitors", () => {
  test("read without an account; everything that changes things needs one (401)", async () => {
    await note("read.md", "# Read\nhello\n");
    await app.ctx.rooms.peek(ws, "read.md")?.flush();
    const anon = await browser();
    expect((await api(anon, "GET", "/api/me")).status).toBe(401);
    expect((await api(anon, "GET", `/api/repos/${ws}`)).status).toBe(200);
    expect((await api(anon, "GET", `/api/repos/${ws}/tree`)).data.files).toContain("read.md");
    expect((await api(anon, "GET", `/api/repos/${ws}/file?path=read.md`)).data.content).toContain("hello");
    expect((await api(anon, "GET", `/api/repos/${ws}/history?path=read.md`)).status).toBe(200);
    expect((await api(anon, "GET", `/api/repos/${ws}/search?q=hello`)).data.hits.length).toBe(1);
    // the joined list is an account's: nothing is recorded for a visitor
    const refused: Array<[string, string, unknown?]> = [
      ["POST", "/api/workspaces", { title: "Nope" }],
      ["GET", "/api/workspaces"],
      ["POST", "/api/repos", { title: "Nope" }],
      ["POST", `/api/repos/${ws}/files`, { path: "new.md" }],
      ["DELETE", `/api/repos/${ws}/files?path=read.md`],
      ["POST", `/api/repos/${ws}/rename`, { from: "read.md", to: "moved.md" }],
      ["POST", `/api/repos/${ws}/images?note=read.md&name=a.png`, {}],
      ["POST", `/api/repos/${ws}/shares`, {}],
      ["POST", `/api/repos/${ws}/restore`, { path: "read.md", sha: "x" }],
      ["PATCH", "/api/me", { name: "x" }],
      ["DELETE", `/api/workspaces/${ws}/join`],
    ];
    for (const [m, p, b] of refused) expect([m, p, (await api(anon, m, p, b)).status]).toEqual([m, p, 401]);
    expect((await api(anon, "GET", `/api/repos/${ws}/tree`)).data.files).toEqual(["README.md", "read.md"]);
  });

  test("join a room under their name; others see them as a guest", async () => {
    await note("join.md");
    const anon = await browser();
    const g = client(anon, "join.md", guestQuery("moist-noodle", "guestOne123"));
    await g.synced;
    expect(g.controls[0]).toMatchObject({ t: "hello", readOnly: false });
    expect(g.controls[1]).toEqual({ t: "anon", used: 0, limit: 10, burstMs: 3000 });
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
    const anon = await browser();
    for (const q of <Record<string, string>[]>[{}, { anon: "x", name: "ok" }, { anon: "abcdef123", name: "<script>" }, { anon: "abcdef123", name: "" }, { anon: "abcdef123", name: "a".repeat(41) }]) {
      const c = client(anon, "bad.md", q);
      await waitFor(() => c.closeCode !== null);
      expect(c.closeCode).toBe(4401);
    }
    const t = client("", "bad.md", { ...guestQuery(), token: "gmt_bad" });
    await waitFor(() => t.closeCode !== null);
    expect(t.closeCode).toBe(4401);
  });

  test("an edit is a burst of changes without a 3 s pause", async () => {
    await note("burst.md");
    const anon = await browser();
    const g = client(anon, "burst.md", guestQuery());
    await g.synced;
    const t = 10_000_000;
    await edit(g, "a", "burst.md", t);
    await waitFor(() => lastAnon(g)?.used === 1);
    await edit(g, "b", "burst.md", t + 2_999);
    await edit(g, "c", "burst.md", t + 5_998);
    expect(lastAnon(g).used).toBe(1);
    // a pause of 3 s ends it
    await edit(g, "d", "burst.md", t + 8_998);
    await waitFor(() => lastAnon(g)?.used === 2);
    await edit(g, "e", "burst.md", t + 20_000);
    await waitFor(() => lastAnon(g)?.used === 3);
    expect((await api(anon, "GET", "/api/anon")).data).toEqual({ used: 3, limit: 10, burstMs: 3000, signedIn: false });
    g.close();
  });

  test("over the limit: the change is refused, the connection turns read-only (anonLimit), earlier edits stay", async () => {
    await note("limit.md", "");
    config.anonEditLimit = 3;
    try {
      const anon = await browser();
      const g = client(anon, "limit.md", guestQuery("sleepy-goblin", "limitGuest1"));
      await g.synced;
      const t = 20_000_000;
      for (let i = 0; i < 3; i++) await edit(g, `e${i} `, "limit.md", t + i * 10_000);
      await waitFor(() => lastAnon(g)?.used === 3);
      // still the third edit (no pause): fine
      await edit(g, "more ", "limit.md", t + 22_000);
      expect(roomText("limit.md")).toBe("e0 e1 e2 more ");
      // the fourth
      clock = t + 40_000;
      g.text.insert(g.text.length, "nope");
      await waitFor(() => g.controls.some((m) => m.t === "anonLimit"));
      expect(g.controls.find((m) => m.t === "anonLimit")).toEqual({ t: "anonLimit", reason: "limit", used: 3, limit: 3, burstMs: 3000 });
      g.text.insert(0, "still nope ");
      await Bun.sleep(150);
      expect(roomText("limit.md")).toBe("e0 e1 e2 more ");
      // a new connection of the same browser (another localStorage id too) can't edit either
      const again = client(anon, "limit.md", guestQuery("other-name", "otherLocal99"));
      await again.synced;
      expect(lastAnon(again)).toEqual({ t: "anon", used: 3, limit: 3, burstMs: 3000 });
      clock = t + 60_000;
      again.text.insert(0, "x");
      await waitFor(() => again.controls.some((m) => m.t === "anonLimit"));
      expect(roomText("limit.md")).toBe("e0 e1 e2 more ");
      // a reconnect's sync (nothing new) is no edit and isn't refused
      const quiet = client(anon, "limit.md", guestQuery("quiet-one", "quietLocal1"));
      await quiet.synced;
      await Bun.sleep(100);
      expect(quiet.controls.some((m) => m.t === "anonLimit")).toBe(false);
      // a new browser (cookies cleared) starts over
      const fresh = client(await browser(), "limit.md", guestQuery("fresh-one", "freshLocal1"));
      await fresh.synced;
      expect(lastAnon(fresh).used).toBe(0);
      for (const c of [g, again, quiet, fresh]) c.close();
    } finally {
      config.anonEditLimit = 10;
    }
  });

  test("the count is the cookie's: a new localStorage id doesn't reset it", async () => {
    await note("cookie.md");
    const anon = await browser();
    const one = client(anon, "cookie.md", guestQuery("one", "localIdOne1"));
    await one.synced;
    await edit(one, "1", "cookie.md", 30_000_000);
    await waitFor(() => lastAnon(one)?.used === 1);
    one.close();
    const two = client(anon, "cookie.md", guestQuery("two", "localIdTwo2"));
    await two.synced;
    expect(lastAnon(two).used).toBe(1);
    await edit(two, "2", "cookie.md", 30_010_000);
    await waitFor(() => lastAnon(two)?.used === 2);
    two.close();
    // without a cookie the room join makes one (counted from zero)
    const before = (db.query("SELECT count(*) AS n FROM anon_visitors").get() as { n: number }).n;
    const none = client("", "cookie.md", guestQuery("none", "localIdNone"));
    await none.synced;
    expect(lastAnon(none).used).toBe(0);
    expect((db.query("SELECT count(*) AS n FROM anon_visitors").get() as { n: number }).n).toBe(before + 1);
    none.close();
  });

  test("per-IP daily cap", async () => {
    await note("ip.md", "");
    config.anonEditsPerIpDay = 2;
    try {
      const t = 40_000_000;
      const a = client(await browser(), "ip.md", guestQuery("ip-a", "ipGuestAaa"));
      const b = client(await browser(), "ip.md", guestQuery("ip-b", "ipGuestBbb"));
      await Promise.all([a.synced, b.synced]);
      await edit(a, "a1 ", "ip.md", t);
      await edit(b, "b1 ", "ip.md", t + 1);
      clock = t + 10_000;
      b.text.insert(b.text.length, "b2");
      await waitFor(() => b.controls.some((m) => m.t === "anonLimit"));
      expect(b.controls.find((m) => m.t === "anonLimit").reason).toBe("ip");
      expect(roomText("ip.md")).toBe("a1 b1 ");
      a.close();
      b.close();
    } finally {
      config.anonEditsPerIpDay = 1000;
    }
  });

  test("their commits are authored as '<name> (guest)'", async () => {
    await note("author.md", "");
    await app.ctx.rooms.peek(ws, "author.md")?.flush();
    const g = client(await browser(), "author.md", guestQuery("crusty-waffle", "authorGst1"));
    await g.synced;
    await edit(g, "hi from a guest", "author.md", 50_000_000);
    await app.ctx.rooms.peek(ws, "author.md")!.flush();
    const hist = (await api(alice, "GET", `/api/repos/${ws}/history?path=author.md&limit=1`)).data;
    expect(hist[0]).toMatchObject({ authorName: "crusty-waffle (guest)", authorEmail: "guest@grimoire.invalid" });
    g.close();
  });

  test("agents are never limited: an agent link keeps writing after a guest on the same note hit the limit, and counts nothing", async () => {
    await note("agent.md", "");
    config.anonEditLimit = 1;
    try {
      const g = client(await browser(), "agent.md", guestQuery("feral-pigeon", "agentGuest1"));
      await g.synced;
      await edit(g, "guest ", "agent.md", 60_000_000);
      clock = 60_100_000;
      g.text.insert(g.text.length, "refused");
      await waitFor(() => g.controls.some((m) => m.t === "anonLimit"));
      const counts = () => [
        (db.query("SELECT coalesce(sum(edit_count), 0) AS n FROM anon_visitors").get() as { n: number }).n,
        (db.query("SELECT coalesce(sum(edits), 0) AS n FROM anon_ip_days").get() as { n: number }).n,
      ];
      const before = counts();
      const share = (await api(alice, "POST", `/api/repos/${ws}/shares`, { label: "Helper" })).data;
      for (let i = 0; i < 5; i++) {
        clock += 10_000;
        const r = await fetch(`${base}/a/${share.id}`, { method: "POST", body: `echo 'agent ${i}' >> agent.md` });
        expect((await r.json()).exitCode).toBe(0);
      }
      await waitFor(() => roomText("agent.md")?.includes("agent 4") ?? false);
      expect(roomText("agent.md")).toBe("guest agent 0\nagent 1\nagent 2\nagent 3\nagent 4\n");
      expect(counts()).toEqual(before);
      // the guest saw the agent's edits live and is still refused; no anonLimit or anon message went to anyone else
      await waitFor(() => g.text.toString().includes("agent 4"));
      // signed-in people aren't limited either
      const a = client(alice, "agent.md");
      await a.synced;
      for (let i = 0; i < 3; i++) await edit(a, `alice${i} `, "agent.md", (clock += 10_000));
      expect(roomText("agent.md")).toContain("alice2 ");
      expect(a.controls.some((m) => m.t === "anon" || m.t === "anonLimit")).toBe(false);
      expect(counts()).toEqual(before);
      g.close();
      a.close();
    } finally {
      config.anonEditLimit = 10;
    }
  });

  test("a guest can't pass for an agent (or a user): kind and identity come from how the request authenticated", async () => {
    await note("imp.md", "");
    await app.ctx.rooms.peek(ws, "imp.md")?.flush();
    const g = client(await browser(), "imp.md", { ...guestQuery("Helper", "impGuest01"), kind: "agent" });
    await g.synced;
    // an awareness state claiming to be an agent, also under an agent's client id range
    g.awareness.setLocalState({ user: { id: "share:x", name: "Helper", color: "#000", kind: "agent" }, cursor: null });
    const a = client(alice, "imp.md");
    await a.synced;
    await waitFor(() => [...a.awareness.getStates().values()].some((s: any) => s.user?.name === "Helper"));
    const users = [...a.awareness.getStates().values()].map((s: any) => s.user).filter(Boolean);
    expect(users).toEqual([{ id: "guest:impGuest01", name: "Helper", color: "#2b6a54", kind: "guest" }]);
    expect(app.ctx.rooms.peek(ws, "imp.md")!.participants().find((u) => u.name === "Helper")?.kind).toBe("guest");
    // and it is counted like any guest
    await edit(g, "x", "imp.md", 70_000_000);
    await waitFor(() => lastAnon(g)?.used === 1);
    await app.ctx.rooms.peek(ws, "imp.md")!.flush();
    expect((await api(alice, "GET", `/api/repos/${ws}/history?path=imp.md&limit=1`)).data[0]).toMatchObject({ authorName: "Helper (guest)", authorEmail: "guest@grimoire.invalid" });
    g.close();
    a.close();
  });
});
