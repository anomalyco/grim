// End-to-end: deleting from the sidebar tree with the keyboard. On a focused row, Backspace (the Mac's delete key),
// forward Delete and Ctrl+Backspace (⌘⌫ on the Mac) open the row menu's Delete confirm ("Delete note" / "Delete
// folder", its wording); Enter confirms, Escape cancels and focus goes back to the row. After a delete, focus moves to
// the next row (the previous one at the end), so you can keep deleting; deleting the open note opens the note that
// gets focus (the next note in the tree, not the workspace's first). The row menu's Delete (⋯, right-click) does the
// same. Nothing happens in a read-only workspace, while renaming in place, or with focus in the editor.
// Usage: bun run build:client && bun test/e2e/tree-delete.mjs
// Needs playwright-core in /tmp/opencode/pw and the Playwright Chromium headless shell.
import "../local-storage.ts";
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { startTarget } from "./target.mjs";

// TARGET=workers runs it against wrangler dev (see target.mjs)
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
const until = (page, fn, arg, timeout = 8000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto(`${base}/auth/dev?next=/app/${WS}/Welcome.md`);
await page.fill("input[name=name]", "Alice");
await page.click("form button[type=submit]");
await page.waitForSelector(".mde .ln", { timeout: 10000 });
const files = [["Alpha.md", "# Alpha\n"], ["Beta.md", "# Beta\n"], ["Gamma.md", "# Gamma\n"], ["Dir/In one.md", "# In one\n"], ["Dir/In two.md", "# In two\n"], ["Omega.md", "# Omega\n"], ["Zed.md", "# Zed\n"], ["Menu A.md", "# Menu A\n"], ["Menu B.md", "# Menu B\n"], ["Menu C.md", "# Menu C\n"], ["Menu dir/Inside.md", "# Inside\n"]];
for (const [path, content] of files) {
  await page.evaluate(([WS, path, content]) => fetch(`/api/workspace/${WS}/files`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, content }) }), [WS, path, content]);
  await T.save(WS, path);
}
await page.goto(`${base}/app/${WS}/Beta.md`);
await page.waitForSelector(`.file-row[href="/app/${WS}/Zed.md"]`, { timeout: 10000 });
await page.waitForSelector(".mde .ln", { timeout: 10000 });

const label = (el) => el?.querySelector(".file-name, .folder-name")?.textContent;
const focus = () => page.evaluate(() => {
  const a = document.activeElement;
  if (a?.getAttribute("role") === "treeitem") return `tree:${a.querySelector(".file-name, .folder-name")?.textContent}`;
  if (a?.closest(".mde")) return "editor";
  if (a?.closest("dialog")) return `dialog:${a.textContent}`;
  return a?.tagName ?? "none";
});
const rows = () => page.$$eval(".sb-tree [role=treeitem]", (els) => els.map((e) => e.querySelector(".file-name, .folder-name")?.textContent));
const dialog = () => page.evaluate(() => {
  const d = document.querySelector("dialog[open]");
  return d ? { title: d.querySelector("h2, .modal-title, header")?.textContent?.trim(), text: d.querySelector(".modal-body p")?.textContent } : null;
});
const path = () => page.evaluate(() => decodeURIComponent(location.pathname));
const listed = () => page.evaluate((WS) => fetch(`/api/workspace/${WS}/tree`).then((r) => r.json()).then((t) => t.files ?? t), WS);
/** Click row `name` (focuses the tree on it, and opens a note). */
const clickRow = async (name) => {
  await page.locator(".sb-tree [role=treeitem]", { has: page.locator(".file-name, .folder-name", { hasText: new RegExp(`^${name}$`) }) }).first().click();
  await until(page, (n) => document.activeElement?.querySelector(".file-name, .folder-name")?.textContent === n, name);
};
const waitFocus = (want) => until(page, (want) => {
  const a = document.activeElement;
  return a?.getAttribute("role") === "treeitem" && a.querySelector(".file-name, .folder-name")?.textContent === want;
}, want);
const gone = (name) => until(page, (n) => ![...document.querySelectorAll(".sb-tree [role=treeitem]")].some((r) => r.querySelector(".file-name, .folder-name")?.textContent === n), name);

console.log("     rows:", (await rows()).join(", "));

// 1. a note, Backspace, Escape: nothing deleted, focus back on the row
await clickRow("Alpha");
await page.keyboard.press("Backspace");
let d = await dialog();
check("Backspace on a note: the menu's confirm (Delete note, “Delete “Alpha.md”? It stays in the Git history.”)", d?.title?.includes("Delete note") && d?.text === "Delete “Alpha.md”? It stays in the Git history.", JSON.stringify(d));
check("…the confirm button has focus (Enter confirms)", (await focus()) === "dialog:Delete", await focus());
await page.keyboard.press("Escape");
check("Escape cancels: the dialog closes", await until(page, () => !document.querySelector("dialog[open]")));
check("…focus back on the row", await waitFocus("Alpha"), await focus());
check("…nothing deleted", (await rows()).includes("Alpha"));

