// End-to-end: a new note always takes focus — "+ New note", the row menu's New note and a subfolder's "+" — even
// when the tree had focus, and keys typed before its editor appears aren't lost: "# Hello" + Enter typed at once
// lands in the note, which is then named after the heading.
// Usage: bun run build:client && bun test/e2e/newnote-focus.mjs
// Needs playwright-core in /tmp/opencode/pw and the Playwright Chromium headless shell.
import "../local-storage.ts";
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "np-e2e-newnotefocus-"));
process.env.ALLOW_DEV_LOGIN = "1";
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
const until = (page, fn, arg, timeout = 10000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);

const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto(`${base}/auth/dev?next=/app/notes/Welcome.md`);
await page.fill("input[name=name]", "Alice");
await page.click("form button[type=submit]");
await page.waitForSelector(".mde .ln", { timeout: 10000 });
await page.evaluate(() => fetch("/api/repos/notes/files", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "trips/Packing.md", content: "# Packing\n" }) }));
await page.reload();
await page.waitForSelector('.folder-row[title="trips"]', { timeout: 10000 });
await page.waitForSelector(".mde .ln", { timeout: 10000 });

const text = () => page.evaluate(() => document.querySelector(".mde")?.mdeView?.doc.text ?? null);
const inEditor = () => page.evaluate(() => !!document.activeElement?.closest(".mde"));

async function treeFocused() {
  await page.click('.file-row[href="/app/notes/Welcome.md"]');
  return until(page, () => document.activeElement?.getAttribute("role") === "treeitem" && location.pathname === "/app/notes/Welcome.md" && !!document.querySelector(".mde .ln"));
}

/** Start a new note with `start`, type "# <title>" + Enter at once (no waiting), expect `<dir><title>.md`. */
async function flow(label, start, title, dir) {
  check(`${label}: the tree has focus first`, await treeFocused());
  await start();
  await page.keyboard.type(`# ${title}`);
  await page.keyboard.press("Enter");
  const want = `/app/notes/${dir}${encodeURIComponent(title)}.md`;
  check(`${label}: typed at once, the note is named “${title}.md”`, await until(page, (w) => location.pathname === w, want), await page.evaluate(() => location.pathname));
  check(`${label}: the text landed in the note, caret on the new line`, await until(page, (t) => {
    const v = document.querySelector(".mde")?.mdeView;
    return v?.doc.text === `# ${t}\n` && v.sel.head === t.length + 3;
  }, title), JSON.stringify(await text()));
  check(`${label}: the editor has focus (not the sidebar)`, await inEditor(), await page.evaluate(() => document.activeElement?.className));
  await page.keyboard.type("more");
  check(`${label}: and typing goes on in the note`, await until(page, (t) => document.querySelector(".mde")?.mdeView?.doc.text === `# ${t}\nmore`, title), JSON.stringify(await text()));
}

await flow("“+ New note”", () => page.click(".new-note"), "Hello", "");
await flow("row menu New note", async () => {
  await page.click('.file-item:has(a[href="/app/notes/trips/Packing.md"]) .row-menu', { force: true });
  await page.click('.menu-item:has(.menu-label:text-is("New note"))');
}, "Second", "trips/");
await flow("subfolder “+”", async () => {
  await page.hover('.folder-row[title="trips"]');
  await page.click('.folder-item:has(> .folder-row[title="trips"]) > .folder-add');
}, "Third", "trips/");
// keyboard only: the tree focused (⌘⇧E), the row menu from the keyboard (Shift+F10), Enter on New note
await flow("keyboard: Shift+F10 → New note", async () => {
  await page.keyboard.press("ControlOrMeta+Shift+E");
  await page.keyboard.press("Shift+F10");
  await page.waitForSelector(".menu .menu-item");
  await page.keyboard.press("Enter");
}, "Fourth", "");

await browser.close();
await app.stop();
rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
