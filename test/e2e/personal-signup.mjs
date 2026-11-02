// End-to-end (Bun): every new account has its own workspace, made as it signs up (src/server/personal.ts): even when
// its browser never reaches /app (a closed tab, the Mac app, an MCP client's OAuth); a web sign-up still lands in it
// with the one-time welcome; one whose making was cut off (row left "importing", no repo) is finished on the next
// landing; signup and personal_workspace_created count the same.
// Usage: bun run build:client && bun test/e2e/personal-signup.mjs
import "../local-storage.ts";
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { startTarget } from "./target.mjs";

const T = await startTarget();
const base = T.base;
const browser = await chromium.launch({ executablePath: "/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell" });
const sql = (s) => T.sql(s);
let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(ok ? "ok  " : "FAIL", name, ok ? "" : detail);
};

// 1. a sign-up whose browser never reaches /app (a closed tab, the Mac app, an MCP client): the workspace exists anyway
const res = await fetch(`${base}/auth/dev`, { method: "POST", headers: { origin: base }, body: new URLSearchParams({ name: "Closed Tab" }), redirect: "manual" });
const cookie = res.headers.getSetCookie().find((s) => s.startsWith("np_session="))?.split(";")[0];
const list = await (await fetch(`${base}/api/workspaces`, { headers: { cookie } })).json();
check("never reached /app: its workspace is there", list.length === 1 && list[0].title === "Closed's notes" && list[0].status === "ready", JSON.stringify(list));
check("…its welcome pending", (await sql("SELECT welcome_ws FROM users WHERE name = 'Closed Tab'"))[0]?.welcome_ws === list[0]?.id);

// 2. web sign-up in a browser: lands in it, sees the welcome once
const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const page = await ctx.newPage();
const calls = [];
page.on("request", (r) => r.url().includes("/api/workspaces") && calls.push(`${r.method()} ${new URL(r.url()).pathname}`));
await page.goto(`${base}/auth/dev?next=/app`);
await page.fill("input[name=name]", "Ünal Kaya");
await page.click("form button[type=submit]");
const welcomed = await page.waitForFunction(() => document.querySelector("dialog.modal[open] h2")?.textContent === "Welcome to Grim", null, { timeout: 8000 }).then(() => true, () => false);
check("web sign-up: the welcome", welcomed);
check("…for its workspace", (await page.evaluate(() => document.querySelector("dialog.modal[open] .modal-body p")?.textContent)) === "Your notes live in “Ünal's notes”.");
check("…made once (one POST …/personal, no other workspace)", calls.filter((c) => c === "POST /api/workspaces/personal").length === 1 && (await sql("SELECT count(*) AS n FROM repos r JOIN users u ON u.id = r.owner_id WHERE u.name = 'Ünal Kaya'"))[0].n === 1, calls.join());
await page.keyboard.press("Escape");
await page.reload();
await page.waitForTimeout(2000);
check("reload: no welcome", !(await page.evaluate(() => !!document.querySelector("dialog.modal[open]"))));
await ctx.close();

// 3. a workspace whose making was cut off (row still importing, no repo): finished on the next landing
const r3 = await fetch(`${base}/auth/dev`, { method: "POST", headers: { origin: base }, body: new URLSearchParams({ name: "Stuck" }), redirect: "manual" });
const c3 = r3.headers.getSetCookie().find((s) => s.startsWith("np_session="))?.split(";")[0];
const uid = (await sql("SELECT id FROM users WHERE name = 'Stuck'"))[0].id;
await sql(`DELETE FROM repos WHERE owner_id = '${uid}'`);
await sql(`UPDATE users SET welcome_ws = NULL WHERE id = '${uid}'`);
await sql(`INSERT INTO repos (id, title, kind, branch, status, created_by, created_at, owner_id) VALUES ('stuck-s-notes-zzzzzzzzzzzz', 'Stuck''s notes', 'notes', 'main', 'importing', '${uid}', ${Date.now() - 120_000}, '${uid}')`);
await sql(`INSERT INTO joined (workspace_id, user_id, via, joined_at) VALUES ('stuck-s-notes-zzzzzzzzzzzz', '${uid}', 'x', 0)`);
const p3 = await (await fetch(`${base}/api/workspaces/personal`, { method: "POST", headers: { cookie: c3, origin: base } })).json();
const tree = await (await fetch(`${base}/api/workspace/stuck-s-notes-zzzzzzzzzzzz/tree`, { headers: { cookie: c3 } })).json();
check("cut off: finished on the next landing", p3.id === "stuck-s-notes-zzzzzzzzzzzz" && p3.status === "ready" && JSON.stringify(tree.files) === '["README.md"]', JSON.stringify([p3, tree]));
const counts = Object.fromEntries((await sql("SELECT event, SUM(count) AS n FROM metrics_daily WHERE event IN ('signup','personal_workspace_created') GROUP BY event")).map((r) => [r.event, r.n]));
check("signup and personal_workspace_created count the same", counts.signup === 3 && counts.personal_workspace_created === 3, JSON.stringify(counts));

await browser.close();
await T.stop();
console.log(fails ? `${fails} failed` : "all ok");
process.exit(fails ? 1 : 0);
