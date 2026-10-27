// End-to-end: the Rust engine owning the shared document in the browser (yrs in wasm speaking the room's
// WebSocket protocol) through the real server: offline edits merging on reconnect, a room restarted with a new
// generation, a read-only notebook, an agent's edit (share link) with its cursor, a CRLF note staying
// byte-identical, and an engine crash (read-only notice; the unsent edits merged after a reload).
// Usage: bun run build:client && bun test/e2e/rust-collab.mjs
// Needs playwright-core in /tmp/opencode/pw and the Playwright Chromium headless shell.
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "np-rc-e2e-"));
process.env.STORAGE = "local";
process.env.ALLOW_DEV_LOGIN = "1";
process.env.ALLOWED_GITHUB_USERS = "*";
process.env.QUIET_MS = "1000";
process.env.PORT = "0";
const { startServer } = await import("../../src/server/index.ts");
const { db } = await import("../../src/server/db.ts");
const { roomKey } = await import("../../src/server/rooms.ts");
const app = await startServer({ port: 0, quiet: true });
const base = `http://localhost:${app.server.port}`;
const store = app.ctx.store;

const browser = await chromium.launch({
  executablePath: "/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell",
});
let fails = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(ok ? "ok  " : "FAIL", name, ok ? "" : `\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(50);
  }
}

async function user(name) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[${name}] PAGEERROR`, e.message));
  page.on("console", (m) => m.type() === "error" && !/401|ERR_INTERNET_DISCONNECTED|WebSocket/.test(m.text()) && console.log(`[${name}] CONSOLE`, m.text()));
  await page.goto(base + "/");
  await page.fill("input[name=name]", name);
  await page.click("form button[type=submit], form button");
  await page.waitForURL(/\/app\//, { timeout: 10000 });
  await page.waitForSelector(".mde .ln", { timeout: 10000 });
  return page;
}

async function open(page, repo, path) {
  await page.goto(`${base}/app/${encodeURIComponent(repo)}/${path}`);
  await page.waitForSelector(".mde .ln", { timeout: 10000 });
  await sleep(200);
}

/** The editor's raw text. */
const raw = (page) => page.evaluate(() => document.querySelector(".mde")?.mdeView?.engine.text() ?? null);
const domText = (page) => page.evaluate(() => [...document.querySelectorAll(".mde .ln")].map((l) => l.textContent).join("\n"));
const status = (page) => page.evaluate(() => document.querySelector(".save-status")?.textContent ?? "");
const isCollab = (page) => page.evaluate(() => !!document.querySelector(".mde")?.mdeView?.collab);
const roomOf = (repo, path) => app.ctx.rooms.open.get(roomKey(repo, path));
const serverText = (repo, path) => roomOf(repo, path)?.text.toString();
const headText = async (repo, path) => store.readFile(repo, path, await store.head(repo, "main"));
/** The sessionStorage key of a note's kept edits (grimoire.unsent:<user>\0<repo>\0<path>), or null. */
const keptKey = (page, repo, path) => page.evaluate(([r, p]) => Object.keys(sessionStorage).find((k) => k.startsWith("grimoire.unsent:") && k.endsWith(`\u0000${r}\u0000${p}`)) ?? null, [repo, path]);
const toastWith = (page, s) => until(() => page.evaluate((s) => [...document.querySelectorAll(".toast")].some((t) => t.textContent.includes(s)), s));
/** Make the engine trap (a wasm panic, simulated by a RuntimeError from receive) and wait for the read-only notice. */
async function trap(page) {
  await page.evaluate(() => {
    const c = document.querySelector(".mde").mdeView.collab;
    c.engine.receive = () => {
      throw new WebAssembly.RuntimeError("unreachable");
    };
    c.onFrame(new Uint8Array([1, 0]));
  });
  return until(() => page.evaluate(() => document.querySelector(".mde-fallback .mde-notice")?.textContent ?? null));
}
/** Disconnect `name` from the note's room and keep the page offline. */
async function goOffline(page, name, repo, path) {
  await page.context().setOffline(true);
  for (const c of roomOf(repo, path).conns) if (c.user.name === name) c.close(1006, "network gone");
  await until(async () => (await status(page)).startsWith("Offline"));
}
async function typeAtEnd(page, line, text) {
  await page.click(`.mde .ln >> nth=${line}`);
  await page.keyboard.press("End");
  await page.keyboard.type(text);
}

