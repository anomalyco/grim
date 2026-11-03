// "Read the latest instructions before writing" (server/instructions.ts): an agent session's writes are refused until
// it has read the workspace's current AGENTS.md and, for a note it changes, the note's current ```instructions block;
// reads count from the next command; people are never checked. Plus the block's parser (shared/instructions.ts).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { isolate, seedNotebook } from "./helpers.ts";
import { instructionsBlockOf, instructionsOf } from "../../src/shared/instructions.ts";

process.env.POLL_MS = "60000";
const { config } = await import("../../src/server/config.ts");
const { db } = await import("../../src/server/db.ts");
const restore = isolate(config, db);
Object.assign(config, { storage: "local", allowDevLogin: true, signIn: false, signInSetting: "", quietMs: 100 });
const { startServer } = await import("../../src/server/index.ts");

let app: Awaited<ReturnType<typeof startServer>>;
let base = "";
const WS = "instructions-notes";
const NOTE_RULE = (p: string) => `${p} has instructions you haven't read (or they changed since you read it). Run: instructions ${p} — then redo your edit.`;
const MD_CHANGED = "This workspace's AGENTS.md changed since you read it. Run: instructions — then redo your command.";

beforeAll(async () => {
  app = await startServer({ port: 0, quiet: true });
  await seedNotebook(app.ctx, WS);
  base = `http://localhost:${app.server.port}`;
});

afterAll(async () => {
  await app?.stop();
  restore();
});

async function run(session: string, command: string) {
  const res = await fetch(`${base}/app/${WS}`, { method: "POST", headers: { "content-type": "application/json", "x-agent-name": "Tester" }, body: JSON.stringify({ command, session_id: session }) });
  return (await res.json()) as { stdout: string; stderr: string; exitCode: number; agents_md?: string };
}

