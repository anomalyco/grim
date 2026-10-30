// End-to-end: the landing page doodle (your pencil and the bots', all in the browser: no socket) through the real
// server.
// Usage: bun run build:client && bun test/e2e/home-doodle.mjs   (SHOTS=dir for screenshots, RECORD=1 for a video)
// Needs playwright-core in /tmp/opencode/pw and the Playwright Chromium headless shell (WebGL via SwiftShader).
import "../local-storage.ts";
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "np-e2e-home-"));
process.env.ALLOW_DEV_LOGIN = "1";
process.env.SIGN_IN = "on";
// (the landing page and its pencils are only on the marketing site)
process.env.MARKETING_SITE = "on";
process.env.PORT = "0";
const { startServer } = await import("../../src/server/index.ts");
const app = await startServer({ port: 0, quiet: true });
const base = `http://localhost:${app.server.port}`;
const shots = process.env.SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

const browser = await chromium.launch({
  executablePath: "/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell",
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(ok ? "ok  " : "FAIL", name, ok ? "" : detail);
};
const errors = [];
const sockets = [];

async function visitor(name, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, ...opts });
  const page = await ctx.newPage();
  page.on("websocket", (ws) => sockets.push(`[${name}] ${ws.url()}`));
  page.on("pageerror", (e) => errors.push(`[${name}] ${e.message}`));
  page.on("crash", () => errors.push(`[${name}] page crashed`));
  page.on("console", (m) => m.type() === "error" && !m.text().includes("401") && errors.push(`[${name}] console: ${m.text()}`));
  await page.goto(base + "/");
  return page;
}

/** Ink pixels (alpha > 0) in a page-space rectangle of the doodle canvas. */
const inkIn = (page, x0, y0, x1, y1) =>
  page.evaluate(
    ([x0, y0, x1, y1]) => {
      const c = document.querySelector("canvas.doodle-ink");
      if (!c) return -1;
      const k = c.width / parseFloat(c.style.width);
      const d = c.getContext("2d").getImageData(x0 * k, y0 * k, (x1 - x0) * k, (y1 - y0) * k).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
      return n;
    },
    [x0, y0, x1, y1],
  );

const alice = await visitor("alice", process.env.RECORD ? { recordVideo: { dir: join(process.env.DATA_DIR, "video"), size: { width: 960, height: 600 } } } : {});
await alice.waitForSelector("canvas.doodle-ink", { state: "attached", timeout: 10000 });
check("pencil canvas (WebGL) is up", await alice.locator("canvas.doodle-gl").count() === 1);
await alice.waitForFunction(() => document.querySelectorAll(".doodle-label").length >= 2, null, { timeout: 10000 }).then(
  () => check("bot pencils arrive with labels", true),
  () => check("bot pencils arrive with labels", false),
);
await alice.mouse.move(80, 300);
await alice.waitForFunction(() => +(document.getElementById("app")?.dataset.pencils ?? 0) >= 3, null, { timeout: 10000 }).then(
  () => check("pencils render (bots + mine)", true),
  () => check("pencils render (bots + mine)", false, String(alice.evaluate(() => document.getElementById("app")?.dataset.pencils))),
);
check("system cursor hidden over the page", (await alice.evaluate(() => getComputedStyle(document.querySelector(".home-hero")).cursor)) === "none");
await alice.waitForFunction(() => {
  const c = document.querySelector("canvas.doodle-ink");
  const d = c.getContext("2d").getImageData(0, 0, c.width, Math.min(c.height, 900 * (c.width / parseFloat(c.style.width)))).data;
  for (let i = 3; i < d.length; i += 4 * 7) if (d[i] > 0) return true;
  return false;
}, null, { timeout: 15000, polling: 500 }).then(
  () => check("bots draw words", true),
  () => check("bots draw words", false),
);