async function commitFile(repo, path, content) {
  await store.commit({
    repo,
    branch: "main",
    expectedHead: await store.head(repo, "main"),
    changes: [{ path, content }],
    message: `seed ${path}`,
    author: { name: "seed", email: "seed@example.com" },
  });
}

const alice = await user("Alice");
const bob = await user("Bob");
check("Alice: Rust engine in collab mode", await isCollab(alice), true);
const repo = new URL(alice.url()).pathname.split("/")[2];

// ---------------------------------------------------------------------------------------------
// Offline: edits made while disconnected merge with the others' edits on reconnect.
{
  await commitFile(repo, "offline.md", "first line\nsecond line\nthird line\n");
  await open(alice, repo, "offline.md");
  await open(bob, repo, "offline.md");
  check("offline: both loaded", [await raw(alice), await raw(bob)], ["first line\nsecond line\nthird line\n", "first line\nsecond line\nthird line\n"]);
  await alice.context().setOffline(true);
  for (const c of roomOf(repo, "offline.md").conns) if (c.user.name === "Alice") c.close(1006, "network gone");
  check("offline: Alice shows Offline", await until(async () => (await status(alice)).startsWith("Offline")), true);
  await alice.click(".mde .ln >> nth=0");
  await alice.keyboard.press("End");
  await alice.keyboard.type(" (alice offline)");
  await bob.click(".mde .ln >> nth=2");
  await bob.keyboard.press("End");
  await bob.keyboard.type(" (bob online)");
  await sleep(300);
  check("offline: Alice's edit stayed local", serverText(repo, "offline.md"), "first line\nsecond line\nthird line (bob online)\n");
  check("offline: Alice doesn't see Bob's edit yet", await raw(alice), "first line (alice offline)\nsecond line\nthird line\n");
  await alice.context().setOffline(false);
  await alice.evaluate(() => window.dispatchEvent(new Event("online")));
  const want = "first line (alice offline)\nsecond line\nthird line (bob online)\n";
  check("offline: merged on reconnect (server)", await until(() => serverText(repo, "offline.md") === want) && serverText(repo, "offline.md"), want);
  check("offline: merged on reconnect (Alice)", await until(async () => (await raw(alice)) === want) && (await raw(alice)), want);
  check("offline: merged on reconnect (Bob)", await until(async () => (await raw(bob)) === want) && (await raw(bob)), want);
  check("offline: status cleared", await until(async () => (await status(alice)) === ""), true);
  check("offline: DOM matches", await domText(alice), await domText(bob));
}

// ---------------------------------------------------------------------------------------------
// A room restarted with a new generation (its crash log dropped): the Rust client resets cleanly.
{
  await commitFile(repo, "restart.md", "before restart\n");
  await open(alice, repo, "restart.md");
  await alice.click(".mde .ln >> nth=0");
  await alice.keyboard.press("End");
  await alice.keyboard.type(" +a");
  check("restart: edit reached the server", await until(() => serverText(repo, "restart.md") === "before restart +a\n"), true);
  const room = roomOf(repo, "restart.md");
  await room.flush();
  check("restart: committed", await headText(repo, "restart.md"), "before restart +a\n");
  const oldGen = room.generation;
  // the room goes away with its log; the file changes in Git meanwhile; the client reconnects to a new room
  for (const c of room.conns) c.close(1012, "restart");
  room.destroy(true);
  await commitFile(repo, "restart.md", "before restart +a\nchanged in git\n");
  const toastSeen = await until(() => alice.evaluate(() => [...document.querySelectorAll(".toast")].some((t) => t.textContent.includes("reloaded from the server"))));
  check("restart: 'reloaded from the server' toast", !!toastSeen, true);
  check("restart: new generation", await until(() => roomOf(repo, "restart.md") && roomOf(repo, "restart.md").generation !== oldGen), true);
  check("restart: editor shows the new room's text", await until(async () => (await raw(alice)) === "before restart +a\nchanged in git\n") && (await raw(alice)), "before restart +a\nchanged in git\n");
  check("restart: still the Rust engine", await isCollab(alice), true);
  await alice.click(".mde .ln >> nth=1");
  await alice.keyboard.press("End");
  await alice.keyboard.type("!");
  check("restart: typing after the reset reaches the server", await until(() => serverText(repo, "restart.md") === "before restart +a\nchanged in git!\n") && serverText(repo, "restart.md"), "before restart +a\nchanged in git!\n");
}

