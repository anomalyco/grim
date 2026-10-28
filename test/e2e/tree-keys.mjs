// End-to-end: keyboard focus in the sidebar tree. Clicking a row focuses the tree (blue current row); Up/Down move
// and open notes, Right/Left expand/collapse and go to child/parent, Home/End, type-ahead; Enter/Tab/Escape go to
// the editor; ⌘⇧E (Ctrl+Shift+E) comes back. Search files (Ctrl+P): the dialog, ranking, keys. The rows' ⋯ menu.
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
  if (a?.classList.contains("fs-input")) return "search";
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

// "+ New note" is a quiet row: regular weight, muted; its plus is centred on the top-level chevrons, its label on the folder names
const nn = await page.evaluate(() => {
  const c = document.querySelector('.folder-row[title="a"] .chev').getBoundingClientRect();
  const fn = document.querySelector('.folder-row[title="a"] .folder-name').getBoundingClientRect();
  const btn = document.querySelector(".new-note");
  const p = btn.querySelector(".plus").getBoundingClientRect();
  const r = document.createRange();
  r.selectNodeContents([...btn.childNodes].find((n) => n.nodeType === 3));
  const s = getComputedStyle(btn);
  return { dx: p.left + p.width / 2 - (c.left + c.width / 2), labelDx: r.getBoundingClientRect().left - fn.left, weight: s.fontWeight, color: s.color };
});
check("New note: plus centred on the chevrons, label on the folder names, regular weight, muted", Math.abs(nn.dx) <= 0.5 && Math.abs(nn.labelDx) <= 0.5 && nn.weight === "400" && nn.color === "rgb(98, 98, 106)", JSON.stringify(nn));

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
check("…shown only by a light blue background (no bar/ring), dark text", bb > br + 15 && br > 190 && blue.shadow === "none" && rgb(blue.color).every((v) => v < 80), JSON.stringify(blue));
await page.hover('.file-row[href="/app/notes/a/One.md"]');
const hovered = await style('.file-row[href="/app/notes/a/One.md"]');
check("…hover doesn't override it", hovered.bg === blue.bg, JSON.stringify(hovered));
await page.hover('.file-row[href="/app/notes/Zeta.md"]');
const otherHover = await style('.file-row[href="/app/notes/Zeta.md"]');
check("…other rows hover light grey, clearly unlike the blue", rgb(otherHover.bg).slice(0, 3).every((v, k) => Math.abs(v - rgb(otherHover.bg)[0]) < 6) && Math.abs(rgb(otherHover.bg)[2] - rgb(otherHover.bg)[0]) < 6 && rgb(otherHover.bg)[0] - br > 20, JSON.stringify(otherHover));
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
check("editor focused: no blue on the open note, grey selected tint", grey.bg !== blue.bg && grey.bg !== "rgba(0, 0, 0, 0)" && Math.abs(rgb(grey.bg)[2] - rgb(grey.bg)[0]) < 6, JSON.stringify(grey));
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

