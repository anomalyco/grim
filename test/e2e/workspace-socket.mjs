// End-to-end: protocol v2 in the web app (docs/07-workspace-socket.md). One WebSocket for the selected workspace:
// note switches open channels on it (no new connection, no /api request besides the tree), no /api/events stream,
// the previous note switches back at once (a hidden channel), workspace events (tree, presence) arrive on it; the
// switcher moves the tab to the other workspace's socket and closes the old one; switching back is one connection.
// Usage: bun run build:client && bun test/e2e/workspace-socket.mjs   (skips when the server doesn't serve v2)
import "../local-storage.ts";
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "np-e2e-wsock-"));
process.env.ALLOW_DEV_LOGIN = "1";
process.env.SIGN_IN = "on";
process.env.QUIET_MS = "600";
process.env.PORT = "0";
const { startServer } = await import("../../src/server/index.ts");
const app = await startServer({ port: 0, quiet: true });
const base = `http://localhost:${app.server.port}`;

const info = await fetch(`${base}/api/server`).then((r) => r.json());
if (!info.ws?.includes(2)) {
  console.log("skipped: the server doesn't serve protocol v2 (/api/server ws)", JSON.stringify(info.ws ?? null));
  app.server.stop(true);
  process.exit(0);
}

const browser = await chromium.launch({
  executablePath: "/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell",
});
let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(ok ? "ok  " : "FAIL", name, ok ? "" : detail);
};
const until = (page, fn, arg, timeout = 10000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);

/** A signed-in page whose WebSockets and /api requests are recorded. */
async function open(name) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await ctx.newPage();
  // every WebSocket the page makes, to read their states
  await page.addInitScript(() => {
    const Native = window.WebSocket;
    window.__sockets = [];
    window.WebSocket = class extends Native {
      constructor(...args) {
        super(...args);
        window.__sockets.push(this);
      }
    };
  });
  page.on("pageerror", (e) => console.log(`[${name}] PAGEERROR`, e.message));
  const rec = { sockets: [], api: [] };
  page.on("websocket", (ws) => {
    const s = { url: ws.url(), open: true };
    rec.sockets.push(s);
    ws.on("close", () => (s.open = false));
  });
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/api/")) rec.api.push(u.pathname + u.search);
  });
  await page.goto(`${base}/auth/dev?next=/app/notes/Welcome.md`);
  await page.fill("input[name=name]", name);
  await page.click("form button[type=submit]");
  await page.waitForSelector(".mde .ln", { timeout: 10000 });
  return { page, rec };
}
const openSockets = (rec) => rec.sockets.filter((s) => s.open);
/** Until the page's not-closed WebSockets (connecting or open, not closing) are exactly one, for workspace `repo`. */
const onlySocketFor = (page, repo) =>
  until(page, (repo) => {
    const live = window.__sockets.filter((s) => s.readyState <= 1 && new URL(s.url).pathname === "/ws");
    return live.length === 1 && new URL(live[0].url).searchParams.get("repo") === repo;
  }, repo);
const pageSockets = (page) => page.evaluate(() => window.__sockets.map((s) => `${s.url} ${s.readyState}`));
const repoOf = (url) => new URL(url).searchParams.get("repo");
const live = (page, text) => until(page, (t) => [...document.querySelectorAll(".doc-body .editor-host:not(.preview) .mde-content[contenteditable=true] .ln")].some((l) => l.textContent.includes(t)), text);

const { page, rec } = await open("Alice");
for (const [path, content] of [["One.md", "# One\nfirst"], ["Two.md", "# Two\nsecond"], ["Three.md", "# Three\nthird"]]) {
  await page.evaluate(([path, content]) => fetch("/api/repos/notes/files", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, content }) }), [path, content]);
}
await until(page, () => !!document.querySelector('.file-row[href="/app/notes/Three.md"]'));
check("one WebSocket, for the workspace (no path)", openSockets(rec).length === 1 && repoOf(openSockets(rec)[0].url) === "notes" && !new URL(openSockets(rec)[0].url).searchParams.has("path"), JSON.stringify(rec.sockets));
check("no /api/events stream", !rec.api.some((u) => u.startsWith("/api/events")), JSON.stringify(rec.api));

// note switches: channels on the socket
const socketsBefore = rec.sockets.length;
const apiBefore = rec.api.length;
await page.click('.file-row[href="/app/notes/One.md"]');
check("switch to One shows it live", await live(page, "first"));
await page.click('.file-row[href="/app/notes/Two.md"]');
check("switch to Two shows it live", await live(page, "second"));
check("…no new WebSocket", rec.sockets.length === socketsBefore, JSON.stringify(rec.sockets));
const extra = rec.api.slice(apiBefore).filter((u) => !/^\/api\/repos\/notes\/tree/.test(u));
check("…and no /api request besides the tree", extra.length === 0, JSON.stringify(extra));

// the previous note is warm: back to One without waiting on the network
const back = await page.evaluate(() => new Promise((resolve) => {
  const t0 = performance.now();
  document.querySelector('.file-row[href="/app/notes/One.md"]').dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  const done = () => [...document.querySelectorAll(".doc-body .editor-host:not(.preview) .mde-content[contenteditable=true] .ln")].some((l) => l.textContent.includes("first"));
  if (done()) return resolve(performance.now() - t0);
  const obs = new MutationObserver(() => done() && (obs.disconnect(), resolve(performance.now() - t0)));
  obs.observe(document.querySelector(".doc-body"), { subtree: true, childList: true, attributes: true, characterData: true });
}));
check("the previous note comes back live at once (a hidden channel)", back < 100, `${back.toFixed(1)} ms`);

// workspace events on the socket: another user's presence dot, and a new file in the tree
const { page: bob } = await open("Bob");
await bob.goto(`${base}/app/notes/Three.md`);
await bob.waitForSelector(".mde .ln", { timeout: 10000 });
check("presence: Bob's dot on Three in Alice's tree", await until(page, () => !!document.querySelector('.file-row[href="/app/notes/Three.md"] .presence-dots')));
await bob.evaluate(() => fetch("/api/repos/notes/files", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "Four.md", content: "# Four\n" }) }));
check("tree: Bob's new note shows in Alice's tree", await until(page, () => !!document.querySelector('.file-row[href="/app/notes/Four.md"]')));

// switching workspaces: the old socket closes, one socket for the new workspace
const other = await page.evaluate(() => fetch("/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Second" }) }).then((r) => r.json()));
await page.evaluate(() => fetch("/api/workspaces").then((r) => r.json()));
await page.reload();
await page.waitForSelector(".mde .ln", { timeout: 10000 });
const switchTo = async (title) => {
  await page.click(".ws-switcher");
  await page.waitForSelector(".ws-menu", { timeout: 5000 });
  await page.click(`.ws-menu .menu-item[role=menuitemradio]:has(.menu-label:text-is("${title}"))`);
  await until(page, (t) => document.querySelector(".ws-switcher .ws-title")?.textContent === t, title);
};
await switchTo("Second");
check("after switching to B: exactly one open WebSocket, for B", await onlySocketFor(page, other.id), JSON.stringify(await pageSockets(page)));
const beforeBack = (await pageSockets(page)).length;
await switchTo("Notes");
await page.waitForSelector(".mde .ln", { timeout: 10000 });
const backToA = await onlySocketFor(page, "notes");
check("switching back to A: one new connection, the only one open, for A", backToA && (await pageSockets(page)).length === beforeBack + 1, JSON.stringify(await pageSockets(page)));

await browser.close();
app.server.stop(true);
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
