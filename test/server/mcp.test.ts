import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "np-mcp-test-"));
process.env.DATA_DIR = dir;
process.env.QUIET_MS = "50";

const { LocalGitStore } = await import("../../src/server/store/localgit.ts");
const { RoomManager } = await import("../../src/server/rooms.ts");
const { RepoService } = await import("../../src/server/repos.ts");
const { db } = await import("../../src/server/db.ts");
const { handleMcp } = await import("../../src/server/mcp.ts");
const ops = await import("../../src/server/ops.ts");

const store = new LocalGitStore(join(dir, "git"));
const rooms = new RoomManager(store);
const repos = new RepoService(store, rooms);
const ctx = { store, rooms, repos };

const bot = { id: "agent1", name: "Robo", email: "robo@agents.notepad", kind: "agent" as const, color: "#0f0" };
const alice = { id: "u1", name: "Alice", email: "alice@example.com", kind: "human" as const, color: "#f00" };

type AccessLevel = "write" | "read" | "none";
const accessMap: Record<string, AccessLevel> = { notes: "write", secret: "none", ro: "read", frozen: "write" };
const access = async (r: { id: string }) => accessMap[r.id] ?? "none";

let nextId = 1;

async function post(body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) {
  const req = new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal,
  });
  return handleMcp(req, ctx, bot, access);
}

