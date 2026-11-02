import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { seedNotebook } from "./helpers.ts";

// The preload's DATA_DIR (one per test process, shared by every file in it).
const dir = process.env.DATA_DIR!;
process.env.ALLOW_DEV_LOGIN = "1";
process.env.QUIET_MS = "100";
process.env.POLL_MS = "60000";
delete process.env.GITHUB_CLIENT_ID;

// bun test may share one module registry between files, so config can already be loaded with another
// file's env: override what matters directly, and use repo ids no other test uses.
const { config } = await import("../../src/server/config.ts");
Object.assign(config, { storage: "local", allowDevLogin: true, signIn: true, quietMs: 100 });
config.github.clientId = "";
config.github.appSlug = "";
// adding GitHub copies is off by default (GITHUB_COPIES); these tests add them
config.githubCopiesEnabled = true;
const { startServer } = await import("../../src/server/index.ts");
const { db } = await import("../../src/server/db.ts");
const { setGitHubFetch } = await import("../../src/server/auth.ts");
const { agentLimits } = await import("../../src/server/agent-url.ts");
const { createAppToken } = await import("../../src/server/tokens.ts");
const { sh, upstreams } = await import("./upstream.ts");
const { MAX_FILE_BYTES } = await import("../../src/server/store/types.ts");
const N = "api-notes";
const ops = await import("../../src/server/ops.ts");
const { notesRepoId } = await import("../../src/server/repos.ts");
const { errorResponse } = await import("../../src/server/api.ts");
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect width="10" height="10"/></svg>';

let app: Awaited<ReturnType<typeof startServer>>;
let base = "";
let alice = "";
let bob = "";

async function login(name: string): Promise<string> {
  const res = await fetch(`${base}/auth/dev`, { method: "POST", headers: { origin: base }, body: new URLSearchParams({ name }), redirect: "manual" });
  expect(res.status).toBe(303);
  const c = res.headers.getSetCookie().find((s) => s.startsWith("np_session="))!;
  return c.split(";")[0]!;
}

/** The account behind a session cookie. */
async function uid(cookie: string): Promise<string> {
  return (await api(cookie, "GET", "/api/me")).data.id;
}

async function api(cookie: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

async function waitFor(fn: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await Bun.sleep(20);
  }
  throw new Error("timed out waiting");
}

interface Client {
  doc: Y.Doc;
  text: Y.Text;
  awareness: awarenessProtocol.Awareness;
  controls: any[];
  closeCode: number | null;
  opened: Promise<void>;
  close(): void;
}

function connect(cookie: string, repo: string, path: string, origin = base): Client {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  const ws = new WebSocket(`${base.replace("http", "ws")}/ws?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`, {
    headers: { cookie, origin },
  } as any);
  ws.binaryType = "arraybuffer";
  const c: Client = {
    doc,
    text: doc.getText("md"),
    awareness,
    controls: [],
    closeCode: null,
    opened: new Promise((r) => ws.addEventListener("open", () => r())),
    close: () => ws.close(),
  };
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
      syncProtocol.readSyncMessage(dec, enc, doc, "remote");
      if (encoding.length(enc) > 1) send(enc);
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
  awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    if (origin === "remote") return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 1);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]));
    send(enc);
  });
  return c;
}

async function committed(cookie: string, repo: string, path: string): Promise<string | null> {
  const tree = await api(cookie, "GET", `/api/workspace/${repo}/tree`);
  const r = await api(cookie, "GET", `/api/workspace/${repo}/file?path=${encodeURIComponent(path)}&ref=${tree.data.head}`);
  return r.status === 200 ? r.data.content : null;
}

beforeAll(async () => {
  app = await startServer({ port: 0, quiet: true });
  await seedNotebook(app.ctx, "api-notes");
  base = `http://localhost:${app.server.port}`;
  alice = await login("Alice");
  bob = await login("Bob");
});

const tempRepos: string[] = [];
function insertRepo(id: string, fields: { kind?: string; readOnly?: number; status?: string } = {}) {
  db.query("INSERT INTO repos (id, title, kind, gh_owner, gh_name, read_only, branch, status, created_at) VALUES (?, ?, ?, 'o', ?, ?, 'main', ?, ?)").run(
    id,
    id,
    fields.kind ?? "github",
    id,
    fields.readOnly ?? 0,
    fields.status ?? "ready",
    Date.now(),
  );
  tempRepos.push(id);
}

afterAll(async () => {
  await app?.stop();
  for (const id of tempRepos) db.query("DELETE FROM repos WHERE id = ?").run(id);
});

describe("auth", () => {
  test("server info is public, reading folders is open, the rest needs a session", async () => {
    const info = await (await fetch(`${base}/api/server`)).json();
    expect(info).toMatchObject({ signIn: true, marketing: false, githubLogin: false, googleLogin: false, githubAppSlug: null, githubCopies: true, ws: [1, 2] });
    expect(info).not.toHaveProperty("storage");
    expect((await fetch(`${base}/api/config`)).status).toBe(404);
    expect((await fetch(`${base}/api/me`)).status).toBe(401);
    expect((await fetch(`${base}/api/workspace/${N}/tree`)).status).toBe(200);
    // signed out: no list (no default notebook either)
    expect((await fetch(`${base}/api/workspaces`)).status).toBe(401);
  });

  test("dev login → /api/me; nobody is special, not even the first account", async () => {
    const me = await api(alice, "GET", "/api/me");
    expect(me.status).toBe(200);
    expect(me.data).toMatchObject({ name: "Alice" });
    expect(me.data.login).toMatch(/^alice-[a-z2-9]{4}$/);
    expect(me.data.githubToken).toBeUndefined();
    expect("admin" in me.data || "isAdmin" in me.data).toBe(false);
    const b = await api(bob, "GET", "/api/me");
    expect(b.data.login).toMatch(/^bob-[a-z2-9]{4}$/);
  });

  test("the test sign-in with an existing account's name creates a different account", async () => {
    const aliceId = await uid(alice);
    const mine = (await api(alice, "POST", "/api/workspaces", { title: "Alice Own" })).data.id as string;
    tempRepos.push(mine);
    const impostor = await login("Alice");
    const me = (await api(impostor, "GET", "/api/me")).data;
    expect(me.id).not.toBe(aliceId);
    expect(me.name).toBe("Alice");
    expect(me.login).not.toBe((await api(alice, "GET", "/api/me")).data.login);
    // Not the original's account: her folders aren't listed for the impostor, and only she may remove them.
    expect((await api(impostor, "GET", "/api/workspaces")).data.some((w: any) => w.id === mine)).toBe(false);
    expect((await api(impostor, "DELETE", `/api/workspace/${mine}`)).status).toBe(403);
    // The same name typed with other spacing or case: a new account again.
    const again = await login("  ALICE ");
    expect(await uid(again)).not.toBe(aliceId);
    expect(await uid(again)).not.toBe(me.id);
    // The original account still works.
    expect((await api(alice, "GET", "/api/workspaces")).data.some((w: any) => w.id === mine)).toBe(true);
  });

  test("logout ends the session", async () => {
    const c = await login("Carol");
    expect((await api(c, "GET", "/api/me")).status).toBe(200);
    await fetch(`${base}/auth/logout`, { method: "POST", headers: { cookie: c, origin: base }, redirect: "manual" });
    expect((await api(c, "GET", "/api/me")).status).toBe(401);
  });

  test("guest accounts are gone: /auth/guest doesn't exist", async () => {
    const before = (db.query("SELECT count(*) AS n FROM users").get() as { n: number }).n;
    const res = await fetch(`${base}/auth/guest`, { method: "POST", headers: { origin: base } });
    expect(res.status).toBe(404);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("np_session="))).toBe(false);
    expect((db.query("SELECT count(*) AS n FROM users").get() as { n: number }).n).toBe(before);
  });

  test("people can change their display name", async () => {
    const c = await login("Dora");
    expect((await api(c, "PATCH", "/api/me", { name: "  Dora the Explorer  " })).status).toBe(200);
    expect((await api(c, "GET", "/api/me")).data.name).toBe("Dora the Explorer");
    expect((await api(c, "PATCH", "/api/me", { name: "  " })).status).toBe(400);
    expect((await api(c, "PATCH", "/api/me", { name: "x" }).then(() => fetch(`${base}/api/me`, { method: "PATCH", headers: { cookie: c, origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ name: "Hacked" }) }))).status).toBe(403);
  });

  test("dev login and logout require the same origin", async () => {
    const res = await fetch(`${base}/auth/dev`, { method: "POST", body: new URLSearchParams({ name: "Mallory" }), redirect: "manual" });
    expect(res.status).toBe(403);
    const evil = await fetch(`${base}/auth/logout`, { method: "POST", headers: { cookie: bob, origin: "https://evil.example" }, redirect: "manual" });
    expect(evil.status).toBe(403);
    const other = await fetch(`${base}/auth/logout`, { method: "POST", headers: { cookie: bob, origin: base.replace("http:", "https:") }, redirect: "manual" });
    expect(other.status).toBe(403);
    expect((await api(bob, "GET", "/api/me")).status).toBe(200);
  });

  test("the test sign-in is off on an https server, even with ALLOW_DEV_LOGIN=1 (sign-in there is Google only)", async () => {
    const was = config.publicUrl;
    config.publicUrl = "https://notes.example";
    try {
      for (const method of ["GET", "POST"]) expect((await fetch(`${base}/auth/dev`, { method, headers: { origin: base }, body: method === "POST" ? new URLSearchParams({ name: "Mallory" }) : undefined, redirect: "manual" })).status).toBe(404);
    } finally {
      config.publicUrl = was;
    }
  });

  test("signing in lands on /app (or a safe next under /app); signing out on /", async () => {
    const dev = (body: Record<string, string>, query = "") =>
      fetch(`${base}/auth/dev${query}`, { method: "POST", headers: { origin: base }, body: new URLSearchParams({ name: "Alice", ...body }), redirect: "manual" });
    const res = await dev({});
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/app");
    expect((await dev({ next: "/app/notes/a%20b.md?view=raw" })).headers.get("location")).toBe("/app/notes/a%20b.md?view=raw");
    // (the old /start guide is gone)
    expect((await dev({}, "?next=/start")).headers.get("location")).toBe("/app");
    for (const next of ["https://evil.example/app", "//evil.example/app", "/\\evil.example/app", "/api/me", "/app/../api/me", "/apple", "javascript:alert(1)", "/"])
      expect((await dev({ next })).headers.get("location")).toBe("/app");
    const json = await fetch(`${base}/auth/dev`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ name: "Alice", next: "/app/x" }), redirect: "manual" });
    expect(json.headers.get("location")).toBe("/app/x");
    const c = await login("Carol");
    const out = await fetch(`${base}/auth/logout`, { method: "POST", headers: { cookie: c, origin: base }, redirect: "manual" });
    expect(out.headers.get("location")).toBe("/");
  });

  test("GitHub sign-in carries next through the state cookie", async () => {
    try {
      config.github.clientId = "cid";
      config.github.clientSecret = "secret";
      const start = await fetch(`${base}/auth/github?next=${encodeURIComponent("/app/notes/X.md")}`, { redirect: "manual" });
      const set = start.headers.getSetCookie().find((c) => c.startsWith("np_oauth_state="))!;
      const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
      expect(decodeURIComponent(set.split(";")[0]!.slice("np_oauth_state=".length))).toBe(`${state} /app/notes/X.md`);
      const evil = await fetch(`${base}/auth/github?next=${encodeURIComponent("//evil.example")}`, { redirect: "manual" });
      expect(decodeURIComponent(evil.headers.getSetCookie()[0]!.split(";")[0]!)).toEndWith(" /app");
    } finally {
      config.github.clientId = "";
      config.github.clientSecret = "";
    }
  });

  test("pages: /app and /app/* serve the app; old /r/ links redirect to /app/, /start to /", async () => {
    for (const p of ["/app", "/app/", "/app/notes", "/app/app/api.md", "/app/api/x/y.md"]) {
      // (as browsers ask: anything else gets the note itself, note-url.test.ts)
      const res = await fetch(`${base}${p}`, { redirect: "manual", headers: { accept: "text/html,*/*;q=0.8" } });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
    }
    // not the marketing site (MARKETING_SITE off, the default): no landing page, "/" is the app
    const root = await fetch(`${base}/?x=1`, { redirect: "manual" });
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("/app?x=1");
    // (no socket but /ws: an old landing page's /ws/home is a plain 404)
    expect((await fetch(`${base}/ws/home`)).status).toBe(404);
    expect(((await (await fetch(`${base}/api/server`)).json()) as { marketing: boolean }).marketing).toBe(false);
    const start = await fetch(`${base}/start`, { redirect: "manual" });
    expect(start.status).toBe(308);
    expect(start.headers.get("location")).toBe("/");
    const cases: Array<[string, string]> = [
      ["/r/notes/X.md", "/app/notes/X.md"],
      ["/r/notes/dir/a%20b.md?view=raw&x=1", "/app/notes/dir/a%20b.md?view=raw&x=1"],
      ["/r/notes", "/app/notes"],
      ["/r/", "/app/"],
      ["/r", "/app"],
    ];
    for (const [from, to] of cases) {
      const res = await fetch(`${base}${from}`, { redirect: "manual" });
      expect(res.status).toBe(308);
      expect(res.headers.get("location")).toBe(to);
    }
    expect((await fetch(`${base}/rx`, { redirect: "manual" })).status).toBe(404);
    expect((await fetch(`${base}/apple`, { redirect: "manual" })).status).toBe(404);
  });

  test("OAuth state must match the cookie, which is cleared either way", async () => {
    try {
      config.github.clientId = "cid";
      config.github.clientSecret = "secret";
      const start = await fetch(`${base}/auth/github`, { redirect: "manual" });
      expect(start.status).toBe(303);
      const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
      const set = start.headers.getSetCookie().find((c) => c.startsWith("np_oauth_state="))!;
      expect(set).toContain("Path=/auth");
      expect(set).toContain("HttpOnly");
      const bad = await fetch(`${base}/auth/github/callback?code=x&state=${state}x`, { headers: { cookie: `np_oauth_state=${state}` }, redirect: "manual" });
      expect(bad.status).toBe(400);
      const cleared = bad.headers.getSetCookie().find((c) => c.startsWith("np_oauth_state="))!;
      expect(cleared).toContain("Max-Age=0");
      expect(cleared).toContain("Path=/auth");
      const none = await fetch(`${base}/auth/github/callback?code=x&state=${state}`, { redirect: "manual" });
      expect(none.status).toBe(400);
    } finally {
      config.github.clientId = "";
      config.github.clientSecret = "";
    }
  });

  test("Secure cookies behind an https proxy", async () => {
    const res = await fetch(`${base}/auth/dev`, {
      method: "POST",
      headers: { origin: base, "x-forwarded-proto": "https" },
      body: new URLSearchParams({ name: "Alice" }),
      redirect: "manual",
    });
    expect(res.headers.getSetCookie().find((c) => c.startsWith("np_session="))).toContain("; Secure");
    expect((await fetch(`${base}/auth/dev`, { method: "POST", headers: { origin: base }, body: new URLSearchParams({ name: "Alice" }), redirect: "manual" })).headers.getSetCookie()[0]).not.toContain("Secure");
  });

  test("cross-origin state changes are refused", async () => {
    const res = await fetch(`${base}/api/workspace/${N}/files`, {
      method: "POST",
      headers: { cookie: alice, origin: "https://evil.example", "content-type": "text/plain" },
      body: JSON.stringify({ path: "evil.md" }),
    });
    expect(res.status).toBe(403);
    const res2 = await fetch(`${base}/api/workspace/${N}/files`, {
      method: "POST",
      headers: { cookie: alice, "content-type": "text/plain" },
      body: JSON.stringify({ path: "evil.md" }),
    });
    expect(res2.status).toBe(403);
    const ok = await fetch(`${base}/api/workspace/${N}/files`, {
      method: "POST",
      headers: { cookie: alice, origin: base, "content-type": "text/plain" },
      body: JSON.stringify({ path: "same-origin.md" }),
    });
    expect(ok.status).toBe(201);
  });
});

