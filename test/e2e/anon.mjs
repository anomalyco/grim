// End-to-end: visitors who aren't signed in ("guests"). They see and edit the notes without an account (no limit),
// their cursor carries a made-up name that others see, they open folders (Open…, by URL or name); New…, New note,
// New folder, Rename, Delete and pasting images ask them to sign in (outside the demo: demo.mjs), and signing in
// from New note makes the note. The sign-in dialog also offers a scratch note (local only). Signing in from it lands back on the note under
// the account's name. Also: the switcher's × (confirm; the only folder can't go).
// Usage: bun run build:client && bun test/e2e/anon.mjs   (screenshots in /tmp/opencode/anon/)
// Needs playwright-core in /tmp/opencode/pw and the Playwright Chromium headless shell.
import "../local-storage.ts";
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { mkdirSync } from "node:fs";
import { fakeGoogleEnv, startFakeGoogle } from "./fake-google.mjs";
import { startTarget } from "./target.mjs";

const SHOTS = "/tmp/opencode/anon";
mkdirSync(SHOTS, { recursive: true });
const QUIET = 700;
// TARGET=workers runs it against wrangler dev (see target.mjs); the notebook is `WS` ("notes" on Bun), also in pages.
// Sign-in is Google only: a fake Google, whose redirect needs the server's public URL first (pick a free port).
const probe = Bun.serve({ port: 0, fetch: () => new Response() });
const port = probe.port;
probe.stop(true);
const fake = await startFakeGoogle();
const T = await startTarget({ port, env: { ...fakeGoogleEnv(fake), QUIET_MS: String(QUIET), PUBLIC_URL: `http://localhost:${port}` } });
const base = T.base;
const WS = T.ws;

const browser = await chromium.launch({
  executablePath: "/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell",
});
let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(ok ? "ok  " : "FAIL", name, ok ? "" : detail);
};
const until = (page, fn, arg, timeout = 10000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const serverText = () => T.live(WS, "Welcome.md");

async function context(name) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await ctx.addInitScript((ws) => (globalThis.WS = ws), WS);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[${name}] PAGEERROR`, e.message));
  page.on("console", (m) => m.type() === "error" && !/401/.test(m.text()) && console.log(`[${name}] CONSOLE`, m.text()));
  return { ctx, page };
}

// ---- the home page: "View the notes" (no account) and "Sign in" ----
{
  const { ctx, page } = await context("home");
  await page.goto(base + "/");
  await page.waitForSelector(".home-cta");
  const cta = await page.$eval(".home-cta a.btn-cta", (a) => [a.textContent, a.getAttribute("href")]);
  check("home: View the notes → the demo folder, no name field", cta[0] === "View the notes" && cta[1] === "/app/demo" && !(await page.$(".home-cta input")), JSON.stringify(cta));
  check("home: a Sign in link next to it", (await page.textContent(".home-cta .cta-signin")) === "Sign in");
  await page.$eval(".home-cta", (el) => el.scrollIntoView({ block: "center" }));
  await sleep(300);
  await page.screenshot({ path: `${SHOTS}/homepage-cta.png` });
  const [signin] = await Promise.all([page.waitForRequest((r) => r.url().includes("/auth/google"), { timeout: 10000 }).catch(() => null), page.click(".home-cta .cta-signin")]);
  check("home: Sign in goes straight to Google (no dialog)", !!signin, "no /auth/google request");
  await page.goto(base + "/");
  await page.waitForSelector(".home-cta");
  await page.click(".home-cta a.btn-cta");
  check("home: View the notes opens a note without an account", await until(page, () => !!document.querySelector(".mde .ln") && location.pathname.startsWith("/app/")));
  check("/auth/guest is gone", (await page.evaluate(async () => (await fetch("/auth/guest", { method: "POST" })).status)) === 404);
  await ctx.close();
}

// ---- a server with no shared workspace (hosted): guests land in the demo, people signed in get the empty state ----
{
  const { ctx, page } = await context("no-default");
  await page.route("**/api/repos", (r) => r.fulfill({ json: [] }));
  await page.goto(`${base}/app`);
  check("no shared workspace: a guest on /app goes to the demo", await until(page, () => location.pathname.startsWith("/app/demo/") && !!document.querySelector(".demo-banner") && !!document.querySelector(".mde .ln")), await page.evaluate(() => location.pathname));
  await page.goto(`${base}/auth/dev?next=/app`);
  await page.fill("input[name=name]", "Nora");
  await page.click("form button[type=submit]");
  await page.route("**/api/workspaces", (r) => (r.request().method() === "GET" ? r.fulfill({ json: [] }) : r.continue()));
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${base}/app`);
  check("no workspaces: signed in, /app shows the empty state with New workspace", await until(page, () => location.pathname === "/app" && [...document.querySelectorAll(".empty-state button")].some((b) => b.textContent === "New workspace")), await page.evaluate(() => location.pathname + " " + document.querySelector("#doc, main")?.textContent?.slice(0, 200)));
  await ctx.close();
}

