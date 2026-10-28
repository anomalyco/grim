// End-to-end: visitors who aren't signed in ("guests"). They see and edit the notes without an account (no limit),
// their cursor carries a made-up name that others see, they create notes; only New… and Open… (folders) ask them to
// sign in. The sign-in dialog also offers a scratch note (local only). Signing in from it lands back on the note under
// the account's name. Also: the switcher's × (confirm; the only folder can't go).
// Usage: bun run build:client && bun test/e2e/anon.mjs   (screenshots in /tmp/opencode/anon/)
// Needs playwright-core in /tmp/opencode/pw and the Playwright Chromium headless shell.
import "../local-storage.ts";
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHOTS = "/tmp/opencode/anon";
mkdirSync(SHOTS, { recursive: true });
const QUIET = 700;
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "np-e2e-anon-"));
process.env.ALLOW_DEV_LOGIN = "1";
process.env.QUIET_MS = String(QUIET);
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
const until = (page, fn, arg, timeout = 10000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const serverText = () => app.ctx.rooms.peek("notes", "Welcome.md")?.text.toString() ?? "";

async function context(name) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
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
  await page.click(".home-cta .cta-signin");
  check("home: Sign in opens the sign-in options (no limit wording)", await until(page, () => {
    const d = document.querySelector("dialog.signin-modal[open]");
    return !!d && d.querySelector("h2")?.textContent === "Sign in" && !!d.querySelector(".signin-name") && !d.textContent.includes("guest edits");
  }));
  await page.keyboard.press("Escape");
  await page.click(".home-cta a.btn-cta");
  check("home: View the notes opens a note without an account", await until(page, () => !!document.querySelector(".mde .ln") && location.pathname.startsWith("/app/")));
  check("/auth/guest is gone", (await page.evaluate(async () => (await fetch("/auth/guest", { method: "POST" })).status)) === 404);
  await ctx.close();
}

// ---- a guest and a signed-in person in the same note ----
const { ctx: gctx, page: guest } = await context("guest");
await guest.goto(`${base}/app/notes/Welcome.md`);
await guest.waitForSelector(".mde .ln", { timeout: 10000 });
const guestName = await guest.evaluate(() => JSON.parse(localStorage.getItem("grimoire.anon.v1")).name);
check("guest: has a made-up name, kept in this browser", /^[a-z]+-[a-z]+$/.test(guestName), guestName);
check("guest: not signed in (no account)", (await guest.evaluate(async () => (await fetch("/api/me")).status)) === 401);
check("guest: the account row just says Sign in", (await guest.textContent(".sb-account")) === "Sign in");
check("guest: no Share with an agent card", await guest.$eval(".sb-agent", (el) => el.hidden));
check("sidebar order: switcher, Filter files, New note, tree", await guest.evaluate(() => {
  const y = (sel) => document.querySelector(sel).getBoundingClientRect().top;
  return y(".ws-switcher") < y(".sb-filter") && y(".sb-filter") < y(".new-note") && y(".new-note") < y(".sb-tree");
}));
await guest.screenshot({ path: `${SHOTS}/sidebar-order.png`, clip: { x: 0, y: 0, width: 300, height: 260 } });
await guest.screenshot({ path: `${SHOTS}/bottom-left-sign-in.png`, clip: { x: 0, y: 560, width: 300, height: 240 } });

const { ctx: actx, page: alice } = await context("alice");
await alice.goto(`${base}/auth/dev?next=/app/notes/Welcome.md`);
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
check("twelve separate edits all arrive (no limit)", await until(alice, () => document.querySelector(".mde")?.textContent.includes("abcdefghijkl")) && serverText().includes("abcdefghijkl"), serverText().slice(0, 80));
check("…the editor stays writable, no hint, no dialog", !(await guest.$(".mde.readonly")) && !(await guest.$(".anon-hint")) && !(await guest.$("dialog[open]")));
await guest.screenshot({ path: `${SHOTS}/guest-editing.png` });