// Alice draws a zigzag in the left margin: it shows on her page (nobody else's: nothing leaves the page)
await alice.mouse.move(60, 320);
await alice.mouse.down();
for (let i = 1; i <= 14; i++) await alice.mouse.move(60 + (i % 2 ? 70 : 0), 320 + i * 20, { steps: 3 });
await alice.mouse.up();
check("Alice's drawing shows on her page", (await inkIn(alice, 40, 300, 150, 620)) > 200);

// A refresh starts afresh: no ink, no pencils, then the bots come in again one at a time
await alice.reload();
await alice.waitForSelector("canvas.doodle-ink", { state: "attached", timeout: 10000 });
const fresh = await alice.evaluate(() => ({ ink: document.getElementById("app").dataset.ink ?? "0", labels: [...document.querySelectorAll(".doodle-label")].filter((l) => !l.hidden).length }));
check("a refresh starts over: an empty page", fresh.ink === "0" && fresh.labels === 0, JSON.stringify(fresh));
await alice.waitForFunction(() => [...document.querySelectorAll(".doodle-label")].filter((l) => !l.hidden).length === 3, null, { timeout: 10000 }).then(
  () => check("…and the bots come in again", true),
  () => check("…and the bots come in again", false),
);

// The CTA still opens the notes (no account needed) (before Alice makes the page grow below: resizing a big canvas
// stalls the shared software GPU in headless Chromium for a long while)
const bob = await visitor("bob", { reducedMotion: "reduce" });
await bob.click(".home-cta a.btn-cta");
await bob.waitForURL(/\/app\//, { timeout: 10000 }).then(
  () => check("the CTA opens the notes", true),
  () => check("the CTA opens the notes", false, bob.url()),
);
await bob.context().close();

// Below the fold: every spot has either the pencil or a system cursor, text can be selected, and the ink grows with
// the page
await alice.locator(".home-cta").scrollIntoViewIfNeeded();
const cursorAt = (x, y) =>
  alice.evaluate(([x, y]) => getComputedStyle(document.elementFromPoint(x, y)).cursor, [x, y]);
const spots = await alice.evaluate(() => {
  const r = (sel) => document.querySelector(sel).getBoundingClientRect();
  const cta = r(".home-cta");
  // (the footer's line: the plain text below the fold, now the note says everything)
  const about = r(".site-footer .copyright p");
  return { cta: [cta.left + 8, cta.top + cta.height / 2], about: [about.left + 30, about.top + 8], aboutEnd: [about.right - 40, about.bottom - 4] };
});
for (const [name, [x, y]] of Object.entries({ "call to action (whitespace)": spots.cta, "footer text": spots.about })) {
  await alice.mouse.move(x - 5, y);
  await alice.mouse.move(x, y, { steps: 2 });
  await alice.waitForTimeout(250);
  const mine = await alice.evaluate(() => document.getElementById("app").dataset.mine);
  const cur = await cursorAt(x, y);
  check(`${name}: pencil or system cursor`, (mine === "1") === (cur === "none"), `pencil ${mine}, cursor ${cur}`);
}
await alice.mouse.move(...spots.about);
await alice.mouse.down();
await alice.mouse.move(...spots.aboutEnd.map((v, i) => (v + spots.about[i]) / 2), { steps: 4 });
const drewWhileSelecting = await alice.evaluate(() => document.getElementById("app").classList.contains("doodling"));
await alice.mouse.move(...spots.aboutEnd, { steps: 4 });
await alice.mouse.up();
check("text can be selected", (await alice.evaluate(() => String(getSelection()).length)) > 20);
check("selecting text doesn't draw", !drewWhileSelecting);
// [canvas height, page height (the bottom of the content: the footer), height the page scrolls to]
const inkHeight = () =>
  alice.evaluate(() => {
    const page = document.querySelector(".site-footer");
    return [document.querySelector("canvas.doodle-ink").clientHeight, page.offsetTop + page.offsetHeight, document.documentElement.scrollHeight];
  });
const covers = ([c, page, scroll]) => c === page && scroll === page;
const sz0 = await inkHeight();
const [h0, app0] = sz0;
check("ink covers the page and doesn't add to it", covers(sz0), `canvas, page, scroll: ${sz0}`);

