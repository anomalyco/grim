// End-to-end: the landing page doodle on phones, with real touch events (CDP Input.dispatchTouchEvent) in Chromium's
// mobile emulation. Ink comes out exactly at the drawn pencil tip; one finger draws on the paper and doesn't scroll,
// two fingers scroll; the bots stay inside a phone's window over a long run. (The bots run in the page: the touches
// go where no bot's pencil is, so it doesn't get in the way of measuring yours.)
// Usage: bun run build:client && bun test/e2e/home-mobile.mjs   (SHOTS=dir for screenshots, LONG=ms per size)
// Needs playwright-core in /tmp/opencode/pw and the Playwright Chromium headless shell (WebGL via SwiftShader).
import "../local-storage.ts";
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "np-e2e-mobile-"));
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
const LONG = +(process.env.LONG ?? 30000);
// (on a phone the bots take turns, and a turn can take up to ~30 s to come round: AREA_PER_PHRASE in bots/engine.ts)
const PHONE_LONG = Math.max(LONG, 40000);

const browser = await chromium.launch({
  executablePath: "/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell",
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(ok ? "ok  " : "FAIL", name, detail);
};
const errors = [];
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

async function phone(name, width, height) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: UA });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`[${name}] ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !m.text().includes("401") && errors.push(`[${name}] console: ${m.text()}`));
  await page.goto(base + "/");
  await page.waitForSelector("canvas.doodle-gl", { state: "attached", timeout: 10000 });
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1, radiusX: 6, radiusY: 6, force: 1 })) });
  return { page, ctx, touch };
}
/** The pencils' tips on the page ([x, y, z, scale]): the bots' (drawn 1.12 times as big as yours) and yours. */
const pencilTips = (page) =>
  page.evaluate(() => {
    const all = document.getElementById("app").doodleTips ?? [];
    const big = Math.max(0, ...all.map((t) => t[3]));
    return { bots: all.filter((t) => t[3] > big * 0.97), mine: all.find((t) => t[3] < big * 0.95) ?? null };
  });
/** Of `spots` (client px), one at least `gap` px from every bot's pencil tip right now (waiting for one, a while). */
async function clearSpot(page, spots, gap = 130) {
  for (let i = 0; i < 40; i++) {
    const tips = (await pencilTips(page)).bots;
    const ok = spots.find(([x, y]) => tips.every((t) => Math.hypot(t[0] - (x - 20), t[1] - (y - 32)) > gap));
    if (ok) return ok;
    await page.waitForTimeout(250);
  }
  return spots[0];
}
/** Is there ink within `r` px of client point `at`? */
const inkNear = (page, at, r = 1.5) =>
  page.evaluate(([x, y, r]) => {
    const c = document.querySelector("canvas.doodle-ink");
    const k = c.width / parseFloat(c.style.width);
    const b = c.getBoundingClientRect();
    const d = c.getContext("2d").getImageData(Math.round((x - b.left - r) * k), Math.round((y - b.top - r) * k), Math.max(1, Math.round(2 * r * k)), Math.max(1, Math.round(2 * r * k))).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
    return false;
  }, [at[0], at[1], r]);
const frames = (page, n = 3) => page.evaluate((n) => new Promise((r) => { let i = 0; const f = () => (++i >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);

/** Pixels of a screenshot region, decoded in the page: { w, h, d } at device scale. */
async function shotPixels(page, clip) {
  const png = await page.screenshot({ clip, scale: "device" });
  return page.evaluate(async (b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bin], { type: "image/png" }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext("2d");
    g.drawImage(bmp, 0, 0);
    return { w: bmp.width, h: bmp.height, d: Array.from(g.getImageData(0, 0, bmp.width, bmp.height).data) };
  }, png.toString("base64"));
}

/** Where the drawn pencil's tip is, in client CSS px: the farthest pencil pixel toward the tip (up its axis) in a box
 *  around `near`, from the difference with and without the pencil layer. Shadows are
 *  faint; the pencil (paint, wood, outline) differs strongly. */
async function drawnTip(page, near) {
  const clip = { x: near[0] - 30, y: near[1] - 30, width: 60, height: 60 };
  const a = await shotPixels(page, clip);
  await page.evaluate(() => (document.querySelector("canvas.doodle-gl").style.visibility = "hidden"));
  const b = await shotPixels(page, clip);
  await page.evaluate(() => (document.querySelector("canvas.doodle-gl").style.visibility = ""));
  const k = a.w / clip.width;
  const px = [];
  for (let y = 0; y < a.h; y++)
    for (let x = 0; x < a.w; x++) {
      const i = (y * a.w + x) * 4;
      const diff = Math.max(Math.abs(a.d[i] - b.d[i]), Math.abs(a.d[i + 1] - b.d[i + 1]), Math.abs(a.d[i + 2] - b.d[i + 2]));
      if (diff < 90) continue;
      const cx = clip.x + (x + 0.5) / k;
      const cy = clip.y + (y + 0.5) / k;
      px.push([cx, cy, 0]);
    }
  if (!px.length) return null;
  // the pencil's direction here (it leans as it moves): the principal axis of its pixels, pointing down the pencil
  const mx = px.reduce((s, p) => s + p[0], 0) / px.length;
  const my = px.reduce((s, p) => s + p[1], 0) / px.length;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const [x, y] of px) {
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
    sxy += (x - mx) * (y - my);
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let ux = Math.cos(th);
  let uy = Math.sin(th);
  if (ux * 0.52 + uy * 0.85 < 0) [ux, uy] = [-ux, -uy];
  for (const p of px) p[2] = p[0] * ux + p[1] * uy;
  // The point of the tip: its foremost pixel along the axis, centred across it. (The sharpened end, with its outline,
  // is a blunt ring ~2 px across: depending on the pencil's roll, its foremost pixel can be on either side.)
  const front = Math.min(...px.map((p) => p[2]));
  const end = px.filter((p) => p[2] < front + 1.5);
  const across = end.reduce((s, p) => s + (-p[0] * uy + p[1] * ux), 0) / end.length;
  return [front * ux - across * uy, front * uy + across * ux];
}

/** The ink's centre (alpha-weighted, client CSS px at scroll `sy`) in a box around `near`. */
const inkCentre = (page, near) =>
  page.evaluate(([nx, ny]) => {
    const c = document.querySelector("canvas.doodle-ink");
    // (as the canvas shows: its pixels over its CSS size, across and down)
    const kx = c.width / parseFloat(c.style.width);
    const ky = c.height / parseFloat(c.style.height);
    const r = c.getBoundingClientRect();
    const x0 = nx - 20 - r.left;
    const y0 = ny - 20 - r.top;
    const w = Math.round(40 * kx);
    const d = c.getContext("2d").getImageData(Math.round(x0 * kx), Math.round(y0 * ky), w, Math.round(40 * ky)).data;
    let sx = 0;
    let sy = 0;
    let s = 0;
    for (let i = 0; i < d.length / 4; i++) {
      const a = d[i * 4 + 3];
      if (!a) continue;
      sx += ((i % w) + 0.5) * a;
      sy += (Math.floor(i / w) + 0.5) * a;
      s += a;
    }
    if (!s) return null;
    return [(Math.round(x0 * kx) + sx / s) / kx + r.left, (Math.round(y0 * ky) + sy / s) / ky + r.top];
  }, near);

const dist = (a, b) => (a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : Infinity);
const f2 = (p) => (p ? `(${p[0].toFixed(2)}, ${p[1].toFixed(2)})` : "none");

// ---------- 1. ink comes out of the drawn tip (iPhone 15: 393×852 @3x), away from the bots ----------
{
  const { page, ctx, touch } = await phone("iphone15", 393, 852);
  await page.waitForFunction(() => document.querySelectorAll(".doodle-label").length >= 3, null, { timeout: 10000 });
  check("iPhone: the paper doesn't pan with one finger (touch-action)", (await page.evaluate(() => getComputedStyle(document.querySelector(".home-hero")).touchAction)) === "pinch-zoom");
  const spots = [[200, 400], [60, 160], [330, 600], [70, 560], [320, 180], [120, 700]];
  let worst = 0;
  const details = [];
  for (let n = 0; n < 4; n++) {
    const [fx, fy] = await clearSpot(page, spots);
    await touch("touchStart", [[fx, fy]]);
    await page.waitForTimeout(350);
    await frames(page);
    const { mine } = await pencilTips(page);
    const near = mine ? [mine[0], mine[1]] : [fx - 20, fy - 32];
    const tip = await drawnTip(page, near);
    const inkC = await inkCentre(page, near);
    await touch("touchEnd", []);
    const d = dist(tip, inkC);
    worst = Math.max(worst, d);
    details.push(`finger (${fx}, ${fy}): drawn tip ${f2(tip)}, ink centre ${f2(inkC)} (${d.toFixed(2)} px)`);
    if (shots && n === 0) {
      await touch("touchStart", [[fx, fy]]);
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(shots, "after-tip-zoom.png"), clip: { x: fx - 70, y: fy - 70, width: 140, height: 140 }, scale: "device" });
      await touch("touchEnd", []);
    }
    await page.waitForTimeout(1000);
  }
  check("iPhone: a dot's ink and the drawn tip within 1 CSS px", worst <= 1, "\n      " + details.join("\n      "));
  check("iPhone: the tip is up the pencil from the finger, not under it", details.length > 0 && !details.some((s) => s.includes("none")));

  // a stroke: the page doesn't scroll, the ink follows the tip to its end
  const y0 = await page.evaluate(() => scrollY);
  const [sx, sy] = await clearSpot(page, [[90, 300], [90, 560], [90, 160]], 200);
  const pts = [];
  for (let i = 0; i <= 40; i++) pts.push([sx + i * 6, sy + Math.sin(i / 4) * 60]);
  await touch("touchStart", [pts[0]]);
  for (const p of pts.slice(1)) await touch("touchMove", [p]);
  // (held still: the pencil's lean settles)
  await page.waitForTimeout(1200);
  await frames(page);
  const end = (await pencilTips(page)).mine;
  const tip = await drawnTip(page, [end[0], end[1]]);
  if (shots) await page.screenshot({ path: join(shots, "after-stroke.png") });
  if (shots) await page.screenshot({ path: join(shots, "after-stroke-tip.png"), clip: { x: end[0] - 12, y: end[1] - 12, width: 24, height: 24 }, scale: "device" });
  const inkAtEnd = await inkNear(page, [end[0], end[1]]);
  await touch("touchEnd", []);
  const y1 = await page.evaluate(() => scrollY);
  check("iPhone: drawing with one finger doesn't scroll the page", y0 === y1, `${y0} → ${y1}`);
  check("iPhone: the stroke ends at the drawn tip", dist(tip, [end[0], end[1]]) <= 1 && inkAtEnd, `tip ${f2(tip)}, pose ${f2(end)}, ink there: ${inkAtEnd}`);

  // scrolled a little: still exact
  await page.evaluate(() => scrollTo(0, 120));
  await page.waitForTimeout(300);
  const [qx, qy] = await clearSpot(page, [[220, 420], [100, 300], [300, 600]]);
  await touch("touchStart", [[qx, qy]]);
  await page.waitForTimeout(350);
  await frames(page);
  const t2 = (await pencilTips(page)).mine;
  const tip2 = await drawnTip(page, [t2[0], t2[1]]);
  const ink2 = await inkCentre(page, [t2[0], t2[1]]);
  await touch("touchEnd", []);
  check("iPhone: scrolled, ink still at the tip", dist(tip2, ink2) <= 1, `${dist(tip2, ink2).toFixed(2)} px`);
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForTimeout(300);

  // two fingers scroll (and don't draw)
  const top0 = await page.evaluate(() => visualViewport.pageTop);
  let drew = false;
  const drawing = () => page.evaluate(() => document.getElementById("app").classList.contains("doodling"));
  await touch("touchStart", [[150, 600]]);
  await touch("touchStart", [[150, 600], [250, 600]]);
  for (let i = 1; i <= 12; i++) {
    await touch("touchMove", [[150, 600 - i * 20], [250, 600 - i * 20]]);
    if (await drawing()) drew = true;
  }
  await touch("touchEnd", []);
  await page.waitForTimeout(500);
  const top1 = await page.evaluate(() => visualViewport.pageTop);
  check("iPhone: two fingers scroll the page", top1 > top0 + 60, `${top0} → ${top1}`);
  check("iPhone: …and leave no mark", !drew);
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForTimeout(300);

  // a long press on the paper: no selection (no magnifier)
  await touch("touchStart", [[180, 70]]);
  await page.waitForTimeout(900);
  await touch("touchEnd", []);
  check("iPhone: a long press selects nothing", (await page.evaluate(() => String(getSelection()))) === "");

  // below the paper, one finger scrolls
  const noteTop = await page.evaluate(() => document.querySelector(".home-editor").getBoundingClientRect().top);
  check("iPhone: the note peeks in below the paper", noteTop < 852 - 20, `note at ${noteTop}`);
  const s0 = await page.evaluate(() => scrollY);
  await touch("touchStart", [[200, 830]]);
  for (let i = 1; i <= 10; i++) await touch("touchMove", [[200, 830 - i * 30]]);
  await touch("touchEnd", []);
  await page.waitForTimeout(600);
  const s1 = await page.evaluate(() => scrollY);
  check("iPhone: one finger below the paper scrolls", s1 > s0 + 100, `${s0} → ${s1}`);

  // the hint is plain text, shown only at the very top
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForTimeout(400);
  check("iPhone: the hint shows at the top", (await page.evaluate(() => getComputedStyle(document.querySelector(".home-hint")).opacity)) === "1");
  await page.evaluate(() => scrollTo(0, 40));
  await page.waitForTimeout(400);
  check("iPhone: the hint fades once scrolled", (await page.evaluate(() => getComputedStyle(document.querySelector(".home-hint")).opacity)) === "0");
  await page.evaluate(() => scrollTo(0, 0));

  // the scratch note: tap and type
  await page.tap(".home-editor .mde .ln >> nth=1");
  await page.keyboard.type(" fingers!");
  check("iPhone: the scratch note is typeable", (await page.locator(".home-editor .mde").textContent()).includes("fingers!"));
  // the footer
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(400);
  const foot = await page.evaluate(() => {
    const a = document.querySelector(".site-footer a");
    const b = a.getBoundingClientRect();
    const f = document.querySelector(".site-footer").getBoundingClientRect();
    return { top: document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) === a, fits: f.left === 0 && Math.round(f.right) === innerWidth, overflow: document.documentElement.scrollWidth > innerWidth };
  });
  check("iPhone: the footer fits, its link on top", foot.top && foot.fits && !foot.overflow, JSON.stringify(foot));
  if (shots) await page.screenshot({ path: join(shots, "after-footer.png") });
  await ctx.close();
}

// ---------- 2. the bots stay inside phones' windows over a long run ----------
for (const [w, h] of [[390, 844], [360, 740]]) {
  const { page, ctx } = await phone(`phone${w}`, w, h);
  await page.waitForTimeout(1500);
  let samples = 0;
  const off = [];
  const t0 = Date.now();
  while (Date.now() - t0 < PHONE_LONG) {
    await page.waitForTimeout(250);
    const s = await page.evaluate(() => {
      const tips = document.getElementById("app").doodleTips ?? [];
      const labels = [...document.querySelectorAll(".doodle-label")].filter((l) => !l.hidden).map((l) => l.getBoundingClientRect()).map((r) => [r.left, r.right]);
      return { tips, labels, vw: innerWidth };
    });
    samples++;
    for (const t of s.tips) if (t[0] < 0 || t[0] > s.vw) off.push(`tip x ${t[0].toFixed(0)}`);
    for (const [l, r] of s.labels) if (l < -1 || r > s.vw + 1) off.push(`label ${l.toFixed(0)}..${r.toFixed(0)}`);
  }
  const inked = await page.evaluate(() => +(document.getElementById("app").dataset.ink ?? 0));
  check(`${w}×${h}: pencils and labels stay in the window (${samples} samples over ${PHONE_LONG / 1000}s)`, off.length === 0, off.slice(0, 8).join("; "));
  check(`${w}×${h}: the bots write (${inked} strokes on the page)`, inked > 5);
  if (shots) await page.screenshot({ path: join(shots, `after-bots-${w}.png`) });
  await ctx.close();
}

check("no page errors", errors.length === 0, errors.join("\n"));
await browser.close();
await app.stop();
rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