// 2. Backspace, Enter: deleted; focus moves to the next row (Beta), which is the open note: it stays open
await page.keyboard.press("Backspace");
await until(page, () => !!document.querySelector("dialog[open]"));
await page.keyboard.press("Enter");
check("Enter confirms: the note is deleted", await gone("Alpha"));
check("…on the server too", !(await listed()).includes("Alpha.md"), JSON.stringify(await listed()));
check("…focus on the next row (Beta)", await waitFocus("Beta"), await focus());

// 3. forward Delete on the open note (Beta): deleted, focus on the next row (Dir comes first? rows are folders first)
const order = await rows();
const iBeta = order.indexOf("Beta");
const nextAfterBeta = order[iBeta + 1];
check("Beta is open", (await path()) === `/app/${WS}/Beta.md`, await path());
await page.keyboard.press("Delete");
d = await dialog();
check("forward Delete on the open note: the same confirm", d?.text === "Delete “Beta.md”? It stays in the Git history.", JSON.stringify(d));
await page.keyboard.press("Enter");
check("…deleted", await gone("Beta"));
check(`…focus on the next row (${nextAfterBeta})`, await waitFocus(nextAfterBeta), await focus());
check(`…and that note opens in place of the deleted one`, await until(page, ([WS, n]) => decodeURIComponent(location.pathname) === `/app/${WS}/${n}.md` && !!document.querySelector(".mde .ln"), [WS, nextAfterBeta]), await path());
check("…focus stays in the tree (keep deleting)", await waitFocus(nextAfterBeta), await focus());

// 4. a folder: Ctrl+Backspace (⌘⌫ on the Mac), cancel with the Cancel button's Escape, then confirm with Enter
await clickRow("Dir");
const afterDir = (await rows()).filter((r) => r !== "In one" && r !== "In two");
const nextAfterDir = afterDir[afterDir.indexOf("Dir") + 1];
await page.keyboard.press("Control+Backspace");
d = await dialog();
check("Ctrl+Backspace on a folder: the folder confirm (“Delete “Dir” and the 2 notes in it? …”)", d?.title?.includes("Delete folder") && d?.text === "Delete “Dir” and the 2 notes in it? They stay in the Git history.", JSON.stringify(d));
await page.keyboard.press("Escape");
check("Escape: focus back on the folder row", await waitFocus("Dir"), await focus());
check("…the folder is still there", (await rows()).includes("Dir"));
await page.keyboard.press("Delete");
await until(page, () => !!document.querySelector("dialog[open]"));
await page.keyboard.press("Enter");
check("Delete + Enter on a folder: deleted with its notes", await gone("Dir") && !(await rows()).includes("In one"));
check("…on the server too", !(await listed()).some((f) => f.startsWith("Dir/")), JSON.stringify(await listed()));
check(`…focus on the next row (${nextAfterDir}), not a row that was inside it`, await waitFocus(nextAfterDir), await focus());

// 5. the last row, with Meta+Backspace (⌘⌫): focus goes to the previous one
const all = await rows();
const last = all[all.length - 1];
const prev = all[all.length - 2];
await clickRow(last);
await page.keyboard.press("Meta+Backspace");
await until(page, () => !!document.querySelector("dialog[open]"));
await page.keyboard.press("Enter");
check(`⌘⌫ deletes the last row (${last})`, await gone(last));
check(`…focus on the previous row (${prev})`, await waitFocus(prev), await focus());

