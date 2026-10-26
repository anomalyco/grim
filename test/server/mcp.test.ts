import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

// One directory of our own inside the preload's DATA_DIR (shared by every file in the test process).
const dir = mkdtempSync(join(process.env.DATA_DIR!, "mcp-"));
process.env.QUIET_MS = "50";

const { LocalGitStore } = await import("../../src/server/store/localgit.ts");
const { RoomManager } = await import("../../src/server/rooms.ts");
const { RepoService } = await import("../../src/server/repos.ts");
const { db } = await import("../../src/server/db.ts");
const { McpServer, formatResult } = await import("../../src/server/mcp.ts");
const { ShellSessions } = await import("../../src/server/shell/session.ts");

const store = new LocalGitStore(join(dir, "git"));
const rooms = new RoomManager(store);
const repos = new RepoService(store, rooms);
const ctx = { store, rooms, repos };
const shells = new ShellSessions(ctx);
const mcp = new McpServer(shells);

const bot = { id: "agent1", name: "Robo", email: "robo@agents.grimoire", kind: "agent" as const, color: "#0f0" };
const other = { id: "agent2", name: "Other", email: "other@agents.grimoire", kind: "agent" as const, color: "#00f" };
const alice = { id: "u1", name: "Alice", email: "alice@example.com", kind: "human" as const, color: "#f00" };

type AccessLevel = "write" | "read" | "none";
const accessMap: Record<string, AccessLevel> = { notes: "write", secret: "none", ro: "read", frozen: "write" };
const access = async (r: { id: string }) => accessMap[r.id] ?? "none";

let nextId = 1;
let sid: string | null = null;

async function post(body: unknown, headers: Record<string, string> = {}, opts: { signal?: AbortSignal; actor?: typeof bot } = {}) {
  const req = new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal: opts.signal,
  });
  return mcp.handle(req, opts.actor ?? bot, access);
}

async function rpc(method: string, params?: unknown, session: string | null = sid) {
  const id = nextId++;
  const res = await post({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }, session ? { "mcp-session-id": session } : {});
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/json");
  const body = (await res.json()) as { id: number; result?: any; error?: { code: number; message: string } };
  expect(body.id).toBe(id);
  return body;
}

async function initialize(actor = bot): Promise<string> {
  const res = await post({ jsonrpc: "2.0", id: nextId++, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }, {}, { actor });
  expect(res.status).toBe(200);
  const id = res.headers.get("mcp-session-id");
  expect(id).toMatch(/^[\x21-\x7e]+$/);
  return id!;
}

async function call(args: Record<string, unknown>, session: string | null = sid, name = "document_command") {
  const { result } = await rpc("tools/call", { name, arguments: args }, session);
  return { text: result.content[0].text as string, isError: !!result.isError };
}

const bash = async (command: string, session: string | null = sid) => (await call({ command }, session)).text;

beforeAll(async () => {
  await repos.ensureNotesRepo();
  // A repo the agent can't see, and one it can only read.
  // "frozen" is read_only=1 but the access function says write: must be treated as read.
  for (const id of ["secret", "ro", "frozen"]) {
    await store.createRepo(id, { branch: "main" });
    await store.commit({ repo: id, branch: "main", expectedHead: null, changes: [{ path: "a.md", content: "# A\n" }], message: "seed", author: alice });
    db.query("INSERT INTO repos (id, title, kind, branch, status, read_only, created_at) VALUES (?, ?, 'notes', 'main', 'ready', ?, ?)").run(id, id, id === "frozen" ? 1 : 0, Date.now());
  }
  sid = await initialize();
});

afterAll(() => shells.stop());

