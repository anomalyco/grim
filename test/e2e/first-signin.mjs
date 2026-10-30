// End-to-end: the one-time welcome after a first sign-in. A new account lands in its own new workspace
// ("<First name>'s notes", POST /api/workspaces/personal answering created: true) and sees "Welcome to Grim" once it's
// open: where its notes live, that anyone with the link can see and edit them, beta / no private notes, self-host
// link (new tab), "Got it" (Escape closes it too). A reload, and signing in again, don't show it again.
// Usage: bun run build:client && bun test/e2e/first-signin.mjs
// Needs playwright-core in /tmp/opencode/pw and the Playwright Chromium headless shell.
import "../local-storage.ts";
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { startTarget } from "./target.mjs";

const T = await startTarget();
const base = T.base;
const browser = await chromium.launch({
  executablePath: "/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell",
});
let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(ok ? "ok  " : "FAIL", name, ok ? "" : detail);
};
const until = (page, fn, arg, timeout = 8000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
const dialogOpen = (page) => page.evaluate(() => !!document.querySelector("dialog.modal[open]"));

const signIn = async (page, name) => {
  await page.goto(`${base}/auth/dev?next=/app`);
  await page.fill("input[name=name]", name);
  await page.click("form button[type=submit]");
  await page.waitForSelector(".mde .ln", { timeout: 10000 });
};

const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await signIn(page, "Wendy Welcome");
check("first sign-in: the welcome opens", await until(page, () => document.querySelector("dialog.modal[open] h2")?.textContent === "Welcome to Grim"));
const text = await page.evaluate(() => document.querySelector("dialog.modal[open] .modal-body")?.textContent ?? "");
check("…names the new workspace", text.includes("Your notes live in “Wendy's notes”."), text);
check("…says anyone with the link can see and edit", text.includes("can see and edit its notes"), text);
check("…beta, no private notes", text.includes("Grim is in beta, and private notes aren’t available yet."), text);
const link = await page.evaluate(() => {
  const a = document.querySelector("dialog.modal[open] a");
  return a && { href: a.getAttribute("href"), target: a.getAttribute("target") };
});
check("…self-host link in a new tab", link?.href === "https://github.com/anomalyco/grim" && link?.target === "_blank", JSON.stringify(link));
check("…one button, Got it", (await page.evaluate(() => [...document.querySelectorAll("dialog.modal[open] button.btn")].map((b) => b.textContent))).join() === "Got it");
await page.keyboard.press("Escape");
check("Escape closes it", await until(page, () => !document.querySelector("dialog.modal[open]")));

// shown once: a reload, and the same account signing in again, don't show it
await page.reload();
await page.waitForSelector(".mde .ln", { timeout: 10000 });
check("reload: no welcome", !(await dialogOpen(page)));
const again = (await page.evaluate(() => fetch("/api/workspaces/personal", { method: "POST" }).then((r) => r.json()))).created;
check("the server: created is false after the first time", again === false, String(again));

// the same account in a fresh browser (its session cookie, nothing in localStorage; the test sign-in always makes a
// new account): the server says created: false, so no welcome
const ctx2 = await browser.newContext({ viewport: { width: 1200, height: 800 } });
await ctx2.addCookies(await ctx.cookies());
const page2 = await ctx2.newPage();
await page2.goto(`${base}/app`);
await page2.waitForSelector(".mde .ln", { timeout: 10000 });
check("the same account in another browser: no welcome", !(await dialogOpen(page2)));

// Got it closes it (another new account)
const ctx3 = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const page3 = await ctx3.newPage();
await signIn(page3, "Gus");
await until(page3, () => !!document.querySelector("dialog.modal[open]"));
await page3.click("dialog.modal[open] button.btn-primary");
check("Got it closes it", await until(page3, () => !document.querySelector("dialog.modal[open]")));

await browser.close();
await T.stop();
console.log(fails ? `${fails} failed` : "all ok");
process.exit(fails ? 1 : 0);