// ---- a guest and a signed-in person in the same note ----
const { ctx: gctx, page: guest } = await context("guest");
await guest.goto(`${base}/app/${WS}/Welcome.md`);
await guest.waitForSelector(".mde .ln", { timeout: 10000 });
const guestName = await guest.evaluate(() => JSON.parse(localStorage.getItem("grimoire.anon.v1")).name);
check("guest: has a made-up name, kept in this browser", /^[a-z]+-[a-z]+$/.test(guestName), guestName);
check("guest: not signed in (no account)", (await guest.evaluate(async () => (await fetch("/api/me")).status)) === 401);
check("guest: the account row just says Sign in", (await guest.textContent(".sb-account")) === "Sign in");
check("guest: no Share with an agent card", await guest.$eval(".sb-agent", (el) => el.hidden));
check("sidebar order: switcher, Search files, New note, tree", await guest.evaluate(() => {
  const y = (sel) => document.querySelector(sel).getBoundingClientRect().top;
  return y(".ws-switcher") < y(".sb-search") && y(".sb-search") < y(".new-note") && y(".new-note") < y(".sb-tree");
}));
await guest.screenshot({ path: `${SHOTS}/sidebar-order.png`, clip: { x: 0, y: 0, width: 300, height: 260 } });
await guest.screenshot({ path: `${SHOTS}/bottom-left-sign-in.png`, clip: { x: 0, y: 560, width: 300, height: 240 } });

const { ctx: actx, page: alice } = await context("alice");
await alice.goto(`${base}/auth/dev?next=/app/${WS}/Welcome.md`);
await alice.fill("input[name=name]", "Alice");
await alice.click("form button[type=submit]");
await alice.waitForSelector(".mde .ln", { timeout: 10000 });
check("signed in: the agent card is there", await alice.$eval(".sb-agent", (el) => !el.hidden));
check("signed in: the account row shows the name", (await alice.textContent(".sb-account")).includes("Alice"));

await guest.click(".mde .ln >> nth=0");
await guest.keyboard.press("End");
check("Alice sees the guest's cursor, named", await until(alice, (n) => [...document.querySelectorAll(".mde .rcaret .rlabel")].some((l) => l.textContent === n), guestName));
check("…and the guest in the participants list, marked as a guest", await until(alice, (n) => [...document.querySelectorAll(".participants .avatar.is-guest")].some((a) => a.title === `${n} (guest, not signed in)`), guestName));
await alice.screenshot({ path: `${SHOTS}/anon-cursor-seen-by-alice.png` });

// ---- guests edit freely ----
for (let i = 0; i < 12; i++) {
  await guest.keyboard.type(String.fromCharCode(97 + i));
  await sleep(QUIET + 100);
}
check("twelve separate edits all arrive (no limit)", await until(alice, () => document.querySelector(".mde")?.textContent.includes("abcdefghijkl")) && (await serverText()).includes("abcdefghijkl"), (await serverText()).slice(0, 80));
check("…the editor stays writable, no hint, no dialog", !(await guest.$(".mde.readonly")) && !(await guest.$(".anon-hint")) && !(await guest.$("dialog[open]")));
await guest.screenshot({ path: `${SHOTS}/guest-editing.png` });

