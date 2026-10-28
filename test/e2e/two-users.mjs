// End-to-end: two people in the same note through the real server.
// Usage: bun run build:client && bun test/e2e/two-users.mjs
// The editor's engine (Rust, wasm) owns the shared document in the browser (yrs talking to the server directly).
// Needs playwright-core in /tmp/opencode/pw and the Playwright Chromium headless shell.
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "np-e2e-"));
process.env.ALLOW_DEV_LOGIN = "1";
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
  await page.waitForURL(/\/app\//, { timeout: 10000 });
  await page.waitForSelector(".mde .ln", { timeout: 10000 });
  // the engine in collab mode (its own WebSocket protocol)
  const collab = await page.evaluate(() => !!document.querySelector(".mde")?.mdeView?.collab);
  check(`${name}'s editor owns the shared document`, collab);
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
  .waitForFunction(() => document.body.innerText.toLowerCase().includes("alice") && [...document.querySelectorAll(".mde .rcaret .rlabel")].some((l) => l.textContent === "Alice"), null, { timeout: 5000 })
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
check("no save status text while connected", (await alice.evaluate(() => document.querySelector(".save-status")?.textContent ?? "")) === "");

// An agent gets a "Share with agent" link from Alice and edits through it; the people see it.
const share = await alice.evaluate(async () => {
  const r = await fetch("/api/repos/notes/shares", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "Helper" }) });
  return r.json();
});
const linkUrl = `${base}/a/${share.id}`;
const prompt = await (await fetch(linkUrl)).text();
check("share link GET returns the agent prompt", prompt.includes("Grimoire notebook") && prompt.includes(share.url), prompt.slice(0, 200));
const agentRes = await fetch(linkUrl, { method: "POST", body: "echo 'Agent note appended.' >> Welcome.md" });
const agentOut = agentRes.ok ? await agentRes.json() : null;
check("share link append ok", !!agentOut && agentOut.exitCode === 0, JSON.stringify(agentOut));
await bob.waitForFunction(() => document.querySelector(".mde")?.textContent?.includes("Agent note appended"), null, { timeout: 5000 }).then(
  () => check("Bob sees the agent's edit live", true),
  () => check("Bob sees the agent's edit live", false),
);
const agentShown = await bob.waitForFunction(() => document.body.innerText.toLowerCase().includes("helper"), null, { timeout: 5000 }).then(() => true, () => false);
check("agent shows up as a participant", agentShown);

// URLs: / is always the home page, /app reopens the last note, notes live at /app/<notebook>/<path>, /r/ redirects.
await alice.evaluate(() => fetch("/api/repos/notes/files", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "Second.md", content: "# Second\nThe second note.\n" }) }));
const noteText = (page, s) => page.waitForFunction((s) => document.querySelector(".mde")?.textContent?.includes(s), s, { timeout: 10000 }).then(() => true, () => false);
await alice.goto(`${base}/app/notes/Second.md`);
check("deep link opens the note", await noteText(alice, "The second note"));
await alice.goto(`${base}/`);
const homeCta = await alice.waitForSelector(".home-cta a.btn-cta", { timeout: 10000 }).then((el) => el.evaluate((a) => [a.textContent, a.getAttribute("href")]), () => null);
check("/ signed in: home page with Open Grimoire →", homeCta?.[0] === "Open Grimoire →" && homeCta[1] === "/app" && !(await alice.$("input[name=name]")) && !!(await alice.$(".home-editor")), JSON.stringify(homeCta));
await alice.click(".home-cta a.btn-cta");
await alice.waitForURL(/\/app\/notes\/Second\.md$/, { timeout: 10000 }).then(() => check("/app reopens the last note", true), () => check("/app reopens the last note", false, alice.url()));
check("/app shows the last note", await noteText(alice, "The second note"));
await alice.click('.file-row[href="/app/notes/Welcome.md"]');
await alice.waitForURL(/\/app\/notes\/Welcome\.md$/, { timeout: 5000 }).catch(() => {});
check("sidebar link navigates within /app", await noteText(alice, "edited live"), alice.url());
await alice.goBack();
check("back goes to the previous note", alice.url().endsWith("/app/notes/Second.md") && (await noteText(alice, "The second note")), alice.url());
await alice.goForward();
check("forward goes to the next note", alice.url().endsWith("/app/notes/Welcome.md") && (await noteText(alice, "edited live")), alice.url());
await alice.goto(`${base}/app/notes/Second?x=1#h`);
check("canonical URL keeps the query and hash", (await noteText(alice, "The second note")) && alice.url() === `${base}/app/notes/Second.md?x=1#h`, alice.url());
await alice.goto(`${base}/app/notes/Missing.md`);
check("a missing note says so", await alice.waitForFunction(() => document.body.innerText.includes("Note not found"), null, { timeout: 10000 }).then(() => true, () => false));
await alice.goto(`${base}/app`);
await alice.waitForURL(/\/app\/notes\/Second\.md$/, { timeout: 10000 }).then(() => check("/app doesn't reopen a missing note (last synced one)", true), () => check("/app doesn't reopen a missing note (last synced one)", false, alice.url()));

async function signedOut(path) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[guest] PAGEERROR`, e.message));
  const res = await page.goto(base + path);
  return { page, ctx, res };
}
{
  const { page, ctx } = await signedOut("/");
  const cta = await page.waitForSelector("form.cta-form button", { timeout: 10000 }).then((b) => b.textContent(), () => null);
  check("/ signed out: home page with the sign-in CTA", cta === "View the notes" && !(await page.$('a[href="/app"].btn-cta')), cta);
  await ctx.close();
}
{
  const { page, ctx } = await signedOut("/app/notes/Second.md");
  check("deep link signed out: guest lands on the note", (await noteText(page, "The second note")) && page.url().endsWith("/app/notes/Second.md"), page.url());
  await ctx.close();
}
{
  const { page, ctx, res } = await signedOut("/r/notes/Second.md?x=1#h");
  const hop = res?.request().redirectedFrom();
  check("old /r/ link: 308 to /app/", hop?.url() === `${base}/r/notes/Second.md?x=1` && (await hop.response())?.status() === 308, hop?.url());
  check("old /r/ link: lands on the note", (await noteText(page, "The second note")) && page.url() === `${base}/app/notes/Second.md?x=1#h`, page.url());
  await ctx.close();
}

await alice.screenshot({ path: "/tmp/opencode/e2e-alice.png" });
await bob.screenshot({ path: "/tmp/opencode/e2e-bob.png" });
await browser.close();
await app.stop();
rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
