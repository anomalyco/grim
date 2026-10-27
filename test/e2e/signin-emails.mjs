// End-to-end: a server limited to some emails (SIGNIN=emails) with Google sign-in (a fake provider). The home page
// offers only "Continue with Google"; signed out, /app shows the sign-in screen; a listed email gets in.
// Usage: bun run build:client && bun test/e2e/signin-emails.mjs
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGoogleEnv, startFakeGoogle } from "./fake-google.mjs";

const probe = Bun.serve({ port: 0, fetch: () => new Response() });
const port = probe.port;
probe.stop(true);
const fake = await startFakeGoogle();
fakeGoogleEnv(fake);
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "np-e2e-emails-"));
process.env.ALLOW_DEV_LOGIN = "1";
process.env.SIGNIN = "emails";
process.env.ALLOWED_EMAILS = "*@example.com";
process.env.PORT = String(port);
process.env.PUBLIC_URL = `http://localhost:${port}`;
const { startServer } = await import("../../src/server/index.ts");
const app = await startServer({ port, quiet: true });
const base = `http://localhost:${port}`;

const browser = await chromium.launch({
  executablePath: "/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell",
});
let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(ok ? "ok  " : "FAIL", name, ok ? "" : detail);
};
const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));

await page.goto(base + "/");
await page.waitForSelector(".home-cta", { timeout: 10000 });
const cta = await page.$$eval(".home-cta a, .home-cta button, .home-cta input", (els) => els.map((e) => e.textContent?.trim() || e.tagName));
check("home page (emails server): only Continue with Google", cta.length === 1 && cta[0] === "Continue with Google" && !(await page.$("input[name=name]")), JSON.stringify(cta));

await page.goto(base + "/app");
const screen = await page.waitForSelector(".signin-card", { timeout: 10000 }).then(() => true, () => false);
check("/app signed out: the sign-in screen, Google only", screen && !!(await page.$("a.btn-google")) && !(await page.$(".signin-name")));

await page.click("a.btn-google");
await page.waitForURL(/\/auth\?/, { timeout: 10000 });
await page.fill("#email", "dana@example.com");
await page.click("#go");
await page.waitForURL(/\/app/, { timeout: 10000 }).catch(() => {});
check("a listed email signs in and lands in the app", (await page.waitForSelector(".ws-switcher .ws-title", { timeout: 10000 }).then(() => true, () => false)), page.url());

const other = await (await browser.newContext()).newPage();
await other.goto(base + "/");
await other.click("a.btn-google");
await other.waitForURL(/\/auth\?/, { timeout: 10000 });
await other.fill("#email", "eve@elsewhere.org");
await other.click("#go");
await other.waitForLoadState();
const refused = (await other.context().request.get(base + "/api/me")).status();
check("an unlisted email is refused", refused === 401, String(refused));

await browser.close();
await app.stop();
fake.stop();
rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
