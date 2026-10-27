// "Bob" in a headless browser on the scratch server, editing the note the Mac client edits.
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
const base = process.env.W3_BASE;
const note = process.env.W3_NOTE || "/app/notes/Welcome.md";
const browser = await chromium.launch({
  executablePath: "/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell",
});
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => log("PAGEERROR", e.message));
await page.goto(base + "/");
await page.fill("input[name=name]", "Bob");
await page.click("form button[type=submit], form button");
await page.waitForURL(/\/app/, { timeout: 15000 });
await page.goto(base + note);
await page.waitForSelector(".mde .ln", { timeout: 15000 });
log("opened", page.url());
await page.click(".mde .ln >> nth=2");
await page.keyboard.press("End");
await page.keyboard.type(" Bob was here");
log("typed");
const has = (s) => page.waitForFunction((s) => document.querySelector(".mde")?.textContent?.includes(s), s, { timeout: 180000 });
await has("Mac was here");
log("sees the Mac's edit");
const label = await page
  .waitForFunction(() => [...document.querySelectorAll(".mde .rcaret .rlabel")].some((l) => l.textContent === "Mac user"), null, { timeout: 20000 })
  .then(() => true, () => false);
log("Mac's caret label visible:", label);
await page.screenshot({ path: "/tmp/opencode/workspaces/native/web-sees-mac-cursor.png" });
await page.click(".mde .ln >> nth=2");
await page.keyboard.press("End");
await page.keyboard.type(" Bob saw Mac");
await new Promise((r) => setTimeout(r, 3000));
const cookie = (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
const f = await (await fetch(`${base}/api/repos/notes/file?path=${encodeURIComponent(note.split("/").slice(3).join("/"))}`, { headers: { cookie } })).json();
console.log("BOB-TEXT-BEGIN\n" + f.content + "\nBOB-TEXT-END");
await browser.close();