describe("files", () => {
  test("lists the notes repo with Welcome.md", async () => {
    // opening its tree joins it
    expect((await api(alice, "GET", `/api/workspace/${N}/tree`)).status).toBe(200);
    const repos = await api(alice, "GET", "/api/workspaces");
    expect(repos.data).toContainEqual(expect.objectContaining({ id: N, kind: "notes", readOnly: false, canRemove: false }));
    const tree = await api(alice, "GET", `/api/workspace/${N}/tree`);
    expect(tree.data.files).toContain("Welcome.md");
    expect(tree.data.head).toMatch(/^[0-9a-f]{40}$/);
  });

  test("create, rename, history, search, delete", async () => {
    const created = await api(alice, "POST", `/api/workspace/${N}/files`, { path: "ideas/todo", content: "# Todo\n\nbuy pineapples\n" });
    expect(created.status).toBe(201);
    expect(created.data).toEqual({ path: "ideas/todo.md", version: expect.any(String) });
    expect((await api(alice, "POST", `/api/workspace/${N}/files`, { path: "ideas/todo.md" })).status).toBe(409);
    expect((await api(alice, "GET", `/api/workspace/${N}/tree`)).data.files).toContain("ideas/todo.md");

    const renamed = await api(alice, "POST", `/api/workspace/${N}/rename`, { from: "ideas/todo.md", to: "ideas/done.md" });
    expect(renamed.data).toEqual({ path: "ideas/done.md" });
    const files = (await api(alice, "GET", `/api/workspace/${N}/tree`)).data.files;
    expect(files).toContain("ideas/done.md");
    expect(files).not.toContain("ideas/todo.md");

    const hist = await api(alice, "GET", `/api/workspace/${N}/history?path=ideas/done.md&limit=5`);
    expect(hist.data[0]).toMatchObject({ message: expect.stringContaining("Rename"), authorName: "Alice" });
    const diff = await api(alice, "GET", `/api/workspace/${N}/diff?sha=${hist.data[0].sha}&path=ideas/done.md`);
    expect(diff.data.diff).toContain("pineapples");

    const hits = await api(alice, "GET", `/api/workspace/${N}/search?q=pineapples`);
    expect(hits.data.hits).toContainEqual(expect.objectContaining({ path: "ideas/done.md", text: expect.stringContaining("pineapples") }));

    expect((await api(alice, "DELETE", `/api/workspace/${N}/files?path=ideas/done.md`)).data).toEqual({ ok: true });
    expect((await api(alice, "GET", `/api/workspace/${N}/tree`)).data.files).not.toContain("ideas/done.md");
    expect((await api(alice, "DELETE", `/api/workspace/${N}/files?path=ideas/done.md`)).status).toBe(404);
    expect((await api(alice, "GET", "/api/workspace/nope/tree")).status).toBe(404);
  });

  test("restore replaces live text with an old version", async () => {
    await api(alice, "POST", `/api/workspace/${N}/files`, { path: "r.md", content: "v1\n" });
    await waitFor(async () => (await committed(alice, N, "r.md")) === "v1\n"); // committed after the quiet period
    const [first] = (await api(alice, "GET", `/api/workspace/${N}/history?path=r.md`)).data;
    const c = connect(alice, N, "r.md");
    await waitFor(() => c.text.toString() === "v1\n");
    c.text.delete(0, c.text.length);
    c.text.insert(0, "v2\n");
    await waitFor(async () => (await committed(alice, N, "r.md")) === "v2\n");
    expect((await api(alice, "POST", `/api/workspace/${N}/restore`, { path: "r.md", sha: first.sha })).data).toEqual({ ok: true });
    await waitFor(() => c.text.toString() === "v1\n");
    c.close();
  });

  test("new notes repo", async () => {
    const r = await api(bob, "POST", "/api/workspaces", { title: "API Team Plans" });
    expect(r.status).toBe(201);
    expect(r.data).toMatchObject({ title: "API Team Plans", kind: "notes", readOnly: false, canRemove: true });
    const id = r.data.id as string;
    expect(id).toMatch(/^api-team-plans-[a-hjkmnp-z2-9]{12}$/);
    expect((await api(bob, "GET", `/api/workspace/${id}/tree`)).data.files).toEqual(["README.md"]);
    // New workspaces are open to everyone; only whoever made one removes it (the first account isn't special).
    const frank = await login("Frank");
    expect((await api(frank, "GET", `/api/workspace/${id}/tree`)).status).toBe(200);
    expect((await api(frank, "DELETE", `/api/workspace/${id}`)).status).toBe(403);
    expect((await api(alice, "DELETE", `/api/workspace/${id}`)).status).toBe(403);
    expect((await api(bob, "DELETE", `/api/workspace/${id}`)).data).toEqual({ ok: true });
    const mine = await api(bob, "POST", "/api/workspaces", { title: "API Bob Own" });
    expect((await api(bob, "DELETE", `/api/workspace/${mine.data.id}`)).data).toEqual({ ok: true });
  });

  test("notes workspace ids: title + random suffix, permanent", async () => {
    const ids = new Set(Array.from({ length: 200 }, () => notesRepoId("Design")));
    for (const id of ids) expect(id).toMatch(/^design-[abcdefghjkmnpqrstuvwxyz23456789]{12}$/);
    expect(ids.size).toBe(200);
    expect(notesRepoId("..")).toMatch(/^notes-[a-z2-9]{12}$/);
    expect(notesRepoId("!!!")).toMatch(/^notes-[a-z2-9]{12}$/);
    expect(notesRepoId("x".repeat(200))).toMatch(/^x{24}-[a-z2-9]{12}$/);
    // Same title twice: different, unrelated ids (no -2 revealing the count).
    const a = (await api(bob, "POST", "/api/workspaces", { title: "API Same" })).data.id as string;
    const b = (await api(bob, "POST", "/api/workspaces", { title: "API Same" })).data.id as string;
    expect(a).toMatch(/^api-same-[a-z2-9]{12}$/);
    expect(b).toMatch(/^api-same-[a-z2-9]{12}$/);
    expect(a).not.toBe(b);
    // Title that slugifies to nothing.
    const empty = await api(bob, "POST", "/api/workspaces", { title: "???" });
    expect(empty.status).toBe(201);
    expect(empty.data.id).toMatch(/^notes-[a-z2-9]{12}$/);
    // A collision is retried with new randomness: the first two draws are forced to "aaaa".
    const real = crypto.getRandomValues.bind(crypto);
    let forced = 0;
    crypto.getRandomValues = ((arr: any) => (forced++ < 2 ? arr.fill(0) : real(arr))) as typeof crypto.getRandomValues;
    let c: string, d: string;
    try {
      c = (await api(bob, "POST", "/api/workspaces", { title: "API Dup" })).data.id;
      d = (await api(bob, "POST", "/api/workspaces", { title: "API Dup" })).data.id;
    } finally {
      crypto.getRandomValues = real;
    }
    expect(c).toBe("api-dup-aaaa");
    expect(d).toMatch(/^api-dup-[a-z2-9]{12}$/);
    expect(d).not.toBe(c);
    expect(forced).toBeGreaterThanOrEqual(3);
    for (const id of [a, b, empty.data.id, c, d]) expect((await api(bob, "DELETE", `/api/workspace/${id}`)).data).toEqual({ ok: true });
  });
});