// the editor edits as usual, with the normal cursor
await alice.locator(".home-editor").scrollIntoViewIfNeeded();
const line = alice.locator(".home-editor .mde .ln").first();
await line.hover();
check("editor shows a text cursor", (await alice.evaluate(() => getComputedStyle(document.querySelector(".home-editor .mde .ln")).cursor)) === "text");
await line.click();
await alice.keyboard.press("End");
await alice.keyboard.type(" pencils!");
check("the editor still edits", (await alice.locator(".home-editor .mde").textContent()).includes("pencils!"));
for (let i = 0; i < 30; i++) await alice.keyboard.press("Enter");
// (resizes wait for the page to settle, and rendering is slow in software-rendered Chromium)
await alice.waitForFunction((h) => document.querySelector("canvas.doodle-ink").clientHeight > h, h0, { timeout: 8000 }).catch(() => {});
const s1 = await inkHeight();
check("ink grows with the page", covers(s1) && s1[1] > app0 + 300, `${sz0} → ${s1}`);
for (let i = 0; i < 30; i++) await alice.keyboard.press("Backspace");
await alice.waitForFunction((h) => document.querySelector("canvas.doodle-ink").clientHeight === h, h0, { timeout: 8000 }).catch(() => {});
const s2 = await inkHeight();
check("…and shrinks back", covers(s2) && s2[0] === h0, `${s1} → ${s2} (was ${sz0})`);

// The footer: over the ink, its link on top of the doodle, the system cursor (no pencil) over it
const footerLink = alice.locator(".site-footer a");
await footerLink.scrollIntoViewIfNeeded();
await alice.locator(".site-footer .signature").waitFor({ state: "attached" });
await footerLink.hover();
check("footer: its link is on top of the doodle", await footerLink.evaluate((a) => {
  const b = a.getBoundingClientRect();
  return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) === a && getComputedStyle(a).cursor === "pointer";
}));
check("footer: the system cursor, not the pencil", (await alice.evaluate(() => getComputedStyle(document.querySelector(".site-footer p")).cursor)) === "default");

// Phones: no pencil cursor (a finger brings the pencil out only while it draws: home-mobile.mjs), the bots' still shown
const phone = await visitor("phone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await phone.waitForSelector("canvas.doodle-ink", { state: "attached" });
await phone.waitForTimeout(3000);
check("phone: system cursor not hidden", !(await phone.evaluate(() => document.getElementById("app").classList.contains("doodle-on"))));
if (shots) await phone.screenshot({ path: join(shots, "phone.png") });
await phone.context().close();

// Reduced motion: no pencils, just drawings
const calm = await visitor("calm", { reducedMotion: "reduce" });
await calm.waitForSelector("canvas.doodle-ink", { state: "attached" });
await calm.waitForTimeout(1500);
check("reduced motion: no 3D pencils", (await calm.locator("canvas.doodle-gl").count()) === 0);
await calm.context().close();

await alice.context().close();

if (shots) {
  // a fresh desktop visitor for screenshots (and a recording with RECORD=1)
  const rec = process.env.RECORD ? { recordVideo: { dir: join(process.env.DATA_DIR, "video"), size: { width: 960, height: 600 } } } : {};
  const desk = await visitor("desk", { viewport: { width: 1440, height: 900 }, ...rec });
  await desk.mouse.move(1000, 600);
  await desk.waitForTimeout(process.env.RECORD ? 14000 : 7000);
  await desk.screenshot({ path: join(shots, "desktop-above-fold.png") });
  await desk.locator(".home-editor").scrollIntoViewIfNeeded();
  await desk.mouse.move(1130, 420);
  await desk.waitForTimeout(500);
  await desk.screenshot({ path: join(shots, "desktop-editor.png") });
  const video = desk.video();
  await desk.context().close();
  if (video) renameSync(await video.path(), join(shots, "above-fold.webm"));
}
check("no WebSocket, ever", sockets.length === 0, sockets.join("\n"));
check("no page errors", errors.length === 0, errors.join("\n"));
await browser.close();
await app.stop();
rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
