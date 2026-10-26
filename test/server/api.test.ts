import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

// The preload's DATA_DIR (one per test process, shared by every file in it).
const dir = process.env.DATA_DIR!;
process.env.ALLOW_DEV_LOGIN = "1";
process.env.ALLOWED_GITHUB_USERS = "*";
process.env.QUIET_MS = "100";
process.env.POLL_MS = "60000";
delete process.env.GITHUB_CLIENT_ID;
delete process.env.CODE_STORAGE_WEBHOOK_SECRET;

// bun test may share one module registry between files, so config can already be loaded with another
// file's env: override what matters directly, and use repo ids no other test uses.
const { config } = await import("../../src/server/config.ts");
Object.assign(config, { storage: "local", allowDevLogin: true, allowedUsers: ["*"], quietMs: 100, pollMs: 60000, notesRepo: "api-notes" });
config.github.clientId = "";
config.github.appSlug = "";
config.codeStorage.webhookSecret = "";
const { startServer } = await import("../../src/server/index.ts");
const { db } = await import("../../src/server/db.ts");
const { setCachedAccess, setGitHubFetch } = await import("../../src/server/auth.ts");
const { shareLimits } = await import("../../src/server/shares.ts");
const { sh, upstreams } = await import("./upstream.ts");
const { MAX_FILE_BYTES } = await import("../../src/server/store/types.ts");
const carolId = () => (db.query("SELECT id FROM users WHERE login = 'carol'").get() as { id: string }).id;
const { emit } = await import("../../src/server/events.ts");
const N = "api-notes";
const ops = await import("../../src/server/ops.ts");
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
  const tree = await api(cookie, "GET", `/api/repos/${repo}/tree`);
  const r = await api(cookie, "GET", `/api/repos/${repo}/file?path=${encodeURIComponent(path)}&ref=${tree.data.head}`);
  return r.status === 200 ? r.data.content : null;
}

beforeAll(async () => {
  app = await startServer({ port: 0, quiet: true });
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

async function hmacHex(secret: string, data: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data))).toString("hex");
}

afterAll(async () => {
  await app?.stop();
  for (const id of tempRepos) db.query("DELETE FROM repos WHERE id = ?").run(id);
});