// 5b. the row menu's Delete (⋯ and right-click) does the same: deleting the open note opens the next note in the tree
// (the previous one at the end), not the workspace's first note, and focus moves the same way
const rowEl = (name) => page.locator(".sb-tree [role=treeitem]", { has: page.locator(".file-name, .folder-name", { hasText: new RegExp(`^${name}$`) }) }).first();
const menuDelete = async (name, how) => {
  if (how === "right-click") await rowEl(name).click({ button: "right" });
  else {
    await rowEl(name).hover();
    // (keys hold a NUL: match the ⋯ button's data-for in the page, not in a selector)
    const key = await rowEl(name).getAttribute("data-key");
    const box = await page.evaluateHandle((k) => [...document.querySelectorAll(".row-menu")].find((b) => b.dataset.for === k), key);
    await box.asElement().click();
  }
  await page.click('.menu-item:has(.menu-label:text-is("Delete"))');
  await until(page, () => !!document.querySelector("dialog[open]"));
};
const isOpenNote = (n) => until(page, ([WS, p]) => decodeURIComponent(location.pathname) === `/app/${WS}/${p}` && !!document.querySelector(".mde .ln"), [WS, n]);
console.log("     rows:", (await rows()).join(", "));
// cancel: nothing deleted, focus on the row
await clickRow("Menu B");
await menuDelete("Menu B", "⋯");
d = await dialog();
check("⋯ → Delete: the same confirm", d?.text === "Delete “Menu B.md”? It stays in the Git history.", JSON.stringify(d));
await page.click('dialog[open] .modal-actions button:text-is("Cancel")');
check("…Cancel: nothing deleted, focus on the row", (await rows()).includes("Menu B") && (await waitFocus("Menu B")), await focus());
// the open note, from ⋯: the next note opens and has focus
let order2 = await rows();
let next2 = order2[order2.indexOf("Menu B") + 1];
await menuDelete("Menu B", "⋯");
await page.click('dialog[open] .modal-actions button:text-is("Delete")');
check("⋯ → Delete on the open note: deleted", await gone("Menu B"));
check(`…the next note (${next2}) opens, not the workspace's first`, await isOpenNote(`${next2}.md`), await path());
check(`…and has focus`, await waitFocus(next2), await focus());
// a folder holding the open note, from a right-click: the next row after the folder opens
await clickRow("Inside");
check("Inside (in Menu dir) is open", await isOpenNote("Menu dir/Inside.md"), await path());
order2 = (await rows()).filter((r) => r !== "Inside");
next2 = order2[order2.indexOf("Menu dir") + 1];
await menuDelete("Menu dir", "right-click");
d = await dialog();
check("right-click → Delete on a folder: the folder confirm", d?.text === "Delete “Menu dir” and the note in it? They stay in the Git history.", JSON.stringify(d));
await page.keyboard.press("Enter");
check("…deleted", await gone("Menu dir"));
check(`…the next row (${next2}) opens and has focus`, (await isOpenNote(`${next2}.md`)) && (await waitFocus(next2)), `${await path()} ${await focus()}`);
// the open note in the last row, from ⋯: the previous note opens
order2 = await rows();
const last2 = order2[order2.length - 1];
const prev2 = order2[order2.length - 2];
await clickRow(last2);
check(`${last2} (the last row) is open`, await isOpenNote(`${last2}.md`), await path());
await menuDelete(last2, "⋯");
await page.keyboard.press("Enter");
check(`⋯ → Delete on the last row: deleted`, await gone(last2));
check(`…the previous note (${prev2}) opens and has focus`, (await isOpenNote(`${prev2}.md`)) && (await waitFocus(prev2)), `${await path()} ${await focus()}`);

// 6. not while renaming in place, nor in the editor
const rowsBefore = await rows();
await page.keyboard.press("F2").catch(() => {});
const renaming = await page.$(".sb-tree .row-rename");
if (!renaming) {
  // (no F2 binding: start a rename from the row menu)
  await page.keyboard.press("Shift+F10");
  await page.locator(".menu [role=menuitem]", { hasText: "Rename" }).click();
}
await page.waitForSelector(".sb-tree .row-rename", { timeout: 5000 });
await page.keyboard.press("End");
await page.keyboard.press("Backspace");
await sleep(200);
check("in the rename field, Backspace edits the name (no confirm)", !(await dialog()), JSON.stringify(await dialog()));
await page.keyboard.press("Escape");
await sleep(200);
check("…nothing deleted", JSON.stringify(await rows()) === JSON.stringify(rowsBefore), JSON.stringify(await rows()));
await page.click(".mde .ln >> nth=0");
await page.keyboard.press("End");
await page.keyboard.press("Backspace");
await sleep(200);
check("in the editor, Backspace edits the note (no confirm)", !(await dialog()), JSON.stringify(await dialog()));
await page.keyboard.press("Control+z");

// 7. a read-only workspace: nothing (no menu Delete, no keyboard delete)
const ro = await ctx.newPage();
await ro.route(/\/api\/(repos|workspaces)(\?|$|\/[^/]+$)/, async (route) => {
  const res = await route.fetch();
  let body = await res.text();
  try {
    const mark = (v) => {
      if (Array.isArray(v)) v.forEach(mark);
      else if (v && typeof v === "object") {
        if (v.id === WS) v.readOnly = true;
        Object.values(v).forEach(mark);
      }
    };
    const j = JSON.parse(body);
    mark(j);
    body = JSON.stringify(j);
  } catch {}
  await route.fulfill({ response: res, body });
});
await ro.goto(`${base}/app/${WS}`);
await ro.waitForSelector(".sb-tree [role=treeitem]", { timeout: 10000 });
await ro.waitForSelector(".mde .ln", { timeout: 10000 });
const roState = await ro.evaluate(() => ({ menus: document.querySelectorAll(".sb-tree .row-menu").length, readonly: !!document.querySelector(".mde.readonly") }));
check("read-only workspace (stubbed): no row menus", roState.menus === 0, JSON.stringify(roState));
await ro.locator(".sb-tree [role=treeitem]").first().click();
const roRows = await ro.$$eval(".sb-tree [role=treeitem]", (els) => els.length);
for (const k of ["Backspace", "Delete", "Control+Backspace"]) await ro.keyboard.press(k);
await sleep(300);
check("…Backspace / Delete / Ctrl+Backspace on a row do nothing", !(await ro.$("dialog[open]")) && (await ro.$$eval(".sb-tree [role=treeitem]", (els) => els.length)) === roRows);
await ro.close();

await browser.close();
await T.stop();
console.log(fails ? `${fails} FAILED` : "all ok");
process.exit(fails ? 1 : 0);
