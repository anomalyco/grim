import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

const dir = mkdtempSync(join(tmpdir(), "np-api-"));
process.env.DATA_DIR = dir;
process.env.STORAGE = "local";
process.env.ALLOW_DEV_LOGIN = "1";
process.env.ALLOWED_GITHUB_USERS = "*";
process.env.QUIET_MS = "100";
process.env.POLL_MS = "60000";
delete process.env.GITHUB_CLIENT_ID;
delete process.env.CODE_STORAGE_WEBHOOK_SECRET;

// bun test may share one module registry between files, so config can already be loaded with another
// file's env: override what matters directly, and use repo ids no other test uses.
const { config } = await import("../../src/server/config.ts");
Object.assign(config, { dataDir: dir, storage: "local", allowDevLogin: true, allowedUsers: ["*"], quietMs: 100, pollMs: 60000, notesRepo: "api-notes" });
config.github.clientId = "";
config.github.appSlug = "";
config.codeStorage.webhookSecret = "";
const { startServer } = await import("../../src/server/index.ts");
const { db } = await import("../../src/server/db.ts");
const { setCachedAccess } = await import("../../src/server/auth.ts");
const { emit } = await import("../../src/server/events.ts");
const N = "api-notes";

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
    expect(hits.data).toContainEqual(expect.objectContaining({ path: "ideas/done.md", text: expect.stringContaining("pineapples") }));

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
    expect((await api(bob, "POST", "/api/repos", { github: "octo/hello" })).status).toBe(403);
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

describe("agents", () => {
  test("admin creates tokens; agents authenticate to /mcp", async () => {
    expect((await api(bob, "POST", "/api/agent-tokens", { name: "x" })).status).toBe(403);
    const created = await api(alice, "POST", "/api/agent-tokens", { name: "Claude" });
    expect(created.status).toBe(201);
    expect(created.data.token).toMatch(/^grim_/);
    const list = await api(alice, "GET", "/api/agent-tokens");
    expect(list.data).toContainEqual(expect.objectContaining({ id: created.data.id, name: "Claude", lastUsedAt: null }));
    expect(JSON.stringify(list.data)).not.toContain(created.data.token);

    const rpc = (auth: string | null, body: unknown) =>
      fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(auth ? { authorization: auth } : {}) },
        body: JSON.stringify(body),
      });
    expect((await rpc(null, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
    expect((await rpc("Bearer grim_wrong", { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);

    const auth = `Bearer ${created.data.token}`;
    const init = await rpc(auth, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    expect(init.status).toBe(200);
    expect((await init.json()).result.protocolVersion).toBeTruthy();
    const sid = init.headers.get("mcp-session-id")!;
    expect(sid).toBeTruthy();
    const call = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: auth, "mcp-session-id": sid },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "bash", arguments: { command: `echo 'hello from claude' > /workspace/${N}/agent.md` } } }),
    });
    const out = await call.json();
    expect(out.result.isError).toBeFalsy();
    expect(out.result.content[0].text).toBe("(no output)");
    const read = await api(alice, "GET", `/api/repos/${N}/file?path=agent.md`);
    expect(read.data.content).toContain("hello from claude");
    // The session belongs to this token's agent.
    const end = await fetch(`${base}/mcp`, { method: "DELETE", headers: { authorization: auth, "mcp-session-id": sid } });
    expect(end.status).toBe(204);

    const after = await api(alice, "GET", "/api/agent-tokens");
    expect(after.data.find((t: any) => t.id === created.data.id).lastUsedAt).toBeGreaterThan(0);

    expect((await api(alice, "DELETE", `/api/agent-tokens/${created.data.id}`)).data).toEqual({ ok: true });
    expect((await rpc(auth, { jsonrpc: "2.0", id: 3, method: "ping" })).status).toBe(401);
  });
});