// ---------------------------------------------------------------------------------------------
// A read-only notebook: shown, not editable, nothing sent.
{
  await store.createRepo("ro-e2e", { branch: "main" });
  await commitFile("ro-e2e", "README.md", "read me\n- item\n");
  db.query("INSERT INTO repos (id, title, kind, gh_owner, gh_name, read_only, branch, status, created_at) VALUES ('ro-e2e', 'o/ro', 'github', 'o', 'ro', 1, 'main', 'ready', ?)").run(Date.now());
  await open(alice, "ro-e2e", "README.md");
  check("read-only: Rust engine in collab mode", await isCollab(alice), true);
  check("read-only: text", await raw(alice), "read me\n- item\n");
  check("read-only: editor is read-only", await alice.evaluate(() => [document.querySelector(".mde").classList.contains("readonly"), document.querySelector(".mde-content").contentEditable]), [true, "false"]);
  check("read-only: engine read-only", await alice.evaluate(() => document.querySelector(".mde").mdeView.engine.read_only()), true);
  await alice.click(".mde .ln >> nth=0");
  await alice.keyboard.type("vandal");
  await alice.keyboard.press("Enter");
  await sleep(400);
  check("read-only: typing changes nothing", [await raw(alice), serverText("ro-e2e", "README.md")], ["read me\n- item\n", "read me\n- item\n"]);
}

// ---------------------------------------------------------------------------------------------
// An agent edits through a share link: the edit and the agent's cursor appear live in the Rust editor.
{
  await commitFile(repo, "agent.md", "# Agent test\nhello\n");
  await open(alice, repo, "agent.md");
  await alice.click(".mde .ln >> nth=1");
  const share = await alice.evaluate(async (repo) => {
    const r = await fetch(`/api/repos/${repo}/shares`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "Helper" }) });
    return r.json();
  }, repo);
  const res = await fetch(`${base}/a/${share.id}`, { method: "POST", headers: { "X-Agent-Name": "Robo" }, body: "echo 'from the agent' >> agent.md" });
  const out = res.ok ? await res.json() : null;
  check("agent: shell edit ok", out?.exitCode, 0);
  check("agent: edit appears live", await until(async () => (await raw(alice)) === "# Agent test\nhello\nfrom the agent\n") && (await raw(alice)), "# Agent test\nhello\nfrom the agent\n");
  const label = await until(() => alice.evaluate(() => [...document.querySelectorAll(".mde .rcaret .rlabel")].map((l) => l.textContent).find((t) => /robo|helper/i.test(t)) ?? null));
  check("agent: its cursor is drawn with its name", !!label, true);
  const caretLine = await alice.evaluate(() => {
    const c = document.querySelector(".mde .rcaret");
    if (!c) return -1;
    const y = c.getBoundingClientRect().top + 2;
    return [...document.querySelectorAll(".mde .ln")].findIndex((l) => {
      const r = l.getBoundingClientRect();
      return y >= r.top && y < r.bottom;
    });
  });
  check("agent: cursor at the end of its edit", caretLine >= 2, true);
}

// ---------------------------------------------------------------------------------------------
// A note with CRLF line ends: opening it in the Rust editor and editing elsewhere keeps the file
// byte-identical apart from the edit.
{
  const crlf = "# Windows\r\nline one\r\n- item\r\nlast\r\n";
  await commitFile(repo, "crlf.md", crlf);
  await open(alice, repo, "crlf.md");
  await open(bob, repo, "crlf.md");
  check("crlf: Rust editor has the exact text", await raw(alice), crlf);
  await sleep(2000);
  const commits = async () => (await store.history(repo, "main", "crlf.md", 10)).length;
  check("crlf: opening commits nothing", [await commits(), serverText(repo, "crlf.md")], [1, crlf]);
  // Bob edits the last line; Alice (Rust) has it open
  await bob.click(".mde .ln >> nth=3");
  await bob.keyboard.press("Home");
  await bob.keyboard.type("very ");
  const want = "# Windows\r\nline one\r\n- item\r\nvery last\r\n";
  check("crlf: Alice sees Bob's edit", await until(async () => (await raw(alice)) === want) && (await raw(alice)), want);
  // and Alice edits too
  await alice.click(".mde .ln >> nth=1");
  await alice.keyboard.press("Home");
  await alice.keyboard.type("the ");
  const want2 = "# Windows\r\nthe line one\r\n- item\r\nvery last\r\n";
  check("crlf: server text", await until(() => serverText(repo, "crlf.md") === want2) && serverText(repo, "crlf.md"), want2);
  await roomOf(repo, "crlf.md").flush();
  check("crlf: committed byte-identical apart from the edits", [await headText(repo, "crlf.md"), await commits()], [want2, 2]);
}

