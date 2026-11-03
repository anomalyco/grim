// End-to-end: Back and Forward (the header's ‹ ›, ⌘[ / ⌘] or Ctrl+[ / Ctrl+], the browser's own): open A, B, C;
// Back twice is A, Forward is B; opening D drops what was ahead; the browser's Back agrees with the header's; the
// buttons are disabled with nowhere to go; a note comes back at its scroll and caret.
// Usage: bun run build:client && bun test/e2e/nav.mjs   (screenshots in /tmp/opencode/nav/)
// Needs playwright-core in /tmp/opencode/pw and the Playwright Chromium headless shell.
import "../local-storage.ts";
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { mkdirSync } from "node:fs";
import { startTarget } from "./target.mjs";

const SHOTS = "/tmp/opencode/nav";
mkdirSync(SHOTS, { recursive: true });
const T = await startTarget({ env: { QUIET_MS: "600" } });
const base = T.base;

const browser = await chromium.launch({
  executablePath: "/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell",
});
let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(ok ? "ok  " : "FAIL", name, ok ? "" : detail);
};
const until = (page, fn, arg, timeout = 10000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);

const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
// signed in, an account lands in its own workspace (made for it)
await page.goto(`${base}/auth/dev?next=/app`);
await page.fill("input[name=name]", "Alice");
await page.click("form button[type=submit]");
await until(page, () => /^\/app\/[^/]+/.test(location.pathname), null, 15000);
const WS = await page.evaluate(() => decodeURIComponent(location.pathname.split("/")[2]));
await page.waitForSelector(".mde .ln", { timeout: 10000 });
const FIRST = await page.evaluate(() => document.querySelector(".crumb-file")?.textContent);
await page.keyboard.press("Escape");

const long = "# Long\n\n" + Array.from({ length: 150 }, (_, i) => `Line ${i + 1} of a long note.`).join("\n\n") + "\n";
for (const [path, content] of [["A.md", "# A\n"], ["B.md", long], ["C.md", "# C\n"], ["D.md", "# D\n"]]) {
  await page.evaluate(([ws, path, content]) => fetch(`/api/workspace/${ws}/files`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, content }) }), [WS, path, content]);
  await T.save(WS, path);
}
await page.reload();
await page.waitForSelector(`.file-row[href="/app/${WS}/D.md"]`, { timeout: 10000 });
await page.keyboard.press("Escape");

