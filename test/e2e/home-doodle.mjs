// End-to-end: the home page doodle (pencils over /ws/home) through the real server.
// Usage: bun run build:client && bun test/e2e/home-doodle.mjs   (SHOTS=dir for screenshots, RECORD=1 for a video)
// Needs playwright-core in /tmp/opencode/pw and the Playwright Chromium headless shell (WebGL via SwiftShader).
import "../local-storage.ts";
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "np-e2e-home-"));
process.env.ALLOW_DEV_LOGIN = "1";
process.env.PORT = "0";
const { startServer } = await import("../../src/server/index.ts");
// every visitor here comes from loopback: allow more than the default reconnect burst
const app = await startServer({ port: 0, quiet: true, home: { joinBurst: 40 } });
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

async function visitor(name, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, ...opts });
  const page = await ctx.newPage();
  // count animation frames, to see the loop sleep when nothing moves
  await page.addInitScript(() => {
    window.__frames = 0;
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => raf((t) => (window.__frames++, cb(t)));
  });
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

// Bob and Carol skip the 3D pencils (reduced motion), which keeps software-rendered WebGL in headless Chromium
// affordable; finished strokes still arrive the same way.
const bob = await visitor("bob", { reducedMotion: "reduce" });
await bob.waitForSelector("canvas.doodle-ink", { state: "attached" });
await bob.waitForFunction(() => document.querySelectorAll(".doodle-label").length >= 3, null, { timeout: 10000 }).then(
  () => check("Bob sees the bots and Alice's pencil", true),
  () => check("Bob sees the bots and Alice's pencil", false),
);
// Alice draws a zigzag in the left margin, outside where the bots write
const before = await inkIn(bob, 40, 300, 150, 620);
await alice.mouse.move(60, 320);
await alice.mouse.down();
for (let i = 1; i <= 14; i++) await alice.mouse.move(60 + (i % 2 ? 70 : 0), 320 + i * 20, { steps: 3 });
await alice.mouse.up();
check("Alice's drawing shows on her page", (await inkIn(alice, 40, 300, 150, 620)) > 200);
await bob
  .waitForFunction(
    ([b]) => {
      const c = document.querySelector("canvas.doodle-ink");
      const k = c.width / parseFloat(c.style.width);
      const d = c.getContext("2d").getImageData(40 * k, 300 * k, 110 * k, 320 * k).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
      return n > b + 200;
    },
    [before],
    { timeout: 10000 },
  )
  .then(
    () => check("Bob receives Alice's drawing live", true),
    async () => check("Bob receives Alice's drawing live", false, `before ${before}, after ${await inkIn(bob, 40, 300, 150, 620)}`),
  );
check("server buffered Alice's stroke", app.homes.first().strokes.some((s) => !s.u.startsWith("bot") && s.p.length > 60));

// Bob is in reduced motion: Alice's stroke still ends on his page when she's gone mid-stroke
await alice.mouse.move(70, 700);
await alice.mouse.down();
for (let i = 1; i <= 6; i++) await alice.mouse.move(70 + i * 12, 700 + (i % 2) * 15, { steps: 2 });
await alice.waitForTimeout(200);
const bobBefore = await inkIn(bob, 50, 680, 160, 735);
for (const c of [...app.homes.first().clients]) if (c.open) c.sock.close(4000, "test: dropped");
await alice.mouse.up();
await bob.waitForFunction(([b]) => {
  const c = document.querySelector("canvas.doodle-ink");
  const k = c.width / parseFloat(c.style.width);
  const d = c.getContext("2d").getImageData(50 * k, 680 * k, 110 * k, 55 * k).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
  return n > b + 50;
}, [bobBefore], { timeout: 5000 }).then(
  () => check("an unfinished stroke shows (reduced motion) when its owner drops", true),
  async () => check("an unfinished stroke shows (reduced motion) when its owner drops", false, `${bobBefore} → ${await inkIn(bob, 50, 680, 160, 735)}`),
);

