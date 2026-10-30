// End-to-end: "New note" makes Untitled.md (Untitled 2.md, …) at once, in the open note's folder or the subfolder
// whose "+" was used; an untitled note is named after its first-line H1 when Enter is pressed past it, once, and
// collaborators follow the rename. Notes that aren't untitled, or whose first line isn't an H1, keep their name.
// Usage: bun run build:client && bun test/e2e/autoname.mjs   (screenshots in /tmp/opencode/anon/)
// Needs playwright-core in /tmp/opencode/pw and the Playwright Chromium headless shell.
import "../local-storage.ts";
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { mkdirSync } from "node:fs";
import { startTarget } from "./target.mjs";

const SHOTS = "/tmp/opencode/anon";
mkdirSync(SHOTS, { recursive: true });
// TARGET=workers runs it against wrangler dev (see target.mjs); the notebook is `WS` ("notes" on Bun), also in pages.
const T = await startTarget({ env: { QUIET_MS: "600" } });
const base = T.base;
const WS = T.ws;

const browser = await chromium.launch({
  executablePath: "/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell",
});
let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(ok ? "ok  " : "FAIL", name, ok ? "" : detail);
};
const until = (page, fn, arg, timeout = 10000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// a new note's editor has mounted and taken focus (keys typed before that have nowhere to go)
const editorFocused = (page) => until(page, () => {
  const v = document.querySelector(".mde")?.mdeView;
  return !!v && document.activeElement === v.root;
});

async function user(name) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await ctx.addInitScript((ws) => (globalThis.WS = ws), WS);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[${name}] PAGEERROR`, e.message));
  await page.goto(`${base}/auth/dev?next=/app/${WS}/Welcome.md`);
  await page.fill("input[name=name]", name);
  await page.click("form button[type=submit]");
  await page.waitForSelector(".mde .ln", { timeout: 10000 });
  return page;
}
const text = (page) => page.evaluate(() => document.querySelector(".mde")?.mdeView?.doc.text ?? null);

const alice = await user("Alice");
const bob = await user("Bob");

// New note: Untitled.md at once, focused, caret at the start; then Untitled 2.md
await alice.click(".new-note");
check("New note: Untitled.md at once, no dialog", await until(alice, () => location.pathname === `/app/${WS}/Untitled.md` && !!document.querySelector(".mde")) && !(await alice.$("dialog[open]")), alice.url());
check("…empty, focused, caret at the start", await until(alice, () => {
  const v = document.querySelector(".mde")?.mdeView;
  return !!v && v.doc.text === "" && v.sel.head === 0 && document.activeElement === v.root;
}));
await alice.click(".new-note");
check("a second New note: Untitled 2.md", await until(alice, () => location.pathname === `/app/${WS}/Untitled%202.md`), alice.url());
await alice.click(`.file-row[href="/app/${WS}/Untitled.md"]`);
await until(alice, () => location.pathname === `/app/${WS}/Untitled.md` && !!document.querySelector(".mde"));

// Bob has the same untitled note open
await bob.goto(`${base}/app/${WS}/Untitled.md`);
await bob.waitForSelector(".mde", { timeout: 10000 });

await alice.click(".mde");
await alice.keyboard.type("# Trip plans");
await alice.screenshot({ path: `${SHOTS}/autoname-before.png` });
await alice.keyboard.press("Enter");
check("heading + Enter: renamed to “Trip plans.md”, URL updates", await until(alice, () => location.pathname === `/app/${WS}/Trip%20plans.md`), alice.url());
check("…the sidebar and breadcrumb follow", await until(alice, () => !!document.querySelector(`.file-row[href="/app/${WS}/Trip%20plans.md"]`) && !document.querySelector(`.file-row[href="/app/${WS}/Untitled.md"]`) && document.querySelector(".crumb-file")?.textContent === "Trip plans"));
check("…the content stays and the caret is on the new line", await until(alice, () => {
  const v = document.querySelector(".mde")?.mdeView;
  return v?.doc.text === "# Trip plans\n" && v.sel.head === 13 && document.activeElement === v.root;
}), JSON.stringify(await text(alice)));
await alice.keyboard.type("Day one");
check("…and typing goes on there", await until(alice, () => document.querySelector(".mde")?.mdeView?.doc.text === "# Trip plans\nDay one"), JSON.stringify(await text(alice)));
await alice.screenshot({ path: `${SHOTS}/autoname-after.png` });
check("Bob follows the rename", await until(bob, () => location.pathname === `/app/${WS}/Trip%20plans.md` && document.querySelector(".mde")?.textContent.includes("Day one")), bob.url());

// later edits to the heading never rename it again
await alice.keyboard.press("ArrowUp");
await alice.keyboard.press("End");
await alice.keyboard.type(" v2");
await alice.keyboard.press("Enter");
await sleep(1500);
check("editing the heading later: no rename", alice.url().endsWith(`/app/${WS}/Trip%20plans.md`) && (await text(alice)).startsWith("# Trip plans v2\n"), alice.url());

// a note that isn't untitled
await alice.goto(`${base}/app/${WS}/Welcome.md`);
await alice.waitForSelector(".mde .ln");
await alice.click(".mde .ln >> nth=0");
await alice.keyboard.press("End");
await alice.keyboard.press("Enter");
await sleep(1500);
check("a note that isn't untitled: no rename", alice.url().endsWith(`/app/${WS}/Welcome.md`), alice.url());

// an untitled note whose first line isn't an H1
await alice.goto(`${base}/app/${WS}/Untitled%202.md`);
await alice.waitForSelector(".mde");
await alice.click(".mde");
await alice.keyboard.type("just text");
await alice.keyboard.press("Enter");
await alice.keyboard.type("## not an H1");
await alice.keyboard.press("Enter");
await sleep(1500);
check("an untitled note whose first line isn't an H1: no rename", alice.url().endsWith(`/app/${WS}/Untitled%202.md`), alice.url());

// "+" on a subfolder: a new note inside it
await alice.evaluate(() => fetch(`/api/workspace/${WS}/files`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "trips/Packing.md", content: "# Packing\n" }) }));
await T.save(WS, "trips/Packing.md");
await alice.reload();
await alice.waitForSelector('.folder-row[title="trips"]', { timeout: 10000 });
await alice.hover('.folder-row[title="trips"]');
await alice.click('.folder-item:has(> .folder-row[title="trips"]) > .folder-add');
check("“+” on a subfolder: Untitled.md inside it", await until(alice, () => location.pathname === `/app/${WS}/trips/Untitled.md`), alice.url());
check("…its editor takes focus", await editorFocused(alice));
await alice.keyboard.type("# Gear list");
await alice.keyboard.press("Enter");
check("…named after its heading, in the same subfolder", await until(alice, () => location.pathname === `/app/${WS}/trips/Gear%20list.md`), alice.url());
// a taken name gets a number
await alice.click(".new-note");
await until(alice, () => location.pathname === `/app/${WS}/trips/Untitled.md`);
await editorFocused(alice);
await alice.keyboard.type("# Gear list");
await alice.keyboard.press("Enter");
check("a taken name: “Gear list 2.md”", await until(alice, () => location.pathname === `/app/${WS}/trips/Gear%20list%202.md`), alice.url());

// keys typed while the new note loads don't reach the "New note" button (Space/Enter would make another note)
await editorFocused(alice); // the renamed note has mounted (it takes focus back)
await alice.focus(".new-note");
await alice.keyboard.press("Enter");
await alice.keyboard.press("Space");
await alice.keyboard.press("Enter");
await until(alice, () => location.pathname === `/app/${WS}/trips/Untitled.md`);
await sleep(1000);
check("typing while a new note loads: still one new note", (await T.isOpen(WS, "trips/Untitled.md")) && !(await T.isOpen(WS, "trips/Untitled 2.md")), alice.url());

await browser.close();
await T.stop();
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
