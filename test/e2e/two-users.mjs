// End-to-end: two people in the same note through the real server.
// Usage: bun run build:client && bun test/e2e/two-users.mjs
// Needs playwright-core in /tmp/opencode/pw and the Playwright Chromium headless shell.
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "np-e2e-"));
process.env.ALLOW_DEV_LOGIN = "1";
process.env.ALLOWED_GITHUB_USERS = "*";
process.env.QUIET_MS = "1500";
process.env.PORT = "0";
const { startServer } = await import("../../src/server/index.ts");
const app = await startServer({ port: 0, quiet: true });
const base = `http://localhost:${app.server.port}`;

const browser = await chromium.launch({
  executablePath: "/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell",
});
let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(ok ? "ok  " : "FAIL", name, ok ? "" : detail);
};

async function user(name) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[${name}] PAGEERROR`, e.message));
  page.on("console", (m) => m.type() === "error" && console.log(`[${name}] CONSOLE`, m.text()));
  await page.goto(base + "/");
  await page.fill("input[name=name]", name);
  await page.click("form button[type=submit], form button");
  await page.waitForURL(/\/r\//, { timeout: 10000 });
  await page.waitForSelector(".mde .ln", { timeout: 10000 });
  return page;
}

const alice = await user("Alice");
const bob = await user("Bob");
check("both opened the Welcome note", alice.url().includes("Welcome.md") && bob.url().includes("Welcome.md"), `${alice.url()} ${bob.url()}`);

// Alice types at the end of the first line.
await alice.click(".mde .ln >> nth=0");
await alice.keyboard.press("End");
await alice.keyboard.press("Meta+ArrowRight").catch(() => {});
await alice.keyboard.type(" — edited live");
await bob.waitForFunction(() => document.querySelector(".mde")?.textContent?.includes("edited live"), null, { timeout: 5000 }).then(
  () => check("Bob sees Alice's typing live", true),
  () => check("Bob sees Alice's typing live", false),
);

// Bob sees Alice's cursor and her name in the participants list.
const cursorSeen = await bob
  .waitForFunction(() => document.body.innerText.toLowerCase().includes("alice") && document.querySelectorAll(".rc, .remote-caret, [class*=cursor]").length > 0, null, { timeout: 5000 })
  .then(() => true, () => false);
check("Bob sees Alice's cursor/presence", cursorSeen);

// Bob types too; both converge.
await bob.click(".mde .ln >> nth=2");
await bob.keyboard.type("Bob was here ");
await alice.waitForFunction(() => document.querySelector(".mde")?.textContent?.includes("Bob was here"), null, { timeout: 5000 }).then(
  () => check("Alice sees Bob's typing", true),
  () => check("Alice sees Bob's typing", false),
);
await new Promise((r) => setTimeout(r, 500));
const lineText = () => [...document.querySelectorAll(".mde .ln")].map((l) => l.textContent).join("\\n");
const ta = await alice.evaluate(lineText);
const tb = await bob.evaluate(lineText);
check("documents converge", ta === tb, `\n${ta}\n---\n${tb}`);

// After the quiet period the server commits, with both as authors.
await new Promise((r) => setTimeout(r, 3500));
const hist = await (await fetch(`${base}/api/repos/notes/history?path=Welcome.md`, { headers: { cookie: (await alice.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ") } })).json();
check("committed after quiet period", Array.isArray(hist) && hist.length >= 2 && hist[0].message.startsWith("Update Welcome.md"), JSON.stringify(hist).slice(0, 300));
const committed = await app.ctx.store.readFile("notes", "Welcome.md", await app.ctx.store.head("notes", "main"));
check("commit contains both edits", committed.includes("edited live") && committed.includes("Bob was here"));
const full = await app.ctx.store.history("notes", "main", "Welcome.md", 1);
check("save status shows Saved", (await alice.evaluate(() => document.body.innerText)).includes("Saved"));

// An agent edits through MCP's document_command tool; the people see it.
const tok = await alice.evaluate(async () => {
  const r = await fetch("/api/agent-tokens", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Helper" }) });
  return (await r.json()).token;
});
const mcp = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tok}` },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "document_command", arguments: { command: "echo 'Agent note appended.' >> /workspace/notes/Welcome.md" } } }),
});
const mcpOut = mcp.ok ? (await mcp.json()).result : null;
check("MCP bash append ok", !!mcpOut && !mcpOut.isError && !mcpOut.content[0].text.includes("[exit"));
await bob.waitForFunction(() => document.querySelector(".mde")?.textContent?.includes("Agent note appended"), null, { timeout: 5000 }).then(
  () => check("Bob sees the agent's edit live", true),
  () => check("Bob sees the agent's edit live", false),
);
const agentShown = await bob.waitForFunction(() => document.body.innerText.toLowerCase().includes("helper"), null, { timeout: 5000 }).then(() => true, () => false);
check("agent shows up as a participant", agentShown);

await alice.screenshot({ path: "/tmp/opencode/e2e-alice.png" });
await bob.screenshot({ path: "/tmp/opencode/e2e-bob.png" });
await browser.close();
await app.stop();
rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
