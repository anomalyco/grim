// End-to-end: keyboard focus in the sidebar tree. Clicking a row focuses the tree (blue current row); Up/Down move
// and open notes, Right/Left expand/collapse and go to child/parent, Home/End, type-ahead; Enter/Tab/Escape go to
// the editor; ⌘⇧E (Ctrl+Shift+E) comes back; Filter → Down lands on the first match.
// Usage: bun run build:client && bun test/e2e/tree-keys.mjs   (screenshots in /tmp/opencode/tree-keys/)
// Needs playwright-core in /tmp/opencode/pw and the Playwright Chromium headless shell.
import "../local-storage.ts";
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHOTS = "/tmp/opencode/tree-keys";
mkdirSync(SHOTS, { recursive: true });
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "np-e2e-treekeys-"));
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto(`${base}/auth/dev?next=/app/notes/Welcome.md`);
await page.fill("input[name=name]", "Alice");
await page.click("form button[type=submit]");
await page.waitForSelector(".mde .ln", { timeout: 10000 });

for (const [path, content] of [["a/One.md", "# One\n"], ["a/sub/Deep.md", "# Deep\n"], ["b/Two.md", "# Two\n"], ["Zeta.md", "# Zeta\n"]]) {
  await page.evaluate(([path, content]) => fetch("/api/repos/notes/files", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, content }) }), [path, content]);
  await app.ctx.rooms.peek("notes", path)?.flush();
}
await page.reload();
await page.waitForSelector('.file-row[href="/app/notes/Zeta.md"]', { timeout: 10000 });
await page.waitForSelector(".mde .ln", { timeout: 10000 });

/** The focused element, described: "tree:<row label>", "editor", "filter" or the tag. */
const focus = () => page.evaluate(() => {
  const a = document.activeElement;
  if (a?.getAttribute("role") === "treeitem") return `tree:${a.querySelector(".file-name, .folder-name")?.textContent}`;
  if (a?.closest(".mde")) return "editor";
  if (a?.classList.contains("sb-filter-input")) return "filter";
  return a?.tagName ?? "none";
});
const path = () => page.evaluate(() => decodeURIComponent(location.pathname));
const rows = () => page.$$eval(".sb-tree [role=treeitem]", (els) => els.map((e) => e.querySelector(".file-name, .folder-name")?.textContent));
const style = (sel) => page.$eval(sel, (el) => {
  const s = getComputedStyle(el);
  return { bg: s.backgroundColor, shadow: s.boxShadow, color: s.color };
});
const press = async (key, want, wantPath) => {
  await page.keyboard.press(key);
  const ok = await until(page, ([want, wantPath]) => {
    const a = document.activeElement;
    const f = a?.getAttribute("role") === "treeitem" ? `tree:${a.querySelector(".file-name, .folder-name")?.textContent}` : a?.closest(".mde") ? "editor" : a?.tagName;
    return f === want && (!wantPath || (decodeURIComponent(location.pathname) === wantPath && !!document.querySelector(".mde .ln")));
  }, [want, wantPath], 5000);
  check(`${key} → ${want}${wantPath ? ` (${wantPath})` : ""}`, ok, `${await focus()} ${await path()}`);
};

check("tree rows in order", JSON.stringify(await rows()) === JSON.stringify(["a", "sub", "Deep", "One", "b", "Two", "Welcome", "Zeta"]), JSON.stringify(await rows()));
check("ARIA: a tree of treeitems with levels, expanded state and one tab stop", await page.evaluate(() => {
  const tree = document.querySelector(".sb-tree [role=tree]");
  const items = [...document.querySelectorAll(".sb-tree [role=treeitem]")];
  const sub = items.find((e) => e.textContent === "sub");
  return !!tree && items.every((e) => e.hasAttribute("aria-level") && e.hasAttribute("aria-selected")) &&
    sub?.getAttribute("aria-level") === "2" && sub.getAttribute("aria-expanded") === "true" &&
    items.filter((e) => e.tabIndex === 0).length === 1 && items.filter((e) => e.getAttribute("aria-selected") === "true").length === 1;
}));

// Click a note: the tree has focus, the row is blue
await page.click('.file-row[href="/app/notes/a/One.md"]');
check("click a note → it opens, the tree has focus on it", await until(page, () => location.pathname === "/app/notes/a/One.md" && !!document.querySelector(".mde .ln")) && (await focus()) === "tree:One", await focus());
await sleep(300);
check("…still focused after the editor mounts", (await focus()) === "tree:One", await focus());
const blue = await style('.file-row[href="/app/notes/a/One.md"]');
const rgb = (c) => {
  const n = c.match(/[\d.]+/g).map(Number);
  return c.startsWith("color(") ? n.map((v) => v * 255) : n;
};
const [br, bgG, bb] = rgb(blue.bg);
check("…blue tint, blue left edge, dark text", bb > br + 10 && br > 190 && blue.shadow.includes("41, 109, 154") && rgb(blue.color).every((v) => v < 80), JSON.stringify(blue));
await page.hover('.file-row[href="/app/notes/a/One.md"]');
const hovered = await style('.file-row[href="/app/notes/a/One.md"]');
check("…hover doesn't override it", hovered.bg === blue.bg && hovered.shadow === blue.shadow, JSON.stringify(hovered));
await page.mouse.move(900, 500);
await page.screenshot({ path: `${SHOTS}/tree-focused.png` });