// ---------------------------------------------------------------------------------------------
// The engine traps (a wasm panic: here simulated by a RuntimeError from receive) with an edit made offline:
// the note is shown read-only with a notice and a Reload button, the edit is kept (sessionStorage); after the
// reload it is merged into the current document (Bob edited meanwhile) and sent. A sync frame the engine
// rejects (connected, the edit already sent) does the same.
for (const how of ["trap", "rejected"]) {
  const path = `crash-${how}.md`;
  await commitFile(repo, path, "alpha\nbeta\n");
  await open(alice, repo, path);
  await open(bob, repo, path);
  check(`crash/${how}: Rust collab`, await isCollab(alice), true);
  await alice.context().setOffline(true);
  for (const c of roomOf(repo, path).conns) if (c.user.name === "Alice") c.close(1006, "network gone");
  await until(async () => (await status(alice)).startsWith("Offline"));
  await alice.click(".mde .ln >> nth=0");
  await alice.keyboard.press("End");
  await alice.keyboard.type(" (unsent)");
  if (how === "rejected") {
    // frames are only looked at once the room said hello: reconnect first (the edit goes out with it)
    await alice.context().setOffline(false);
    await alice.evaluate(() => window.dispatchEvent(new Event("online")));
    await until(async () => (await status(alice)) === "");
  }
  await alice.evaluate((how) => {
    const c = document.querySelector(".mde").mdeView.collab;
    if (how === "trap") {
      c.engine.receive = () => {
        throw new WebAssembly.RuntimeError("unreachable");
      };
      c.onFrame(new Uint8Array([1, 0]));
    } else {
      c.onFrame(new Uint8Array([0, 2, 9, 9, 9]));
    }
  }, how);
  const notice = await until(() => alice.evaluate(() => document.querySelector(".mde-fallback .mde-notice")?.textContent ?? null));
  check(`crash/${how}: read-only notice with Reload`, notice, "The editor ran into a problem. Reload to continue editing.Reload");
  check(`crash/${how}: the note's text, read-only`, await alice.evaluate(() => [document.querySelector(".mde-fallback-text")?.textContent, !!document.querySelector(".mde-content")]), ["alpha (unsent)\nbeta\n", false]);
  const toastSeen = await until(() => alice.evaluate(() => [...document.querySelectorAll(".toast")].some((t) => t.textContent.includes("unsaved edits are kept"))));
  check(`crash/${how}: toast`, !!toastSeen, true);
  check(`crash/${how}: edits kept in sessionStorage (per user, repo, path)`, !!(await keptKey(alice, repo, path)), true);
  // Bob edits meanwhile
  await bob.click(".mde .ln >> nth=1");
  await bob.keyboard.press("End");
  await bob.keyboard.type(" (bob)");
  const bobs = how === "trap" ? "alpha\nbeta (bob)\n" : "alpha (unsent)\nbeta (bob)\n";
  check(`crash/${how}: Bob's edit reached the server`, await until(() => serverText(repo, path) === bobs) && serverText(repo, path), bobs);
  await alice.context().setOffline(false);
  await alice.click(".mde-notice button");
  await alice.waitForSelector(".mde .ln", { timeout: 10000 });
  const want = "alpha (unsent)\nbeta (bob)\n";
  check(`crash/${how}: after the reload, the kept edit is merged`, await until(async () => (await raw(alice)) === want) && (await raw(alice)), want);
  check(`crash/${how}: ... and reaches the server`, await until(() => serverText(repo, path) === want) && serverText(repo, path), want);
  check(`crash/${how}: Bob sees it`, await until(async () => (await raw(bob)) === want) && (await raw(bob)), want);
  // (rejected: the edit had reached the server before the crash: nothing to restore, no toast)
  const restored = await until(() => alice.evaluate(() => [...document.querySelectorAll(".toast")].some((t) => t.textContent.includes("were restored"))), how === "trap" ? 8000 : 1500);
  check(`crash/${how}: 'restored' toast only if something was restored`, !!restored, how === "trap");
  check(`crash/${how}: sessionStorage cleared`, await until(async () => (await keptKey(alice, repo, path)) === null) && (await keptKey(alice, repo, path)), null);
  await alice.click(".mde .ln >> nth=1");
  await alice.keyboard.press("End");
  await alice.keyboard.type("!");
  check(`crash/${how}: typing after the reload works`, await until(() => serverText(repo, path) === "alpha (unsent)\nbeta (bob)!\n") && serverText(repo, path), "alpha (unsent)\nbeta (bob)!\n");
  await alice.reload();
  await alice.waitForSelector(".mde .ln", { timeout: 10000 });
  await sleep(500);
  check(`crash/${how}: nothing merged twice on the next load`, [await raw(alice), serverText(repo, path)], ["alpha (unsent)\nbeta (bob)!\n", "alpha (unsent)\nbeta (bob)!\n"]);
}