// ---- New… (creating folders) needs an account; opening folders and notes doesn't ----
await guest.click(".ws-switcher");
await guest.click(".menu-item >> text=New…");
const folderLine = "You need to sign in to create workspaces. It's free.";
check("New… opens the sign-in dialog", await until(guest, (l) => document.querySelector("dialog.signin-modal[open] .signin-why")?.textContent === l, folderLine));
check("…with the sign-in options, the scratch note and the demo folder", await guest.$eval("dialog.signin-modal", (d) => d.querySelector("h2").textContent === "Sign in" && !!d.querySelector("a.btn-google") && !d.querySelector("input, form") && d.querySelector(".signin-scratch")?.textContent === "Play in a scratch note instead" && d.querySelector(".signin-demo")?.getAttribute("href") === "/app/demo"));
await guest.screenshot({ path: `${SHOTS}/sign-in-dialog.png` });
await guest.keyboard.press("Escape");
await guest.click(".ws-switcher");
await guest.click(".menu-item >> text=Open…");
check("Open… opens the Open dialog for a guest (no sign-in prompt), URL only (no GitHub repo tab)", await until(guest, () => !!document.querySelector("dialog.open-modal[open]") && document.activeElement?.getAttribute("aria-label") === "URL or workspace name") && !(await guest.$("dialog.signin-modal")) && JSON.stringify(await guest.$$eval(".open-choice", (els) => els.map((e) => e.textContent))) === JSON.stringify(["URL"]));
await guest.keyboard.type(`${base}/app/demo`);
await guest.keyboard.press("Enter");
// (the URL changes before the folder is open: the previous note stays on screen until then)
check("…a URL opens that folder, no sign-in prompt", await until(guest, () => location.pathname.startsWith("/app/demo") && document.querySelector(".ws-switcher .ws-title")?.textContent === "Demo" && !!document.querySelector(".mde .ln")) && !(await guest.$("dialog.signin-modal")), guest.url());
await guest.click(".ws-switcher");
check("…and it's in the guest's list", await until(guest, () => [...document.querySelectorAll(".ws-menu .menu-item .menu-label")].some((e) => e.textContent === "Demo")));
check("…remembered in this browser", await guest.evaluate(() => JSON.parse(localStorage.getItem("grimoire.visited.v1") ?? "[]").some((w) => w.id === "demo")));
await guest.click(".menu-item >> text=Open…");
await guest.waitForSelector("dialog.open-modal[open]");
await guest.keyboard.type(WS);
await guest.keyboard.press("Enter");
check("Open… with a folder name opens it", await until(guest, () => location.pathname.startsWith(`/app/${WS}`) && !!document.querySelector(".mde .ln")) && !(await guest.$("dialog.signin-modal")), guest.url());
// (back to a list with just Notes, for the × checks below)
await guest.evaluate(() => localStorage.setItem("grimoire.visited.v1", JSON.stringify(JSON.parse(localStorage.getItem("grimoire.visited.v1") ?? "[]").filter((w) => w.id !== "demo"))));
await guest.goto(`${base}/app/${WS}/Welcome.md`);
await guest.waitForSelector(".mde .ln");
// ---- creating, renaming, deleting and adding images need an account (outside the demo): a sign-in prompt instead ----
const writesBy = (page) => {
  const seen = [];
  const on = (r) => r.method() !== "GET" && seen.push(`${r.method()} ${new URL(r.url()).pathname}`);
  page.on("request", on);
  return { seen, stop: () => page.off("request", on) };
};
const prompted = (page, line) => until(page, (l) => document.querySelector("dialog.signin-modal[open] .signin-why")?.textContent === l, line);
const createLine = "Sign in to create notes and folders. It's free.";
{
  const w = writesBy(guest);
  await guest.click(".new-note");
  check("New note (a guest) asks to sign in, with Continue with Google only and no note made", await prompted(guest, createLine) && !!(await guest.$("dialog.signin-modal a.btn-google")) && !(await guest.$("dialog.signin-modal input")) && new URL(guest.url()).pathname !== `/app/${WS}/Untitled.md`);
  await guest.screenshot({ path: `${SHOTS}/new-note-sign-in.png` });
  await guest.keyboard.press("Escape");
  await guest.click(`.file-item:has(a[href="/app/${WS}/Welcome.md"]) .row-menu`);
  check("…the row menu still offers New note, New folder, Rename, Delete", JSON.stringify(await guest.$$eval(".menu-item .menu-label", (els) => els.map((e) => e.textContent))) === JSON.stringify(["New note", "New folder", "Rename", "Delete"]));
  await guest.click('.menu-item:has(.menu-label:text-is("New folder"))');
  check("…New folder asks to sign in", await prompted(guest, createLine));
  await guest.keyboard.press("Escape");
  await guest.click(`.file-item:has(a[href="/app/${WS}/Welcome.md"]) .row-menu`);
  await guest.click('.menu-item:has(.menu-label:text-is("Rename"))');
  check("…Rename asks to sign in (no rename field)", (await prompted(guest, "Sign in to rename notes and folders. It's free.")) && !(await guest.$(".sb-tree .row-rename")));
  await guest.keyboard.press("Escape");
  await guest.click(`.file-item:has(a[href="/app/${WS}/Welcome.md"]) .row-menu`);
  await guest.click('.menu-item:has(.menu-label:text-is("Delete"))');
  check("…Delete asks to sign in (no confirmation)", (await prompted(guest, "Sign in to delete notes and folders. It's free.")) && !(await guest.$("dialog[open] .btn-danger")));
  await guest.keyboard.press("Escape");
  await guest.focus(`.file-row[href="/app/${WS}/Welcome.md"]`);
  await guest.keyboard.press("Delete");
  check("…so does the Delete key on a tree row", (await prompted(guest, "Sign in to delete notes and folders. It's free.")) && !(await guest.$("dialog[open] .btn-danger")));
  await guest.keyboard.press("Escape");
  // pasting a screenshot
  await guest.click(".mde .ln >> nth=0");
  await guest.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" }));
    document.querySelector(".mde [contenteditable=true], .mde[contenteditable=true]")?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  check("…pasting an image asks to sign in (nothing uploaded)", await prompted(guest, "Sign in to add images. It's free."));
  await guest.keyboard.press("Escape");
  await sleep(300);
  check("…and none of it reached the server", w.seen.length === 0, JSON.stringify(w.seen));
  check("…closing the prompt forgets the action", (await guest.evaluate(() => sessionStorage.getItem("grimoire.afterSignIn.v1"))) === null);
  w.stop();
  check("the server refuses a guest's new note too", (await guest.evaluate(async (ws) => (await fetch(`/api/repos/${ws}/files`, { method: "POST", headers: { "content-type": "application/json", "x-grimoire-guest": "e2eGuest01", "x-grimoire-guest-name": "e2e-guest" }, body: JSON.stringify({ path: "Nope.md" }) })).status, WS)) === 401);
}
await guest.goto(`${base}/app/${WS}/Welcome.md`);
await guest.waitForSelector(".mde .ln");