// Reconnecting replaces the page's strokes with the server's: none of Alice's own are doubled. (What the server sends
// is its strokes with a point still showing: it also keeps ones that have just faded away until its next prune, so
// compare with the snapshot Alice got, not with app.homes.first().strokes.)
const tick = app.homes.first().tick;
app.homes.first().tick = () => {};
await alice.waitForFunction(() => document.querySelectorAll(".doodle-label").length >= 2, null, { timeout: 10000 });
await alice.waitForTimeout(1500);
let hiStrokes = -1;
const gotHi = new Promise((resolve) => {
  alice.on("websocket", (ws) => {
    if (!ws.url().endsWith("/ws/home")) return;
    ws.on("framereceived", (f) => {
      if (typeof f.payload !== "string" || !f.payload.startsWith('{"t":"hi"')) return;
      hiStrokes = JSON.parse(f.payload).strokes.length;
      resolve();
    });
  });
});
const pageBefore = await alice.evaluate(() => +document.getElementById("app").dataset.ink);
for (const c of [...app.homes.first().clients]) c.sock.close(1012, "test: restart");
await Promise.race([gotHi, alice.waitForTimeout(10000)]);
await alice.waitForTimeout(300);
const pageStrokes = await alice.evaluate(() => +document.getElementById("app").dataset.ink);
check("after a reconnect, the page has exactly the server's strokes", hiStrokes > 0 && pageStrokes === hiStrokes, `page ${pageStrokes} (${pageBefore} before), sent ${hiStrokes}`);

// Nothing moving: once the pencils settle, the frame loop goes to sleep (a fade check a second at most)
await alice.mouse.move(1100, 500);
let idleFrames = Infinity;
for (let i = 0; i < 15 && idleFrames >= 5; i++) {
  const f0 = await alice.evaluate(() => window.__frames);
  await alice.waitForTimeout(1000);
  idleFrames = (await alice.evaluate(() => window.__frames)) - f0;
}
check("idle: the frame loop sleeps", idleFrames < 5, `${idleFrames} frames a second`);
app.homes.first().tick = tick;

// A newcomer gets the drawings so far (marks fade after DOODLE.inkLifeMs: Alice draws a fresh one first)
await alice.mouse.move(60, 320);
await alice.mouse.down();
for (let i = 1; i <= 14; i++) await alice.mouse.move(60 + (i % 2 ? 70 : 0), 320 + i * 20, { steps: 3 });
await alice.mouse.up();
await alice.waitForTimeout(300);
const carol = await visitor("carol", { reducedMotion: "reduce" });
await carol.waitForSelector("canvas.doodle-ink", { state: "attached" });
await carol.waitForFunction(() => document.querySelectorAll(".doodle-label").length >= 3, null, { timeout: 10000 }).catch(() => {});
await carol.waitForTimeout(500);
check("a newcomer sees earlier drawings", (await inkIn(carol, 40, 300, 150, 620)) > 200);
await carol.context().close();

// The CTA still opens the notes (no account needed) (before Alice makes the page grow below: resizing a big canvas
// stalls the shared software GPU in headless Chromium for a long while)
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
  const about = r(".home-about");
  return { cta: [cta.left + 8, cta.top + cta.height / 2], about: [about.left + 30, about.top + 10], aboutEnd: [about.right - 40, about.bottom - 8] };
});
for (const [name, [x, y]] of Object.entries({ "call to action (whitespace)": spots.cta, "about text": spots.about })) {
  await alice.mouse.move(x - 5, y);
  await alice.mouse.move(x, y, { steps: 2 });
  await alice.waitForTimeout(250);
  const mine = await alice.evaluate(() => document.getElementById("app").dataset.mine);
  const cur = await cursorAt(x, y);
  check(`${name}: pencil or system cursor`, (mine === "1") === (cur === "none"), `pencil ${mine}, cursor ${cur}`);
}
check("about text has a text cursor", (await cursorAt(...spots.about)) === "text");
const strokesBefore = app.homes.first().strokes.length;
await alice.mouse.move(...spots.about);
await alice.mouse.down();
await alice.mouse.move(...spots.aboutEnd, { steps: 8 });
await alice.mouse.up();
check("text can be selected", (await alice.evaluate(() => String(getSelection()).length)) > 20);
await alice.waitForTimeout(200);
check("selecting text doesn't draw", app.homes.first().strokes.length === strokesBefore || !app.homes.first().strokes.slice(strokesBefore).some((s) => !s.u.startsWith("bot")));
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

// Phones: no pencil cursor (a finger brings the pencil out only while it draws: home-mobile.mjs), others still shown
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
check("no page errors", errors.length === 0, errors.join("\n"));
await browser.close();
await app.stop();
rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