// ---------------------------------------------------------------------------------------------
// Crash, then the room is recreated from Git (new generation, items with other ids): the edit that was saved
// isn't inserted again and the unsent one isn't lost (a 3-way text merge, not a Yjs merge that can't integrate).
{
  const path = "crash-newgen.md";
  await commitFile(repo, path, "alpha\nbeta\n");
  await open(alice, repo, path);
  await typeAtEnd(alice, 0, " one");
  check("crash/newgen: first edit reached the server", await until(() => serverText(repo, path) === "alpha one\nbeta\n"), true);
  const room = roomOf(repo, path);
  await room.flush();
  check("crash/newgen: committed", await headText(repo, path), "alpha one\nbeta\n");
  await goOffline(alice, "Alice", repo, path);
  await typeAtEnd(alice, 0, " two");
  check("crash/newgen: notice", !!(await trap(alice)), true);
  const oldGen = room.generation;
  for (const c of room.conns) c.close(1012, "restart");
  room.destroy(true);
  await alice.context().setOffline(false);
  await alice.click(".mde-notice button");
  await alice.waitForSelector(".mde .ln", { timeout: 10000 });
  const want = "alpha one two\nbeta\n";
  check("crash/newgen: merged once, nothing lost", await until(async () => (await raw(alice)) === want) && (await raw(alice)), want);
  check("crash/newgen: ... on the server", await until(() => serverText(repo, path) === want) && serverText(repo, path), want);
  check("crash/newgen: a new room generation", roomOf(repo, path)?.generation !== oldGen, true);
  check("crash/newgen: 'restored' toast", !!(await toastWith(alice, "were restored")), true);
  check("crash/newgen: sessionStorage cleared", await keptKey(alice, repo, path), null);
}