// ---- the switcher's ×: the only folder can't go; others ask first ----
await guest.click(".ws-switcher");
await guest.click('.ws-menu .menu-row:has(.menu-label:text-is("Notes")) .menu-remove');
check("guest: × on the only workspace says it can't be removed", await until(guest, () => document.querySelector("dialog[open] h2")?.textContent === "Can't remove your only workspace"));
await guest.click('dialog[open] .modal-actions button:text-is("New workspace…")');
check("…New workspace… asks to sign in (a guest)", await until(guest, (l) => document.querySelector("dialog.signin-modal[open] .signin-why")?.textContent === l, folderLine));
await guest.keyboard.press("Escape");
const other = await alice.evaluate(async () => (await (await fetch("/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Other" }) })).json()).id);
await guest.goto(`${base}/app/${other}`);
await guest.waitForSelector(".ws-switcher .ws-title");
await until(guest, () => document.querySelector(".ws-switcher .ws-title")?.textContent === "Other");
await guest.click(".ws-switcher");
await guest.click('.ws-menu .menu-row:has(.menu-label:text-is("Other")) .menu-remove');
check("guest: × asks first", await until(guest, () => document.querySelector("dialog[open] h2")?.textContent === "Remove Other from your list?"));
await guest.click('dialog[open] .modal-actions button:text-is("Remove")');
check("…Remove takes it off this browser's list and switches away", await until(guest, () => document.querySelector(".ws-switcher .ws-title")?.textContent === "Notes" && !JSON.parse(localStorage.getItem("grimoire.visited.v1")).some((w) => w.title === "Other")));
await guest.goto(`${base}/app/${WS}/Welcome.md`);
await guest.waitForSelector(".mde .ln");

