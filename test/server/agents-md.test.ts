// The workspace root's AGENTS.md: GET of the workspace URL always ends with it; POST and MCP command/changes show it
// once per agent session (session_id, else the MCP connection, else address plus agent name) and again when it changes;
// workspace_info and list_workspaces report it. Only "AGENTS.md" exactly, at the root, counts (as in OpenCode).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { isolate, seedNotebook } from "./helpers.ts";

process.env.POLL_MS = "60000";
const { config } = await import("../../src/server/config.ts");
const { db } = await import("../../src/server/db.ts");
const restore = isolate(config, db);
Object.assign(config, { storage: "local", allowDevLogin: true, signIn: false, signInSetting: "", quietMs: 100 });
const { startServer } = await import("../../src/server/index.ts");
const { AGENTS_MD_TRUNCATED, MAX_AGENTS_MD_BYTES } = await import("../../src/server/agents-md.ts");

let app: Awaited<ReturnType<typeof startServer>>;
let base = "";
const WS = "agents-md-notes";
const START = "[Workspace instructions (AGENTS.md), shown once per session and again if it changes]";

beforeAll(async () => {
  app = await startServer({ port: 0, quiet: true });
  await seedNotebook(app.ctx, WS);
  base = `http://localhost:${app.server.port}`;
});

afterAll(async () => {
  await app?.stop();
  restore();
});