describe("auth", () => {
  test("config is public, the rest needs a session", async () => {
    const cfg = await (await fetch(`${base}/api/config`)).json();
    expect(cfg).toEqual({ githubLogin: false, devLogin: true, githubAppSlug: null, storage: "local" });
    expect((await fetch(`${base}/api/me`)).status).toBe(401);
    expect((await fetch(`${base}/api/repos`)).status).toBe(401);
  });

  test("dev login → /api/me; first user is admin", async () => {
    const me = await api(alice, "GET", "/api/me");
    expect(me.status).toBe(200);
    expect(me.data).toMatchObject({ login: "alice", name: "Alice", isAdmin: true });
    expect(me.data.githubToken).toBeUndefined();
    const b = await api(bob, "GET", "/api/me");
    expect(b.data).toMatchObject({ login: "bob", isAdmin: false });
  });

  test("logout ends the session", async () => {
    const c = await login("Carol");
    expect((await api(c, "GET", "/api/me")).status).toBe(200);
    await fetch(`${base}/auth/logout`, { method: "POST", headers: { cookie: c, origin: base }, redirect: "manual" });
    expect((await api(c, "GET", "/api/me")).status).toBe(401);
  });

  test("guest sign-in creates a new account with a generated name, never an existing one", async () => {
    const guest = async () => {
      const res = await fetch(`${base}/auth/guest`, { method: "POST", headers: { origin: base } });
      expect(res.status).toBe(200);
      const { name } = (await res.json()) as { name: string };
      const c = res.headers.getSetCookie().find((s) => s.startsWith("np_session="))!.split(";")[0]!;
      return { name, c };
    };
    const a = await guest();
    expect(a.name).toMatch(/^[a-z]+-[a-z]+(-\d+)?$/);
    const me = (await api(a.c, "GET", "/api/me")).data;
    expect(me.name).toBe(a.name);
    expect(me.is_admin ?? me.isAdmin ?? false).toBeFalsy();
    // Exhaust every generated name: guests still get fresh, distinct accounts.
    const ids = new Set<string>([me.id]);
    for (let i = 0; i < 30; i++) ids.add((await api((await guest()).c, "GET", "/api/me")).data.id);
    expect(ids.size).toBe(31);
    expect((await api(alice, "GET", "/api/me")).data.name).toBe("Alice");
    const cross = await fetch(`${base}/auth/guest`, { method: "POST", headers: { origin: "https://evil.example" } });
    expect(cross.status).toBe(403);
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

  test("the allowlist is re-checked on every request, but never locks out the admin", async () => {
    try {
      config.allowedUsers = ["someone-else"];
      expect((await api(bob, "GET", "/api/me")).status).toBe(401);
      expect((await api(alice, "GET", "/api/me")).status).toBe(200);
      const res = await fetch(`${base}/auth/dev`, { method: "POST", headers: { origin: base }, body: new URLSearchParams({ name: "Eve" }), redirect: "manual" });
      expect(res.status).toBe(403);
    } finally {
      config.allowedUsers = ["*"];
    }
    expect((await api(bob, "GET", "/api/me")).status).toBe(200);
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
    const res = await fetch(`${base}/api/repos/${N}/files`, {
      method: "POST",
      headers: { cookie: alice, origin: "https://evil.example", "content-type": "text/plain" },
      body: JSON.stringify({ path: "evil.md" }),
    });
    expect(res.status).toBe(403);
    const res2 = await fetch(`${base}/api/repos/${N}/files`, {
      method: "POST",
      headers: { cookie: alice, "content-type": "text/plain" },
      body: JSON.stringify({ path: "evil.md" }),
    });
    expect(res2.status).toBe(403);
    const ok = await fetch(`${base}/api/repos/${N}/files`, {
      method: "POST",
      headers: { cookie: alice, origin: base, "content-type": "text/plain" },
      body: JSON.stringify({ path: "same-origin.md" }),
    });
    expect(ok.status).toBe(201);
  });
});

describe("files", () => {
  test("lists the notes repo with Welcome.md", async () => {
    const repos = await api(alice, "GET", "/api/repos");
    expect(repos.data).toContainEqual(expect.objectContaining({ id: N, kind: "notes", access: "write", readOnly: false }));
    const tree = await api(alice, "GET", `/api/repos/${N}/tree`);
    expect(tree.data.files).toContain("Welcome.md");
    expect(tree.data.head).toMatch(/^[0-9a-f]{40}$/);
  });

  test("create, rename, history, search, delete", async () => {
    const created = await api(alice, "POST", `/api/repos/${N}/files`, { path: "ideas/todo", content: "# Todo\n\nbuy pineapples\n" });
    expect(created.status).toBe(201);
    expect(created.data).toEqual({ path: "ideas/todo.md", version: expect.any(String) });
    expect((await api(alice, "POST", `/api/repos/${N}/files`, { path: "ideas/todo.md" })).status).toBe(409);
    expect((await api(alice, "GET", `/api/repos/${N}/tree`)).data.files).toContain("ideas/todo.md");

    const renamed = await api(alice, "POST", `/api/repos/${N}/rename`, { from: "ideas/todo.md", to: "ideas/done.md" });
    expect(renamed.data).toEqual({ path: "ideas/done.md" });
    const files = (await api(alice, "GET", `/api/repos/${N}/tree`)).data.files;
    expect(files).toContain("ideas/done.md");
    expect(files).not.toContain("ideas/todo.md");

    const hist = await api(alice, "GET", `/api/repos/${N}/history?path=ideas/done.md&limit=5`);
    expect(hist.data[0]).toMatchObject({ message: expect.stringContaining("Rename"), authorName: "Alice" });
    const diff = await api(alice, "GET", `/api/repos/${N}/diff?sha=${hist.data[0].sha}&path=ideas/done.md`);
    expect(diff.data.diff).toContain("pineapples");

    const hits = await api(alice, "GET", `/api/repos/${N}/search?q=pineapples`);
    expect(hits.data.hits).toContainEqual(expect.objectContaining({ path: "ideas/done.md", text: expect.stringContaining("pineapples") }));

    expect((await api(alice, "DELETE", `/api/repos/${N}/files?path=ideas/done.md`)).data).toEqual({ ok: true });
    expect((await api(alice, "GET", `/api/repos/${N}/tree`)).data.files).not.toContain("ideas/done.md");
    expect((await api(alice, "DELETE", `/api/repos/${N}/files?path=ideas/done.md`)).status).toBe(404);
    expect((await api(alice, "GET", "/api/repos/nope/tree")).status).toBe(404);
  });

  test("restore replaces live text with an old version", async () => {
    await api(alice, "POST", `/api/repos/${N}/files`, { path: "r.md", content: "v1\n" });
    await waitFor(async () => (await committed(alice, N, "r.md")) === "v1\n"); // committed after the quiet period
    const [first] = (await api(alice, "GET", `/api/repos/${N}/history?path=r.md`)).data;
    const c = connect(alice, N, "r.md");
    await waitFor(() => c.text.toString() === "v1\n");
    c.text.delete(0, c.text.length);
    c.text.insert(0, "v2\n");
    await waitFor(async () => (await committed(alice, N, "r.md")) === "v2\n");
    expect((await api(alice, "POST", `/api/repos/${N}/restore`, { path: "r.md", sha: first.sha })).data).toEqual({ ok: true });
    await waitFor(() => c.text.toString() === "v1\n");
    c.close();
  });

  test("new notes repo", async () => {
    const r = await api(bob, "POST", "/api/repos", { title: "API Team Plans" });
    expect(r.status).toBe(201);
    expect(r.data).toMatchObject({ id: "api-team-plans", title: "API Team Plans", kind: "notes", access: "write" });
    expect((await api(bob, "GET", "/api/repos/api-team-plans/tree")).data.files).toEqual(["README.md"]);
    expect((await api(bob, "DELETE", "/api/repos/api-team-plans")).status).toBe(403);
    expect((await api(alice, "DELETE", "/api/repos/api-team-plans")).data).toEqual({ ok: true });
  });
});

describe("repo rules", () => {
  test("linking GitHub repos needs a GitHub login or admin; bad ids are rejected", async () => {
    // Without Code Storage + the GitHub App, nothing could push edits back: editable links are refused outright.
    const editable = await api(bob, "POST", "/api/repos", { github: "octo/hello", readOnly: false });
    expect(editable.status).toBe(400);
    expect(editable.data.error).toContain("GitHub App");
    expect((await api(alice, "POST", "/api/repos", { github: "octo/.." })).status).toBe(400);
    expect((await api(alice, "POST", "/api/repos", { title: ".." })).status).toBe(400);
    expect((await api(alice, "GET", "/api/repos/%E0%A4%A/tree")).status).toBe(400);
  });

  test("repos that aren't ready refuse reads (409) and websockets (1013)", async () => {
    insertRepo("api-importing", { status: "importing" });
    expect((await api(alice, "GET", "/api/repos/api-importing/tree")).status).toBe(409);
    const c = connect(alice, "api-importing", "README.md");
    await waitFor(() => c.closeCode !== null);
    expect(c.closeCode).toBe(1013);
  });
});

describe("websocket", () => {
  test("rejects cross-origin connections and repos without access", async () => {
    const c = connect(alice, N, "Welcome.md", "https://evil.example");
    await waitFor(() => c.closeCode !== null);
    expect(c.closeCode).toBe(4403);

    const dave = await login("Dave");
    const daveId = (await api(dave, "GET", "/api/me")).data.id;
    db.query("UPDATE users SET github_token = 'fake' WHERE id = ?").run(daveId);
    insertRepo("api-private");
    setCachedAccess(daveId, "api-private", "none");
    expect((await api(dave, "GET", "/api/repos/api-private/tree")).status).toBe(404);
    const d = connect(dave, "api-private", "README.md");
    await waitFor(() => d.closeCode !== null);
    expect(d.closeCode).toBe(4403);
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
    const [last] = (await api(alice, "GET", `/api/repos/${N}/history?path=Welcome.md`)).data;
    expect(last).toMatchObject({ authorName: "Alice", authorEmail: "alice@dev.grimoire" });
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
    const repos = await api(alice, "GET", "/api/repos");
    expect(repos.data).toContainEqual(expect.objectContaining({ id: "ro-api", access: "read", readOnly: true }));
    expect((await api(alice, "POST", "/api/repos/ro-api/files", { path: "x.md" })).status).toBe(403);

    const c = connect(alice, "ro-api", "README.md");
    await waitFor(() => c.text.toString() === "read me\n");
    expect(c.controls[0]).toMatchObject({ t: "hello", readOnly: true });
    c.text.insert(0, "vandalism ");
    await Bun.sleep(300);
    expect((await api(alice, "GET", "/api/repos/ro-api/file?path=README.md")).data.content).toBe("read me\n");
    expect(await committed(alice, "ro-api", "README.md")).toBe("read me\n");
    c.close();
  });
});

describe("MCP and /api/shell", () => {
  const rpc = (headers: Record<string, string>, body: unknown) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify(body),
    });
  const shell = (headers: Record<string, string>, body: unknown) =>
    fetch(`${base}/api/shell`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  test("MCP works with a browser session; bearer tokens are gone", async () => {
    expect((await rpc({}, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
    expect((await rpc({ authorization: "Bearer grim_whatever" }, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
    expect((await rpc({ cookie: alice, origin: "https://evil.example" }, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(403);
    const init = await rpc({ cookie: alice }, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    expect(init.status).toBe(200);
    const sid = init.headers.get("mcp-session-id")!;
    expect(sid).toBeTruthy();
    const out = await (await rpc({ cookie: alice, "mcp-session-id": sid }, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "document_command", arguments: { command: `echo 'hello from mcp' > /workspace/${N}/mcp.md` } } })).json();
    expect(out.result.isError).toBeFalsy();
    expect((await api(alice, "GET", `/api/repos/${N}/file?path=mcp.md`)).data.content).toBe("hello from mcp\n");
    expect((await fetch(`${base}/mcp`, { method: "DELETE", headers: { cookie: alice, origin: base, "mcp-session-id": sid } })).status).toBe(204);
  });

  test("/api/shell: browser sessions only, same-origin or JSON; sessions keep cwd", async () => {
    expect((await shell({}, { command: "pwd" })).status).toBe(401);
    expect((await shell({ authorization: "Bearer grim_nope" }, { command: "pwd" })).status).toBe(401);
    const r = await shell({ cookie: bob }, { command: `cd /workspace/${N} && echo hi && echo warn >&2 && false`, session: "a" });
    expect(await r.json()).toEqual({ stdout: "hi\n", stderr: "warn\n", exitCode: 1, cwd: `/workspace/${N}` });
    expect((await (await shell({ cookie: bob, "x-shell-session": "a" }, { command: "pwd" })).json()).stdout).toBe(`/workspace/${N}\n`);
    expect((await (await shell({ cookie: bob }, { command: "pwd", session: "b" })).json()).stdout).toBe("/workspace\n");
    const ok = await (await shell({ cookie: bob }, { command: "echo $USER; ls /workspace" })).json();
    expect(ok.stdout).toContain("bob\n");
    expect(ok.stdout).toContain(`${N}\n`);
    expect((await shell({ cookie: bob, origin: base }, { command: "true" })).status).toBe(200);
    expect((await shell({ cookie: bob, origin: "https://evil.example" }, { command: "true" })).status).toBe(403);
    const form = await fetch(`${base}/api/shell`, { method: "POST", headers: { cookie: bob, "content-type": "text/plain" }, body: JSON.stringify({ command: "true" }) });
    expect(form.status).toBe(403);
    for (const bad of [{}, { command: "" }, { command: "true", timeout_seconds: 111 }, { command: "true", session: "bad session!" }]) {
      expect((await shell({ cookie: bob }, bad)).status).toBe(400);
    }
    expect((await fetch(`${base}/api/shell`, { headers: { cookie: bob } })).status).toBe(405);
    expect((await api(alice, "GET", "/api/agent-tokens")).status).toBe(404);
  });
});

describe("share links", () => {
  const RO = "ro-share";

  test("reuse: true returns the same link for the same person, and makes one the first time", async () => {
    const first = await api(alice, "POST", `/api/repos/${N}/shares`, { reuse: true });
    expect([200, 201]).toContain(first.status);
    const again = await api(alice, "POST", `/api/repos/${N}/shares`, { reuse: true });
    expect(again.status).toBe(200);
    expect(again.data.url).toBe(first.data.url);
  });
  let other = "";
  let gina = "";
  let ginaId = "";

  /** POST a command to a share link: a string is sent as a plain-text body, an object as JSON. */
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
  const create = async (cookie: string, repo: string, label?: string) => {
    const r = await api(cookie, "POST", `/api/repos/${repo}/shares`, label === undefined ? {} : { label });
    expect(r.status).toBe(201);
    return r.data as { id: string; url: string };
  };
  /** The link's URL on the test server (config.publicUrl may point elsewhere). */
  const local = (url: string) => `${base}/a/${url.split("/a/")[1]}`;

  beforeAll(async () => {
    other = (await api(alice, "POST", "/api/repos", { title: "Share Other" })).data.id;
    tempRepos.push(other);
    await api(alice, "POST", `/api/repos/${other}/files`, { path: "secret.md", content: "secret\n" });
    await app.ctx.store.createRepo(RO, { branch: "main" });
    await app.ctx.store.commit({ repo: RO, branch: "main", expectedHead: null, changes: [{ path: "README.md", content: "read me\n" }], message: "seed", author: { name: "x", email: "x@example.com" } });
    db.query("INSERT INTO repos (id, title, kind, gh_owner, gh_name, read_only, branch, status, created_at) VALUES (?, 'o/ro-share', 'github', 'o', 'ro-share', 1, 'main', 'ready', ?)").run(RO, Date.now());
    tempRepos.push(RO);
    gina = await login("Gina");
    ginaId = (await api(gina, "GET", "/api/me")).data.id;
  });

  test("create, list and revoke: who may do what", async () => {
    const link = await create(bob, N, "Claude");
    expect(link.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(link.url).toBe(`${config.publicUrl}/a/${link.id}`);
    const list = await api(alice, "GET", `/api/repos/${N}/shares`);
    expect(list.status).toBe(200);
    expect(list.data).toContainEqual({ id: link.id, url: link.url, label: "Claude", createdAt: expect.any(Number), lastUsedAt: null, createdBy: "Bob", canRevoke: true });
    // Others only see their own links.
    expect((await api(gina, "GET", `/api/repos/${N}/shares`)).data.some((l: any) => l.id === link.id)).toBe(false);
    expect((await api(bob, "GET", `/api/repos/${N}/shares`)).data.map((l: any) => l.id)).toContain(link.id);
    expect((await api(bob, "GET", "/api/repos")).data.find((r: any) => r.id === N).canShare).toBe(true);

    // Read-only notebooks: anyone who can read may share (the link is read-only too).
    expect((await api(gina, "POST", `/api/repos/${RO}/shares`, {})).status).toBe(201);
    // An editable GitHub repo this user can only read: no link.
    db.query("UPDATE users SET github_token = 'fake' WHERE id = ?").run(ginaId);
    insertRepo("share-gh");
    setCachedAccess(ginaId, "share-gh", "read");
    expect((await api(gina, "POST", "/api/repos/share-gh/shares", {})).status).toBe(403);
    expect((await api(gina, "GET", "/api/repos/share-gh/shares")).status).toBe(403);
    expect((await api(gina, "GET", "/api/repos")).data.find((r: any) => r.id === "share-gh").canShare).toBe(false);
    setCachedAccess(ginaId, "share-gh", "none");
    expect((await api(gina, "POST", "/api/repos/share-gh/shares", {})).status).toBe(404);
    expect((await api(bob, "POST", `/api/repos/${N}/shares`, { label: 5 })).status).toBe(400);
    expect((await fetch(`${base}/api/repos/${N}/shares`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);

    // The creator, an admin, or anyone who can edit the notebook revokes; readers can't.
    const roLink = (await api(gina, "POST", `/api/repos/${RO}/shares`, {})).data;
    expect((await api(bob, "DELETE", `/api/shares/${roLink.id}`)).status).toBe(403);
    expect((await api(gina, "DELETE", `/api/shares/${roLink.id}`)).data).toEqual({ ok: true });
    const byEditor = await create(bob, N);
    expect((await api(gina, "DELETE", `/api/shares/${byEditor.id}`)).data).toEqual({ ok: true });
    expect((await post(local(link.url), "true")).status).toBe(200);
    expect((await api(bob, "DELETE", `/api/shares/${link.id}`)).data).toEqual({ ok: true });
    expect((await api(bob, "DELETE", `/api/shares/${link.id}`)).status).toBe(404);
    expect((await api(alice, "GET", `/api/repos/${N}/shares`)).data.some((l: any) => l.id === link.id)).toBe(false);
    const gone = await post(local(link.url), "true");
    expect(gone.status).toBe(404);
    expect(gone.data.error).toContain("revoked");
    expect(await (await fetch(`${local(link.url)}?format=text`, { method: "POST", body: "true" })).text()).toContain("revoked");
    expect((await fetch(local(link.url))).status).toBe(404);
    const admin = await create(bob, N);
    expect((await api(alice, "DELETE", `/api/shares/${admin.id}`)).data).toEqual({ ok: true });
  });

  test("GET: a prompt for the agent", async () => {
    const link = await create(alice, N, "Helper");
    const res = await fetch(local(link.url));
    expect(res.status).toBe(200);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(text).toContain("Grimoire");
    expect(text).toContain(`Grimoire notebook: Notes`);
    expect(text).toContain("Markdown");
    expect(text).toContain(`/workspace/${N}`);
    expect(text).toContain(`curl -s -X POST '${link.url}' --data-binary 'ls -R'`);
    expect(text).toContain("POST");
    expect(text).toContain("X-Agent-Name");
    expect(text).toContain("Welcome.md");
    expect(text).toContain("read and write");
    const md = await fetch(local(link.url), { headers: { accept: "text/markdown" } });
    expect(md.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const ro = await create(alice, RO);
    const roText = await (await fetch(local(ro.url))).text();
    expect(roText).toContain("read-only");
    expect(roText).toContain("README.md");
    expect(roText).not.toContain("sed -i");
    for (const bad of ["/a/nope", "/a/00000000-0000-4000-8000-000000000000", `/a/${link.id}/x`]) expect((await fetch(`${base}${bad}`)).status).toBe(404);
    expect((await fetch(local(link.url), { method: "PUT" })).status).toBe(405);
  });

  test("POST: plain text or JSON; starts in the notebook; only that notebook is visible", async () => {
    const link = await create(alice, N, "Helper");
    const url = local(link.url);
    const plain = await post(url, "pwd; ls /workspace");
    expect(plain.status).toBe(200);
    expect(plain.data).toEqual({ stdout: `/workspace/${N}\n${N}\n`, stderr: "", exitCode: 0, cwd: `/workspace/${N}`, truncated: false });
    // curl's default form content type is still a command.
    const form = await post(url, "echo $HOME", { "content-type": "application/x-www-form-urlencoded" });
    expect(form.data.stdout).toBe(`/workspace/${N}\n`);
    const json = await post(url, { command: "cat Welcome.md | head -1" });
    expect(json.data.stdout).toContain("# Welcome");
    // A JSON body sent with curl -d's form type, or with no content type, is understood too; text/plain is always a command.
    const asJson = JSON.stringify({ command: "echo json" });
    expect((await post(url, asJson, { "content-type": "application/x-www-form-urlencoded" })).data.stdout).toBe("json\n");
    const untyped = await fetch(url, { method: "POST", body: new TextEncoder().encode(` ${asJson}`) });
    expect((await untyped.json()).stdout).toBe("json\n");
    expect((await post(url, asJson, { "content-type": "text/plain" })).data.stdout).not.toBe("json\n");
    // A form-typed body that is a shell group, not JSON, runs as a command.
    expect((await post(url, "{ echo grouped; }", { "content-type": "application/x-www-form-urlencoded" })).data.stdout).toBe("grouped\n");
    const secret = await post(url, `repos; cat /workspace/${other}/secret.md`);
    expect(secret.data.exitCode).not.toBe(0);
    expect(secret.data.stdout).not.toContain(other);
    expect(secret.data.stdout + secret.data.stderr).not.toContain("secret\n");
    expect((await post(url, `ls /workspace/${RO}`)).data.exitCode).not.toBe(0);

    const text = await fetch(`${url}?format=text`, { method: "POST", body: "echo out; echo err >&2; exit 3" });
    expect(text.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(text.headers.get("x-exit-code")).toBe("3");
    expect(await text.text()).toBe("out\n[stderr]\nerr\n[exit 3]\n");
    expect(await (await fetch(url, { method: "POST", headers: { accept: "text/plain" }, body: "true" })).text()).toBe("(no output)\n");

    for (const bad of [{}, { command: 5 }, { command: " " }, { command: "true", session: "bad session!" }, { command: "true", timeout_seconds: 999 }, { command: "true", cwd: "/" }]) {
      const r = await post(url, bad);
      expect(r.status).toBe(400);
      expect(typeof r.data.error).toBe("string");
    }
    expect((await post(url, "")).status).toBe(400);
    expect((await post(url, "{oops", { "content-type": "application/json" })).status).toBe(400);
    const big = await post(url, "x".repeat(1024 * 1024 + 1));
    expect(big.status).toBe(413);
    expect((await api(alice, "GET", `/api/repos/${N}/shares`)).data.find((l: any) => l.id === link.id).lastUsedAt).toBeGreaterThan(0);
  });

  test("sessions: cwd and variables persist per link; separate sessions on request", async () => {
    const link = await create(alice, N);
    const url = local(link.url);
    await post(url, "mkdir -p deep && cd deep && X=42");
    expect((await post(url, "pwd; echo $X")).data.stdout).toBe(`/workspace/${N}/deep\n42\n`);
    expect((await post(url, { command: "pwd", session: "two" })).data.stdout).toBe(`/workspace/${N}\n`);
    await post(url, "cd /tmp", { "x-shell-session": "three" });
    expect((await post(url, "pwd", { "x-shell-session": "three" })).data.stdout).toBe("/tmp\n");
    expect((await post(url, "pwd")).data.stdout).toBe(`/workspace/${N}/deep\n`);
    // Another link is another agent with its own sessions.
    const second = await create(alice, N);
    expect((await post(local(second.url), "pwd")).data.stdout).toBe(`/workspace/${N}\n`);
  });

  test("edits are live, attributed to X-Agent-Name or the label", async () => {
    const link = await create(alice, N, "Scribe");
    const url = local(link.url);
    const made = await post(url, "cat > share/heredoc.md <<'EOF'\n# From a heredoc\nbody\nEOF\nsave share/heredoc.md");
    expect(made.data.exitCode).toBe(0);
    expect((await api(alice, "GET", `/api/repos/${N}/file?path=share/heredoc.md`)).data.content).toBe("# From a heredoc\nbody\n");
    let [last] = (await api(alice, "GET", `/api/repos/${N}/history?path=share/heredoc.md`)).data;
    expect(last).toMatchObject({ authorName: "Scribe", authorEmail: "scribe@agents.grimoire" });

    await post(url, "cd share");
    const named = await post(url, "echo '- by claude' >> heredoc.md && save heredoc.md && whoami && echo $USER", { "x-agent-name": "  Claude \t Code  " });
    expect(named.data.exitCode).toBe(0);
    [last] = (await api(alice, "GET", `/api/repos/${N}/history?path=share/heredoc.md`)).data;
    expect(last).toMatchObject({ authorName: "Claude Code", authorEmail: "claude-code@agents.grimoire" });
    // Still one agent per link: the same session (cwd kept) and one actor, whatever name it gives.
    expect(named.data.cwd).toBe(`/workspace/${N}/share`);
    expect(named.data.stdout).toBe(`saved heredoc.md (${last.sha.slice(0, 7)})\nclaude-code\nclaude-code\n`);
    await post(url, "true", { "x-agent-name": "Third Name" });
    await post(url, "true", { "x-agent-name": "Fourth Name" });
    expect(app.shells.pending(`share:${link.id}`)).toBe(0);
    expect([...((app.shells as any).sessions as Map<string, unknown>).keys()].filter((k) => k.startsWith(`share:${link.id}`))).toEqual([`share:${link.id}\0share`]);
    expect((await post(url, "grep -rn 'by claude' .")).data.stdout).toBe("heredoc.md:3:- by claude\n");
  });

  test("read-only notebooks refuse writes", async () => {
    const link = await create(gina, RO);
    const url = local(link.url);
    expect((await post(url, "cat README.md")).data.stdout).toBe("read me\n");
    const w = await post(url, "echo nope >> README.md");
    expect(w.data.exitCode).not.toBe(0);
    expect(w.data.stderr).toContain("read-only");
    expect(await committed(alice, RO, "README.md")).toBe("read me\n");
  });

  test("not ready → 409; rate limit → 429; removing the notebook removes its links", async () => {
    insertRepo("share-importing", { kind: "notes", status: "importing" });
    const pending = await create(alice, "share-importing");
    expect((await fetch(local(pending.url))).status).toBe(409);
    expect((await post(local(pending.url), "true")).status).toBe(409);

    const link = await create(alice, N);
    const url = local(link.url);
    const old = shareLimits.perMinute;
    shareLimits.perMinute = 3;
    try {
      for (let i = 0; i < 3; i++) expect((await post(url, "true")).status).toBe(200);
      const limited = await post(url, "true");
      expect(limited.status).toBe(429);
      expect(limited.data.error).toContain("Too many calls");
      const wait = Number(limited.headers.get("retry-after"));
      expect(wait).toBeGreaterThanOrEqual(1);
      expect(wait).toBeLessThanOrEqual(60);
      expect((await fetch(url)).status).toBe(429);
      // Per link: another link is unaffected.
      expect((await post(local((await create(alice, N)).url), "true")).status).toBe(200);
    } finally {
      shareLimits.perMinute = old;
    }

    const doomed = (await api(alice, "POST", "/api/repos", { title: "Share Doomed" })).data.id;
    const d = await create(alice, doomed);
    expect((await fetch(local(d.url))).status).toBe(200);
    expect((await api(alice, "DELETE", `/api/repos/${doomed}`)).status).toBe(200);
    expect((db.query("SELECT COUNT(*) AS n FROM share_links WHERE repo_id = ?").get(doomed) as { n: number }).n).toBe(0);
    expect((await fetch(local(d.url))).status).toBe(404);
  });

  test("revoking stops running and queued commands at once and drops the link's sessions", async () => {
    const link = await create(alice, N, "Revokee");
    const url = local(link.url);
    expect((await post(url, "cd /tmp && echo kept > /tmp/x")).status).toBe(200);
    const started = Date.now();
    const running = post(url, "sleep 20; echo late > revoke-running.md", { "x-shell-session": "a" });
    const queued = post(url, "echo queued > revoke-queued.md", { "x-shell-session": "a" });
    await waitFor(() => app.shells.pending(`share:${link.id}`) === 2);
    expect((await api(alice, "DELETE", `/api/shares/${link.id}`)).data).toEqual({ ok: true });
    const [r1, r2] = await Promise.all([running, queued]);
    expect(Date.now() - started).toBeLessThan(5000);
    expect([r1.status, r2.status]).toEqual([404, 404]);
    expect(app.shells.pending(`share:${link.id}`)).toBe(0);
    expect([...((app.shells as any).sessions as Map<string, unknown>).keys()].some((k) => k.startsWith(`share:${link.id}`))).toBe(false);
    await Bun.sleep(100);
    for (const f of ["revoke-running.md", "revoke-queued.md"]) expect((await api(alice, "GET", `/api/repos/${N}/file?path=${f}`)).status).toBe(404);
  });

  test("writes are checked again right before they're applied", async () => {
    const link = await create(alice, N);
    const url = local(link.url);
    // Revoked behind the server's back (no listeners run), between the command's start and its writes.
    const res = post(url, "sleep 1; echo sneaky > recheck.md; echo done");
    await Bun.sleep(300);
    db.query("UPDATE share_links SET revoked_at = ? WHERE id = ?").run(Date.now(), link.id);
    expect((await res).status).toBe(404);
    expect((await api(alice, "GET", `/api/repos/${N}/file?path=recheck.md`)).status).toBe(404);
  });

  test("removing the notebook stops what its links are running", async () => {
    const doomed = (await api(alice, "POST", "/api/repos", { title: "Share Doomed Running" })).data.id;
    const d = await create(alice, doomed);
    const started = Date.now();
    const running = post(local(d.url), "sleep 20; echo late > late.md");
    await waitFor(() => app.shells.pending(`share:${d.id}`) === 1);
    expect((await api(alice, "DELETE", `/api/repos/${doomed}`)).status).toBe(200);
    expect((await running).status).toBe(404);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(app.shells.pending(`share:${d.id}`)).toBe(0);
  });

  test("a link never does more than its creator can do now", async () => {
    await app.ctx.store.createRepo("share-gh", { branch: "main" });
    await app.ctx.store.commit({ repo: "share-gh", branch: "main", expectedHead: null, changes: [{ path: "a.md", content: "a\n" }], message: "seed", author: { name: "x", email: "x@example.com" } });
    setCachedAccess(ginaId, "share-gh", "write");
    const link = await create(gina, "share-gh");
    const url = local(link.url);
    expect((await post(url, "echo b >> a.md")).data.exitCode).toBe(0);
    expect(await (await fetch(url)).text()).toContain("read and write");
    // Gina is down to read access on GitHub: the link is read-only.
    setCachedAccess(ginaId, "share-gh", "read");
    expect((await post(url, "cat a.md")).data.stdout).toBe("a\nb\n");
    const w = await post(url, "echo c >> a.md");
    expect(w.data.exitCode).not.toBe(0);
    expect(w.data.stderr).toContain("read-only");
    expect(await (await fetch(url)).text()).toContain("read-only");
    // No access at all: the link is gone.
    setCachedAccess(ginaId, "share-gh", "none");
    expect((await fetch(url)).status).toBe(404);
    expect((await post(url, "true")).status).toBe(404);
    setCachedAccess(ginaId, "share-gh", "write");
    expect((await post(url, "true")).status).toBe(200);

    // A creator the allowlist no longer lets in takes the link down with them.
    const allowed = config.allowedUsers;
    config.allowedUsers = ["alice"];
    try {
      expect((await post(url, "true")).status).toBe(404);
    } finally {
      config.allowedUsers = allowed;
    }
    expect((await post(url, "true")).status).toBe(200);

    // Deleting the creator deletes their links.
    const hal = await login("Hal");
    const halId = (await api(hal, "GET", "/api/me")).data.id;
    const halLink = await create(hal, N);
    db.query("DELETE FROM users WHERE id = ?").run(halId);
    expect(db.query("SELECT 1 FROM share_links WHERE id = ?").get(halLink.id)).toBeNull();
    expect((await fetch(local(halLink.url))).status).toBe(404);
  });

  test("at most a few commands at once per link, across sessions", async () => {
    const link = await create(alice, N);
    const url = local(link.url);
    const old = shareLimits.concurrent;
    shareLimits.concurrent = 2;
    try {
      const slow = [post(url, "sleep 1", { "x-shell-session": "c1" }), post(url, "sleep 1", { "x-shell-session": "c2" })];
      await waitFor(() => app.shells.pending(`share:${link.id}`) === 2);
      const busy = await post(url, "true", { "x-shell-session": "c3" });
      expect(busy.status).toBe(429);
      expect(busy.data.error).toContain("running or queued");
      expect((await Promise.all(slow)).map((r) => r.status)).toEqual([200, 200]);
      expect((await post(url, "true", { "x-shell-session": "c3" })).status).toBe(200);
    } finally {
      shareLimits.concurrent = old;
    }
  });

  test("body limit applies to streamed bodies too", async () => {
    const link = await create(alice, N);
    const chunk = new Uint8Array(256 * 1024).fill(120);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= 8) return c.close();
        sent++;
        c.enqueue(chunk);
      },
    });
    const res = await fetch(local(link.url), { method: "POST", body: stream, duplex: "half" } as RequestInit);
    expect(res.status).toBe(413);
    expect((await res.json()).error).toContain("too large");
  });

  test("older share_links tables get the creator foreign key, keeping their rows", async () => {
    const tmp = mkdtempSync(join(dir, "migrate-"));
    const { Database } = await import("bun:sqlite");
    const old = new Database(join(tmp, "grimoire.sqlite"));
    old.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, github_id INTEGER UNIQUE, login TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, avatar TEXT, github_token TEXT, is_admin INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE repos (id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL, gh_owner TEXT, gh_name TEXT, read_only INTEGER NOT NULL DEFAULT 0, branch TEXT NOT NULL, status TEXT NOT NULL, error TEXT, created_by TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE share_links (id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE, label TEXT, created_by TEXT, created_at INTEGER, last_used_at INTEGER, revoked_at INTEGER);
      INSERT INTO users (id, login, name, email, created_at) VALUES ('u1', 'u', 'U', 'u@x', 1);
      INSERT INTO repos (id, title, kind, branch, status, created_at) VALUES ('r1', 'R', 'notes', 'main', 'ready', 1);
      INSERT INTO share_links (id, repo_id, label, created_by, created_at, last_used_at) VALUES ('l1', 'r1', 'Kept', 'u1', 5, 6), ('l2', 'r1', 'Orphan', 'gone', 7, NULL);`);
    old.close();
    const p = Bun.spawn([process.execPath, "-e", `const { db } = await import(${JSON.stringify(join(import.meta.dir, "../../src/server/db.ts"))});
      console.log(JSON.stringify({ fks: db.query("PRAGMA foreign_key_list(share_links)").all().map((f) => f.table + "." + f.from), rows: db.query("SELECT id, label, created_by, created_at, last_used_at FROM share_links ORDER BY id").all() }));`], {
      env: { ...process.env, DATA_DIR: tmp },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(err).toBe("");
    const r = JSON.parse(out);
    expect(r.fks.sort()).toEqual(["repos.repo_id", "users.created_by"]);
    expect(r.rows).toEqual([
      { id: "l1", label: "Kept", created_by: "u1", created_at: 5, last_used_at: 6 },
      { id: "l2", label: "Orphan", created_by: null, created_at: 7, last_used_at: null },
    ]);
  });

  test("CLI: bin/grimoire runs commands through a share link", async () => {
    const link = await create(alice, N, "Cli");
    const url = local(link.url);
    const home = mkdtempSync(join(dir, "cli-home-"));
    const cli = join(import.meta.dir, "../../bin/grimoire");
    const env = { PATH: process.env.PATH!, HOME: home, GRIMOIRE_SHARE_URL: url, GRIMOIRE_SESSION: "cli-test" };
    const run = async (args: string[], opts: { env?: Record<string, string>; stdin?: string } = {}) => {
      const p = Bun.spawn([process.execPath, cli, ...args], { env: opts.env ?? env, stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]), stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { stdout, stderr, code };
    };
    expect(await run(["pwd"])).toEqual({ stdout: `/workspace/${N}\n`, stderr: "", code: 0 });
    expect(await run(["mkdir -p cli; cd cli; echo out; echo err >&2; (exit 3)"])).toEqual({ stdout: "out\n", stderr: "err\n", code: 3 });
    expect(await run(["pwd"])).toEqual({ stdout: `/workspace/${N}/cli\n`, stderr: "", code: 0 });
    expect((await run(["ls", "/workspace"])).stdout).toBe(`${N}\n`);
    expect(await run([], { stdin: "cat <<'EOF'\nfrom stdin\nEOF\n" })).toEqual({ stdout: "from stdin\n", stderr: "", code: 0 });
    expect(await run(["-c", "whoami"])).toEqual({ stdout: "cli\n", stderr: "", code: 0 });
    expect(await run(["whoami"], { env: { ...env, GRIMOIRE_AGENT_NAME: "Robo" } })).toEqual({ stdout: "robo\n", stderr: "", code: 0 });
    // --url instead of the environment.
    expect(await run(["--url", url, "echo $USER"], { env: { PATH: process.env.PATH!, HOME: home } })).toEqual({ stdout: "cli\n", stderr: "", code: 0 });
    const noConfig = await run(["pwd"], { env: { PATH: process.env.PATH!, HOME: home } });
    expect(noConfig.code).toBe(2);
    expect(noConfig.stderr).toContain("GRIMOIRE_SHARE_URL");
    expect((await run(["--url", base, "pwd"])).code).toBe(2);
    // Only v4 UUIDs are share links.
    expect((await run(["--url", `${base}/a/00000000-0000-0000-0000-000000000000`, "pwd"])).code).toBe(2);
    // Settings from the config file.
    const configFile = join(home, ".config/grimoire/config.json");
    await Bun.write(configFile, JSON.stringify({ url }));
    chmodSync(configFile, 0o644);
    const loose = await run(["echo $USER"], { env: { PATH: process.env.PATH!, HOME: home } });
    expect(loose.stdout).toBe("cli\n");
    expect(loose.stderr).toContain("chmod 600");
    chmodSync(configFile, 0o600);
    expect(await run(["echo $USER"], { env: { PATH: process.env.PATH!, HOME: home } })).toEqual({ stdout: "cli\n", stderr: "", code: 0 });
    await Bun.write(configFile, "null");
    expect((await run(["pwd"], { env: { PATH: process.env.PATH!, HOME: home } })).code).toBe(2);
    await api(alice, "DELETE", `/api/shares/${link.id}`);
    const revoked = await run(["pwd"]);
    expect(revoked.code).toBe(255);
    expect(revoked.stderr).toContain("404");
  });
});

describe("events", () => {
  test("SSE only carries events for repos the user can access", async () => {
    const erin = await login("Erin");
    const erinId = (await api(erin, "GET", "/api/me")).data.id;
    db.query("UPDATE users SET github_token = 'fake' WHERE id = ?").run(erinId);
    insertRepo("api-sse-hidden");
    insertRepo("api-sse-shown");
    // Seed access for every GitHub repo so the stream never asks GitHub.
    for (const r of db.query("SELECT id FROM repos WHERE kind = 'github' AND read_only = 0").all() as Array<{ id: string }>) setCachedAccess(erinId, r.id, "none");
    setCachedAccess(erinId, "api-sse-shown", "read");
    setCachedAccess(erinId, "api-sse-hidden", "none", 60_000);

    const ac = new AbortController();
    const res = await fetch(`${base}/api/events`, { headers: { cookie: erin }, signal: ac.signal });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    let got = "";
    await waitFor(async () => {
      got += new TextDecoder().decode((await reader.read()).value);
      return got.includes(": connected");
    });
    emit({ type: "tree", repo: "api-sse-hidden" });
    emit({ type: "tree", repo: "no-such-repo" });
    emit({ type: "tree", repo: "api-sse-shown" });
    emit({ type: "tree", repo: N });
    emit({ type: "repos" });
    while (!got.includes("event: repos")) got += new TextDecoder().decode((await reader.read()).value);
    ac.abort();
    expect(got).toContain('"repo":"api-sse-shown"');
    expect(got).toContain(`"repo":"${N}"`);
    expect(got).not.toContain("api-sse-hidden");
    expect(got).not.toContain("no-such-repo");
    const tree = (repo: string) => got.indexOf(`data: {"type":"tree","repo":"${repo}"}`);
    expect(tree("api-sse-shown")).toBeGreaterThan(0);
    expect(tree("api-sse-shown")).toBeLessThan(tree(N));
    // Emitting after the client went away must not throw.
    await Bun.sleep(20);
    expect(() => emit({ type: "repos" })).not.toThrow();
  });
});

describe("static & webhooks", () => {
  test("webhook refuses when no secret is configured", async () => {
    expect((await fetch(`${base}/webhooks/codestorage`, { method: "POST", body: "{}" })).status).toBe(503);
  });

  test("webhook signatures are verified; a valid push merges into open rooms", async () => {
    const secret = "whsec_test";
    config.codeStorage.webhookSecret = secret;
    try {
      await api(alice, "POST", `/api/repos/${N}/files`, { path: "hook.md", content: "before\n" });
      await waitFor(async () => (await committed(alice, N, "hook.md")) === "before\n");
      const c = connect(alice, N, "hook.md");
      await waitFor(() => c.text.toString() === "before\n");
      const head = await app.ctx.store.head(N, "main");
      const r = await app.ctx.store.commit({
        repo: N,
        branch: "main",
        expectedHead: head,
        changes: [{ path: "hook.md", content: "after\n" }],
        message: "outside push",
        author: { name: "Outsider", email: "o@example.com" },
      });
      expect(r.ok).toBe(true);
      const body = JSON.stringify({
        repository: { id: N, url: "https://example.com" },
        ref: "refs/heads/main",
        before: head,
        after: r.ok ? r.sha : "",
        customer_id: "c",
        pushed_at: new Date().toISOString(),
      });
      const t = Math.floor(Date.now() / 1000);
      const send = (sig: string) =>
        fetch(`${base}/webhooks/codestorage`, { method: "POST", headers: { "x-pierre-signature": `t=${t},sha256=${sig}`, "x-pierre-event": "push" }, body });
      expect((await send("00".repeat(32))).status).toBe(401);
      expect(c.text.toString()).toBe("before\n");
      const ok = await send(await hmacHex(secret, `${t}.${body}`));
      expect(ok.status).toBe(200);
      await waitFor(() => c.text.toString() === "after\n");
      expect(c.controls.some((m) => m.t === "external")).toBe(true);
      c.close();
    } finally {
      config.codeStorage.webhookSecret = "";
    }
  });

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
    await waitFor(async () => (repo = (await api(cookie, "GET", `/api/repos/${id}`)).data).status !== "importing", 10_000);
    return repo;
  }

  let handbookId = "";

  test("anyone signed in can add a public repo read-only, by URL, without a GitHub token", async () => {
    calls.length = 0;
    const r = await api(bob, "POST", "/api/repos", { github: "https://github.com/Acme/Handbook/tree/main" });
    expect(r.status).toBe(201);
    expect(r.data).toMatchObject({ kind: "github", title: "acme/handbook", ghOwner: "acme", ghName: "handbook", branch: "main", readOnly: true, access: "read", canRemove: true });
    expect(calls.every((c) => c.auth === null)).toBe(true);
    handbookId = r.data.id;
    expect(await ready(bob, handbookId)).toMatchObject({ status: "ready", error: null });
    expect((await api(bob, "GET", `/api/repos/${handbookId}/tree`)).data.files).toEqual(["README.md", "guide/a.md"]);
    expect((await api(bob, "GET", `/api/repos/${handbookId}/file?path=README.md`)).data.content).toBe("# Handbook\n");
    expect((await api(bob, "GET", `/api/repos/${handbookId}/history?path=README.md`)).data).toHaveLength(1);
    expect((await api(bob, "POST", `/api/repos/${handbookId}/files`, { path: "x.md" })).status).toBe(403);
    // Only the repo's Markdown was downloaded.
    const dir = join(config.dataDir, "git", `${handbookId}.git`);
    expect((await sh(["config", "remote.origin.promisor"], dir)).trim()).toBe("true");
    const missing = await sh(["cat-file", "--batch-check"], dir, (await sh(["rev-parse", "HEAD:logo.bin"], dir)), { GIT_NO_LAZY_FETCH: "1" });
    expect(missing).toContain("missing");
    // Everyone sees it; its creator and admins may remove it, but not other repos.
    expect((await api(alice, "GET", "/api/repos")).data).toContainEqual(expect.objectContaining({ id: handbookId, canRemove: true }));
    expect((await api(bob, "GET", "/api/repos")).data.find((x: any) => x.id === "api-notes")?.canRemove).toBe(false);
  });

  test("adding the same repo again returns the existing copy", async () => {
    for (const github of ["acme/handbook", "git@github.com:acme/handbook.git", "https://github.com/ACME/handbook.git", "https://github.com/acme/handbook/blob/main/guide/a.md"]) {
      const r = await api(alice, "POST", "/api/repos", { github });
      expect(r.status).toBe(200);
      expect(r.data.id).toBe(handbookId);
    }
    expect((db.query("SELECT COUNT(*) AS n FROM repos WHERE lower(gh_owner) = 'acme' AND lower(gh_name) = 'handbook'").get() as { n: number }).n).toBe(1);
  });

  test("branches from /tree/ URLs, including names with slashes", async () => {
    const r = await api(bob, "POST", "/api/repos", { github: "https://github.com/acme/handbook/tree/feature/x/guide" });
    expect(r.status).toBe(201);
    expect(r.data).toMatchObject({ branch: "feature/x", title: "acme/handbook (feature/x)" });
    expect(r.data.id).not.toBe(handbookId);
    expect((await ready(bob, r.data.id)).status).toBe("ready");
    expect((await api(bob, "POST", "/api/repos", { github: "acme/handbook", branch: "feature/x" })).data.id).toBe(r.data.id);
    expect((await api(bob, "POST", "/api/repos", { github: "https://github.com/acme/handbook/tree/nope" })).status).toBe(404);
  });

  test("clear errors: bad input, unknown or private repos, unsafe branches, no Markdown", async () => {
    expect((await api(bob, "POST", "/api/repos", { github: "https://gitlab.com/a/b" })).status).toBe(400);
    expect((await api(bob, "POST", "/api/repos", { github: "acme/handbook", branch: "--upload-pack=touch /tmp/x" })).status).toBe(400);
    const missing = await api(bob, "POST", "/api/repos", { github: "acme/nothing" });
    expect(missing.status).toBe(404);
    expect(missing.data.error).toContain("wasn't found");
    const secret = await api(bob, "POST", "/api/repos", { github: "https://github.com/acme/secret" });
    expect(secret.status).toBe(403);
    expect(secret.data.error).toContain("private");
    // Editable links keep the old rules.
    expect((await api(bob, "POST", "/api/repos", { github: "acme/handbook", readOnly: false })).status).toBe(400);

    const code = await api(bob, "POST", "/api/repos", { github: "acme/code" });
    expect(code.status).toBe(201);
    const repo = await ready(bob, code.data.id);
    expect(repo).toMatchObject({ status: "error", error: "No Markdown files in acme/code on main" });
    expect(existsSync(join(config.dataDir, "git", `${code.data.id}.git`))).toBe(false);
    // Anyone may retry a failed import (and then counts as its creator), or remove it.
    const carol = await login("Carol");
    expect((await api(carol, "GET", `/api/repos/${code.data.id}`)).data.canRemove).toBe(true);
    const retry = await api(carol, "POST", "/api/repos", { github: "acme/code" });
    expect(retry.status).toBe(200);
    expect(retry.data).toMatchObject({ id: code.data.id, status: "importing" });
    expect((db.query("SELECT created_by FROM repos WHERE id = ?").get(code.data.id) as any).created_by).toBe(carolId());
    expect((await ready(carol, code.data.id)).status).toBe("error");
    expect((await api(carol, "DELETE", `/api/repos/${code.data.id}`)).status).toBe(200);
  });

  test("read-only adds never send the user's GitHub token", async () => {
    const tess = await login("Tess");
    db.query("UPDATE users SET github_token = 'secret-token' WHERE login = 'tess'").run();
    calls.length = 0;
    // No explicit branch: GitHub is asked which branch is the default before matching the existing copy.
    const r = await api(tess, "POST", "/api/repos", { github: "acme/handbook" });
    expect(r.status).toBe(200);
    expect(r.data.id).toBe(handbookId);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.auth === null)).toBe(true);
    // An explicit branch that's already here needs no GitHub call at all.
    calls.length = 0;
    expect((await api(tess, "POST", "/api/repos", { github: "acme/handbook", branch: "main" })).data.id).toBe(handbookId);
    expect(calls).toEqual([]);
  });

  test("branches in URLs are checked on GitHub; if that's impossible the add fails instead of guessing", async () => {
    const bare = join(ghTmp, "upstream", "acme", "handbook.git");
    renameSync(bare, `${bare}.away`);
    try {
      const r = await api(bob, "POST", "/api/repos", { github: "https://github.com/acme/handbook/tree/feature/x" });
      expect(r.status).toBe(502);
      expect(r.data.error).toContain("could not reach GitHub");
    } finally {
      renameSync(`${bare}.away`, bare);
    }
    // /blob/<branch>/<file>: the file name is never taken as part of the branch.
    const blob = await api(bob, "POST", "/api/repos", { github: "https://github.com/acme/handbook/blob/main/guide/a.md" });
    expect(blob.data.id).toBe(handbookId);
  });

  test("caps on read-only copies: per person and in total", async () => {
    const old = { ...config.githubCopies };
    try {
      const mine = app.ctx.repos.readOnlyCopies((db.query("SELECT id FROM users WHERE login = 'bob'").get() as { id: string }).id);
      config.githubCopies.perUser = mine.mine;
      const r = await api(bob, "POST", "/api/repos", { github: "acme/limits" });
      expect(r.status).toBe(403);
      expect(r.data.error).toContain("the most one person can");
      // Existing copies are still returned.
      expect((await api(bob, "POST", "/api/repos", { github: "acme/handbook" })).status).toBe(200);
      config.githubCopies.perUser = 100;
      config.githubCopies.max = mine.total;
      expect((await api(bob, "POST", "/api/repos", { github: "acme/limits" })).status).toBe(503);
    } finally {
      Object.assign(config.githubCopies, old);
    }
  });

  test("a repo removed while it imports leaves nothing on disk", async () => {
    const r = await api(bob, "POST", "/api/repos", { github: "acme/limits" });
    expect(r.status).toBe(201);
    await app.ctx.repos.removeRepo(r.data.id);
    await Bun.sleep(500);
    expect(existsSync(join(config.dataDir, "git", `${r.data.id}.git`))).toBe(false);
    expect((await api(bob, "GET", `/api/repos/${r.data.id}`)).status).toBe(404);
  });

  test("imports run at most two at a time, and all finish", async () => {
    const ids: string[] = [];
    for (const n of ["q1", "q2", "q3", "q4"]) {
      await up.make("acme", n, { "README.md": `# ${n}\n` });
      known.set(`acme/${n}`, { private: false, default_branch: "main", full_name: `acme/${n}` });
      ids.push((await api(alice, "POST", "/api/repos", { github: `acme/${n}` })).data.id);
    }
    expect((app.ctx.repos as any).importing).toBeLessThanOrEqual(2);
    for (const id of ids) expect((await ready(alice, id)).status).toBe("ready");
    for (const id of ids) await app.ctx.repos.removeRepo(id);
  });

  test("files over the size limit are refused with a clear error", async () => {
    await up.make("acme", "big", { "README.md": "# Big\n", "big.md": "x".repeat(MAX_FILE_BYTES + 10) });
    known.set("acme/big", { private: false, default_branch: "main", full_name: "acme/big" });
    const r = await api(alice, "POST", "/api/repos", { github: "acme/big" });
    expect((await ready(alice, r.data.id)).status).toBe("ready");
    const file = await api(alice, "GET", `/api/repos/${r.data.id}/file?path=big.md`);
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
      const r = await api(bob, "POST", "/api/repos", { github: "acme/limits" });
      expect(r.status).toBe(201);
      expect((await ready(bob, r.data.id)).status).toBe("ready");
      const ghost = await api(bob, "POST", "/api/repos", { github: "acme/ghost" });
      expect(ghost.status).toBe(429);
      expect(ghost.data.error).toContain("rate limit");
      expect(ghost.data.error).toContain("10 minutes");
      expect((await api(alice, "DELETE", `/api/repos/${r.data.id}`)).status).toBe(200);
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

    const r = await api(bob, "POST", `/api/repos/${handbookId}/refresh`);
    expect(r.status).toBe(200);
    expect((await api(bob, "GET", `/api/repos/${handbookId}/tree`)).data).toEqual({ head: r.data.head, files: ["README.md", "guide/a.md", "new.md"] });
    await waitFor(() => c.text.toString() === "# Handbook v2\n");
    expect((await api(bob, "GET", `/api/repos/${handbookId}/history`)).data.map((x: any) => x.message)).toEqual(["Second", "Initial commit"]);

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
      await app.ctx.repos.onPush(handbookId);
      await Bun.sleep(200);
      expect(c.closeCode).toBeNull();
      expect(c.text.toString()).toBe("# Handbook v2\n");
      // A refresh that fails is reported, and still counts toward the cooldown.
      (app.ctx.repos as any).lastRefresh.delete(handbookId);
      const failed = await api(bob, "POST", `/api/repos/${handbookId}/refresh`);
      expect(failed.status).toBe(502);
      expect((await api(bob, "POST", `/api/repos/${handbookId}/refresh`)).status).toBe(200);
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
    const r = await api(bob, "POST", "/api/repos", { github: "acme/pics" });
    expect((await ready(bob, r.data.id)).status).toBe("ready");
    const dir = join(config.dataDir, "git", `${r.data.id}.git`);
    const oid = await sh(["rev-parse", "HEAD:img/a.png"], dir);
    expect(await sh(["cat-file", "--batch-check"], dir, oid, { GIT_NO_LAZY_FETCH: "1" })).toContain("missing");
    const res = await fetch(`${base}/api/repos/${r.data.id}/raw?path=img/a.png`, { headers: { cookie: bob } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    // listings stay Markdown-only
    expect((await api(bob, "GET", `/api/repos/${r.data.id}/tree`)).data.files).toEqual(["README.md"]);
    await app.ctx.repos.removeRepo(r.data.id);
  });

  test("the creator can remove a read-only copy; others can't", async () => {
    expect((await api(alice, "GET", `/api/repos/${handbookId}`)).data.canRemove).toBe(true);
    const carol = await login("Carol");
    expect((await api(carol, "DELETE", `/api/repos/${handbookId}`)).status).toBe(403);
    expect((await api(bob, "DELETE", `/api/repos/${handbookId}`)).status).toBe(200);
    expect(existsSync(join(config.dataDir, "git", `${handbookId}.git`))).toBe(false);
  });
});

describe("GitHub links without a way to push", () => {
  test("an older editable link is switched to read-only at startup", async () => {
    const { db } = await import("../../src/server/db.ts");
    const { RepoService, getRepo } = await import("../../src/server/repos.ts");
    // Other test files share this database and use editable GitHub repos: put them back afterwards.
    const others = (db.query("SELECT id FROM repos WHERE kind = 'github' AND read_only = 0").all() as Array<{ id: string }>).map((r) => r.id);
    db.query("INSERT INTO repos (id, title, kind, gh_owner, gh_name, read_only, branch, status, created_at) VALUES ('gh-old-edit', 'old/edit', 'github', 'old', 'edit', 0, 'main', 'ready', 0)").run();
    try {
      new RepoService(null as never, null as never).enforceGitHubReadOnly();
      expect(getRepo("gh-old-edit")!.read_only).toBe(1);
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
    return sha;
  }

  const raw = (cookie: string, repo: string, query: string) => fetch(`${base}/api/repos/${repo}/raw?${query}`, { headers: cookie ? { cookie } : {} });

  beforeAll(async () => {
    const r = await api(alice, "POST", "/api/repos", { title: "Raw images" });
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

  test("access is checked like file reads", async () => {
    expect((await raw("", id, "path=img/logo.svg")).status).toBe(401);
    const gh = "raw-gh-private";
    insertRepo(gh);
    await app.ctx.store.createRepo(gh, { branch: "main" });
    await app.ctx.store.commit({ repo: gh, branch: "main", expectedHead: null, changes: [{ path: "README.md", content: "# x\n" }], message: "init", author: { name: "T", email: "t@x" } });
    await commitRaw(gh, { "x.png": PNG });
    // people with a GitHub login get GitHub's answer (cached here): none → 404, read → served
    const [rhea, remy] = [await login("Rhea"), await login("Remy")];
    for (const [name, access] of [["rhea", "none"], ["remy", "read"]] as const) {
      const uid = (db.query("SELECT id FROM users WHERE login = ?").get(name) as { id: string }).id;
      db.query("UPDATE users SET github_token = 'fake' WHERE id = ?").run(uid);
      setCachedAccess(uid, gh, access);
    }
    expect((await raw(rhea, gh, "path=x.png")).status).toBe(404);
    expect((await raw(remy, gh, "path=x.png")).status).toBe(200);
    await app.ctx.store.deleteRepo(gh);
  });

  test("the store reads blobs as bytes with a cap", async () => {
    expect(await app.ctx.store.readBlob(id, "a/b/c.webp", "main", 10)).toEqual(new TextEncoder().encode("webp"));
    expect(await app.ctx.store.readBlob(id, "missing.png", "main", 10)).toBeNull();
    expect(await app.ctx.store.readBlob(id, "img", "main", 10)).toBeNull();
    await expect(app.ctx.store.readBlob(id, "a/b/c.webp", "main", 3)).rejects.toThrow("too large");
  });
});