// Crash, Bob changed the same place meanwhile and the room was recreated: not merged, not forgotten: the text is
// offered to copy.
{
  const path = "crash-conflict.md";
  await commitFile(repo, path, "one two three\n");
  await open(alice, repo, path);
  await open(bob, repo, path);
  await goOffline(alice, "Alice", repo, path);
  await alice.click(".mde .ln >> nth=0");
  await alice.keyboard.press("End");
  for (let i = 0; i < 5; i++) await alice.keyboard.press("Backspace");
  await alice.keyboard.type("3");
  check("crash/conflict: notice", !!(await trap(alice)), true);
  await bob.click(".mde .ln >> nth=0");
  await bob.keyboard.press("End");
  for (let i = 0; i < 5; i++) await bob.keyboard.press("Backspace");
  await bob.keyboard.type("THREE");
  check("crash/conflict: Bob's edit on the server", await until(() => serverText(repo, path) === "one two THREE\n"), true);
  // (in the same room generation Yjs merges both edits; a recreated room needs the text merge, which conflicts)
  const room = roomOf(repo, path);
  await room.flush();
  for (const c of room.conns) c.close(1012, "restart");
  room.destroy(true);
  await alice.context().setOffline(false);
  await alice.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  await alice.click(".mde-notice button");
  await alice.waitForSelector(".mde .ln", { timeout: 10000 });
  const banner = await until(() => alice.evaluate(() => {
    const n = document.querySelector(".mde-unsaved");
    return n && [n.querySelector(".mde-notice span").textContent, [...n.querySelectorAll("button")].map((b) => b.textContent), n.querySelector("pre").textContent];
  }));
  check("crash/conflict: notice above the editor with the text and actions", banner && [/couldn't be merged/.test(banner[0]), banner[1], banner[2]], [true, ["Copy your unsaved text", "Download .md", "Discard"], "one two 3\n"]);
  check("crash/conflict: 'couldn't be restored' toast", !!(await toastWith(alice, "couldn't be restored")), true);
  check("crash/conflict: nothing merged", [await raw(alice), serverText(repo, path)], ["one two THREE\n", "one two THREE\n"]);
  check("crash/conflict: still kept", !!(await keptKey(alice, repo, path)), true);
  await alice.click(".mde-unsaved button >> text=Copy your unsaved text");
  check("crash/conflict: copied", await until(() => alice.evaluate(() => navigator.clipboard.readText().catch(() => null)).then((t) => t === "one two 3\n")), true);
  await alice.click(".mde-unsaved button >> text=Discard");
  check("crash/conflict: discarded", [await alice.evaluate(() => !!document.querySelector(".mde-unsaved")), await keptKey(alice, repo, path)], [false, null]);
}

// Crash, then the recovery code fails to load after the reload: the edits stay kept (toast + notice with the
// text and Reload); the next load merges them.
{
  const path = "crash-import.md";
  await commitFile(repo, path, "alpha\n");
  await open(alice, repo, path);
  await goOffline(alice, "Alice", repo, path);
  await typeAtEnd(alice, 0, " x");
  check("crash/import: notice", !!(await trap(alice)), true);
  await alice.context().setOffline(false);
  const block = (r) => r.abort();
  await alice.route(/\/dist\/recover-[^/]*\.js/, block);
  await alice.click(".mde-notice button");
  await alice.waitForSelector(".mde .ln", { timeout: 10000 });
  const banner = await until(() => alice.evaluate(() => {
    const n = document.querySelector(".mde-unsaved");
    return n && [n.querySelector(".mde-notice span").textContent, [...n.querySelectorAll("button")].map((b) => b.textContent)];
  }), 10000);
  check("crash/import: notice with the text and Reload", banner && [/couldn't be restored/.test(banner[0]), banner[1]], [true, ["Copy your unsaved text", "Download .md", "Reload", "Discard"]]);
  check("crash/import: toast", !!(await toastWith(alice, "couldn't be restored yet")), true);
  check("crash/import: still kept, the note editable", [!!(await keptKey(alice, repo, path)), await raw(alice)], [true, "alpha\n"]);
  await alice.unroute(/\/dist\/recover-[^/]*\.js/, block);
  await alice.click(".mde-unsaved button >> text=Reload");
  await alice.waitForSelector(".mde .ln", { timeout: 10000 });
  check("crash/import: merged on the next load", await until(async () => (await raw(alice)) === "alpha x\n") && serverText(repo, path), "alpha x\n");
  check("crash/import: then forgotten", await until(async () => (await keptKey(alice, repo, path)) === null) && (await keptKey(alice, repo, path)), null);
}

// Crash with a full sessionStorage: the notice says the edits couldn't be kept and offers Copy / Download.
{
  const path = "crash-quota.md";
  await commitFile(repo, path, "alpha\n");
  await open(alice, repo, path);
  await goOffline(alice, "Alice", repo, path);
  await typeAtEnd(alice, 0, " q");
  await alice.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("full", "QuotaExceededError");
    };
  });
  const notice = await trap(alice);
  check("crash/quota: notice says copy before reloading", /couldn't be kept/.test(notice ?? ""), true);
  check("crash/quota: actions", await alice.evaluate(() => [...document.querySelectorAll(".mde-fallback .mde-notice button")].map((b) => b.textContent)), ["Copy your unsaved text", "Download .md", "Reload"]);
  check("crash/quota: toast", !!(await toastWith(alice, "couldn't be kept")), true);
  const [dl] = await Promise.all([alice.waitForEvent("download"), alice.click(".mde-notice button >> text=Download .md")]);
  const { readFileSync } = await import("node:fs");
  check("crash/quota: download", [dl.suggestedFilename(), readFileSync(await dl.path(), "utf8")], ["crash-quota.md", "alpha q\n"]);
  await alice.context().setOffline(false);
  await alice.reload();
  await alice.waitForSelector(".mde .ln", { timeout: 10000 });
}

// Signing out drops the user's kept edits.
{
  await alice.evaluate(() => sessionStorage.setItem("grimoire.unsent:x\u0000r\u0000p.md", "{}"));
  const mine = await alice.evaluate(() => fetch("/api/me").then((r) => r.json()).then((m) => m.id));
  await alice.evaluate((id) => sessionStorage.setItem(`grimoire.unsent:${id}\u0000r\u0000p.md`, "{}"), mine);
  await alice.click(".ws-switcher");
  await alice.click(".menu-item >> text=Sign out");
  await alice.waitForURL(`${base}/`, { timeout: 10000 });
  check("sign out: the user's kept edits dropped, another user's kept", await alice.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith("grimoire.unsent:"))), ["grimoire.unsent:x\u0000r\u0000p.md"]);
}

await browser.close();
await app.stop();
rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