// ---- Search files (Ctrl+P): a dialog over the folder's full paths; the tree is never filtered ----
const fsItems = () => page.$$eval(".fs-modal .fs-item", (els) => els.map((e) => e.textContent));
const fsSelected = () => page.$eval(".fs-modal .fs-item[aria-selected=true]", (e) => e.textContent).catch(() => null);
const fsOpen = () => page.evaluate(() => !!document.querySelector("dialog.fs-modal[open]"));
check("the sidebar shows a “Search files” field with Ctrl P", await page.$eval(".sb-search", (b) => b.textContent === "Search filesCtrl P" && b.tagName === "BUTTON"), await page.$eval(".sb-search", (b) => b.textContent));
await page.click(".sb-search");
check("click “Search files” → the dialog, its input focused", await until(page, () => document.activeElement?.classList.contains("fs-input") && !!document.querySelector("dialog.fs-modal[open]")));
check("…empty query: every note as its full path, by path", JSON.stringify(await fsItems()) === JSON.stringify(["a/One", "a/sub/Deep", "b/Two", "Welcome", "Zeta"]), JSON.stringify(await fsItems()));
check("…the directory muted, the name emphasised", await page.$eval('.fs-item[title="a/sub/Deep.md"]', (e) => e.querySelector(".fs-dir")?.textContent === "a/sub/" && e.querySelector(".fs-name")?.textContent === "Deep" && getComputedStyle(e.querySelector(".fs-name")).fontWeight === "600"));
await sleep(400);
await page.screenshot({ path: `${SHOTS}/search-files.png` });
await page.keyboard.type("deep");
check("typing filters full paths", JSON.stringify(await fsItems()) === JSON.stringify(["a/sub/Deep"]), JSON.stringify(await fsItems()));
check("…the tree isn't filtered", (await rows()).length === 8, JSON.stringify(await rows()));
await page.fill(".fs-input", "o");
check("ranked: name prefix > name contains (shorter names first)", JSON.stringify(await fsItems()) === JSON.stringify(["a/One", "b/Two", "Welcome"]), JSON.stringify(await fsItems()));
await page.fill(".fs-input", "asd");
check("loose match: letters in order in the path", JSON.stringify(await fsItems()) === JSON.stringify(["a/sub/Deep"]), JSON.stringify(await fsItems()));
await page.fill(".fs-input", "zzz");
check("no match: “No matching files”", await page.$eval(".fs-modal .fs-list", (l) => l.textContent === "No matching files"));
await page.fill(".fs-input", "e");
check("…shorter names first, the first result highlighted", JSON.stringify(await fsItems()) === JSON.stringify(["a/One", "Zeta", "a/sub/Deep", "Welcome"]) && (await fsSelected()) === "a/One", JSON.stringify(await fsItems()));
await page.keyboard.press("ArrowDown");
check("Down moves the highlight", (await fsSelected()) === "Zeta", await fsSelected());
await page.keyboard.press("ArrowDown");
await page.keyboard.press("ArrowUp");
check("Up moves it back", (await fsSelected()) === "Zeta", await fsSelected());
await page.keyboard.press("Enter");
check("Enter opens the note, closes the dialog, focuses the editor", await until(page, () => location.pathname === "/app/notes/Zeta.md" && !document.querySelector("dialog.fs-modal") && !!document.activeElement?.closest(".mde")), `${await path()} ${await focus()}`);
await page.keyboard.press("Control+P");
check("Ctrl+P opens it (from the editor)", await until(page, () => document.activeElement?.classList.contains("fs-input")));
await page.keyboard.press("Escape");
check("Escape closes it, focus back in the editor", await until(page, () => !document.querySelector("dialog.fs-modal")) && (await focus()) === "editor", await focus());
await press("ControlOrMeta+Shift+E", "tree:Zeta");
await page.keyboard.press("Control+P");
check("Ctrl+P from the tree", await until(page, () => document.activeElement?.classList.contains("fs-input")));
await page.keyboard.type("two");
await page.click('.fs-item[title="b/Two.md"]');
check("a click opens the note", await until(page, () => location.pathname === "/app/notes/b/Two.md" && !document.querySelector("dialog.fs-modal") && !!document.activeElement?.closest(".mde")), `${await path()} ${await focus()}`);
await press("ControlOrMeta+Shift+E", "tree:Two");
await page.keyboard.press("/");
await sleep(200);
check("“/” no longer does anything special (tree)", !(await fsOpen()) && (await focus()) === "tree:Two", await focus());

// ---- the rows' "⋯" menu: + New note, + New folder, Rename, Delete ----
await page.keyboard.press("Escape");
const menuLabels = () => page.$$eval(".menu .menu-item .menu-label", (els) => els.map((e) => e.textContent));
const MENU = JSON.stringify(["+ New note", "+ New folder", "Rename", "Delete"]);
await page.hover('.file-row[href="/app/notes/b/Two.md"]');
await page.click('.file-item:has(a[href="/app/notes/b/Two.md"]) .row-menu');
check("note ⋯: + New note, + New folder, Rename, Delete (no Open)", JSON.stringify(await menuLabels()) === MENU, JSON.stringify(await menuLabels()));
check("…no separators", (await page.$$(".menu .menu-sep")).length === 0);
await sleep(400);
await page.screenshot({ path: `${SHOTS}/row-menu.png` });
await page.keyboard.press("Escape");
await page.hover('.folder-row[title="a"]');
await page.click('.folder-item:has(> .folder-row[title="a"]) > .row-menu');
check("folder ⋯: the same menu", JSON.stringify(await menuLabels()) === MENU, JSON.stringify(await menuLabels()));
await page.keyboard.press("Escape");
await page.click('.folder-row[title="b"]', { button: "right" });
check("right-click: the same menu", JSON.stringify(await menuLabels()) === MENU, JSON.stringify(await menuLabels()));
await page.keyboard.press("Escape");

// + New note on a note row: in the note's folder; on a folder row: inside it
await page.click('.file-item:has(a[href="/app/notes/b/Two.md"]) .row-menu');
await page.click('.menu-item:has(.menu-label:text-is("+ New note"))');
check("note's + New note → Untitled.md in its folder", await until(page, () => location.pathname === "/app/notes/b/Untitled.md"), await path());
await page.hover('.folder-row[title="a"]');
await page.click('.folder-item:has(> .folder-row[title="a"]) > .row-menu');
await page.click('.menu-item:has(.menu-label:text-is("+ New note"))');
check("folder's + New note → Untitled.md inside it", await until(page, () => location.pathname === "/app/notes/a/Untitled.md"), await path());

