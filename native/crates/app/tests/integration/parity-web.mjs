// The web app's side of the parity run, in headless Chromium on the Linux box: the switcher's items for the same
// states the Mac lists (James: owner of "Linked"; joined to "Parity QA" through its link), and the Mac's note
// links opened signed out (view: can't type; edit: typing reaches the server, read back through the agent link).
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
const base = process.env.BASE, view = process.env.NOTE_VIEW, edit = process.env.NOTE_EDIT, agent = process.env.AGENT;
const linked = process.env.LINKED, parity = process.env.PARITY, out = process.env.OUT;
const browser = await chromium.launch({ executablePath: "/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell" });
const log = (...a) => console.log(...a);

async function switcherItems(page) {
  await page.click(".ws-switcher");
  await page.waitForSelector(".ws-menu");
  const items = await page.$$eval(".ws-menu > *", (els) =>
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
log("WEB MENU link-viewer " + JSON.stringify(await switcherItems(page)));
await page.goto(`${base}/app/${linked}`);
await page.waitForTimeout(1500);
const owner = await switcherItems(page);
log("WEB MENU owner " + JSON.stringify(owner));
await page.click(".ws-switcher");
await page.screenshot({ path: `${out}/web-menu-owner.png` });
await page.keyboard.press("Escape");

// the note links, signed out
async function openLink(url, name) {
  const c = await browser.newContext({ viewport: { width: 1100, height: 700 } });
  const p = await c.newPage();
  await p.goto(url);
  await p.waitForSelector(".mde .ln", { timeout: 20000 }).catch(() => {});
  await p.waitForTimeout(1500);
  const text0 = await p.$eval(".mde", (e) => e.textContent).catch(() => null);
  await p.click(".mde .ln >> nth=0").catch(() => {});
  await p.keyboard.press("End");
  await p.keyboard.type(` typed via ${name} link`);
  await p.waitForTimeout(2500);
  const text1 = await p.$eval(".mde", (e) => e.textContent).catch(() => null);
  await p.screenshot({ path: `${out}/web-note-${name}.png` });
  const ro = await p.$eval("body", (b) => b.innerText.match(/view only|read only|can view/i)?.[0] ?? null).catch(() => null);
  await c.close();
  return { url: p.url(), before: text0, after: text1, changed: text0 !== text1, roLabel: ro };
}
const v = await openLink(view, "view");
log("WEB NOTE-VIEW " + JSON.stringify(v));
const e = await openLink(edit, "edit");
log("WEB NOTE-EDIT " + JSON.stringify(e));
await new Promise((r) => setTimeout(r, 2500));
const cat = await (await fetch(agent, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "cat README.md" }) })).json();
log("SERVER README " + JSON.stringify(cat.stdout));
await browser.close();