// ---- New… and Open… (folders) need an account; notes don't ----
await guest.click(".ws-switcher");
await guest.click(".menu-item >> text=New…");
const folderLine = "You need to sign in to create or open folders. It's free.";
check("New… opens the sign-in dialog", await until(guest, (l) => document.querySelector("dialog.signin-modal[open] .signin-why")?.textContent === l, folderLine));
check("…with the sign-in options, the scratch note and the demo folder", await guest.$eval("dialog.signin-modal", (d) => d.querySelector("h2").textContent === "Sign in" && !!d.querySelector(".signin-name input[name=name]") && d.querySelector(".signin-scratch")?.textContent === "Play in a scratch note instead" && d.querySelector(".signin-demo")?.getAttribute("href") === "/app/demo"));
await guest.screenshot({ path: `${SHOTS}/sign-in-dialog.png` });
await guest.keyboard.press("Escape");
await guest.click(".ws-switcher");
await guest.click(".menu-item >> text=Open…");
check("Open… opens the sign-in dialog", await until(guest, (l) => document.querySelector("dialog.signin-modal[open] .signin-why")?.textContent === l, folderLine) && !(await guest.$("dialog.open-modal")));
await guest.keyboard.press("Escape");
await guest.click(".new-note");
check("a guest creates a note (New note: Untitled.md at once)", await until(guest, () => location.pathname === "/app/notes/Untitled.md" && !!document.querySelector(".mde")));
await guest.keyboard.type("# Guest note");
await guest.keyboard.press("Enter");
check("…and names it after its heading", await until(guest, () => location.pathname === "/app/notes/Guest%20note.md"), guest.url());
await app.ctx.rooms.peek("notes", "Guest note.md")?.flush();
const gh = await app.ctx.store.history("notes", "main", "Guest note.md", 5);
check("…authored as '<name> (guest)'", gh.length > 0 && gh.every((c) => c.authorName === `${guestName} (guest)`), JSON.stringify(gh));
await guest.click('.file-item:has(a[href="/app/notes/Guest%20note.md"]) .row-menu');
await guest.click(".menu-item >> text=Rename…");
await guest.fill("dialog[open] input", "guest-renamed.md");
await guest.keyboard.press("Enter");
check("a guest renames a note", await until(guest, () => !!document.querySelector('.file-row[href="/app/notes/guest-renamed.md"]')));
await guest.goto(`${base}/app/notes/Welcome.md`);
await guest.waitForSelector(".mde .ln");

// ---- the switcher's ×: the only folder can't go; others ask first ----
await guest.click(".ws-switcher");
await guest.click('.ws-menu .menu-row:has(.menu-label:text-is("Notes")) .menu-remove');
check("guest: × on the only folder says it can't be removed", await until(guest, () => document.querySelector("dialog[open] h2")?.textContent === "Can't remove your only folder"));
await guest.click('dialog[open] .modal-actions button:text-is("New folder…")');
check("…New folder… asks to sign in (a guest)", await until(guest, (l) => document.querySelector("dialog.signin-modal[open] .signin-why")?.textContent === l, folderLine));
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
await guest.goto(`${base}/app/notes/Welcome.md`);
await guest.waitForSelector(".mde .ln");

// ---- the scratch note ----
const noteText = await guest.evaluate(() => document.querySelector(".mde").mdeView.doc.text);
await guest.click(".sb-account");
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
check("scratch: never reached the note", !serverText().includes("scratch-only"));
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
await guest.click(".sb-account");
await until(guest, () => !!document.querySelector("dialog.signin-modal[open]"));
await guest.fill("dialog.signin-modal input[name=name]", "Gina");
await guest.click("dialog.signin-modal .signin-name button[type=submit]");
await guest.waitForURL(/\/app\/notes\/Welcome\.md$/, { timeout: 10000 });
await guest.waitForSelector(".doc-body .mde .ln", { timeout: 10000 });
check("signed in: back on the same note, writable", await until(guest, () => !document.querySelector(".mde.readonly")));
check("signed in: the account row shows Gina, the agent card is there", (await guest.textContent(".sb-account")).includes("Gina") && (await guest.$eval(".sb-agent", (el) => !el.hidden)));
await guest.click(".mde .ln >> nth=0");
await guest.keyboard.press("End");
await guest.keyboard.type(" Gina was here");
check("signed in: edits reach Alice", await until(alice, () => document.querySelector(".mde").textContent.includes("Gina was here")));
check("signed in: Alice sees the cursor named Gina now", await until(alice, () => [...document.querySelectorAll(".mde .rcaret .rlabel")].some((l) => l.textContent === "Gina")));
// the guest's edits stay in the history under the guest name
await app.ctx.rooms.peek("notes", "Welcome.md")?.flush();
const hist = await app.ctx.store.history("notes", "main", "Welcome.md", 20);
check("history: the guest's edits under '<name> (guest)'", hist.some((c) => c.authorName === `${guestName} (guest)` && c.authorEmail === "guest@grimoire.invalid"), JSON.stringify(hist.map((c) => c.authorName)));

await browser.close();
await app.stop();
rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