// + New folder: "New folder/Untitled.md", opened, the folder expanded and its name in rename mode
await page.hover('.folder-row[title="a"]');
await page.click('.folder-item:has(> .folder-row[title="a"]) > .row-menu');
await page.click('.menu-item:has(.menu-label:text-is("+ New folder"))');
check("+ New folder → a/New folder/Untitled.md opens", await until(page, () => location.pathname === "/app/notes/a/New%20folder/Untitled.md" && !!document.querySelector(".mde")), await path());
check("…the folder is expanded with its note", await until(page, () => document.querySelector('.folder-row[title="a/New folder"]')?.getAttribute("aria-expanded") === "true" && !!document.querySelector('.file-row[href="/app/notes/a/New%20folder/Untitled.md"]')));
check("…its name is in rename mode, focused, selected", await until(page, () => {
  const i = document.activeElement;
  return i?.classList.contains("row-rename") && i.value === "New folder" && i.selectionStart === 0 && i.selectionEnd === 10 && !!i.closest('.folder-row[title="a/New folder"]');
}), await focus());
await sleep(500);
check("…still in rename mode after the note mounts", await page.evaluate(() => document.activeElement?.classList.contains("row-rename")), await focus());
await page.screenshot({ path: `${SHOTS}/new-folder-rename.png` });
await page.keyboard.type("Launch");
await page.keyboard.press("Enter");
check("Enter renames it: a/Launch/Untitled.md, the note follows", await until(page, () => location.pathname === "/app/notes/a/Launch/Untitled.md" && !!document.querySelector('.folder-row[title="a/Launch"]') && !document.querySelector('.folder-row[title="a/New folder"]')), await path());
check("…focus back on the folder row", await until(page, () => document.activeElement?.matches('.folder-row[title="a/Launch"]')), await focus());
await page.click(".mde");
await page.keyboard.type("hello");
check("…the editor works in the moved note", await until(page, () => document.querySelector(".mde")?.mdeView?.doc.text.includes("hello")));

// Escape keeps "New folder"; a second one is "New folder 2"
await page.click('.folder-row[title="b"]', { button: "right" });
await page.click('.menu-item:has(.menu-label:text-is("+ New folder"))');
await page.waitForSelector(".row-rename", { timeout: 10000 });
await page.keyboard.press("Escape");
check("Escape keeps “New folder”", await until(page, () => !document.querySelector(".row-rename") && !!document.querySelector('.folder-row[title="b/New folder"]') && location.pathname === "/app/notes/b/New%20folder/Untitled.md"), await path());
await page.click('.folder-row[title="b"]', { button: "right" });
await page.click('.menu-item:has(.menu-label:text-is("+ New folder"))');
check("another → “New folder 2”", await until(page, () => document.activeElement?.value === "New folder 2"), await focus());
await page.keyboard.press("Escape");

// Rename a folder: every note under it moves; the open note follows
await page.click('.file-row[href="/app/notes/a/sub/Deep.md"]');
await until(page, () => location.pathname === "/app/notes/a/sub/Deep.md" && !!document.querySelector(".mde .ln"));
await page.click('.folder-row[title="a"]', { button: "right" });
await page.click('.menu-item:has(.menu-label:text-is("Rename"))');
check("folder Rename → in place, “a” selected", await until(page, () => document.activeElement?.value === "a"), await focus());
await page.keyboard.type("alpha");
await page.keyboard.press("Enter");
check("…every note moves under alpha/", await until(page, () => {
  const hrefs = [...document.querySelectorAll(".sb-tree .file-row")].map((a) => decodeURIComponent(a.getAttribute("href")));
  return ["alpha/One.md", "alpha/sub/Deep.md", "alpha/Launch/Untitled.md", "alpha/Untitled.md"].every((p) => hrefs.includes(`/app/notes/${p}`)) && !hrefs.some((h) => h.startsWith("/app/notes/a/"));
}), JSON.stringify(await page.$$eval(".sb-tree .file-row", (els) => els.map((e) => e.getAttribute("href")))));
check("…the open note follows (no toast)", await until(page, () => location.pathname === "/app/notes/alpha/sub/Deep.md" && !!document.querySelector(".mde .ln")) && !(await page.$(".toast")), await path());
check("…committed in one commit", (await app.ctx.store.history("notes", "main", undefined, 1))[0]?.message === "Rename a to alpha", JSON.stringify((await app.ctx.store.history("notes", "main", undefined, 1))[0]));

// Rename a note in place
await page.click('.file-item:has(a[href="/app/notes/Zeta.md"]) .row-menu', { force: true });
await page.click('.menu-item:has(.menu-label:text-is("Rename"))');
check("note Rename → in place, the name without .md", await until(page, () => document.activeElement?.value === "Zeta"), await focus());
await page.keyboard.type("Omega");
await page.keyboard.press("Enter");
check("…renamed to Omega.md", await until(page, () => !!document.querySelector('.file-row[href="/app/notes/Omega.md"]') && !document.querySelector('.file-row[href="/app/notes/Zeta.md"]')));

// Delete a folder (asks first)
await page.click('.folder-row[title="b/New folder 2"]', { button: "right" });
await page.click('.menu-item:has(.menu-label:text-is("Delete"))');
check("folder Delete asks first", await until(page, () => document.querySelector("dialog[open] h2")?.textContent === "Delete folder"));
await page.click("dialog[open] .btn-danger");
check("…and deletes it", await until(page, () => !document.querySelector('.folder-row[title="b/New folder 2"]')));

await browser.close();
app.server.stop(true);
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