describe("shell API", () => {
  const shell = (headers: Record<string, string>, body: unknown) =>
    fetch(`${base}/api/shell`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  test("agent tokens: run commands, sessions keep cwd", async () => {
    const created = await api(alice, "POST", "/api/agent-tokens", { name: "Shelly" });
    const auth = { authorization: `Bearer ${created.data.token}` };
    expect((await shell({}, { command: "pwd" })).status).toBe(401);
    expect((await shell({ authorization: "Bearer grim_nope" }, { command: "pwd" })).status).toBe(401);

    const r = await shell(auth, { command: `cd /workspace/${N} && echo hi && echo warn >&2 && false`, session: "a" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ stdout: "hi\n", stderr: "warn\n", exitCode: 1, cwd: `/workspace/${N}` });
    expect(await (await shell(auth, { command: "pwd", session: "a" })).json()).toMatchObject({ stdout: `/workspace/${N}\n`, exitCode: 0 });
    // Session from the header; other sessions start fresh.
    expect((await (await shell({ ...auth, "x-shell-session": "a" }, { command: "pwd" })).json()).stdout).toBe(`/workspace/${N}\n`);
    expect((await (await shell(auth, { command: "pwd", session: "b" })).json()).stdout).toBe("/workspace\n");

    await shell(auth, { command: `echo 'from the shell API' >> /workspace/${N}/shell-api.md` });
    expect((await api(alice, "GET", `/api/repos/${N}/file?path=shell-api.md`)).data.content).toBe("from the shell API\n");

    const big = await (await shell(auth, { command: "seq 1 100000" })).json();
    expect(big.truncated).toBe(true);
    for (const bad of [{}, { command: "" }, { command: "true", timeout_seconds: 111 }, { command: "true", session: "bad session!" }]) {
      expect((await shell(auth, bad)).status).toBe(400);
    }
    expect((await fetch(`${base}/api/shell`, { headers: auth })).status).toBe(405);
    await api(alice, "DELETE", `/api/agent-tokens/${created.data.id}`);
  });

  test("browser sessions: same-origin or JSON only", async () => {
    const ok = await shell({ cookie: bob }, { command: "echo $USER; ls /workspace" });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.stdout).toContain("bob\n");
    expect(body.stdout).toContain(`${N}\n`);
    expect((await shell({ cookie: bob, origin: base }, { command: "true" })).status).toBe(200);
    expect((await shell({ cookie: bob, origin: "https://evil.example" }, { command: "true" })).status).toBe(403);
    const form = await fetch(`${base}/api/shell`, { method: "POST", headers: { cookie: bob, "content-type": "text/plain" }, body: JSON.stringify({ command: "true" }) });
    expect(form.status).toBe(403);
  });

  test("CLI: bin/grimoire runs commands against the server", async () => {
    const created = await api(alice, "POST", "/api/agent-tokens", { name: "Cli" });
    const home = mkdtempSync(join(tmpdir(), "np-cli-home-"));
    const cli = join(import.meta.dir, "../../bin/grimoire");
    const env = { PATH: process.env.PATH!, HOME: home, GRIMOIRE_URL: base, GRIMOIRE_TOKEN: created.data.token, GRIMOIRE_SESSION: "cli-test" };
    const run = async (args: string[], opts: { env?: Record<string, string>; stdin?: string } = {}) => {
      const p = Bun.spawn([process.execPath, cli, ...args], { env: opts.env ?? env, stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]), stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { stdout, stderr, code };
    };
    expect(await run([`cd /workspace/${N}; echo out; echo err >&2; (exit 3)`])).toEqual({ stdout: "out\n", stderr: "err\n", code: 3 });
    expect(await run(["pwd"])).toEqual({ stdout: `/workspace/${N}\n`, stderr: "", code: 0 });
    expect((await run(["ls", "-d", "/workspace/*"])).stdout).toContain(`/workspace/${N}\n`);
    expect(await run([], { stdin: "cat <<'EOF'\nfrom stdin\nEOF\n" })).toEqual({ stdout: "from stdin\n", stderr: "", code: 0 });
    const noConfig = await run(["pwd"], { env: { PATH: process.env.PATH!, HOME: home } });
    expect(noConfig.code).toBe(2);
    expect(noConfig.stderr).toContain("GRIMOIRE_URL");
    // Settings from the config file instead of the environment.
    const configFile = join(home, ".config/grimoire/config.json");
    await Bun.write(configFile, JSON.stringify({ url: base, token: created.data.token }));
    chmodSync(configFile, 0o644);
    const loose = await run(["echo $USER"], { env: { PATH: process.env.PATH!, HOME: home } });
    expect(loose.stdout).toBe("cli\n");
    expect(loose.stderr).toContain("chmod 600");
    chmodSync(configFile, 0o600);
    expect(await run(["echo $USER"], { env: { PATH: process.env.PATH!, HOME: home } })).toEqual({ stdout: "cli\n", stderr: "", code: 0 });
    expect(await run(["-c", "whoami"])).toEqual({ stdout: "cli\n", stderr: "", code: 0 });
    await Bun.write(configFile, "null");
    expect((await run(["pwd"], { env: { PATH: process.env.PATH!, HOME: home } })).code).toBe(2);
    const badToken = await run(["pwd"], { env: { ...env, GRIMOIRE_TOKEN: "grim_nope" } });
    expect(badToken.code).toBe(255);
    expect(badToken.stderr).toContain("401");
    await api(alice, "DELETE", `/api/agent-tokens/${created.data.id}`);
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