async function rpc(method: string, params?: unknown) {
  const id = nextId++;
  const res = await post({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/json");
  const body = (await res.json()) as { id: number; result?: any; error?: { code: number; message: string } };
  expect(body.id).toBe(id);
  return body;
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const { result } = await rpc("tools/call", { name, arguments: args });
  return { text: result.content[0].text as string, isError: !!result.isError, raw: result };
}

async function callJson(name: string, args: Record<string, unknown> = {}) {
  const r = await call(name, args);
  if (r.isError) throw new Error(`${name} failed: ${r.text}`);
  return JSON.parse(r.text);
}

function parseRead(t: string) {
  const nl = t.indexOf("\n");
  return { header: JSON.parse(t.slice(0, nl)) as { path: string; version: string; live: boolean }, content: t.slice(nl + 1) };
}

beforeAll(async () => {
  await repos.ensureNotesRepo();
  // A repo the agent can't see, and one it can only read.
  // "frozen" is read_only=1 but the access function says write: must be treated as read.
  for (const id of ["secret", "ro", "frozen"]) {
    await store.createRepo(id, { branch: "main" });
    await store.commit({ repo: id, branch: "main", expectedHead: null, changes: [{ path: "a.md", content: "# A\n" }], message: "seed", author: alice });
    db.query("INSERT INTO repos (id, title, kind, branch, status, read_only, created_at) VALUES (?, ?, 'notes', 'main', 'ready', ?, ?)").run(id, id, id === "frozen" ? 1 : 0, Date.now());
  }
});

describe("protocol", () => {
  test("initialize negotiates the protocol version", async () => {
    const { result } = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(result.protocolVersion).toBe("2025-03-26");
    expect(result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(result.serverInfo).toEqual({ name: "notepad", version: "0.1.0" });
    expect(result.instructions).toContain("edit_file");
    const other = await rpc("initialize", { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(other.result.protocolVersion).toBe("2025-06-18");
    expect((await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } })).result.protocolVersion).toBe("2025-11-25");
    // An unknown version header doesn't block initialize, but does block later requests.
    const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2099-01-01" } }, { "mcp-protocol-version": "2099-01-01" });
    expect(init.status).toBe(200);
    expect(((await init.json()) as any).result.protocolVersion).toBe("2025-06-18");
    expect((await post({ jsonrpc: "2.0", id: 2, method: "ping" }, { "mcp-protocol-version": "2099-01-01" })).status).toBe(400);
    expect((await post({ jsonrpc: "2.0", id: 3, method: "ping" }, { "mcp-protocol-version": "2025-11-25" })).status).toBe(200);
  });

  test("notification → 202 with empty body", async () => {
    const res = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  test("ping, unknown method, parse error, GET/DELETE", async () => {
    expect((await rpc("ping")).result).toEqual({});
    expect((await rpc("nope/nope")).error?.code).toBe(-32601);
    const bad = await post("{not json");
    expect(((await bad.json()) as any).error.code).toBe(-32700);
    for (const method of ["GET", "DELETE"]) {
      const res = await handleMcp(new Request("http://localhost/mcp", { method }), ctx, bot, access);
      expect(res.status).toBe(405);
    }
  });

  test("batch", async () => {
    const res = await post([
      { jsonrpc: "2.0", id: "a", method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: "b", method: "tools/list" },
      { jsonrpc: "2.0", id: "c", method: "bogus" },
    ]);
    expect(res.status).toBe(200);
    const out = (await res.json()) as any[];
    expect(out.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(out[1].result.tools.length).toBeGreaterThan(0);
    expect(out[2].error.code).toBe(-32601);
    const onlyNotes = await post([{ jsonrpc: "2.0", method: "notifications/initialized" }]);
    expect(onlyNotes.status).toBe(202);
  });

  test("tools/list", async () => {
    const { result } = await rpc("tools/list");
    const names = result.tools.map((t: any) => t.name);
    expect(names).toEqual([
      "list_repos",
      "list_files",
      "read_file",
      "search",
      "create_file",
      "write_file",
      "edit_file",
      "append_file",
      "delete_file",
      "rename_file",
      "file_history",
      "diff",
      "save",
      "who_is_here",
      "wait_for_change",
    ]);
    for (const t of result.tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(typeof t.description).toBe("string");
      expect(t.annotations).toBeDefined();
    }
    const edit = result.tools.find((t: any) => t.name === "edit_file");
    expect(edit.inputSchema.required).toEqual(["repo", "path", "old_text", "new_text"]);
    expect(result.tools.find((t: any) => t.name === "read_file").annotations.readOnlyHint).toBe(true);
    expect(result.tools.find((t: any) => t.name === "delete_file").annotations.destructiveHint).toBe(true);
  });

  test("unknown tool and bad arguments → isError", async () => {
    const r = await call("does_not_exist");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("unknown tool");
    const missing = await call("read_file", { repo: "notes" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("path");
    const notObject = (await rpc("tools/call", { name: "list_repos", arguments: [1] })).result;
    expect(notObject.isError).toBe(true);
    expect(notObject.content[0].text).toContain("object");
  });
});

describe("tools", () => {
  test("list_repos hides repos without access", async () => {
    const list = await callJson("list_repos");
    const ids = list.map((r: any) => r.id);
    expect(ids).toContain("notes");
    expect(ids).toContain("ro");
    expect(ids).not.toContain("secret");
    expect(list.find((r: any) => r.id === "ro").access).toBe("read");
    expect(list.find((r: any) => r.id === "frozen").access).toBe("read");
    for (const [name, args] of [
      ["save", { repo: "frozen", path: "a.md" }],
      ["append_file", { repo: "frozen", path: "a.md", text: "x" }],
    ] as const) {
      const res = await call(name, args);
      expect(res.isError).toBe(true);
      expect(res.text).toContain("read-only");
    }
    const hidden = await call("read_file", { repo: "secret", path: "a.md" });
    expect(hidden.isError).toBe(true);
    const ro = await call("append_file", { repo: "ro", path: "a.md", text: "x" });
    expect(ro.isError).toBe(true);
    expect(ro.text).toContain("read-only");
    expect((await call("read_file", { repo: "ro", path: "a.md" })).isError).toBe(false);
  });

  test("list_files, read_file", async () => {
    expect(await callJson("list_files", { repo: "notes" })).toEqual(["Welcome.md"]);
    const r = parseRead((await call("read_file", { repo: "notes", path: "Welcome" })).text);
    expect(r.header.path).toBe("Welcome.md");
    expect(r.header.live).toBe(false);
    expect(r.header.version).toBe(ops.version(r.content));
    expect(r.content).toStartWith("# Welcome to Notepad");
    expect((await call("read_file", { repo: "notes", path: "missing.md" })).isError).toBe(true);
  });

  test("create, edit, write, append", async () => {
    const created = await callJson("create_file", { repo: "notes", path: "plan", content: "# Plan\n\n- one\n- two\n- two\n" });
    expect(created.path).toBe("plan.md");
    expect((await call("create_file", { repo: "notes", path: "plan.md", content: "x" })).isError).toBe(true);
    expect(await callJson("list_files", { repo: "notes" })).toContain("plan.md");

    const ok = await callJson("edit_file", { repo: "notes", path: "plan.md", old_text: "- one", new_text: "- uno" });
    expect(ok.version).toHaveLength(16);
    const amb = await call("edit_file", { repo: "notes", path: "plan.md", old_text: "- two", new_text: "- dos" });
    expect(amb.isError).toBe(true);
    expect(amb.text).toContain("more than once");
    const nf = await call("edit_file", { repo: "notes", path: "plan.md", old_text: "- three", new_text: "x" });
    expect(nf.isError).toBe(true);
    expect(nf.text).toContain("not found");

    const read = parseRead((await call("read_file", { repo: "notes", path: "plan.md" })).text);
    expect(read.header.live).toBe(true);
    expect(read.content).toBe("# Plan\n\n- uno\n- two\n- two\n");
    expect(read.header.version).toBe(ok.version);

    // Someone else edits; the stale version must be rejected.
    const room = rooms.peek("notes", "plan.md")!;
    room.agentEdit(alice, (t) => t.insert(0, "<!-- hi -->\n"));
    const stale = await call("write_file", { repo: "notes", path: "plan.md", content: "clobber", expected_version: read.header.version });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain("expected_version");
    expect(room.text.toString()).toStartWith("<!-- hi -->");

    const fresh = parseRead((await call("read_file", { repo: "notes", path: "plan.md" })).text);
    const w = await callJson("write_file", { repo: "notes", path: "plan.md", content: "# Plan\n\n- uno\n", expected_version: fresh.header.version });
    expect(w.version).toBe(ops.version("# Plan\n\n- uno\n"));

    await callJson("append_file", { repo: "notes", path: "plan.md", text: "- tres\n" });
    expect(room.text.toString()).toBe("# Plan\n\n- uno\n- tres\n");
  });

  test("save, then file_history shows the agent as author; diff", async () => {
    const saved = await callJson("save", { repo: "notes", path: "plan.md" });
    expect(saved.saved).toBe(true);
    expect(saved.commit).toBeTruthy();
    const hist = await callJson("file_history", { repo: "notes", path: "plan.md", limit: 5 });
    expect(hist[0].authorName).toBe("Robo");
    expect(hist[0].authorEmail).toBe("robo@agents.notepad");
    const d = await call("diff", { repo: "notes", sha: hist[0].sha, path: "plan.md" });
    expect(d.isError).toBe(false);
    expect(d.text).toContain("+- tres");
    expect(await callJson("save", { repo: "notes", path: "plan.md" })).toEqual({ path: "plan.md", saved: false, commit: saved.commit });
    expect(await callJson("save", { repo: "notes", path: "Welcome.md" })).toEqual({ path: "Welcome.md", saved: false, commit: null });
  });

  test("search, who_is_here", async () => {
    const hits = await callJson("search", { repo: "notes", query: "tres" });
    expect(hits.some((h: any) => h.path === "plan.md")).toBe(true);
    const here = await callJson("who_is_here", { repo: "notes", path: "plan.md" });
    expect(here.some((p: any) => p.name === "Robo")).toBe(true);
    expect(await callJson("who_is_here", { repo: "notes", path: "nobody.md" })).toEqual([]);
  });

  test("rename and delete", async () => {
    expect((await callJson("rename_file", { repo: "notes", from: "plan.md", to: "archive/plan.md" })).path).toBe("archive/plan.md");
    let files = await callJson("list_files", { repo: "notes" });
    expect(files).toContain("archive/plan.md");
    expect(files).not.toContain("plan.md");
    expect(parseRead((await call("read_file", { repo: "notes", path: "archive/plan.md" })).text).content).toBe("# Plan\n\n- uno\n- tres\n");

    expect(await callJson("delete_file", { repo: "notes", path: "archive/plan.md" })).toEqual({ ok: true });
    files = await callJson("list_files", { repo: "notes" });
    expect(files).not.toContain("archive/plan.md");
    expect((await call("delete_file", { repo: "notes", path: "archive/plan.md" })).isError).toBe(true);
  });

  test("wait_for_change", async () => {
    const { version: v } = await callJson("create_file", { repo: "notes", path: "watch.md", content: "start\n" });
    expect(v).toBe(ops.version("start\n"));

    // Times out with no change.
    const t0 = Date.now();
    expect(await callJson("wait_for_change", { repo: "notes", path: "watch.md", since_version: v, timeout_seconds: 0 })).toEqual({ changed: false, version: v });
    expect(Date.now() - t0).toBeLessThan(1000);

    // Resolves when someone else edits.
    const waiting = callJson("wait_for_change", { repo: "notes", path: "watch.md", since_version: v, timeout_seconds: 10 });
    await Bun.sleep(30);
    const room = await rooms.get("notes", "watch.md", "main");
    room.agentEdit(alice, (t) => t.insert(t.length, "more\n"));
    const res = await waiting;
    expect(res.changed).toBe(true);
    expect(res.version).toBe(ops.version("start\nmore\n"));

    // Already changed since the given version: returns immediately.
    const t1 = Date.now();
    expect((await callJson("wait_for_change", { repo: "notes", path: "watch.md", since_version: v, timeout_seconds: 60 })).changed).toBe(true);
    expect(Date.now() - t1).toBeLessThan(1000);

    // Repo-wide wait.
    const repoWait = callJson("wait_for_change", { repo: "notes", timeout_seconds: 10 });
    await Bun.sleep(10);
    room.agentEdit(alice, (t) => t.insert(0, "x"));
    expect(await repoWait).toEqual({ changed: true });

    expect((await call("wait_for_change", { repo: "notes", timeout_seconds: 111 })).isError).toBe(true);
    const noPath = await call("wait_for_change", { repo: "notes", since_version: v, timeout_seconds: 0 });
    expect(noPath.isError).toBe(true);
    expect(noPath.text).toContain("requires path");

    // A disconnected client ends the wait.
    const ac = new AbortController();
    const t2 = Date.now();
    const aborted = post({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "wait_for_change", arguments: { repo: "notes", timeout_seconds: 60 } } }, {}, ac.signal);
    await Bun.sleep(10);
    ac.abort();
    const body = (await (await aborted).json()) as any;
    expect(JSON.parse(body.result.content[0].text)).toEqual({ changed: false });
    expect(Date.now() - t2).toBeLessThan(1000);
  });
});
