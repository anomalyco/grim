// End-to-end: the home page doodle (pencils over /ws/home) through the real server.
// Usage: bun run build:client && bun test/e2e/home-doodle.mjs   (SHOTS=dir for screenshots, RECORD=1 for a video)
// Needs playwright-core in /tmp/opencode/pw and the Playwright Chromium headless shell (WebGL via SwiftShader).
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "np-e2e-home-"));
process.env.ALLOW_DEV_LOGIN = "1";
process.env.ALLOWED_GITHUB_USERS = "*";
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

async function visitor(name, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, ...opts });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`[${name}] ${e.message}`));
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
      const k = c.width / c.clientWidth;
      const d = c.getContext("2d").getImageData(x0 * k, y0 * k, (x1 - x0) * k, (y1 - y0) * k).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
      return n;
    },
    [x0, y0, x1, y1],
  );

const alice = await visitor("alice", process.env.RECORD ? { recordVideo: { dir: join(process.env.DATA_DIR, "video"), size: { width: 960, height: 600 } } } : {});
await alice.waitForSelector("canvas.doodle-ink", { timeout: 10000 });
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
  const d = c.getContext("2d").getImageData(0, 0, c.width, Math.min(c.height, 900 * (c.width / c.clientWidth))).data;
  for (let i = 3; i < d.length; i += 4 * 7) if (d[i] > 0) return true;
  return false;
}, null, { timeout: 15000, polling: 500 }).then(
  () => check("bots draw words", true),
  () => check("bots draw words", false),
);

// Bob and Carol skip the 3D pencils (reduced motion), which keeps software-rendered WebGL in headless Chromium
// affordable; finished strokes still arrive the same way.
const bob = await visitor("bob", { reducedMotion: "reduce" });
await bob.waitForSelector("canvas.doodle-ink");
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
      const k = c.width / c.clientWidth;
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
check("server buffered Alice's stroke", app.home.strokes.some((s) => !s.u.startsWith("bot") && s.p.length > 60));

// A newcomer gets the drawings so far
const carol = await visitor("carol", { reducedMotion: "reduce" });
await carol.waitForSelector("canvas.doodle-ink");
await carol.waitForFunction(() => document.querySelectorAll(".doodle-label").length >= 3, null, { timeout: 10000 }).catch(() => {});
await carol.waitForTimeout(500);
check("a newcomer sees earlier drawings", (await inkIn(carol, 40, 300, 150, 620)) > 200);
await carol.context().close();


// Below the fold: the editor edits as usual, with the normal cursor
await alice.locator(".home-editor").scrollIntoViewIfNeeded();
const line = alice.locator(".home-editor .mde .ln").first();
await line.hover();
check("editor shows a text cursor", (await alice.evaluate(() => getComputedStyle(document.querySelector(".home-editor .mde .ln")).cursor)) === "text");
await line.click();
await alice.keyboard.press("End");
await alice.keyboard.type(" pencils!");
check("the editor still edits", (await alice.locator(".home-editor .mde").textContent()).includes("pencils!"));

// Phones: no local pencil, others still shown, page scrolls
const phone = await visitor("phone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await phone.waitForSelector("canvas.doodle-ink");
await phone.waitForTimeout(3000);
check("phone: system cursor not hidden", !(await phone.evaluate(() => document.getElementById("app").classList.contains("doodle-on"))));
if (shots) await phone.screenshot({ path: join(shots, "phone.png") });
await phone.context().close();

// Reduced motion: no pencils, just drawings
const calm = await visitor("calm", { reducedMotion: "reduce" });
await calm.waitForSelector("canvas.doodle-ink");
await calm.waitForTimeout(1500);
check("reduced motion: no 3D pencils", (await calm.locator("canvas.doodle-gl").count()) === 0);
await calm.context().close();

// The CTA still signs in
await bob.fill("input[name=name]", "Bob");
await bob.click("form button[type=submit], form button");
await bob.waitForURL(/\/r\//, { timeout: 10000 }).then(
  () => check("the CTA signs in", true),
  () => check("the CTA signs in", false, bob.url()),
);

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