const note = () => page.evaluate(() => decodeURIComponent(location.pathname).split("/").pop());
const buttons = () => page.evaluate(() => [...document.querySelectorAll(".nav-btn")].map((b) => (b.disabled ? "off" : "on")).join(" "));
/** The note at `name` shows (the URL, the breadcrumb and its text). */
const at = (name) => until(page, (name) => decodeURIComponent(location.pathname).endsWith("/" + name + ".md") && document.querySelector(".crumb-file")?.textContent === name && !!document.querySelector(".mde .ln"), name, 8000);
const open = async (name) => {
  await page.click(`.file-row[href="/app/${WS}/${name}.md"]`);
  return at(name);
};
const key = (k) => page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+${k}`);

check("the header has ‹ and › before the breadcrumb", await page.evaluate(() => {
  const nav = document.querySelector(".doc-header .nav-btns");
  const [b, f] = [...document.querySelectorAll(".nav-btn")];
  return !!nav && nav.nextElementSibling?.classList.contains("breadcrumb") && b.title === "Back (Ctrl+[)" && f.title === "Forward (Ctrl+])";
}));

check("open A", await open("A"));
check("open B", await open("B"));
// B scrolled down with the caret on a line there
await page.evaluate(() => (document.querySelector(".doc-body").scrollTop = 1500));
await page.mouse.click(700, 450);
await page.waitForTimeout(150);
const bScroll = await page.evaluate(() => document.querySelector(".doc-body").scrollTop);
/** The caret: its line's text and offset. */
const caret = () => page.evaluate(() => {
  const s = window.getSelection();
  return s?.anchorNode ? `${s.anchorNode.parentElement?.closest(".ln")?.textContent}@${s.anchorOffset}` : "none";
});
const bCaret = await caret();
check("open C", await open("C"));
check("A B C: Back on, Forward off", (await buttons()) === "on off", await buttons());
await page.screenshot({ path: `${SHOTS}/header-abc.png`, clip: { x: 0, y: 0, width: 1200, height: 120 } });

await page.click(".nav-btn[aria-label=Back]");
check("‹ → B", await at("B"));
check("…B comes back at its scroll", await until(page, (want) => Math.abs(document.querySelector(".doc-body").scrollTop - want) < 4, bScroll, 4000), `${await page.evaluate(() => document.querySelector(".doc-body").scrollTop)} vs ${bScroll}`);
check("…and its caret", await until(page, (want) => {
  const s = window.getSelection();
  return !!s?.anchorNode && `${s.anchorNode.parentElement?.closest(".ln")?.textContent}@${s.anchorOffset}` === want;
}, bCaret, 4000), `${await caret()} vs ${bCaret}`);
await page.screenshot({ path: `${SHOTS}/back-to-b.png` });
await page.click(".nav-btn[aria-label=Back]");
check("‹ again → A", await at("A"));
check("…Back and Forward on", (await buttons()) === "on on", await buttons());
await page.click(".nav-btn[aria-label=Forward]");
check("› → B", await at("B"));

// the browser's own Back and Forward agree
await page.goBack();
check("browser Back → A", await at("A"));
await page.goForward();
check("browser Forward → B", await at("B"));
await page.goForward();
check("browser Forward → C", await at("C"));
check("…at the end: Forward off", (await buttons()) === "on off", await buttons());

// the keys (Ctrl+[ / Ctrl+] here; ⌘ on a Mac), from the editor too
await page.click(".mde .ln");
await key("BracketLeft");
check("Ctrl+[ → B", await at("B"));
await key("BracketLeft");
check("Ctrl+[ → A", await at("A"));
await key("BracketRight");
check("Ctrl+] → B", await at("B"));

// somewhere new drops what was ahead
check("open D", await open("D"));
check("…Forward off (C is gone from ahead)", (await buttons()) === "on off", await buttons());
await key("BracketRight");
await page.waitForTimeout(300);
check("…Ctrl+] stays on D", (await note()) === "D.md", await note());
await key("BracketLeft");
check("Back from D → B", await at("B"));
await key("BracketLeft");
check("…→ A", await at("A"));
await key("BracketLeft");
check(`…→ ${FIRST} (the first note)`, await at(FIRST));
check("…the first place: Back off", (await buttons()) === "off on", await buttons());
await page.screenshot({ path: `${SHOTS}/header-first.png`, clip: { x: 0, y: 0, width: 1200, height: 120 } });

// a reload keeps the tab's place
await page.reload();
await page.waitForSelector(".mde .ln", { timeout: 10000 });
check("after a reload: Back off, Forward on", await until(page, () => [...document.querySelectorAll(".nav-btn")].map((b) => (b.disabled ? "off" : "on")).join(" ") === "off on", null, 4000), await buttons());
await page.click(".nav-btn[aria-label=Forward]");
check("…› → A", await at("A"));

// on a Mac: ⌘[ / ⌘] (and the tooltips say so)
{
  const mac = await browser.newContext({ viewport: { width: 1200, height: 800 }, storageState: await ctx.storageState() });
  await mac.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" }));
  const p = await mac.newPage();
  await p.goto(`${base}/app/${WS}/A.md`);
  await p.waitForSelector(".mde .ln", { timeout: 10000 });
  await p.click(`.file-row[href="/app/${WS}/C.md"]`);
  await until(p, () => location.pathname.endsWith("/C.md"), null, 8000);
  check("Mac: the tooltips say ⌘[ and ⌘]", await p.evaluate(() => [...document.querySelectorAll(".nav-btn")].map((b) => b.title).join() === "Back (⌘[),Forward (⌘])"));
  await p.keyboard.press("Meta+BracketLeft");
  check("Mac: ⌘[ → A", await until(p, () => location.pathname.endsWith("/A.md") && document.querySelector(".crumb-file")?.textContent === "A", null, 8000));
  await p.keyboard.press("Meta+BracketRight");
  check("Mac: ⌘] → C", await until(p, () => location.pathname.endsWith("/C.md") && document.querySelector(".crumb-file")?.textContent === "C", null, 8000));
  await mac.close();
}

await browser.close();
await T.stop();
console.log(fails ? `${fails} failed` : "all ok");
process.exit(fails ? 1 : 0);
