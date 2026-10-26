// First-note-open time through the real server (a scratch data dir), TS engine vs Rust engine: from navigation to
// the note's first line drawn (`.mde .ln`), with a cold HTTP cache (fresh browser context) and a warm one (the
// same context, next visit).
// Usage: bun run build:client && bun tools/perf/note-open.mjs [runs]     (THROTTLE=1: ~10 Mbit/s, 40 ms RTT)
// Needs playwright-core in /tmp/opencode/pw and the Playwright Chromium headless shell.
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUNS = Number(process.argv[2] ?? 5);
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "np-perf-open-"));
process.env.STORAGE = "local";
process.env.ALLOW_DEV_LOGIN = "1";
process.env.ALLOWED_GITHUB_USERS = "*";
process.env.PORT = "0";
const { startServer } = await import("../../src/server/index.ts");
const app = await startServer({ port: 0, quiet: true });
const base = `http://localhost:${app.server.port}`;
const browser = await chromium.launch({
  executablePath: "/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell",
});

// records when the first editor line appears, in ms since navigation start
const probe = () => {
  new MutationObserver((_, o) => {
    if (document.querySelector(".mde .ln")) {
      window.__firstLine = performance.now();
      o.disconnect();
    }
  }).observe(document, { childList: true, subtree: true });
};

async function context(name) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await ctx.addInitScript(probe);
  const r = await ctx.request.post(base + "/auth/dev", { form: { name }, headers: { origin: base }, maxRedirects: 0 });
  if (r.status() >= 400) throw new Error("sign-in failed: " + r.status());
  return ctx;
}

async function open(page, url) {
  if (process.env.THROTTLE) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 40, downloadThroughput: 1.25e6, uploadThroughput: 1.25e6 });
  }
  await page.goto(url);
  await page.waitForFunction(() => window.__firstLine, null, { timeout: 20000 });
  return page.evaluate(() => ({ t: window.__firstLine, engine: document.querySelector(".mde").dataset.engine ?? "ts" }));
}

// find the user's Welcome note once
const setup = await context("Perf");
const sp = await setup.newPage();
await sp.goto(base + "/app?engine=ts");
await sp.waitForURL(/\/app\//);
const notePath = new URL(sp.url()).pathname;
await setup.close();

const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
const results = {};
for (const engine of ["ts", "rust"]) {
  const cold = [], warm = [];
  for (let i = 0; i < RUNS; i++) {
    const ctx = await context("Perf");
    const page = await ctx.newPage();
    const a = await open(page, `${base}${notePath}?engine=${engine}`);
    if (a.engine !== engine) throw new Error(`expected ${engine}, got ${a.engine}`);
    cold.push(a.t);
    const b = await open(page, `${base}${notePath}`);
    warm.push(b.t);
    await ctx.close();
  }
  results[engine] = { cold: median(cold), warm: median(warm), coldAll: cold.map(Math.round), warmAll: warm.map(Math.round) };
  console.log(`${engine.padEnd(4)} cold ${median(cold).toFixed(0)} ms  warm ${median(warm).toFixed(0)} ms   (cold ${cold.map(Math.round).join(" ")} | warm ${warm.map(Math.round).join(" ")})`);
}
await browser.close();
await app.stop();
rmSync(process.env.DATA_DIR, { recursive: true, force: true });