/** A person's change (the API the apps use): never checked. */
async function human(method: string, sub: string, body?: unknown) {
  const res = await fetch(`${base}/api/workspace/${WS}/${sub}`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  expect(res.status).toBeLessThan(300);
  return res.json() as Promise<any>;
}

async function setNote(path: string, content: string) {
  await fetch(`${base}/api/workspace/${WS}/files?path=${encodeURIComponent(path)}`, { method: "DELETE" });
  await human("POST", "files", { path, content });
  await Bun.sleep(300);
}

const text = (path: string) => fetch(`${base}/api/workspace/${WS}/file?path=${encodeURIComponent(path)}`).then(async (r) => ((await r.json()) as { content: string }).content);

describe("the instructions block", () => {
  test("first fenced block with language instructions (or instruction), at the top", () => {
    expect(instructionsOf("```instructions\nbe nice\n```\nrest")).toBe("be nice");
    expect(instructionsOf("\n\n# Title\n\n~~~~Instruction\na\n\nb\n~~~~\n")).toBe("a\n\nb");
    expect(instructionsOf("---\ntags: x\n---\n# T\n```instructions\nfm\n```")).toBe("fm");
    expect(instructionsOf("```instructions\nunclosed\nto the end")).toBe("unclosed\nto the end");
    // anything else before it, another language, a later one: none
    expect(instructionsOf("# T\nintro\n```instructions\nx\n```")).toBeNull();
    expect(instructionsOf("# T\n## Sub\n```instructions\nx\n```")).toBeNull();
    expect(instructionsOf("```ts\nx\n```\n```instructions\ny\n```")).toBeNull();
    expect(instructionsOf("```instructionsx\ny\n```")).toBeNull();
    expect(instructionsBlockOf(["# T", "", "```instructions", "a", "```", "b"])).toEqual({ open: 2, close: 4, body: "a" });
  });
});

describe("writes need the latest instructions", () => {
  test("(a) no AGENTS.md, no block: writes work", async () => {
    const out = await run("ses_a", "echo '# A' > a.md && echo b >> a.md && sed -i s/b/c/ a.md && mv a.md a2.md && rm a2.md");
    expect(out.exitCode).toBe(0);
  });

  test("(b) a note's block: refused until read (a read counts from the next command), then works", async () => {
    await setNote("plan.md", "# Plan\n\n```instructions\nOnly append.\n```\n\nlog:\n");
    let out = await run("ses_b", "echo one >> plan.md");
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(NOTE_RULE("plan.md"));
    out = await run("ses_b", "cat plan.md >/dev/null; echo one >> plan.md");
    expect(out.stderr).toContain(NOTE_RULE("plan.md"));
    expect(await text("plan.md")).not.toContain("one");
    expect((await run("ses_b", "echo one >> plan.md")).exitCode).toBe(0);
    expect(await text("plan.md")).toEndWith("log:\none\n");
  });

  test("(b) the instructions built-in prints just the block (labelled per file) and counts as reading it", async () => {
    expect((await run("ses_b2", "echo two >> plan.md")).stderr).toContain(NOTE_RULE("plan.md"));
    const out = await run("ses_b2", "instructions plan.md README.md");
    expect(out.stdout).toBe("[instructions in plan.md]\nOnly append.\n[end of instructions in plan.md]\n\nREADME.md has no instructions.\n");
    expect((await run("ses_b2", "echo two >> plan.md")).exitCode).toBe(0);
    const missing = await run("ses_b2", "instructions nope.md");
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("nope.md: no such file");
    expect((await run("ses_b2", "instructions")).stdout).toBe("This workspace has no AGENTS.md.\n");
  });

  test("(h) any read counts: head -n 1 (not even the block), grep without a match", async () => {
    expect((await run("ses_h", "head -n 1 plan.md")).stdout).toBe("# Plan\n");
    expect((await run("ses_h", "echo h >> plan.md")).exitCode).toBe(0);
    await run("ses_h2", "grep -c nomatch plan.md");
    expect((await run("ses_h2", "echo h2 >> plan.md")).exitCode).toBe(0);
  });

  test("(f) another session_id is tracked separately", async () => {
    expect((await run("ses_f", "echo f >> plan.md")).stderr).toContain(NOTE_RULE("plan.md"));
  });

  test("(c) a person changes the block: refused until read again (live edits too)", async () => {
    await setNote("plan.md", "# Plan\n\n```instructions\nWrite in French.\n```\n\nlog:\n");
    expect((await run("ses_b", "echo two >> plan.md")).stderr).toContain(NOTE_RULE("plan.md"));
    expect((await run("ses_b", "instructions plan.md")).stdout).toContain("Write in French.");
    expect((await run("ses_b", "echo deux >> plan.md")).exitCode).toBe(0);
    // a restore lands in the live text first
    const history = (await human("GET", "history?path=plan.md")) as { sha: string }[];
    await human("POST", "restore", { path: "plan.md", sha: history.at(-1)!.sha });
    expect((await run("ses_b", "echo trois >> plan.md")).stderr).toContain(NOTE_RULE("plan.md"));
  });

  test("(i) rename and delete need the source's block", async () => {
    expect((await run("ses_i", "mv plan.md plan2.md")).stderr).toContain(NOTE_RULE("plan.md"));
    expect((await run("ses_i", "rm plan.md")).stderr).toContain(NOTE_RULE("plan.md"));
    await run("ses_i", "cat plan.md");
    // the renamed note's block counts as read too
    expect((await run("ses_i", "mv plan.md plan2.md && echo x >> plan2.md")).exitCode).toBe(0);
    expect((await run("ses_i", "rm plan2.md")).exitCode).toBe(0);
  });

  test("one refused file doesn't stop the command's other writes", async () => {
    await setNote("locked.md", "```instructions\nAsk first.\n```\n");
    const out = await run("ses_p", "echo x >> locked.md; echo '# Fresh' > fresh.md");
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(NOTE_RULE("locked.md"));
    expect(await text("fresh.md")).toBe("# Fresh\n");
  });

  test("(d) AGENTS.md: a session's first sight counts; a change refuses the next command's writes, shown with it", async () => {
    await setNote("AGENTS.md", "# Rules\nBe brief.\n");
    let out = await run("ses_d", "echo d1 >> fresh.md");
    expect(out.agents_md).toBe("# Rules\nBe brief.");
    expect(out.exitCode).toBe(0);
    await setNote("AGENTS.md", "# Rules\nBe kind.\n");
    out = await run("ses_d", "echo d2 >> fresh.md");
    expect(out.agents_md).toBe("# Rules\nBe kind.");
    expect(out.stderr).toContain(MD_CHANGED);
    expect((await run("ses_d", "echo d2 >> fresh.md")).exitCode).toBe(0);
    // `instructions` (no argument) prints AGENTS.md and counts as reading it
    await setNote("AGENTS.md", "# Rules\nBe gentle.\n");
    expect((await run("ses_d2", "true")).agents_md).toBe("# Rules\nBe gentle.");
    await setNote("AGENTS.md", "# Rules\nBe exact.\n");
    const md = await run("ses_d2", "instructions");
    expect(md.stdout).toEndWith("[AGENTS.md]\n# Rules\nBe exact.\n[end of AGENTS.md]\n");
    expect((await run("ses_d2", "echo d3 >> fresh.md")).exitCode).toBe(0);
  });

  test("(e) creating a note needs only AGENTS.md; reading AGENTS.md directly counts", async () => {
    await setNote("AGENTS.md", "# Rules\nBe quick.\n");
    expect((await run("ses_d", "echo '# N' > n.md")).stderr).toContain(MD_CHANGED);
    expect((await run("ses_d", "instructions AGENTS.md")).stdout).toBe("[AGENTS.md]\n# Rules\nBe quick.\n[end of AGENTS.md]\n");
    await setNote("AGENTS.md", "# Rules\nBe calm.\n");
    // (delivered above: then changed again) a read of the file counts
    await run("ses_d", "cat AGENTS.md");
    expect((await run("ses_d", "echo '# N' > n.md")).exitCode).toBe(0);
  });

  test("(g) people are never checked", async () => {
    await human("POST", "files", { path: "h.md", content: "```instructions\nx\n```\n" });
    await human("POST", "rename", { from: "h.md", to: "h2.md" });
    await human("DELETE", "files?path=h2.md");
  });

  test("a note GET (with the session id) and MCP: the same rules", async () => {
    await setNote("m.md", "# M\n```instruction\nmcp rule\n```\n");
    await fetch(`${base}/app/${WS}/m.md`, { headers: { "x-agent-session-id": "ses_get" } });
    await run("ses_get", "true");
    expect((await run("ses_get", "echo g >> m.md")).exitCode).toBe(0);
    const init = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "t" } } }) });
    const sid = init.headers.get("mcp-session-id")!;
    const cmd = async (command: string) => {
      const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", "mcp-session-id": sid }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "command", arguments: { workspace: WS, command, session_id: "ses_mcp" } } }) });
      return ((await res.json()) as any).result.content[0].text as string;
    };
    expect(await cmd("echo m >> m.md")).toContain(NOTE_RULE("m.md"));
    await cmd("cat m.md");
    expect(await cmd("echo m >> m.md && echo ok")).toBe("ok\n");
  });
});