describe("repo rules", () => {
  test("linking editable GitHub repos needs the GitHub App and a GitHub login; bad ids are rejected", async () => {
    // Without Code Storage + the GitHub App, nothing could push edits back: editable links are refused outright.
    const editable = await api(bob, "POST", "/api/workspaces", { github: "octo/hello", readOnly: false });
    expect(editable.status).toBe(400);
    expect(editable.data.error).toContain("GitHub App");
    expect((await api(alice, "POST", "/api/workspaces", { github: "octo/.." })).status).toBe(400);
    expect((await api(alice, "POST", "/api/workspaces", { title: ".." })).status).toBe(400);
    expect((await api(alice, "GET", "/api/workspace/%E0%A4%A/tree")).status).toBe(400);
  });

  test("repos that aren't ready refuse reads (409) and websockets (1013)", async () => {
    insertRepo("api-importing", { status: "importing" });
    expect((await api(alice, "GET", "/api/workspace/api-importing/tree")).status).toBe(409);
    const c = connect(alice, "api-importing", "README.md");
    await waitFor(() => c.closeCode !== null);
    expect(c.closeCode).toBe(1013);
  });
});

describe("websocket", () => {
  test("rejects cross-origin connections", async () => {
    const c = connect(alice, N, "Welcome.md", "https://evil.example");
    await waitFor(() => c.closeCode !== null);
    expect(c.closeCode).toBe(4403);
  });

  test("rejects without a session or for missing files", async () => {
    const c = connect("np_session=bogus", N, "Welcome.md");
    await waitFor(() => c.closeCode !== null);
    expect(c.closeCode).toBe(4401);
    const d = connect(alice, N, "does-not-exist.md");
    await waitFor(() => d.closeCode !== null);
    expect(d.closeCode).toBe(4404);
  });

  test("syncs, and commits after the quiet period", async () => {
    const c = connect(alice, N, "Welcome.md");
    await waitFor(() => c.text.toString().startsWith("# Welcome"));
    expect(c.controls[0]).toMatchObject({ t: "hello", readOnly: false, dirty: false });
    c.text.insert(c.text.length, "\nTyped by Alice.\n");
    await waitFor(async () => (await committed(alice, N, "Welcome.md"))?.includes("Typed by Alice.") ?? false);
    const [last] = (await api(alice, "GET", `/api/workspace/${N}/history?path=Welcome.md`)).data;
    expect(last).toMatchObject({ authorName: "Alice", authorEmail: (await api(alice, "GET", "/api/me")).data.email });
    await waitFor(() => c.controls.some((m) => m.t === "status" && !m.dirty && m.commit === last.sha));
    c.close();
  });

  test("two clients see each other's edits and awareness", async () => {
    const a = connect(alice, N, "Welcome.md");
    const b = connect(bob, N, "Welcome.md");
    await waitFor(() => a.text.length > 0 && b.text.length > 0);
    a.text.insert(0, "A! ");
    b.text.insert(b.text.length, "B!");
    await waitFor(() => a.text.toString() === b.text.toString() && a.text.toString().startsWith("A! ") && a.text.toString().endsWith("B!"));
    a.awareness.setLocalStateField("user", { id: "alice", name: "Alice", color: "#f00", kind: "human" });
    await waitFor(() => [...b.awareness.getStates().values()].some((s: any) => s.user?.name === "Alice"));
    a.close();
    await waitFor(() => ![...b.awareness.getStates().values()].some((s: any) => s.user?.name === "Alice"));
    b.close();
  });

  test("read-only repos ignore edits", async () => {
    await app.ctx.store.createRepo("ro-api", { branch: "main" });
    await app.ctx.store.commit({
      repo: "ro-api",
      branch: "main",
      expectedHead: null,
      changes: [{ path: "README.md", content: "read me\n" }],
      message: "seed",
      author: { name: "x", email: "x@example.com" },
    });
    db.query("INSERT INTO repos (id, title, kind, gh_owner, gh_name, read_only, branch, status, created_at) VALUES ('ro-api', 'o/ro', 'github', 'o', 'ro', 1, 'main', 'ready', ?)").run(
      Date.now(),
    );
    tempRepos.push("ro-api");
    expect((await api(alice, "GET", "/api/workspace/ro-api")).data).toMatchObject({ id: "ro-api", readOnly: true });
    expect((await api(alice, "POST", "/api/workspace/ro-api/files", { path: "x.md" })).status).toBe(403);

    const c = connect(alice, "ro-api", "README.md");
    await waitFor(() => c.text.toString() === "read me\n");
    expect(c.controls[0]).toMatchObject({ t: "hello", readOnly: true });
    c.text.insert(0, "vandalism ");
    await Bun.sleep(300);
    expect((await api(alice, "GET", "/api/workspace/ro-api/file?path=README.md")).data.content).toBe("read me\n");
    expect(await committed(alice, "ro-api", "README.md")).toBe("read me\n");
    c.close();
  });
});

describe("MCP (/mcp, OAuth)", () => {
  const rpc = (headers: Record<string, string>, body: unknown) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify(body),
    });

  /** The whole OAuth flow for `cookie`'s account: registration, consent, code, token. */
  async function oauthToken(cookie: string): Promise<string> {
    const redirect = "http://127.0.0.1:43210/callback";
    const reg = await (await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Test client", redirect_uris: [redirect] }) })).json();
    expect(reg.client_id).toStartWith("gmc_");
    const verifier = "v".repeat(50);
    const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
    const params = { response_type: "code", client_id: reg.client_id, redirect_uri: redirect, state: "st", code_challenge: challenge, code_challenge_method: "S256", resource: `${base}/mcp` };
    const page = await fetch(`${base}/oauth/authorize?${new URLSearchParams(params)}`, { headers: { cookie }, redirect: "manual" });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Test client");
    const allow = await fetch(`${base}/oauth/authorize`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ ...params, decision: "allow" }), redirect: "manual" });
    expect(allow.status).toBe(303);
    const back = new URL(allow.headers.get("location")!);
    expect(back.searchParams.get("state")).toBe("st");
    const tok = await (await fetch(`${base}/oauth/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code")!, code_verifier: verifier, client_id: reg.client_id, redirect_uri: redirect }) })).json();
    expect(tok.token_type).toBe("Bearer");
    return tok.access_token as string;
  }

  test("discovery: a 401 names the resource metadata, which names this server", async () => {
    const r = await rpc({}, { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource"`);
    // cookies never count
    expect((await rpc({ cookie: alice }, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
    const meta = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(meta).toMatchObject({ resource: `${base}/mcp`, authorization_servers: [base] });
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(as).toMatchObject({ issuer: base, code_challenge_methods_supported: ["S256"], registration_endpoint: `${base}/oauth/register` });
  });

  test("signed out, authorize sends people to sign in first; a foreign redirect is refused", async () => {
    const reg = await (await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://client.example/cb"] }) })).json();
    const q = { response_type: "code", client_id: reg.client_id, redirect_uri: "https://client.example/cb", code_challenge: "c".repeat(43), code_challenge_method: "S256" };
    const r = await fetch(`${base}/oauth/authorize?${new URLSearchParams(q)}`, { redirect: "manual" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toStartWith("/auth/dev?next=%2Foauth%2Fauthorize");
    expect((await fetch(`${base}/oauth/authorize?${new URLSearchParams({ ...q, redirect_uri: "https://evil.example/cb" })}`, { headers: { cookie: alice } })).status).toBe(400);
    expect((await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }) })).status).toBe(400);
  });

  test("the consent POST: Origin null with Sec-Fetch-Site same-origin passes (real browsers); cross-site fails", async () => {
    const redirect = "http://127.0.0.1:43210/callback";
    const reg = await (await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirect] }) })).json();
    const params = { response_type: "code", client_id: reg.client_id, redirect_uri: redirect, state: "st", code_challenge: "c".repeat(43), code_challenge_method: "S256" };
    const page = await fetch(`${base}/oauth/authorize?${new URLSearchParams(params)}`, { headers: { cookie: alice } });
    expect(page.headers.get("referrer-policy")).toBe("same-origin");
    const post = (headers: Record<string, string>) =>
      fetch(`${base}/oauth/authorize`, { method: "POST", headers: { cookie: alice, ...headers }, body: new URLSearchParams({ ...params, decision: "allow" }), redirect: "manual" });
    const nav = { "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate" };
    for (const ok of [{ origin: "null", ...nav }, nav]) {
      const r = await post(ok);
      expect(r.status).toBe(303);
      expect(new URL(r.headers.get("location")!).searchParams.get("code")).toBeTruthy();
    }
    for (const bad of [{ origin: "https://evil.example", ...nav }, { origin: "null", "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" }, { origin: "null", "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate" }, { origin: "null" }, {}] as Record<string, string>[]) {
      expect((await post(bad)).status).toBe(403);
    }
  });

  test("a token from the flow: tools, list_workspaces, command (live writes, scoped to one workspace)", async () => {
    const token = await oauthToken(alice);
    const auth = { authorization: `Bearer ${token}` };
    // bound to /mcp (audience "mcp"): the API refuses it
    expect((await fetch(`${base}/api/me`, { headers: auth })).status).toBe(401);
    const init = await rpc(auth, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", title: "Test Agent", version: "1" } } });
    expect(init.status).toBe(200);
    const sid = init.headers.get("mcp-session-id")!;
    expect((await init.json()).result.instructions).toContain("list_workspaces");
    const h = { ...auth, "mcp-session-id": sid };
    const tools = (await (await rpc(h, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json()).result.tools.map((t: { name: string }) => t.name);
    expect(tools).toEqual(["list_workspaces", "changes", "command"]);
    const mine = (await api(alice, "POST", "/api/workspaces", { title: "MCP Mine" })).data.id as string;
    const list = (await (await rpc(h, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_workspaces", arguments: {} } })).json()).result;
    expect(list.structuredContent.workspaces).toContainEqual(expect.objectContaining({ id: mine, access: "write", notes: 1 }));
    const call = (args: Record<string, unknown>) => rpc(h, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "command", arguments: args } }).then((r) => r.json());
    expect((await call({ workspace: mine, command: "pwd; ls /workspace" })).result.content[0].text).toBe(`/workspace/${mine}\n${mine}\n`);
    expect((await call({ workspace: mine, command: "echo 'hello from mcp' > mcp.md" })).result.isError).toBeFalsy();
    expect((await api(alice, "GET", `/api/workspace/${mine}/file?path=mcp.md`)).data.content).toBe("hello from mcp\n");
    // directory and session_id; the old session argument is gone
    await call({ workspace: mine, command: "mkdir -p ideas && echo '# I' > ideas/i.md" });
    expect((await call({ workspace: mine, command: "pwd", directory: "ideas" })).result.content[0].text).toBe(`/workspace/${mine}/ideas\n`);
    expect((await call({ workspace: mine, command: "pwd", directory: "../x" })).result).toMatchObject({ isError: true, content: [{ text: "No folder '../x' in this workspace" }] });
    expect((await call({ workspace: mine, command: "pwd", session: "s" })).result.content[0].text).toStartWith("unknown argument: session");
    await call({ workspace: mine, command: "echo '- s' >> ideas/i.md", session_id: "ses_mcp" });
    expect((await app.ctx.store.history(mine, "main", "ideas/i.md", 1))[0]!.message).toEndWith("\n\nAgent-Session-Id: ses_mcp");
    // the changes tool: nothing since the agent's commit, then a person's note, as text and JSON
    const changes = () => rpc(h, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "changes", arguments: { workspace: mine } } }).then((r) => r.json());
    expect((await changes()).result.content[0].text).toMatch(/^Manual changes since the last agent commit [0-9a-f]{7} \(Test Agent, just now\):\n\(none\)\n$/);
    await api(alice, "POST", `/api/workspace/${mine}/files`, { path: "by-hand.md", content: "# By hand\n" });
    const ch = (await changes()).result;
    expect(ch.content[0].text).toContain("A by-hand.md  +1 -0");
    expect(ch.structuredContent.files.map((f: { path: string }) => f.path)).toEqual(["by-hand.md"]);
    // another workspace by id (not in the list) works too; unknown ones don't
    expect((await call({ workspace: N, command: "cat Welcome.md" })).result.isError).toBeFalsy();
    expect((await call({ workspace: "no-such-ws", command: "ls" })).result.isError).toBe(true);
    // the token is an app token: revocable
    expect((await rpc({ authorization: "Bearer gmt_nope" }, { jsonrpc: "2.0", id: 1, method: "ping" })).headers.get("www-authenticate")).toContain('error="invalid_token"');
  });
});