async function post(body: Record<string, unknown>, opts: { name?: string; text?: boolean } = {}) {
  const res = await fetch(`${base}/app/${WS}${opts.text ? "?format=text" : ""}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agent-name": opts.name ?? "Tester" },
    body: JSON.stringify(body),
  });
  return opts.text ? res.text() : (res.json() as Promise<any>);
}

const get = () => fetch(`${base}/app/${WS}`, { headers: { accept: "text/plain" } }).then((r) => r.text());

/** Write the file through the shell and wait until it's committed (what agents are shown). */
async function write(path: string, content: string) {
  const out = await post({ command: `cat > '${path}' <<'EOF'\n${content}\nEOF`, session_id: "writer" });
  expect(out.exitCode).toBe(0);
}

async function rm(path: string) {
  expect((await post({ command: `rm -f '${path}'`, session_id: "writer" })).exitCode).toBe(0);
}

let mcpId = "";
async function mcp(body: Record<string, unknown>, sid = mcpId) {
  const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", ...(sid ? { "mcp-session-id": sid } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }) });
  return { id: res.headers.get("mcp-session-id"), body: (await res.json()) as any };
}
const tool = async (name: string, args: Record<string, unknown>, sid = mcpId) => (await mcp({ method: "tools/call", params: { name, arguments: args } }, sid)).body.result;

describe("AGENTS.md", () => {
  test("(a) none: nothing added anywhere", async () => {
    const out = await post({ command: "echo hi", session_id: "ses_a" });
    expect(out).toEqual({ stdout: "hi\n", stderr: "", exitCode: 0, cwd: `/workspace/${WS}`, truncated: false });
    expect(await get()).not.toContain("AGENTS.md)");
  });

  test("(h) only AGENTS.md exactly, at the root", async () => {
    await write("agents.md", "lowercase rules");
    await write("Agents.md", "mixed case rules");
    await write("work/AGENTS.md", "subfolder rules");
    const out = await post({ command: "echo hi", session_id: "ses_h" });
    expect(out.agents_md).toBeUndefined();
    expect(out.stdout).toBe("hi\n");
    expect(await get()).not.toContain("## This workspace's instructions");
    await rm("agents.md");
    await rm("Agents.md");
    await rm("work/AGENTS.md");
  });

  test("(b) GET shows it every time; (c) a session's first POST shows it, its second doesn't; (d) another session_id sees it", async () => {
    await write("AGENTS.md", "# Rules\nBe nice.");
    for (let i = 0; i < 2; i++) expect(await get()).toEndWith("## This workspace's instructions (AGENTS.md)\n\n# Rules\nBe nice.\n");
    const first = await post({ command: "echo hi", session_id: "ses_c" });
    expect(first.agents_md).toBe("# Rules\nBe nice.");
    expect(first.stdout).toBe(`${START}\n# Rules\nBe nice.\n[end of AGENTS.md]\n\nhi\n`);
    const second = await post({ command: "echo hi", session_id: "ses_c" });
    expect(second.agents_md).toBeUndefined();
    expect(second.stdout).toBe("hi\n");
    // GET doesn't mark it seen, and ?format=text puts it before the output
    expect(await post({ command: "echo hi", session_id: "ses_d" }, { text: true })).toBe(`${START}\n# Rules\nBe nice.\n[end of AGENTS.md]\n\nhi\n`);
    expect(await post({ command: "echo hi", session_id: "ses_d" }, { text: true })).toBe("hi\n");
  });

  test("(e) after an edit the original session sees it once more", async () => {
    await write("AGENTS.md", "# Rules\nBe kind.");
    const again = await post({ command: "echo hi", session_id: "ses_c" });
    expect(again.agents_md).toBe("# Rules\nBe kind.");
    expect((await post({ command: "echo hi", session_id: "ses_c" })).agents_md).toBeUndefined();
  });

  test("(j) without a session_id: address plus agent name", async () => {
    expect((await post({ command: "true" }, { name: "Curly" })).agents_md).toBe("# Rules\nBe kind.");
    expect((await post({ command: "true" }, { name: "Curly" })).agents_md).toBeUndefined();
    expect((await post({ command: "true" }, { name: "Other" })).agents_md).toBe("# Rules\nBe kind.");
  });

  test("(f) MCP: the first command shows it, the second doesn't, an edit shows it again; (j) keyed by connection without session_id", async () => {
    const init = await mcp({ method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "test" } } }, "");
    mcpId = init.id!;
    expect(init.body.result.instructions).toContain("Each workspace may have an AGENTS.md");
    const first = await tool("command", { workspace: WS, command: "echo hi" });
    expect(first.content[0].text).toBe(`${START}\n# Rules\nBe kind.\n[end of AGENTS.md]\n\nhi\n`);
    expect((await tool("command", { workspace: WS, command: "echo hi" })).content[0].text).toBe("hi\n");
    expect((await tool("changes", { workspace: WS })).content[0].text).not.toContain(START);
    // with a session_id: that session's
    expect((await tool("command", { workspace: WS, command: "echo hi", session_id: "ses_f" })).content[0].text).toContain(START);
    expect((await tool("command", { workspace: WS, command: "echo hi", session_id: "ses_f" })).content[0].text).toBe("hi\n");
    await write("AGENTS.md", "# Rules\nBe brief.");
    expect((await tool("changes", { workspace: WS })).content[0].text).toStartWith(`${START}\n# Rules\nBe brief.\n`);
    expect((await tool("command", { workspace: WS, command: "echo hi" })).content[0].text).toBe("hi\n");
    // a new connection is a new session
    const other = (await mcp({ method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "test2" } } }, "")).id!;
    expect((await tool("command", { workspace: WS, command: "echo hi" }, other)).content[0].text).toContain(START);
  });

  test("(g) workspace_info returns it (and doesn't mark it seen); list_workspaces says has_agents_md", async () => {
    const info = await tool("workspace_info", { workspace: WS });
    expect(info.structuredContent).toMatchObject({ id: WS, access: "write", kind: "notes", agents_md: "# Rules\nBe brief." });
    expect(info.content[0].text).toContain("## AGENTS.md\n\n# Rules\nBe brief.");
    const list = await tool("list_workspaces", {});
    expect(list.structuredContent.workspaces.find((w: any) => w.id === WS).has_agents_md).toBe(true);
    expect((await tool("command", { workspace: WS, command: "true", session_id: "ses_g" })).content[0].text).toContain(START);
  });

  test("(i) over 8 KB: cut, with a note to read the rest", async () => {
    const line = "x".repeat(99);
    await write("AGENTS.md", Array.from({ length: 200 }, (_, i) => `${i} ${line}`).join("\n"));
    const out = await post({ command: "true", session_id: "ses_i" });
    expect(new TextEncoder().encode(out.agents_md).length).toBeLessThanOrEqual(MAX_AGENTS_MD_BYTES);
    expect(out.agents_md).toEndWith(`\n\n${AGENTS_MD_TRUNCATED}`);
    expect(out.agents_md).toStartWith(`0 ${line}\n1 ${line}`);
    await rm("AGENTS.md");
    const info = await tool("workspace_info", { workspace: WS });
    expect(info.structuredContent.agents_md).toBeNull();
    expect(info.content[0].text).toContain("No AGENTS.md.");
  });
});
