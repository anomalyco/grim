// The web app's side of the parity run, in headless Chromium on the Linux box: the switcher's items for the same
// states the Mac lists (James made "Linked"; "Parity QA" is someone else's: the Mac user made it), and the
// account row's menu. Every folder is public, so James opens "Parity QA" by its URL like anyone signed in.
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
const base = process.env.BASE, linked = process.env.LINKED, parity = process.env.PARITY, out = process.env.OUT;
const browser = await chromium.launch({ executablePath: "/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell" });
const log = (...a) => console.log(...a);

async function menuItems(page, opener, menu) {
  await page.click(opener);
  await page.waitForSelector(menu);
  const items = await page.$$eval(`${menu} > *`, (els) =>
    els.map((e) => {
      if (e.classList.contains("menu-sep")) return "—";
      if (e.classList.contains("menu-section")) return e.textContent.trim();
      const label = e.querySelector(".menu-label")?.textContent ?? e.textContent;
      const detail = e.querySelector(".menu-detail")?.textContent;
      const on = e.querySelector(".menu-check.on") ? "• " : "";
      return e.disabled ? `(${label})` : `${on}${label}${detail ? ` [${detail}]` : ""}`;
    }),
  );
  await page.keyboard.press("Escape");
  return items;
}

// James, through the fake Google
const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
const page = await ctx.newPage();
await page.goto(`${base}/auth/google?next=/app`);
await page.fill("#email", "james@example.com");
await page.fill("#name", "James");
await page.click("#go");
await page.waitForURL(/\/app/, { timeout: 15000 });
await page.goto(`${base}/app/${parity}`);
await page.waitForSelector(".ws-switcher", { timeout: 15000 });
await page.waitForTimeout(1500);
log("WEB MENU other " + JSON.stringify(await menuItems(page, ".ws-switcher", ".ws-menu")));
await page.goto(`${base}/app/${linked}`);
await page.waitForTimeout(1500);
log("WEB MENU maker " + JSON.stringify(await menuItems(page, ".ws-switcher", ".ws-menu")));
log("WEB ACCOUNT " + JSON.stringify(await menuItems(page, ".sb-account", ".account-menu")));
await page.click(".ws-switcher");
await page.screenshot({ path: `${out}/web-menu-maker.png` });
await page.keyboard.press("Escape");
await browser.close();