describe("agents on the workspace URL", () => {
  const RO = "ro-share";

  let other = "";
  let gina = "";
  let token = "";

  /** POST a command to a workspace URL: a string is sent as a plain-text body, an object as JSON. */
  async function post(url: string, body: string | Record<string, unknown>, headers: Record<string, string> = {}) {
    const res = await fetch(url, {
      method: "POST",
      headers: typeof body === "string" ? headers : { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data, headers: res.headers };
  }
  /** A workspace's URL on the test server (config.publicUrl may point elsewhere). */
  const local = (id: string) => `${base}/app/${id}`;

  beforeAll(async () => {
    other = (await api(alice, "POST", "/api/workspaces", { title: "Share Other" })).data.id;
    tempRepos.push(other);
    await api(alice, "POST", `/api/workspace/${other}/files`, { path: "secret.md", content: "secret\n" });
    await app.ctx.store.createRepo(RO, { branch: "main" });
    await app.ctx.store.commit({ repo: RO, branch: "main", expectedHead: null, changes: [{ path: "README.md", content: "read me\n" }], message: "seed", author: { name: "x", email: "x@example.com" } });
    db.query("INSERT INTO repos (id, title, kind, gh_owner, gh_name, read_only, branch, status, created_at) VALUES (?, 'o/ro-share', 'github', 'o', 'ro-share', 1, 'main', 'ready', ?)").run(RO, Date.now());
    tempRepos.push(RO);
    gina = await login("Gina");
    const ginaId = (await api(gina, "GET", "/api/me")).data.id as string;
    token = (await createAppToken(app.ctx.repos.db, ginaId, "agent test")).token;
  });

  test("GET: instructions for the agent, then the notes; browsers get the app", async () => {
    const res = await fetch(local(N));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("vary")).toContain("Accept");
    const text = await res.text();
    expect(text).toContain("Grim workspace: Notes");
    expect(text).toContain(`/workspace/${N}`);
    expect(text).toContain(`curl -s -X POST --data-binary 'ls -R' '${config.publicUrl}/app/${N}?format=text'`);
    expect(text).toContain("X-Agent-Name");
    expect(text).toContain("EDIT existing notes");
    expect(text).toContain("Authorization: Bearer");
    expect(text.trimEnd().endsWith("Welcome.md")).toBe(true);
    const md = await fetch(local(N), { headers: { accept: "text/markdown" } });
    expect(md.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const roText = await (await fetch(local(RO))).text();
    expect(roText).toContain("read-only");
    expect(roText).toContain("README.md");
    expect(roText).not.toContain("sed -i");
    const browser = await fetch(local(N), { headers: { accept: "text/html,application/xhtml+xml" } });
    expect(browser.headers.get("content-type")).toContain("text/html");
    // notes still answer their Markdown
    expect(await (await fetch(`${local(N)}/Welcome.md`)).text()).toContain("# Welcome");
    expect((await fetch(local("nope"))).status).toBe(404);
  });

  test("old agent links answer 410", async () => {
    for (const p of ["/a/x", "/a/00000000-0000-4000-8000-000000000000", "/a/x/changes"]) {
      const r = await fetch(`${base}${p}`, { method: p.endsWith("changes") ? "GET" : "POST", body: p.endsWith("changes") ? undefined : "ls" });
      expect(r.status).toBe(410);
      expect(await r.text()).toContain("/app/<workspace-id>");
    }
    expect((await fetch(`${base}/api/workspace/${N}/agent-link`, { method: "POST", headers: { cookie: alice, "content-type": "application/json" }, body: "{}" })).status).toBe(404);
  });

  test("POST: plain text or JSON; starts in the workspace; only that workspace is visible", async () => {
    const url = local(N);
    const plain = await post(url, "pwd; ls /workspace");
    expect(plain.status).toBe(200);
    expect(plain.data).toEqual({ stdout: `/workspace/${N}\n${N}\n`, stderr: "", exitCode: 0, cwd: `/workspace/${N}`, truncated: false });
    const form = await post(url, "echo $HOME", { "content-type": "application/x-www-form-urlencoded" });
    expect(form.data.stdout).toBe(`/workspace/${N}\n`);
    expect((await post(url, { command: "cat Welcome.md | head -1" })).data.stdout).toContain("# Welcome");
    const asJson = JSON.stringify({ command: "echo json" });
    expect((await post(url, asJson, { "content-type": "application/x-www-form-urlencoded" })).data.stdout).toBe("json\n");
    expect((await post(url, asJson, { "content-type": "text/plain" })).data.stdout).not.toBe("json\n");
    const secret = await post(url, `repos; cat /workspace/${other}/secret.md`);
    expect(secret.data.exitCode).not.toBe(0);
    expect(secret.data.stdout + secret.data.stderr).not.toContain("secret\n");

    const text = await fetch(`${url}?format=text`, { method: "POST", body: "echo out; echo err >&2; exit 3" });
    expect(text.headers.get("x-exit-code")).toBe("3");
    expect(await text.text()).toBe("out\n[stderr]\nerr\n[exit 3]\n");

    for (const bad of [{}, { command: 5 }, { command: " " }, { command: "true", session: "x" }, { command: "true", directory: 5 }, { command: "true", directory: "nope" }, { command: "true", directory: ".." }, { command: "true", timeout_seconds: 999 }, { command: "true", cwd: "/" }]) {
      const r = await post(url, bad);
      expect(r.status).toBe(400);
      expect(typeof r.data.error).toBe("string");
    }
    expect((await post(url, "x".repeat(1024 * 1024 + 1))).status).toBe(413);
    expect((await post(`${url}/Welcome.md`, "ls")).status).toBe(405);
    expect((await post(local("nope"), "ls")).status).toBe(404);
    const demo = await post(`${base}/app/demo?format=text`, "ls");
    expect(demo.status).toBe(404);
    expect(demo.data).toContain("agents can't join");
  });

  test("without a token: guest rules (edit existing notes only)", async () => {
    const url = local(N);
    await api(alice, "POST", `/api/workspace/${N}/files`, { path: "guest/edit.md", content: "# Edit\n- one\n" });
    const edit = await post(url, "echo '- two' >> guest/edit.md && sed -i 's/one/uno/' guest/edit.md && cat guest/edit.md", { "x-agent-name": "Guesty" });
    expect(edit.data).toMatchObject({ exitCode: 0, stdout: "# Edit\n- uno\n- two\n" });
    const create = await post(url, "echo hi > guest/new.md");
    expect(create.data.exitCode).not.toBe(0);
    expect(create.data.stderr).toContain("Creating notes needs a token: send Authorization: Bearer <token> or use MCP");
    for (const cmd of ["mv guest/edit.md guest/moved.md", "rm guest/edit.md", "mkdir guest/dir", "cp guest/edit.md guest/copy.md"]) {
      const r = await post(url, cmd);
      expect(r.data.exitCode).not.toBe(0);
      expect(r.data.stderr).toContain("needs a token");
    }
    expect((await api(alice, "GET", `/api/workspace/${N}/file?path=guest/edit.md`)).status).toBe(200);
    expect((await api(alice, "GET", `/api/workspace/${N}/file?path=guest/new.md`)).status).toBe(404);
  });

  test("with a token: that account's access; a bad token is refused", async () => {
    const url = local(N);
    const auth = { authorization: `Bearer ${token}`, "x-agent-name": "Tokened" };
    const made = await post(url, "mkdir -p tok && echo '# T' > tok/new.md && mv tok/new.md tok/moved.md && cat tok/moved.md", auth);
    expect(made.data).toMatchObject({ exitCode: 0, stdout: "# T\n" });
    await waitFor(async () => (await committed(alice, N, "tok/moved.md")) === "# T\n");
    const [last] = (await api(alice, "GET", `/api/workspace/${N}/history?path=tok/moved.md`)).data;
    expect(last).toMatchObject({ authorName: "Tokened", authorEmail: "tokened@agents.grimoire" });
    const bad = await post(url, "ls", { authorization: "Bearer gmt_nope" });
    expect(bad.status).toBe(401);
    expect(bad.data.error).toContain("invalid or expired token");
  });

  test("every call starts fresh, in its directory; session_id: a commit trailer and a line author per session", async () => {
    const url = local(N);
    await post(url, "cd /tmp && X=42");
    expect((await post(url, "pwd; echo \"[$X]\"")).data.stdout).toBe(`/workspace/${N}\n[]\n`);
    await post(url, "mkdir -p sub && echo '# Sub' > sub/a.md", { authorization: `Bearer ${token}` });
    expect((await post(url, { command: "pwd; ls", directory: "sub" })).data.stdout).toBe(`/workspace/${N}/sub\na.md\n`);
    expect((await post(url, "pwd", { "x-agent-directory": "sub" })).data.stdout).toBe(`/workspace/${N}/sub\n`);
    expect((await post(url, { command: "pwd", directory: "nope" })).data.error).toBe("No folder 'nope' in this workspace");
    expect((await post(url, { command: "pwd", directory: "sub/../.." })).data.error).toBe("No folder 'sub/../..' in this workspace");
    // session_id: the commit ends with an Agent-Session-Id trailer, and each session is a line author of its own
    await post(url, { command: "echo '- one' >> sub/a.md", session_id: "ses_one" }, { "x-agent-name": "Scribe" });
    await post(url, "echo '- two' >> sub/a.md", { "x-agent-name": "Scribe", "x-agent-session-id": "ses_two" });
    const [last] = await app.ctx.store.history(N, "main", "sub/a.md", 1);
    expect(last!.message).toBe("Update sub/a.md\n\nAgent-Session-Id: ses_two");
    expect((await post(url, "git log -n 1 sub/a.md")).data.stdout).toContain("    Agent-Session-Id: ses_two\n");
    const authors = app.ctx.rooms.peek(N, "sub/a.md")!.blame().authors.filter((a) => a.kind === "agent");
    expect(authors.map((a) => a.session).sort()).toEqual(["ses_one", "ses_two"]);
    expect(authors.every((a) => a.name === "Scribe" && /^#/.test(a.sessionColor ?? ""))).toBe(true);
    // an invalid one is ignored: the write goes through, without a trailer
    expect((await post(url, { command: "echo '- three' >> sub/a.md", session_id: "not valid!" })).data.exitCode).toBe(0);
    expect((await app.ctx.store.history(N, "main", "sub/a.md", 1))[0]!.message).toBe("Update sub/a.md");
  });

  test("changes: the shell built-in and GET /changes", async () => {
    const url = local(N);
    await post(url, "echo '- agent' >> guest/edit.md", { "x-agent-name": "Scribe" });
    await waitFor(async () => ((await api(alice, "GET", `/api/workspace/${N}/history?path=guest/edit.md`)).data[0]?.authorName ?? "") === "Scribe");
    await api(alice, "POST", `/api/workspace/${N}/files`, { path: "guest/by-hand.md", content: "# By hand\n" });
    const ch = await (await fetch(`${url}/changes?path=guest`)).json();
    expect(ch.since).toMatchObject({ agent: "Scribe" });
    expect(ch.files).toEqual([expect.objectContaining({ path: "guest/by-hand.md", status: "added", added: 1, removed: 0 })]);
    expect((await post(url, "changes --stat", { accept: "text/plain" })).data).toContain("guest/by-hand.md");
  });

  test("read-only workspaces refuse writes, token or not", async () => {
    const url = local(RO);
    expect((await post(url, "cat README.md")).data.stdout).toBe("read me\n");
    for (const headers of [{}, { authorization: `Bearer ${token}` }] as Record<string, string>[]) {
      const w = await post(url, "echo nope >> README.md", headers);
      expect(w.data.exitCode).not.toBe(0);
      expect(w.data.stderr).toContain("read-only");
    }
    expect(await committed(alice, RO, "README.md")).toBe("read me\n");
  });

  test("not ready → 409; rate limit → 429 per caller and workspace", async () => {
    insertRepo("share-importing", { kind: "notes", status: "importing" });
    expect((await fetch(local("share-importing"))).status).toBe(409);
    expect((await post(local("share-importing"), "true")).status).toBe(409);

    const old = agentLimits.perMinute;
    agentLimits.perMinute = 3;
    try {
      for (let i = 0; i < 3; i++) expect((await post(local(other), "true")).status).toBe(200);
      const limited = await post(local(other), "true");
      expect(limited.status).toBe(429);
      expect(limited.data.error).toContain("Too many calls");
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
      // a token counts apart
      expect((await post(local(other), "true", { authorization: `Bearer ${token}` })).status).toBe(200);
    } finally {
      agentLimits.perMinute = old;
    }
  });

  test("at most a few commands at once per caller and workspace, across names and agent sessions", async () => {
    const url = local(other);
    const old = agentLimits.concurrent;
    agentLimits.concurrent = 2;
    try {
      const slow = [post(url, "sleep 1", { "x-agent-session-id": "c1" }), post(url, "sleep 1", { "x-agent-name": "B", "x-agent-session-id": "c2" })];
      await waitFor(() => [...((app.shells as any).running as Map<string, number>).values()].reduce((a, b) => a + b, 0) === 2);
      const busy = await post(url, "true", { "x-agent-name": "C" });
      expect(busy.status).toBe(429);
      expect(busy.data.error).toContain("running or queued");
      expect((await Promise.all(slow)).map((r) => r.status)).toEqual([200, 200]);
      expect((await post(url, "true")).status).toBe(200);
    } finally {
      agentLimits.concurrent = old;
    }
  });

  test("body limit applies to streamed bodies too", async () => {
    const chunk = new Uint8Array(256 * 1024).fill(120);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= 8) return c.close();
        sent++;
        c.enqueue(chunk);
      },
    });
    const res = await fetch(local(N), { method: "POST", body: stream, duplex: "half" } as RequestInit);
    expect(res.status).toBe(413);
    expect((await res.json()).error).toContain("too large");
  });

  test("older databases lose the share_links table", async () => {
    const tmp = mkdtempSync(join(dir, "migrate-"));
    const { Database } = await import("bun:sqlite");
    const old = new Database(join(tmp, "grimoire.sqlite"));
    old.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, github_id INTEGER UNIQUE, login TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, avatar TEXT, github_token TEXT, is_admin INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE repos (id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL, gh_owner TEXT, gh_name TEXT, read_only INTEGER NOT NULL DEFAULT 0, branch TEXT NOT NULL, status TEXT NOT NULL, error TEXT, created_by TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE share_links (id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE, label TEXT, created_by TEXT, created_at INTEGER, last_used_at INTEGER, revoked_at INTEGER);
      CREATE INDEX share_links_repo ON share_links(repo_id);
      INSERT INTO repos (id, title, kind, branch, status, created_at) VALUES ('r1', 'R', 'notes', 'main', 'ready', 1);
      INSERT INTO share_links (id, repo_id, label, created_by, created_at) VALUES ('l1', 'r1', 'Gone', NULL, 5);`);
    old.close();
    const p = Bun.spawn([process.execPath, "-e", `const { db } = await import(${JSON.stringify(join(import.meta.dir, "../../src/server/db.ts"))});
      console.log(JSON.stringify(db.query("SELECT name FROM sqlite_master WHERE name LIKE 'share_links%'").all()));`], {
      env: { ...process.env, DATA_DIR: tmp },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(err).toBe("");
    expect(JSON.parse(out)).toEqual([]);
  });
});

describe("static", () => {
  test("dist path traversal is blocked", async () => {
    expect((await fetch(`${base}/dist/..%2Fpackage.json`)).status).toBe(404);
  });
});

describe("GitHub repos", () => {
  const ghTmp = mkdtempSync(join(dir, "github-"));
  const up = upstreams(ghTmp);
  /** What the mocked GitHub API knows about, by lowercased owner/name. */
  const known = new Map<string, { private: boolean; default_branch: string; full_name: string }>();
  const calls: Array<{ url: string; auth: string | null }> = [];
  let rateLimited = false;
  const oldBase = config.github.gitBase;

  beforeAll(async () => {
    config.github.gitBase = up.base;
    setGitHubFetch(async (url, init) => {
      const auth = new Headers(init.headers).get("authorization");
      calls.push({ url, auth });
      if (rateLimited) {
        return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600) },
        });
      }
      const m = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)$/.exec(url);
      const r = m && known.get(`${decodeURIComponent(m[1]!)}/${decodeURIComponent(m[2]!)}`.toLowerCase());
      if (!r) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      return Response.json(r);
    });
    const handbook = await up.make("acme", "handbook", { "README.md": "# Handbook\n", "guide/a.md": "# A\n", "logo.bin": "x".repeat(50_000) });
    await sh(["branch", "feature/x", "main"], handbook.bare);
    known.set("acme/handbook", { private: false, default_branch: "main", full_name: "acme/handbook" });
    await up.make("acme", "code", { "src/a.ts": "export {}\n" });
    known.set("acme/code", { private: false, default_branch: "main", full_name: "acme/code" });
    await up.make("acme", "limits", { "README.md": "# Limits\n" });
    // Known to the API too; the rate-limit test reaches it over Git only.
    known.set("acme/limits", { private: false, default_branch: "main", full_name: "acme/limits" });
    known.set("acme/secret", { private: true, default_branch: "main", full_name: "acme/secret" });
  });

  afterAll(async () => {
    setGitHubFetch(null);
    config.github.gitBase = oldBase;
    for (const r of db.query("SELECT id FROM repos WHERE gh_owner = 'acme'").all() as Array<{ id: string }>) await app.ctx.repos.removeRepo(r.id);
    rmSync(ghTmp, { recursive: true, force: true });
  });

  async function ready(cookie: string, id: string) {
    let repo: any;
    await waitFor(async () => (repo = (await api(cookie, "GET", `/api/workspace/${id}`)).data).status !== "importing", 10_000);
    return repo;
  }

  let handbookId = "";

  test("anyone signed in can add a public repo read-only, by URL, without a GitHub token", async () => {
    calls.length = 0;
    const r = await api(bob, "POST", "/api/workspaces", { github: "https://github.com/Acme/Handbook/tree/main" });
    expect(r.status).toBe(201);
    expect(r.data).toMatchObject({ kind: "github", title: "acme/handbook", ghOwner: "acme", ghName: "handbook", branch: "main", readOnly: true, canRemove: true });
    expect(calls.every((c) => c.auth === null)).toBe(true);
    handbookId = r.data.id;
    expect(await ready(bob, handbookId)).toMatchObject({ status: "ready", error: null });
    expect((await api(bob, "GET", `/api/workspace/${handbookId}/tree`)).data.files).toEqual(["README.md", "guide/a.md"]);
    expect((await api(bob, "GET", `/api/workspace/${handbookId}/file?path=README.md`)).data.content).toBe("# Handbook\n");
    expect((await api(bob, "GET", `/api/workspace/${handbookId}/history?path=README.md`)).data).toHaveLength(1);
    expect((await api(bob, "POST", `/api/workspace/${handbookId}/files`, { path: "x.md" })).status).toBe(403);
    // Only the repo's Markdown was downloaded.
    const dir = join(config.dataDir, "git", `${handbookId}.git`);
    expect((await sh(["config", "remote.origin.promisor"], dir)).trim()).toBe("true");
    const missing = await sh(["cat-file", "--batch-check"], dir, (await sh(["rev-parse", "HEAD:logo.bin"], dir)), { GIT_NO_LAZY_FETCH: "1" });
    expect(missing).toContain("missing");
    // Everyone with its URL may read it; only its creator (its owner) may remove it, and not other repos.
    expect((await api(alice, "GET", `/api/workspace/${handbookId}`)).data).toMatchObject({ id: handbookId, readOnly: true, canRemove: false });
    expect((await api(bob, "GET", "/api/workspaces")).data).toContainEqual(expect.objectContaining({ id: handbookId, canRemove: true }));
    expect((await api(bob, "GET", "/api/workspaces")).data.find((x: any) => x.id === "api-notes")?.canRemove).toBe(false);
  });

  test("adding the same repo again returns the existing copy", async () => {
    for (const github of ["acme/handbook", "git@github.com:acme/handbook.git", "https://github.com/ACME/handbook.git", "https://github.com/acme/handbook/blob/main/guide/a.md"]) {
      const r = await api(alice, "POST", "/api/workspaces", { github });
      expect(r.status).toBe(200);
      expect(r.data.id).toBe(handbookId);
    }
    expect((db.query("SELECT COUNT(*) AS n FROM repos WHERE lower(gh_owner) = 'acme' AND lower(gh_name) = 'handbook'").get() as { n: number }).n).toBe(1);
  });

  test("branches from /tree/ URLs, including names with slashes", async () => {
    const r = await api(bob, "POST", "/api/workspaces", { github: "https://github.com/acme/handbook/tree/feature/x/guide" });
    expect(r.status).toBe(201);
    expect(r.data).toMatchObject({ branch: "feature/x", title: "acme/handbook (feature/x)" });
    expect(r.data.id).not.toBe(handbookId);
    expect((await ready(bob, r.data.id)).status).toBe("ready");
    expect((await api(bob, "POST", "/api/workspaces", { github: "acme/handbook", branch: "feature/x" })).data.id).toBe(r.data.id);
    expect((await api(bob, "POST", "/api/workspaces", { github: "https://github.com/acme/handbook/tree/nope" })).status).toBe(404);
  });

  test("clear errors: bad input, unknown or private repos, unsafe branches, no Markdown", async () => {
    expect((await api(bob, "POST", "/api/workspaces", { github: "https://gitlab.com/a/b" })).status).toBe(400);
    expect((await api(bob, "POST", "/api/workspaces", { github: "acme/handbook", branch: "--upload-pack=touch /tmp/x" })).status).toBe(400);
    const missing = await api(bob, "POST", "/api/workspaces", { github: "acme/nothing" });
    expect(missing.status).toBe(404);
    expect(missing.data.error).toContain("wasn't found");
    const secret = await api(bob, "POST", "/api/workspaces", { github: "https://github.com/acme/secret" });
    expect(secret.status).toBe(403);
    expect(secret.data.error).toContain("private");
    // Editable links keep the old rules.
    expect((await api(bob, "POST", "/api/workspaces", { github: "acme/handbook", readOnly: false })).status).toBe(400);

    const code = await api(bob, "POST", "/api/workspaces", { github: "acme/code" });
    expect(code.status).toBe(201);
    const repo = await ready(bob, code.data.id);
    expect(repo).toMatchObject({ status: "error", error: "No Markdown files in acme/code on main" });
    expect(existsSync(join(config.dataDir, "git", `${code.data.id}.git`))).toBe(false);
    // Anyone may retry a failed import (and then counts as its creator for the caps); only its owners remove it.
    const carol = await login("Carol");
    expect((await api(carol, "GET", `/api/workspace/${code.data.id}`)).data.canRemove).toBe(false);
    const retry = await api(carol, "POST", "/api/workspaces", { github: "acme/code" });
    expect(retry.status).toBe(200);
    expect(retry.data).toMatchObject({ id: code.data.id, status: "importing" });
    expect((db.query("SELECT created_by FROM repos WHERE id = ?").get(code.data.id) as any).created_by).toBe(await uid(carol));
    expect((await ready(carol, code.data.id)).status).toBe("error");
    expect((await api(carol, "DELETE", `/api/workspace/${code.data.id}`)).status).toBe(403);
    expect((await api(bob, "DELETE", `/api/workspace/${code.data.id}`)).status).toBe(200);
  });

  test("read-only adds never send the user's GitHub token", async () => {
    const tess = await login("Tess");
    db.query("UPDATE users SET github_token = 'secret-token' WHERE id = ?").run(await uid(tess));
    calls.length = 0;
    // No explicit branch: GitHub is asked which branch is the default before matching the existing copy.
    const r = await api(tess, "POST", "/api/workspaces", { github: "acme/handbook" });
    expect(r.status).toBe(200);
    expect(r.data.id).toBe(handbookId);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.auth === null)).toBe(true);
    // An explicit branch that's already here needs no GitHub call at all.
    calls.length = 0;
    expect((await api(tess, "POST", "/api/workspaces", { github: "acme/handbook", branch: "main" })).data.id).toBe(handbookId);
    expect(calls).toEqual([]);
  });

  test("editable links: the same rule for everyone (a GitHub sign-in with access on GitHub), the first account too", async () => {
    const old = { storage: config.storage, appSlug: config.github.appSlug };
    Object.assign(config, { storage: "codestorage" });
    config.github.appSlug = "grimoire-test";
    try {
      // No GitHub sign-in: refused before GitHub is asked, whoever asks.
      for (const who of [alice, bob]) {
        const r = await api(who, "POST", "/api/workspaces", { github: "acme/secret", readOnly: false });
        expect(r.status).toBe(403);
        expect(r.data.error).toContain("GitHub sign-in");
      }
      // A GitHub sign-in without access to the repo on GitHub: refused too.
      const tess = await login("Tess");
      db.query("UPDATE users SET github_token = 'secret-token' WHERE id = ?").run(await uid(tess));
      const r = await api(tess, "POST", "/api/workspaces", { github: "acme/secret", readOnly: false });
      expect(r.status).toBe(403);
      expect(r.data.error).toContain("don't have access");
    } finally {
      Object.assign(config, { storage: old.storage });
      config.github.appSlug = old.appSlug;
    }
    // Read-only copies of public repos: anyone signed in (see above), never private ones.
    expect((await api(alice, "POST", "/api/workspaces", { github: "acme/secret" })).status).toBe(403);
  });

  test("branches in URLs are checked on GitHub; if that's impossible the add fails instead of guessing", async () => {
    const bare = join(ghTmp, "upstream", "acme", "handbook.git");
    renameSync(bare, `${bare}.away`);
    try {
      const r = await api(bob, "POST", "/api/workspaces", { github: "https://github.com/acme/handbook/tree/feature/x" });
      expect(r.status).toBe(502);
      expect(r.data.error).toContain("could not reach GitHub");
    } finally {
      renameSync(`${bare}.away`, bare);
    }
    // /blob/<branch>/<file>: the file name is never taken as part of the branch.
    const blob = await api(bob, "POST", "/api/workspaces", { github: "https://github.com/acme/handbook/blob/main/guide/a.md" });
    expect(blob.data.id).toBe(handbookId);
  });

  test("caps on read-only copies: per person and in total", async () => {
    const old = { ...config.githubCopies };
    try {
      const mine = await app.ctx.repos.readOnlyCopies(await uid(bob));
      config.githubCopies.perUser = mine.mine;
      const r = await api(bob, "POST", "/api/workspaces", { github: "acme/limits" });
      expect(r.status).toBe(403);
      expect(r.data.error).toContain("the most one person can");
      // Existing copies are still returned.
      expect((await api(bob, "POST", "/api/workspaces", { github: "acme/handbook" })).status).toBe(200);
      config.githubCopies.perUser = 100;
      config.githubCopies.max = mine.total;
      expect((await api(bob, "POST", "/api/workspaces", { github: "acme/limits" })).status).toBe(503);
    } finally {
      Object.assign(config.githubCopies, old);
    }
  });

  test("a repo removed while it imports leaves nothing on disk", async () => {
    const r = await api(bob, "POST", "/api/workspaces", { github: "acme/limits" });
    expect(r.status).toBe(201);
    await app.ctx.repos.removeRepo(r.data.id);
    await Bun.sleep(500);
    expect(existsSync(join(config.dataDir, "git", `${r.data.id}.git`))).toBe(false);
    expect((await api(bob, "GET", `/api/workspace/${r.data.id}`)).status).toBe(404);
  });

  test("imports run at most two at a time, and all finish", async () => {
    const ids: string[] = [];
    for (const n of ["q1", "q2", "q3", "q4"]) {
      await up.make("acme", n, { "README.md": `# ${n}\n` });
      known.set(`acme/${n}`, { private: false, default_branch: "main", full_name: `acme/${n}` });
      ids.push((await api(alice, "POST", "/api/workspaces", { github: `acme/${n}` })).data.id);
    }
    expect((app.ctx.repos as any).importing).toBeLessThanOrEqual(2);
    for (const id of ids) expect((await ready(alice, id)).status).toBe("ready");
    for (const id of ids) await app.ctx.repos.removeRepo(id);
  });

  test("files over the size limit are refused with a clear error", async () => {
    await up.make("acme", "big", { "README.md": "# Big\n", "big.md": "x".repeat(MAX_FILE_BYTES + 10) });
    known.set("acme/big", { private: false, default_branch: "main", full_name: "acme/big" });
    const r = await api(alice, "POST", "/api/workspaces", { github: "acme/big" });
    expect((await ready(alice, r.data.id)).status).toBe("ready");
    const file = await api(alice, "GET", `/api/workspace/${r.data.id}/file?path=big.md`);
    expect(file.status).toBe(413);
    expect(file.data.error).toContain("too large");
    const c = connect(alice, r.data.id, "big.md");
    await waitFor(() => c.closeCode !== null);
    expect(c.closeCode).toBe(4413);
    await app.ctx.repos.removeRepo(r.data.id);
  });

  test("lsRemote reports the default branch and which branches exist", async () => {
    const { lsRemote } = await import("../../src/server/github.ts");
    await up.make("acme", "branches", { "README.md": "x\n" }, "trunk");
    expect(await lsRemote("acme", "branches", ["trunk", "trunk/docs", "nope"])).toEqual({ defaultBranch: "trunk", branches: ["trunk"] });
    expect(await lsRemote("acme", "absent")).toBeNull();
  });

  test("when GitHub's API is rate limited, public repos are checked over Git instead", async () => {
    rateLimited = true;
    try {
      const r = await api(bob, "POST", "/api/workspaces", { github: "acme/limits" });
      expect(r.status).toBe(201);
      expect((await ready(bob, r.data.id)).status).toBe("ready");
      const ghost = await api(bob, "POST", "/api/workspaces", { github: "acme/ghost" });
      expect(ghost.status).toBe(429);
      expect(ghost.data.error).toContain("rate limit");
      expect(ghost.data.error).toContain("10 minutes");
      expect((await api(bob, "DELETE", `/api/workspace/${r.data.id}`)).status).toBe(200);
    } finally {
      rateLimited = false;
    }
  });

  test("refresh pulls new commits from GitHub into the tree and open read-only notes", async () => {
    const c = connect(alice, handbookId, "README.md");
    await waitFor(() => c.text.toString() === "# Handbook\n");
    // Push to the handbook upstream from a fresh clone of it.
    const work = join(ghTmp, "handbook-push");
    await sh(["clone", "-q", join(ghTmp, "upstream", "acme", "handbook.git"), work], ghTmp);
    await Bun.write(join(work, "README.md"), "# Handbook v2\n");
    await Bun.write(join(work, "new.md"), "# New\n");
    await sh(["add", "-A"], work);
    await sh(["-c", "user.name=Up", "-c", "user.email=up@example.com", "commit", "-q", "-m", "Second"], work);
    await sh(["push", "-q", "origin", "HEAD:main"], work);

    const r = await api(bob, "POST", `/api/workspace/${handbookId}/refresh`);
    expect(r.status).toBe(200);
    expect((await api(bob, "GET", `/api/workspace/${handbookId}/tree`)).data).toEqual({ head: r.data.head, files: ["README.md", "guide/a.md", "new.md"] });
    await waitFor(() => c.text.toString() === "# Handbook v2\n");
    expect((await api(bob, "GET", `/api/workspace/${handbookId}/history`)).data.map((x: any) => x.message)).toEqual(["Second", "Initial commit"]);

    // GitHub unreachable after the new commit's trees arrived: the open note stays open and unchanged, and picks
    // the change up once GitHub is back.
    await Bun.write(join(work, "README.md"), "# Handbook v3\n");
    await sh(["-c", "user.name=Up", "-c", "user.email=up@example.com", "commit", "-q", "-am", "Third"], work);
    await sh(["push", "-q", "origin", "HEAD:main"], work);
    const repoRow = db.query("SELECT * FROM repos WHERE id = ?").get(handbookId) as any;
    await app.ctx.store.pullUpstream!(handbookId, "main");
    const bare = join(ghTmp, "upstream", "acme", "handbook.git");
    renameSync(bare, `${bare}.away`);
    try {
      await app.ctx.repos.host.get(handbookId).onPush(repoRow);
      await Bun.sleep(200);
      expect(c.closeCode).toBeNull();
      expect(c.text.toString()).toBe("# Handbook v2\n");
      // A refresh that fails is reported, and still counts toward the cooldown.
      (app.ctx.repos.host.get(handbookId) as any).lastRefresh = 0;
      const failed = await api(bob, "POST", `/api/workspace/${handbookId}/refresh`);
      expect(failed.status).toBe(502);
      expect((await api(bob, "POST", `/api/workspace/${handbookId}/refresh`)).status).toBe(200);
    } finally {
      renameSync(`${bare}.away`, bare);
    }
    await app.ctx.repos.refresh(repoRow);
    await waitFor(() => c.text.toString() === "# Handbook v3\n");
    expect(c.closeCode).toBeNull();
    c.close();
  });

  test("images in a partial clone are downloaded when first served raw", async () => {
    await up.make("acme", "pics", { "README.md": "# Pics\n![a](img/a.png)\n", "img/a.png": PNG });
    known.set("acme/pics", { private: false, default_branch: "main", full_name: "acme/pics" });
    const r = await api(bob, "POST", "/api/workspaces", { github: "acme/pics" });
    expect((await ready(bob, r.data.id)).status).toBe("ready");
    const dir = join(config.dataDir, "git", `${r.data.id}.git`);
    const oid = await sh(["rev-parse", "HEAD:img/a.png"], dir);
    expect(await sh(["cat-file", "--batch-check"], dir, oid, { GIT_NO_LAZY_FETCH: "1" })).toContain("missing");
    const res = await fetch(`${base}/api/workspace/${r.data.id}/raw?path=img/a.png`, { headers: { cookie: bob } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    // listings stay Markdown-only
    expect((await api(bob, "GET", `/api/workspace/${r.data.id}/tree`)).data.files).toEqual(["README.md"]);
    await app.ctx.repos.removeRepo(r.data.id);
  });

  test("a partial clone never keeps more than about the cap of a blob that's too large", async () => {
    const big = crypto.getRandomValues(new Uint8Array(60_000));
    await up.make("acme", "bigpics", { "README.md": "# Big\n", "big.png": big, "small.png": PNG });
    known.set("acme/bigpics", { private: false, default_branch: "main", full_name: "acme/bigpics" });
    const r = await api(bob, "POST", "/api/workspaces", { github: "acme/bigpics" });
    expect((await ready(bob, r.data.id)).status).toBe("ready");
    const dir = join(config.dataDir, "git", `${r.data.id}.git`);
    const oid = (await sh(["rev-parse", "HEAD:big.png"], dir)).trim();
    const packBytes = () => readdirSync(join(dir, "objects", "pack")).reduce((n, f) => n + statSync(join(dir, "objects", "pack", f)).size, 0);
    const before = packBytes();
    await expect(app.ctx.store.readBlob(r.data.id, "big.png", "main", 1000)).rejects.toThrow("too large");
    expect(await sh(["cat-file", "--batch-check"], dir, oid, { GIT_NO_LAZY_FETCH: "1" })).toContain("missing");
    expect(readdirSync(join(dir, "objects", "pack")).filter((f) => f.startsWith("tmp_"))).toEqual([]);
    expect(packBytes() - before).toBeLessThan(20_000);
    // small files still download, also several at once
    const reads = await Promise.all([1, 2, 3, 4].map(() => app.ctx.store.readBlob(r.data.id, "small.png", "main", 1000)));
    for (const b of reads) expect(b).toEqual(PNG);
    expect(await app.ctx.store.readBlob(r.data.id, "big.png", "main", 100_000)).toEqual(big);
    await app.ctx.repos.removeRepo(r.data.id);
  });

  test("GITHUB_COPIES off: adding and refreshing are refused, /api/server says so, existing copies stay readable", async () => {
    config.githubCopiesEnabled = false;
    try {
      expect((await (await fetch(`${base}/api/server`)).json()).githubCopies).toBe(false);
      const r = await api(bob, "POST", "/api/workspaces", { github: "acme/handbook" });
      expect(r.status).toBe(403);
      expect(r.data.error).toContain("Adding GitHub repos is turned off on this server");
      expect((await api(bob, "POST", `/api/workspace/${handbookId}/refresh`)).status).toBe(403);
      expect((await api(bob, "GET", `/api/workspace/${handbookId}/tree`)).status).toBe(200);
    } finally {
      config.githubCopiesEnabled = true;
    }
  });

  test("the creator can remove a read-only copy; others can't", async () => {
    expect((await api(alice, "GET", `/api/workspace/${handbookId}`)).data.canRemove).toBe(false);
    expect((await api(alice, "DELETE", `/api/workspace/${handbookId}`)).status).toBe(403);
    expect((await api(bob, "GET", `/api/workspace/${handbookId}`)).data.canRemove).toBe(true);
    const carol = await login("Carol");
    expect((await api(carol, "DELETE", `/api/workspace/${handbookId}`)).status).toBe(403);
    expect((await api(bob, "DELETE", `/api/workspace/${handbookId}`)).status).toBe(200);
    expect(existsSync(join(config.dataDir, "git", `${handbookId}.git`))).toBe(false);
  });
});

describe("GitHub links without a way to push", () => {
  test("an older editable link is switched to read-only at startup", async () => {
    const { db } = await import("../../src/server/db.ts");
    const { RepoService, getRepo } = await import("../../src/server/repos.ts");
    const { bunDb } = await import("../../src/server/bun/db-bun.ts");
    // Other test files share this database and use editable GitHub repos: put them back afterwards.
    const others = (db.query("SELECT id FROM repos WHERE kind = 'github' AND read_only = 0").all() as Array<{ id: string }>).map((r) => r.id);
    db.query("INSERT INTO repos (id, title, kind, gh_owner, gh_name, read_only, branch, status, created_at) VALUES ('gh-old-edit', 'old/edit', 'github', 'old', 'edit', 0, 'main', 'ready', 0)").run();
    try {
      await new RepoService(null as never, null as never, bunDb()).enforceGitHubReadOnly();
      expect((await getRepo(bunDb(), "gh-old-edit"))!.read_only).toBe(1);
    } finally {
      db.query("DELETE FROM repos WHERE id = 'gh-old-edit'").run();
      for (const id of others) db.query("UPDATE repos SET read_only = 0 WHERE id = ?").run(id);
    }
  });
});

describe("raw images", () => {
  const { MAX_RAW_BYTES } = ops;
  let id = "";
  let first = "";

  /** Commit files (any bytes) straight into a local bare repo, on top of its branch. */
  async function commitRaw(repo: string, files: Record<string, Uint8Array | string>) {
    const cwd = join(config.dataDir, "git", `${repo}.git`);
    const index = join(cwd, `index-test-${crypto.randomUUID()}`);
    const env = { GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@x" };
    const head = (await sh(["rev-parse", "refs/heads/main"], cwd)).trim();
    await sh(["read-tree", head], cwd, undefined, env);
    for (const [path, content] of Object.entries(files)) {
      const p = Bun.spawn(["git", "hash-object", "-w", "--stdin"], { cwd, stdin: typeof content === "string" ? new TextEncoder().encode(content) : content, stdout: "pipe" });
      const oid = (await new Response(p.stdout).text()).trim();
      await sh(["update-index", "--add", "--cacheinfo", `100644,${oid},${path}`], cwd, undefined, env);
    }
    const tree = (await sh(["write-tree"], cwd, undefined, env)).trim();
    const sha = (await sh(["commit-tree", tree, "-p", head, "-m", "images"], cwd, undefined, env)).trim();
    await sh(["update-ref", "refs/heads/main", sha], cwd);
    rmSync(index, { force: true });
    // A push from outside the server: what a webhook does to the head cache.
    (app.ctx.store as unknown as { invalidate(repo: string): void }).invalidate(repo);
    return sha;
  }

  const raw = (cookie: string, repo: string, query: string) => fetch(`${base}/api/workspace/${repo}/raw?${query}`, { headers: cookie ? { cookie } : {} });

  beforeAll(async () => {
    const r = await api(alice, "POST", "/api/workspaces", { title: "Raw images" });
    id = r.data.id;
    tempRepos.push(id);
    first = await commitRaw(id, { "img/cat.png": PNG, "img/logo.svg": SVG, "Photo.JPG": "jpeg", "notes.txt": "text", "a/b/c.webp": "webp" });
  });

  test("serves images with their type, short private caching and nosniff", async () => {
    const res = await raw(alice, id, "path=img/cat.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("private, max-age=60");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    expect((await raw(alice, id, "path=Photo.JPG")).headers.get("content-type")).toBe("image/jpeg");
    expect((await raw(alice, id, "path=a/b/c.webp")).headers.get("content-type")).toBe("image/webp");
    expect((await raw(alice, id, "path=/a//b/./c.webp")).status).toBe(200);
  });

  test("SVGs are sandboxed: no scripts, nothing loaded", async () => {
    const res = await raw(alice, id, "path=img/logo.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
    expect(await res.text()).toBe(SVG);
  });

  test("at a ref; unsafe refs refused", async () => {
    await commitRaw(id, { "img/cat.png": "changed" });
    expect(await (await raw(alice, id, "path=img/cat.png")).text()).toBe("changed");
    expect(new Uint8Array(await (await raw(alice, id, `path=img/cat.png&ref=${first}`)).arrayBuffer())).toEqual(PNG);
    expect((await raw(alice, id, "path=img/cat.png&ref=--output=x")).status).toBe(400);
    expect((await raw(alice, id, "path=img/cat.png&ref=main..x")).status).toBe(400);
  });

  test("paths outside the repo, .git and non-images are refused; missing files are 404", async () => {
    for (const p of ["../../etc/passwd.png", "img/../../x.png", "..%2F..%2Fx.png", "%2e%2e/x.png", ".git/x.png", "a/.git/x.png", "a%00.png"]) {
      const res = await raw(alice, id, `path=${p}`);
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/json");
    }
    expect((await raw(alice, id, "path=notes.txt")).status).toBe(415);
    expect((await raw(alice, id, "path=Welcome.md")).status).toBe(415);
    expect((await raw(alice, id, "path=img")).status).toBe(415);
    expect((await raw(alice, id, "path=nope.png")).status).toBe(404);
    expect((await raw(alice, id, "path=img.png")).status).toBe(404);
    expect((await raw(alice, id, "")).status).toBe(400);
  });

  test("files over the size cap are refused", async () => {
    await commitRaw(id, { "big.png": new Uint8Array(MAX_RAW_BYTES + 1), "ok.png": new Uint8Array(1000) });
    const res = await raw(alice, id, "path=big.png");
    expect(res.status).toBe(413);
    expect((await res.json()).error).toContain("too large");
    expect((await raw(alice, id, "path=ok.png")).status).toBe(200);
  });

  test("anyone may read them, signed in or not", async () => {
    expect((await raw("", id, "path=img/logo.svg")).status).toBe(200);
    expect((await raw(bob, id, "path=img/logo.svg")).status).toBe(200);
  });

  test("symlinks and submodules aren't served", async () => {
    const cwd = join(config.dataDir, "git", `${id}.git`);
    const target = (await sh(["hash-object", "-w", "--stdin"], cwd, "img/cat.png")).trim();
    const index = join(cwd, `index-test-${crypto.randomUUID()}`);
    const env = { GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@x" };
    const head = (await sh(["rev-parse", "refs/heads/main"], cwd)).trim();
    await sh(["read-tree", head], cwd, undefined, env);
    await sh(["update-index", "--add", "--cacheinfo", `120000,${target},link.png`], cwd, undefined, env);
    await sh(["update-index", "--add", "--cacheinfo", `160000,${head},sub.png`], cwd, undefined, env);
    await sh(["update-index", "--add", "--cacheinfo", `100755,${target},exec.png`], cwd, undefined, env);
    const tree = (await sh(["write-tree"], cwd, undefined, env)).trim();
    await sh(["update-ref", "refs/heads/main", (await sh(["commit-tree", tree, "-p", head, "-m", "links"], cwd, undefined, env)).trim()], cwd);
    rmSync(index, { force: true });
    (app.ctx.store as unknown as { invalidate(repo: string): void }).invalidate(id);
    expect((await raw(alice, id, "path=link.png")).status).toBe(404);
    expect((await raw(alice, id, "path=sub.png")).status).toBe(404);
    expect((await raw(alice, id, "path=exec.png")).status).toBe(200);
    expect((await raw(alice, id, "path=*.png")).status).toBe(404);
  });

  test("the store reads blobs as bytes with a cap", async () => {
    expect(await app.ctx.store.readBlob(id, "a/b/c.webp", "main", 10)).toEqual(new TextEncoder().encode("webp"));
    expect(await app.ctx.store.readBlob(id, "missing.png", "main", 10)).toBeNull();
    expect(await app.ctx.store.readBlob(id, "img", "main", 10)).toBeNull();
    await expect(app.ctx.store.readBlob(id, "a/b/c.webp", "main", 3)).rejects.toThrow("too large");
  });
});

describe("errors across Durable Object RPC", () => {
  // Workers RPC keeps name, message and own fields but not the prototype; Bun's structuredClone keeps only the message, so put the rest back.
  const overRpc = <E extends Error>(e: E): E => Object.assign(structuredClone(e), { ...e, name: e.name });

  test("domain errors map to the same status after a structuredClone", async () => {
    const { RepoBusyError, StoreUnavailableError, StoreFullError, FileTooLargeError } = await import("../../src/server/store/types.ts");
    const { NotFoundError } = await import("../../src/server/rooms.ts");
    const httpError = (status: number, message: string, retryAfter?: number) => Object.assign(new Error(message), { name: "HttpError", status, retryAfter });
    const cases: [Error, number][] = [
      [new ops.OpError(400, "invalid path: x"), 400],
      [new ops.OpError(404, "a.md not found"), 404],
      [Object.assign(new Error("a.md"), { name: "NotFoundError" }), 404],
      [new RepoBusyError(), 409],
      [new FileTooLargeError("big.md", 6 * 1024 * 1024), 413],
      [new StoreFullError("the demo is full"), 413],
      [httpError(429, "slow down", 7), 429],
      [new StoreUnavailableError("GitHub is down"), 503],
    ];
    for (const [e, status] of cases) {
      for (const err of [e, overRpc(e)]) {
        const res = errorResponse(err);
        expect(res?.status).toBe(status);
        expect(((await res!.json()) as { error: string }).error).toBe(e.message);
      }
    }
    // In-process only until rooms.ts names NotFoundError (CF-06).
    expect(errorResponse(new NotFoundError("a.md"))?.status).toBe(404);
    expect(errorResponse(overRpc(httpError(429, "slow down", 7)))!.headers.get("retry-after")).toBe("7");
    const big = overRpc(new FileTooLargeError("big.md", 6 * 1024 * 1024));
    expect(big.name).toBe("FileTooLargeError");
    expect([big.path, big.size]).toEqual(["big.md", 6 * 1024 * 1024]);
  });

  test("other errors are not mapped", () => {
    expect(errorResponse(new Error("boom"))).toBeNull();
    expect(errorResponse(overRpc(new TypeError("boom")))).toBeNull();
    expect(errorResponse("boom")).toBeNull();
  });
});

describe("tree ETag and recorded heads", () => {
  const tree = (cookie: string, id: string, etag?: string) =>
    fetch(`${base}/api/workspace/${id}/tree`, { headers: { cookie, ...(etag ? { "if-none-match": etag } : {}) } });

  test("the tree has an ETag, 304s on a match, and changes with pending notes and saves", async () => {
    const id = (await api(bob, "POST", "/api/workspaces", { title: "API ETag" })).data.id as string;
    const first = await tree(bob, id);
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^"[\w-]+"$/);
    expect(first.headers.get("cache-control")).toBe("private, no-cache");
    const { head, files } = await first.json();
    expect(files).toEqual(["README.md"]);

    const same = await tree(bob, id, etag);
    expect(same.status).toBe(304);
    expect(same.headers.get("etag")).toBe(etag);
    expect(await same.text()).toBe("");
    expect((await tree(bob, id, `"nope", W/${etag}`)).status).toBe(304);
    expect((await tree(bob, id, "*")).status).toBe(304);
    expect((await tree(bob, id, '"nope"')).status).toBe(200);

    // A note that isn't saved yet is in the tree, so it changes the tag.
    const quiet = config.quietMs;
    config.quietMs = 60_000;
    let pendingTag: string;
    try {
      expect((await api(bob, "POST", `/api/workspace/${id}/files`, { path: "pending.md", content: "soon\n" })).status).toBe(201);
      const pending = await tree(bob, id, etag);
      expect(pending.status).toBe(200);
      pendingTag = pending.headers.get("etag")!;
      expect(pendingTag).not.toBe(etag);
      expect(await pending.json()).toEqual({ head, files: ["README.md", "pending.md"] });
      expect((await tree(bob, id, pendingTag)).status).toBe(304);
      await app.ctx.rooms.inRepo(id).find((r) => r.path === "pending.md")!.flush();
    } finally {
      config.quietMs = quiet;
    }

    // Saved: same files, new head, new tag.
    const saved = await tree(bob, id, pendingTag);
    expect(saved.status).toBe(200);
    const after = await saved.json();
    expect(after.files).toEqual(["README.md", "pending.md"]);
    expect(after.head).not.toBe(head);
    expect([etag, pendingTag]).not.toContain(saved.headers.get("etag"));
  });

  test("the workspace list reads repos.head and asks the store only when it is null", async () => {
    const hana = await login("Hana");
    const id = (await api(hana, "POST", "/api/workspaces", { title: "API Heads" })).data.id as string;
    const real = (await api(hana, "GET", `/api/workspace/${id}/tree`)).data.head as string;
    const store = app.ctx.store;
    const head = store.head;
    let calls = 0;
    store.head = (...a: Parameters<typeof head>) => {
      calls++;
      return head.apply(store, a);
    };
    try {
      const recorded = "f".repeat(40);
      db.query("UPDATE repos SET head = ? WHERE id = ?").run(recorded, id);
      const list = (await api(hana, "GET", "/api/workspaces")).data;
      expect(list.map((w: any) => [w.id, w.head])).toEqual([[id, recorded]]);
      expect(calls).toBe(0);

      db.query("UPDATE repos SET head = NULL WHERE id = ?").run(id);
      expect((await api(hana, "GET", "/api/workspaces")).data.map((w: any) => w.head)).toEqual([real]);
      expect(calls).toBe(1);
    } finally {
      store.head = head;
      db.query("UPDATE repos SET head = NULL WHERE id = ?").run(id);
    }
  });

  test("repoHeadWriter records changed heads in repos.head, throttled per repo", async () => {
    const { CachedHeadStore, repoHeadWriter } = await import("../../src/server/store/cached-head.ts");
    const { bunDb } = await import("../../src/server/bun/db-bun.ts");
    const inner = bunDb(db);
    const writes: unknown[][] = [];
    const recording = { ...inner, run: (sql: string, ...params: unknown[]) => (writes.push(params), inner.run(sql, ...params)) };
    const recorded = (id: string) => db.query<{ head: string | null }, [string]>("SELECT head FROM repos WHERE id = ?").get(id)!.head;
    insertRepo("api-head-writer");
    insertRepo("api-head-writer-2");
    const writer = repoHeadWriter(recording, { minIntervalMs: 1000 });

    // Through a CachedHeadStore: a read reports the head, commits move it.
    let n = 0;
    const heads = new Map<string, string>([["api-head-writer", "a"]]);
    const fake = {
      kind: "memory",
      head: async (repo: string) => heads.get(repo) ?? null,
      commit: async (input: { repo: string }) => {
        const sha = `c${++n}`;
        heads.set(input.repo, sha);
        return { ok: true, sha };
      },
    } as unknown as ConstructorParameters<typeof CachedHeadStore>[0];
    const store = new CachedHeadStore(fake, { onHeadChange: writer });
    expect(await store.head("api-head-writer", "main")).toBe("a");
    await waitFor(() => recorded("api-head-writer") === "a");
    expect(writes.length).toBe(1);

    // Changes within the interval are coalesced into one write of the latest, at its end.
    const commit = () => store.commit({ repo: "api-head-writer", branch: "main" } as Parameters<typeof store.commit>[0]);
    await commit();
    await commit();
    await commit();
    await Bun.sleep(50);
    expect(writes.length).toBe(1);
    expect(recorded("api-head-writer")).toBe("a");
    await waitFor(() => recorded("api-head-writer") === "c3");
    expect(writes.length).toBe(2);

    // Re-reading an unchanged head writes nothing; other repos have their own interval; other branches don't touch the row.
    await store.head("api-head-writer", "main", { fresh: true });
    await writer("api-head-writer", "main", "c3");
    await writer("api-head-writer-2", "main", "z");
    expect(recorded("api-head-writer-2")).toBe("z");
    await writer("api-head-writer", "feature", "x");
    await Bun.sleep(50);
    expect(writes.length).toBe(4);
    expect(recorded("api-head-writer")).toBe("c3");

    // flush() writes what is waiting without the timer.
    await writer("api-head-writer", "main", "d");
    await writer("api-head-writer", "main", "e");
    expect(recorded("api-head-writer")).toBe("c3");
    await writer.flush();
    expect(recorded("api-head-writer")).toBe("e");
    expect(writes.length).toBe(5);
  });
});