// Up/Down
await press("ArrowDown", "tree:b");
check("…a folder is only selected (One stays open)", (await path()) === "/app/notes/a/One.md", await path());
await press("ArrowDown", "tree:Two", "/app/notes/b/Two.md");
await press("ArrowUp", "tree:b");
await press("ArrowUp", "tree:One", "/app/notes/a/One.md");
await press("ArrowUp", "tree:Deep", "/app/notes/a/sub/Deep.md");
await press("Home", "tree:a");
await press("ArrowUp", "tree:a");
await press("End", "tree:Zeta", "/app/notes/Zeta.md");
await press("ArrowDown", "tree:Zeta");

// Right/Left
await press("Home", "tree:a");
await press("ArrowRight", "tree:sub");
await press("ArrowRight", "tree:Deep", "/app/notes/a/sub/Deep.md");
await press("ArrowLeft", "tree:sub");
await press("ArrowLeft", "tree:sub");
check("Left on an expanded subfolder collapses it", await until(page, () => document.querySelector('.folder-row[title="a/sub"]')?.getAttribute("aria-expanded") === "false"));
await press("ArrowLeft", "tree:a");
await press("ArrowLeft", "tree:a");
check("Left on an expanded folder collapses it", await until(page, () => document.querySelector('.folder-row[title="a"]')?.getAttribute("aria-expanded") === "false"));
check("…its children are hidden and skipped", JSON.stringify(await rows()) === JSON.stringify(["a", "b", "Two", "Welcome", "Zeta"]), JSON.stringify(await rows()));
// (expand a and sub again, then collapse a)
await page.keyboard.press("ArrowRight");
await until(page, () => document.querySelector('.folder-row[title="a"]')?.getAttribute("aria-expanded") === "true");
await press("ArrowRight", "tree:sub");
await page.keyboard.press("Enter");
await until(page, () => document.querySelector('.folder-row[title="a/sub"]')?.getAttribute("aria-expanded") === "true");
await press("Home", "tree:a");
await page.keyboard.press("ArrowLeft");
await until(page, () => document.querySelector('.folder-row[title="a"]')?.getAttribute("aria-expanded") === "false");
await press("ArrowDown", "tree:b");
await press("ArrowUp", "tree:a");
await press("ArrowRight", "tree:a");
check("Right on a collapsed folder expands it", await until(page, () => document.querySelector('.folder-row[title="a"]')?.getAttribute("aria-expanded") === "true"));
await press("ArrowRight", "tree:sub");
await press("ArrowRight", "tree:Deep", "/app/notes/a/sub/Deep.md");
await press("ArrowRight", "tree:Deep");
await press("ArrowLeft", "tree:sub");
await press("Enter", "tree:sub");
check("Enter on a folder toggles it", await until(page, () => document.querySelector('.folder-row[title="a/sub"]')?.getAttribute("aria-expanded") === "false"));
await press("Enter", "tree:sub");
await until(page, () => document.querySelector('.folder-row[title="a/sub"]')?.getAttribute("aria-expanded") === "true");

// type-ahead
await press("w", "tree:Welcome", "/app/notes/Welcome.md");
await sleep(1100);
await press("t", "tree:Two", "/app/notes/b/Two.md");

// Enter → editor; typing goes into the note
await press("Enter", "editor");
await page.keyboard.type("XY");
check("typing after Enter goes into the note", await until(page, () => document.querySelector(".mde")?.mdeView?.doc.text.includes("XY")), await page.evaluate(() => document.querySelector(".mde")?.mdeView?.doc.text));
check("…and not the tree (no type-ahead jump)", (await path()) === "/app/notes/b/Two.md", await path());
const grey = await style('.file-row[href="/app/notes/b/Two.md"]');
check("editor focused: no blue on the open note, grey selected tint", !grey.shadow.includes("41, 109, 154") && grey.bg !== blue.bg && grey.bg !== "rgba(0, 0, 0, 0)", JSON.stringify(grey));
await page.screenshot({ path: `${SHOTS}/editor-focused.png` });

// ⌘⇧E → tree at the current row; Escape → editor (caret where it was); Tab → editor
await press("ControlOrMeta+Shift+E", "tree:Two");
await press("Escape", "editor");
await page.keyboard.type("Z");
check("Escape → editor, caret where it was", await until(page, () => document.querySelector(".mde")?.mdeView?.doc.text.includes("XYZ")), await page.evaluate(() => document.querySelector(".mde")?.mdeView?.doc.text));
await press("ControlOrMeta+Shift+E", "tree:Two");
await press("ArrowDown", "tree:Welcome", "/app/notes/Welcome.md");
await press("ArrowUp", "tree:Two", "/app/notes/b/Two.md");
await press("Escape", "editor");
await press("ControlOrMeta+Shift+E", "tree:Two");
await press("Tab", "editor");

// Filter → Down → first match
await page.click(".sb-filter-input");
await page.keyboard.type("deep");
await until(page, () => document.querySelectorAll(".sb-tree [role=treeitem]").length === 3);
await press("ArrowDown", "tree:a");
await page.click(".sb-filter-input");
await page.keyboard.press("Tab");
check("Filter → Tab → first match", await until(page, () => document.activeElement?.textContent === "a"), await focus());
await page.keyboard.press("Escape");
check("Escape in the tree → editor", (await focus()) === "editor", await focus());
await page.click(".sb-filter-input");
await page.fill(".sb-filter-input", "");

// "/" still opens the filter from the tree
await press("ControlOrMeta+Shift+E", "tree:Two");
await page.keyboard.press("/");
check('"/" in the tree → Filter files', (await focus()) === "filter", await focus());

await browser.close();
app.server.stop(true);
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