describe("protocol", () => {
  test("initialize negotiates the protocol version and assigns a session", async () => {
    const { result } = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } }, null);
    expect(result.protocolVersion).toBe("2025-03-26");
    expect(result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(result.serverInfo.name).toBe("grimoire");
    for (const s of ["/workspace", "/tmp", "3 s", "save", "who", "watch", "repos", "git log", "python"]) expect(result.instructions).toContain(s);
    const other = await rpc("initialize", { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "t", version: "1" } }, null);
    expect(other.result.protocolVersion).toBe("2025-06-18");
    // An unknown version header doesn't block initialize, but does block later requests.
    const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2099-01-01" } }, { "mcp-protocol-version": "2099-01-01" });
    expect(init.status).toBe(200);
    expect(init.headers.get("mcp-session-id")).toBeTruthy();
    expect(((await init.json()) as any).result.protocolVersion).toBe("2025-06-18");
    expect((await post({ jsonrpc: "2.0", id: 2, method: "ping" }, { "mcp-protocol-version": "2099-01-01" })).status).toBe(400);
    expect((await post({ jsonrpc: "2.0", id: 3, method: "ping" }, { "mcp-protocol-version": "2025-11-25" })).status).toBe(200);
    // Each initialize gets a new session id.
    expect(await initialize()).not.toBe(sid);
  });

  test("notification → 202 with empty body", async () => {
    const res = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": sid! });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  test("ping, unknown method, parse error, GET", async () => {
    expect((await rpc("ping")).result).toEqual({});
    expect((await rpc("nope/nope")).error?.code).toBe(-32601);
    const bad = await post("{not json");
    expect(((await bad.json()) as any).error.code).toBe(-32700);
    const get = await mcp.handle(new Request("http://localhost/mcp", { method: "GET" }), bot, access);
    expect(get.status).toBe(405);
  });

  test("unknown session → 404; another actor's session → 404", async () => {
    const res = await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { "mcp-session-id": "no-such-session" });
    expect(res.status).toBe(404);
    const theirs = await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { "mcp-session-id": sid! }, { actor: other });
    expect(theirs.status).toBe(404);
  });

  test("DELETE ends the session", async () => {
    const s = await initialize();
    expect(await bash("cd notes && pwd", s)).toBe("/workspace/notes\n");
    const del = (id: string | null, actor = bot) =>
      mcp.handle(new Request("http://localhost/mcp", { method: "DELETE", headers: id ? { "mcp-session-id": id } : {} }), actor, access);
    expect((await del(null)).status).toBe(400);
    expect((await del(s, other)).status).toBe(404);
    expect((await del(s)).status).toBe(204);
    expect((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { "mcp-session-id": s })).status).toBe(404);
    expect((await del(s)).status).toBe(404);
  });

  test("idle sessions expire", async () => {
    const quickShells = new ShellSessions(ctx, { idleMs: 50 });
    const quick = new McpServer(quickShells);
    const res = await quick.handle(
      new Request("http://localhost/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) }),
      bot,
      access,
    );
    const s = res.headers.get("mcp-session-id")!;
    await Bun.sleep(80);
    const later = await quick.handle(new Request("http://localhost/mcp", { method: "POST", headers: { "mcp-session-id": s }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }) }), bot, access);
    expect(later.status).toBe(404);
    quickShells.stop();
  });

  test("sessions live in the shell sessions: eviction → 404; requests keep a session alive", async () => {
    const few = new ShellSessions(ctx, { maxSessionsPerActor: 1, idleMs: 150 });
    const m = new McpServer(few);
    const req = (body: unknown, sid?: string) =>
      m.handle(new Request("http://localhost/mcp", { method: "POST", headers: sid ? { "mcp-session-id": sid } : {}, body: JSON.stringify(body) }), bot, access);
    const init = async () => (await req({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).headers.get("mcp-session-id")!;
    try {
      const a = await init();
      for (let i = 0; i < 3; i++) {
        await Bun.sleep(80);
        expect((await req({ jsonrpc: "2.0", id: 2, method: "ping" }, a)).status).toBe(200);
      }
      const b = await init();
      expect((await req({ jsonrpc: "2.0", id: 3, method: "ping" }, a)).status).toBe(404);
      expect((await req({ jsonrpc: "2.0", id: 4, method: "ping" }, b)).status).toBe(200);
      // Only a single, valid initialize request creates a session.
      for (const bad of [{ jsonrpc: "2.0", method: "initialize", params: {} }, { jsonrpc: "1.0", id: 5, method: "initialize" }]) {
        expect((await req(bad)).headers.get("mcp-session-id")).toBeNull();
      }
    } finally {
      few.stop();
    }
  });

  test("batch limits: no initialize, at most 32 messages", async () => {
    const withInit = await post([{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { jsonrpc: "2.0", id: 2, method: "ping" }]);
    expect(withInit.status).toBe(400);
    expect(withInit.headers.get("mcp-session-id")).toBeNull();
    const many = Array.from({ length: 33 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "ping" }));
    expect((await post(many, { "mcp-session-id": sid! })).status).toBe(400);
    expect((await post(many.slice(0, 32), { "mcp-session-id": sid! })).status).toBe(200);
  });

  test("batch", async () => {
    const res = await post(
      [
        { jsonrpc: "2.0", id: "a", method: "ping" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: "b", method: "tools/list" },
        { jsonrpc: "2.0", id: "c", method: "bogus" },
      ],
      { "mcp-session-id": sid! },
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as any[];
    expect(out.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(out[1].result.tools.length).toBe(1);
    expect(out[2].error.code).toBe(-32601);
    const onlyNotes = await post([{ jsonrpc: "2.0", method: "notifications/initialized" }]);
    expect(onlyNotes.status).toBe(202);
  });

  test("tools/list has only bash", async () => {
    const { result } = await rpc("tools/list");
    expect(result.tools.map((t: any) => t.name)).toEqual(["document_command"]);
    const t = result.tools[0];
    expect(t.inputSchema.required).toEqual(["command"]);
    expect(Object.keys(t.inputSchema.properties)).toEqual(["command", "timeout_seconds"]);
    expect(t.inputSchema.properties.timeout_seconds.maximum).toBe(110);
    for (const s of ["/workspace", "/tmp", "grep -rn", "sed -i", "<<'EOF'", "find", "save", "watch", "python"]) expect(t.description).toContain(s);
  });

  test("unknown tool and bad arguments → isError", async () => {
    const r = await call({ command: "ls" }, sid, "read_file");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("unknown tool");
    expect((await call({})).isError).toBe(true);
    expect((await call({ command: "" })).isError).toBe(true);
    expect((await call({ command: "ls", extra: 1 })).isError).toBe(true);
    const notObject = (await rpc("tools/call", { name: "document_command", arguments: [1] })).result;
    expect(notObject.isError).toBe(true);
    expect(notObject.content[0].text).toContain("object");
  });
});

describe("document_command tool", () => {
  test("runs commands over the notes", async () => {
    expect(await bash("pwd")).toBe("/workspace\n");
    const ls = await bash("ls /workspace");
    expect(ls).toContain("notes\n");
    expect(ls).toContain("ro\n");
    expect(ls).not.toContain("secret");
    expect(await bash("head -1 notes/Welcome.md")).toStartWith("# Welcome to Grimoire");
    expect(await bash("true")).toBe("(no output)");
  });

  test("output format: stderr and non-zero exit codes are appended, not errors", async () => {
    const r = await call({ command: "echo out; echo oops >&2; exit 3" });
    expect(r.isError).toBe(false);
    expect(r.text).toBe("out\n[stderr]\noops\n[exit 3]");
    expect(await bash("cat notes/missing.md")).toMatch(/^\[stderr\]\n.*missing\.md.*\n\[exit 1\]$/s);
    expect(await bash("printf abc")).toBe("abc");
    expect(formatResult({ stdout: "abc", stderr: "", exitCode: 2 })).toBe("abc\n[exit 2]");
    expect(formatResult({ stdout: "", stderr: "", exitCode: 1 })).toBe("[exit 1]");
  });

  test("cd persists within a session, but not across sessions", async () => {
    await bash("cd /workspace/notes && export X=1");
    expect(await bash("pwd; echo $X")).toBe("/workspace/notes\n1\n");
    const s2 = await initialize();
    expect(await bash("pwd; echo \"[$X]\"", s2)).toBe("/workspace\n[]\n");
    // Without a session header, an actor has one default shell of its own.
    await bash("cd /workspace/ro", null);
    expect(await bash("pwd", null)).toBe("/workspace/ro\n");
    expect(await bash("pwd")).toBe("/workspace/notes\n");
    await bash("cd /workspace");
  });

  test("an edit is live and attributed to the agent", async () => {
    expect(await bash("echo 'Agent note appended.' >> /workspace/notes/Welcome.md")).toBe("(no output)");
    const room = rooms.peek("notes", "Welcome.md")!;
    expect(room.text.toString()).toEndWith("Agent note appended.\n");
    expect(room.participants().some((p) => p.name === "Robo")).toBe(true);
    expect(await bash("save notes/Welcome.md")).toMatch(/^saved notes\/Welcome\.md/);
    const hist = await bash("git log -n 1 notes/Welcome.md");
    expect(hist).toContain("Author: Robo <robo@agents.grimoire>");
  });

  test("read-only repos can be read but not written", async () => {
    expect(await bash("cat /workspace/frozen/a.md")).toBe("# A\n");
    for (const c of ["echo x >> /workspace/frozen/a.md", "echo x >> /workspace/ro/a.md"]) {
      const r = await call({ command: c });
      expect(r.isError).toBe(false);
      expect(r.text).toContain("read-only");
      expect(r.text).toMatch(/\[exit [1-9]\d*\]$/);
    }
    expect(rooms.peek("ro", "a.md")).toBeUndefined();
    expect(await bash("cat /workspace/secret/a.md")).toContain("[exit 1]");
  });

  test("timeout_seconds: stops the command; capped at 110", async () => {
    const t0 = Date.now();
    const r = await call({ command: "echo start; sleep 10; echo never", timeout_seconds: 1 });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.isError).toBe(false);
    expect(r.text).not.toContain("never");
    expect(r.text).toContain("timed out after 1 s");
    expect(r.text).toEndWith("[exit 124]");
    for (const timeout_seconds of [111, 0, "5"]) {
      const bad = await call({ command: "true", timeout_seconds });
      expect(bad.isError).toBe(true);
      expect(bad.text).toContain("timeout_seconds");
    }
    expect((await call({ command: "echo ok", timeout_seconds: 110 })).text).toBe("ok\n");
  });

  test("a disconnected client stops the command", async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    const pending = post({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "document_command", arguments: { command: "watch /workspace/notes --timeout 60" } } }, { "mcp-session-id": sid! }, { signal: ac.signal });
    await Bun.sleep(50);
    ac.abort();
    await pending;
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
