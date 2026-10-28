// End-to-end: the demo folder. The home page's "View the notes" opens it, a guest edits it freely (well past what
// used to be the guest limit) with the demo banner shown, and the history panel shows the edits with their diff.
// Usage: bun run build:client && bun test/e2e/demo.mjs   (screenshots in /tmp/opencode/anon/)
// Needs playwright-core in /tmp/opencode/pw and the Playwright Chromium headless shell.
import "../local-storage.ts";
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHOTS = "/tmp/opencode/anon";
mkdirSync(SHOTS, { recursive: true });
const QUIET = 500;
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "np-e2e-demo-"));
process.env.ALLOW_DEV_LOGIN = "1";
process.env.QUIET_MS = String(QUIET);
process.env.PORT = "0";
const { startServer } = await import("../../src/server/index.ts");
const { resetDemo } = await import("../../src/server/demo.ts");
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

const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto(base + "/");
await page.click(".home-cta a.btn-cta");
check("home → View the notes → the demo's Welcome note", await until(page, () => location.pathname === "/app/demo/Welcome.md" && document.querySelector(".mde")?.textContent.includes("Welcome to the demo")), page.url());
check("the switcher says Demo", await until(page, () => document.querySelector(".ws-switcher .ws-title")?.textContent === "Demo"));
check("the demo banner", (await page.textContent(".demo-banner").catch(() => null)) === "Demo folder — anyone can edit; it resets every few hours.");
check("the seed's image shows", await until(page, () => [...document.querySelectorAll(".mde img")].some((i) => i.complete && i.naturalWidth > 0)));
check("the tour subfolder is in the tree", await until(page, () => !!document.querySelector('.file-row[href="/app/demo/tour/Ideas.md"]')));
await page.screenshot({ path: `${SHOTS}/demo-folder.png` });

// a guest edits freely: 14 separate edits
await page.click(".mde .ln >> nth=2");
await page.keyboard.press("End");
for (let i = 0; i < 14; i++) {
  await page.keyboard.type(` e${i}`);
  await sleep(QUIET + 150);
}
const live = () => app.ctx.rooms.peek("demo", "Welcome.md")?.text.toString() ?? "";
check("fourteen guest edits all arrive", await until(page, () => true) && live().includes(" e0") && live().includes(" e13"), live().slice(0, 200));
check("…no read-only, no sign-in prompt", !(await page.$(".mde.readonly")) && !(await page.$("dialog[open]")));
await sleep(QUIET * 3);

// the history panel
await page.click("button.btn-tab:text-is('History')");
check("history lists the edits and the seed", await until(page, () => {
  const t = document.body.innerText;
  return t.includes("Start the demo") && t.includes("Update Welcome.md");
}), await page.evaluate(() => document.querySelector(".history")?.innerText.slice(0, 300)));
await page.click(".history .commits .commit >> nth=0");
check("…with the diff of the latest edit", await until(page, () => /e13/.test(document.querySelector(".history")?.innerText ?? "")), await page.evaluate(() => document.querySelector(".history")?.innerText.slice(0, 500)));
await page.screenshot({ path: `${SHOTS}/demo-history.png` });

// a reset: the open note reloads to the seed
await resetDemo(app.ctx);
check("after a reset the open note is back to the seed", await until(page, () => !document.querySelector(".mde")?.textContent.includes("e13") && document.querySelector(".mde")?.textContent.includes("Welcome to the demo"), undefined, 15000));

await browser.close();
await app.stop();
rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