// ---- the scratch note ----
const noteText = await guest.evaluate(() => document.querySelector(".mde").mdeView.doc.text);
// (the plain Sign in goes straight to Google; a sign-in prompt offers the scratch note)
await guest.click(".new-note");
await guest.click("dialog.signin-modal .signin-scratch");
await guest.waitForURL(/\/scratch$/, { timeout: 10000 });
await guest.waitForSelector(".scratch-doc .mde .ln");
check("scratch: starts with the note's text", (await guest.evaluate(() => document.querySelector(".mde").mdeView.doc.text)) === noteText);
check("scratch: says it's only in this browser", (await guest.textContent(".scratch-banner")).includes("Scratch note — only in this browser, not saved to Grimoire") && (await guest.textContent(".scratch-back")) === "← Back to the notes");
const writes = [];
const onReq = (r) => (r.method() !== "GET" || r.url().includes("/ws")) && writes.push(`${r.method()} ${r.url()}`);
guest.on("request", onReq);
guest.on("websocket", (w) => writes.push(`ws ${w.url()}`));
await guest.click(".scratch-doc .mde .ln >> nth=0");
await guest.keyboard.press("End");
await guest.keyboard.type(" scratch-only");
await sleep(600);
check("scratch: edits stay local (no requests)", writes.length === 0, JSON.stringify(writes));
await guest.screenshot({ path: `${SHOTS}/scratch-note.png` });
await guest.reload();
await guest.waitForSelector(".scratch-doc .mde .ln");
check("scratch: a reload keeps the text (localStorage)", (await guest.evaluate(() => document.querySelector(".mde").textContent)).includes("scratch-only"));
check("scratch: never reached the note", !(await serverText()).includes("scratch-only"));
await guest.click(".scratch-banner button");
await guest.click("dialog[open] .btn-danger");
await sleep(500);
check("scratch: Clear empties it", (await guest.evaluate(() => document.querySelector(".mde").mdeView.doc.text)) === "" && JSON.parse(await guest.evaluate(() => localStorage.getItem("grimoire.scratch.v1"))).text === "");
guest.off("request", onReq);
{
  const { ctx, page } = await context("plain scratch");
  await page.goto(`${base}/scratch`);
  await page.waitForSelector(".scratch-doc .mde .ln");
  check("plain /scratch: a short Markdown demo", (await page.evaluate(() => document.querySelector(".mde").mdeView.doc.text)).startsWith("# Scratch note"));
  await ctx.close();
}

// ---- sign in from the dialog: back on the note, under the account's name ----
await guest.click(".scratch-back");
await guest.waitForSelector(".doc-body .mde .ln", { timeout: 10000 });
// a workspace the guest opens is kept when they sign in (merged into the account's list)
const kept = await alice.evaluate(async () => (await (await fetch("/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Kept" }) })).json()).id);
await guest.goto(`${base}/app/${kept}`);
await until(guest, () => document.querySelector(".ws-switcher .ws-title")?.textContent === "Kept");
await guest.goto(`${base}/app/${WS}/Welcome.md`);
await guest.waitForSelector(".doc-body .mde .ln", { timeout: 10000 });
// New note as a guest → sign in from the prompt → back in the workspace, and the note is made
await guest.click(".new-note");
await prompted(guest, createLine);
await guest.click("dialog.signin-modal a.btn-google");
await guest.waitForURL(/\/auth$|\/auth\?/, { timeout: 10000 });
await guest.fill("#email", "gina@example.com");
await guest.fill("#name", "Gina");
await guest.click("#go");
check("signed in from New note: the note is made and opened", await until(guest, (ws) => location.pathname === `/app/${ws}/Untitled.md` && !!document.querySelector(".mde"), WS, 15000), guest.url());
await guest.keyboard.type("# Gina note");
await guest.keyboard.press("Enter");
check("…focused, and named after its heading", await until(guest, (ws) => location.pathname === `/app/${ws}/Gina%20note.md`, WS), guest.url());
check("signed in: the workspaces opened as a guest are in the account's list", await guest.evaluate(async (k) => (await (await fetch("/api/workspaces")).json()).some((w) => w.id === k), kept) && (await guest.evaluate(() => localStorage.getItem("grimoire.visited.v1"))) === null);
await guest.goto(`${base}/app/${WS}/Welcome.md`);
await guest.waitForSelector(".doc-body .mde .ln", { timeout: 10000 });
check("signed in: the note is writable", await until(guest, () => !document.querySelector(".mde.readonly")));
check("signed in: the account row shows Gina, the agent card is there", (await guest.textContent(".sb-account")).includes("Gina") && (await guest.$eval(".sb-agent", (el) => !el.hidden)));
await guest.click(".mde .ln >> nth=0");
await guest.keyboard.press("End");
await guest.keyboard.type(" Gina was here");
check("signed in: edits reach Alice", await until(alice, () => document.querySelector(".mde").textContent.includes("Gina was here")));
check("signed in: Alice sees the cursor named Gina now", await until(alice, () => [...document.querySelectorAll(".mde .rcaret .rlabel")].some((l) => l.textContent === "Gina")));
// the guest's edits stay in the history under the guest name
await T.save(WS, "Welcome.md");
const hist = await T.history(WS, "Welcome.md", 20);
check("history: the guest's edits under '<name> (guest)'", hist.some((c) => c.authorName === `${guestName} (guest)` && c.authorEmail === "guest@grimoire.invalid"), JSON.stringify(hist.map((c) => c.authorName)));

await browser.close();
await T.stop();
fake.stop();
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
