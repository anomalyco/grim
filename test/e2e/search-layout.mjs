// End-to-end: the "Search files" dialog's layout at several window sizes, in the demo folder and a folder with many
// notes: a sensible width (≤ 640), a list that shows its rows (≥ 5 when there are ≥ 5 files, then scrolls), nothing
// clipped (the highlighted row, also after moving far down, is inside the dialog and on screen), a 14 px field.
// Usage: bun run build:client && bun test/e2e/search-layout.mjs   (screenshots /tmp/opencode/tree-keys/search-*.png)
// Needs playwright-core in /tmp/opencode/pw and the Playwright Chromium headless shell.
import "../local-storage.ts";
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHOTS = "/tmp/opencode/tree-keys";
mkdirSync(SHOTS, { recursive: true });
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "np-e2e-searchlayout-"));
process.env.ALLOW_DEV_LOGIN = "1";
process.env.SIGN_IN = "on";
process.env.QUIET_MS = "600";
process.env.PORT = "0";
const { startServer } = await import("../../src/server/index.ts");
const app = await startServer({ port: 0, quiet: true });
const base = `http://localhost:${app.server.port}`;

const browser = await chromium.launch({
  executablePath: "/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell",
});
let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(ok ? "ok  " : "FAIL", name, ok ? "" : detail);
};

// a folder with many notes, some deep with long names
const setup = await (await browser.newContext()).newPage();
await setup.goto(`${base}/auth/dev?next=/app/notes/Welcome.md`);
await setup.fill("input[name=name]", "Alice");
await setup.click("form button[type=submit]");
await setup.waitForSelector(".mde .ln", { timeout: 10000 });
for (let i = 0; i < 40; i++) {
  const path = i % 3 ? `projects/area ${i % 5}/Note number ${i}.md` : `archive/2024/a rather long subfolder name/Meeting notes about the launch ${i}.md`;
  await setup.evaluate((path) => fetch("/api/repos/notes/files", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, content: "x\n" }) }), path);
}
const cookies = await setup.context().cookies();

const geometry = (page) => page.evaluate(() => {
  const r = (e) => e.getBoundingClientRect();
  const dlg = document.querySelector(".fs-modal");
  const list = dlg.querySelector(".fs-list");
  const items = [...list.querySelectorAll(".fs-item")];
  const sel = list.querySelector(".fs-item[aria-selected=true]");
  const d = r(dlg), l = r(list), s = sel ? r(sel) : null;
  const visible = { top: Math.max(d.top, l.top), bottom: Math.min(d.bottom, l.bottom) };
  return {
    dlgW: d.width, dlgTop: d.top, dlgBottom: d.bottom, listH: l.height, rowH: items[0] ? r(items[0]).height : 0, n: items.length,
    selInside: !!s && s.top >= visible.top - 0.5 && s.bottom <= visible.bottom + 0.5 && s.bottom <= innerHeight,
    fieldFont: getComputedStyle(dlg.querySelector(".fs-input")).fontSize, fieldTop: r(dlg.querySelector(".fs-input")).top, vh: innerHeight,
  };
});

for (const [w, hgt] of [[1440, 900], [1900, 900], [1280, 600], [1280, 500]]) {
  for (const where of ["demo", "notes"]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: hgt }, deviceScaleFactor: 2 });
    if (where === "notes") await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
    await page.goto(`${base}/app/${where}`);
    await page.waitForSelector(".sb-tree .file-row", { timeout: 15000 });
    await page.click(".sb-search");
    await page.waitForSelector(".fs-modal .fs-item");
    await page.waitForTimeout(300);
    const tag = `${where} ${w}×${hgt}`;
    let g = await geometry(page);
    check(`${tag}: width ≤ 640 (${g.dlgW})`, g.dlgW <= 640 && g.dlgW >= 400, JSON.stringify(g));
    check(`${tag}: rows ~28–30 px, field 14 px`, g.rowH >= 27 && g.rowH <= 31 && g.fieldFont === "14px", JSON.stringify(g));
    check(`${tag}: the list shows ≥ 5 rows (${g.n} files, ${Math.round(g.listH)} px)`, g.n < 5 ? g.listH >= g.n * g.rowH : g.listH >= 5 * g.rowH, JSON.stringify(g));
    check(`${tag}: the dialog is on screen, the highlighted row fully visible`, g.dlgTop >= 0 && g.dlgBottom <= g.vh && g.fieldTop >= 0 && g.selInside, JSON.stringify(g));
    await page.screenshot({ path: `${SHOTS}/search-${where}-${w}x${hgt}.png` });
    if (where === "notes") {
      for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowDown");
      g = await geometry(page);
      check(`${tag}: after moving down 30 rows the highlight is still visible and the field still shows`, g.selInside && g.fieldTop >= 0 && g.fieldTop < g.dlgTop + 20, JSON.stringify(g));
      await page.keyboard.type("launch");
      await page.waitForTimeout(100);
      g = await geometry(page);
      check(`${tag}: typing filters (${g.n} rows), first highlighted and visible`, g.n === 14 && g.selInside, JSON.stringify(g));
    }
    await ctx.close();
  }
}

await browser.close();
await app.stop();
rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
