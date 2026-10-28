// End-to-end: Shift+Down (and Down) through tables whose header cells wrap. The shell's caret box for a position at a
// soft wrap must be at the start of the next row (where a hit test there puts it); it used to be at the end of the row
// above, so the engine took the hit for the caret's own row and Shift+Down stuck on the header. From every header
// cell (a goal x at its left edge from the paragraph above, and a click at the start of each of its rows) the
// selection extends through the table and beyond; plain Down leaves it too. Up/Down keep a column that's scrolled out
// of the table's view or left of the text column (content x used to be clamped to the root, and moved with the
// block's scroll). And at every soft wrap of paragraphs and tables, a hit at a row's start gives a position whose
// caret box is on that row.
// Usage: bun run build:client && bun test/e2e/shift-down.mjs
// Needs playwright-core in /tmp/opencode/pw and the Playwright Chromium headless shell.
import "../local-storage.ts";
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "np-e2e-shiftdown-"));
process.env.ALLOW_DEV_LOGIN = "1";
process.env.QUIET_MS = "1500";
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

const cols = 12;
const above = Array.from({ length: 40 }, () => "words above the table").join(" ");
const doc = [
  "# Shift+Down",
  "",
  above,
  "| " + Array.from({ length: cols }, (_, i) => `Column ${i + 1}`).join(" | ") + " |",
  "|" + "---|".repeat(cols),
  "| " + Array.from({ length: cols }, (_, i) => `r1c${i + 1}`).join(" | ") + " |",
  "| " + Array.from({ length: cols }, (_, i) => `r2c${i + 1}`).join(" | ") + " |",
  "",
  "After the table.",
  "",
  "The end.",
].join("\n");
const HEAD = 3;
const LAST = 6;

const ctx = await browser.newContext({ viewport: { width: 800, height: 900 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto(base + "/auth/dev?next=/app");
await page.fill("input[name=name]", "Alice");
await page.click("form button[type=submit], form button");
await page.waitForURL(/\/app\//, { timeout: 10000 });
const created = await page.evaluate(async (content) => {
  const r = await fetch("/api/repos/notes/files", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "ShiftDown.md", content }) });
  return r.status;
}, doc);
check("note created", created === 201 || created === 200, String(created));
await page.goto(`${base}/app/notes/ShiftDown.md`);
await page.waitForFunction(() => document.querySelector(".mde")?.textContent?.includes("The end."), null, { timeout: 10000 });
await page.waitForTimeout(300);

const state = () =>
  page.evaluate(() => {
    const v = document.querySelector(".mde").mdeView;
    const li = (p) => v.doc.lines.findIndex((l) => l.from <= p && p <= l.to);
    return { anchor: v.sel.anchor, head: v.sel.head, line: li(v.sel.head) };
  });
/** Scroll the table's block so header cell `c` is in its view. */
const showCell = (c) =>
  page.evaluate(([HEAD, c]) => {
    const div = document.querySelector(".mde-content").getElementsByClassName("ln")[HEAD];
    const cell = div.querySelectorAll(".tcell:not(.tph)")[c];
    const b = div.parentElement;
    const cr = cell.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    if (cr.left < br.left + 8) b.scrollLeft -= br.left + 8 - cr.left;
    else if (cr.right > br.left + b.clientWidth - 8) b.scrollLeft += cr.right - (br.left + b.clientWidth - 8);
  }, [HEAD, c]);
/** The header cells' visual rows (client boxes), revealed or not as the table is now. */
const headerRows = () =>
  page.evaluate((HEAD) => {
    const div = document.querySelector(".mde-content").getElementsByClassName("ln")[HEAD];
    const range = document.createRange();
    return [...div.querySelectorAll(".tcell:not(.tph)")].map((cell) => {
      const rows = [];
      for (const t of cell.querySelectorAll(".t")) {
        range.selectNodeContents(t);
        for (const r of range.getClientRects()) if (r.width > 1 && r.height > 1 && !rows.some((x) => Math.abs(x.y - (r.top + r.bottom) / 2) < 3)) rows.push({ x: r.left, y: (r.top + r.bottom) / 2 });
      }
      return rows;
    });
  }, HEAD);

const collapsed = await headerRows();
check(`the header cells wrap (${collapsed.filter((r) => r.length > 1).length} of ${cols} on two rows)`, collapsed.filter((r) => r.length > 1).length >= cols / 2, JSON.stringify(collapsed.map((r) => r.length)));

/** Press `key` up to `n` times; the lines the head visits. */
async function walk(key, n) {
  const path = [];
  for (let i = 0; i < n; i++) {
    await page.keyboard.press(key);
    path.push((await state()).line);
    if (path[path.length - 1] > LAST) break;
  }
  return path;
}

// 1. from the paragraph above, with the goal x at each header cell's left edge
let stuck = [];
for (let c = 0; c < cols; c++) {
  for (const key of ["Shift+ArrowDown", "ArrowDown"]) {
    await page.keyboard.press("Escape");
    await page.mouse.click(5, 5);
    await showCell(c);
    const x = (await headerRows())[c][0].x + 1;
    const para = await page.evaluate(() => {
      const div = document.querySelector(".mde-content").getElementsByClassName("ln")[2];
      const rs = [...div.getClientRects()];
      const range = document.createRange();
      range.selectNodeContents(div);
      const rows = [...range.getClientRects()];
      const last = rows[rows.length - 1];
      return { y: (last.top + last.bottom) / 2, right: last.right, n: rs.length };
    });
    // the paragraph's last row may end before x: use the row above it then
    const y = para.right > x ? para.y : para.y - 26;
    await page.mouse.click(x, y);
    const start = await state();
    const path = await walk(key, 12);
    const end = await state();
    const through = path.includes(HEAD) && Math.max(...path) > LAST;
    const kept = key === "ArrowDown" || end.anchor === start.anchor;
    if (!through || !kept) stuck.push({ cell: c, key, start, path, end });
  }
}
check(`from above, each header cell's column: Shift+Down extends through the table and beyond, Down leaves it (${cols * 2} runs)`, stuck.length === 0, JSON.stringify(stuck.slice(0, 4)));

// 2. a click at the start of each visual row of each header cell, then Shift+Down / Down
stuck = [];
let runs = 0;
for (let c = 0; c < cols; c++) {
  for (let k = 0; k < collapsed[c].length; k++) {
    for (const key of ["Shift+ArrowDown", "ArrowDown"]) {
      // (clicking reveals the table; its rows move: measure them as they are now)
      await showCell(c);
      const first = (await headerRows())[c];
      await page.mouse.click(first[k]?.x + 1 || first[0].x + 1, (first[k] ?? first[0]).y);
      await showCell(c);
      const rows = await headerRows();
      const row = rows[c]?.[k] ?? rows[c]?.[rows[c].length - 1];
      await page.mouse.click(row.x + 1, row.y);
      const start = await state();
      if (start.line !== HEAD) {
        stuck.push({ cell: c, row: k, key, error: "click missed the header", start });
        continue;
      }
      runs++;
      const path = await walk(key, 12);
      const end = await state();
      if (!(Math.max(...path) > LAST) || (key === "Shift+ArrowDown" && end.anchor !== start.anchor)) stuck.push({ cell: c, row: k, key, start, path, end });
    }
  }
}
check(`from the start of every row of every header cell: Shift+Down extends through the table and beyond, Down leaves it (${runs} runs)`, stuck.length === 0, JSON.stringify(stuck.slice(0, 4)));

// 3. Up/Down keep a column that's scrolled out of the block's view, or left of the text column (a table grown into the
// margin): the caret in the far-right / far-left header cell, Down lands in that column of row 1
const column = async (tag, c) => {
  await showCell(c);
  // (inside "Column": a wrapped cell's second row starts under the revealed pipe)
  await page.mouse.click((await headerRows())[c][0].x + 1, (await headerRows())[c][0].y);
  await showCell(c);
  const first = (await headerRows())[c][0];
  await page.mouse.click(first.x + 24, first.y);
  const head = await state();
  // scroll the block the other way, so the caret's column is out of view
  await page.evaluate((HEAD) => { const b = document.querySelector(".mde-content").getElementsByClassName("ln")[HEAD].parentElement; b.scrollLeft = b.scrollLeft > 0 ? 0 : b.scrollWidth; }, HEAD);
  // (down the header's wrapped second row and the delimiter row to row 1)
  for (let i = 0; i < 4 && (await state()).line < HEAD + 2; i++) await page.keyboard.press("ArrowDown");
  const at = await page.evaluate(() => { const v = document.querySelector(".mde").mdeView; const l = v.doc.lines.find((l) => l.from <= v.sel.head && v.sel.head <= l.to); return v.doc.text.slice(l.from, l.to).slice(0, v.sel.head - l.from).split("|").length - 2; });
  const line = (await state()).line;
  check(`${tag}: Down from header cell ${c + 1} (scrolled out of view) lands in row 1, cell ${c + 1}`, head.line === HEAD && line === HEAD + 2 && at === c, JSON.stringify({ head, line, cell: at }));
};
await column("800px", cols - 1);
await column("800px", 0);
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(300);
const grown = await page.evaluate((HEAD) => { const b = document.querySelector(".mde-content").getElementsByClassName("ln")[HEAD].parentElement; const c = document.querySelector(".mde-content"); return { blockLeft: b.getBoundingClientRect().left, textLeft: c.getBoundingClientRect().left + parseFloat(getComputedStyle(c).paddingLeft) }; }, HEAD);
check("1440px: the table grows into the left margin", grown.blockLeft < grown.textLeft - 50, JSON.stringify(grown));
await column("1440px, left of the text column", 0);
await column("1440px", cols - 1);
await page.setViewportSize({ width: 800, height: 900 });
await page.waitForTimeout(300);

// 4. the shell's geometry at soft wraps: a hit at a row's start gives a position whose caret box is on that row
const geometry = async (tag) => {
  const bad = await page.evaluate(() => {
    const v = document.querySelector(".mde").mdeView;
    const L = v.layout;
    const [ox, oy] = L.origin();
    const range = document.createRange();
    const out = [];
    for (const [li, div] of [...v.root.getElementsByClassName("ln")].entries()) {
      for (const t of div.querySelectorAll(".t")) {
        range.selectNodeContents(t);
        for (const r of range.getClientRects()) {
          if (r.width < 2 || r.height < 2 || r.top < 0 || r.bottom > innerHeight) continue;
          const mid = (r.top + r.bottom) / 2;
          const hit = L.hit_test(r.left + 1 - ox, mid - oy);
          if (hit === undefined) continue;
          const c = L.caret_rect(hit);
          if (mid < c[1] + oy - 1 || mid > c[1] + oy + c[3] + 1) out.push({ li, text: t.textContent.slice(0, 16), hit, rowTop: Math.round(r.top), caretTop: Math.round(c[1] + oy) });
        }
      }
    }
    return out;
  });
  check(`${tag}: at every row start (paragraphs, table cells), the hit's caret box is on that row`, bad.length === 0, JSON.stringify(bad.slice(0, 4)));
};
await page.keyboard.press("Control+Home");
await page.waitForTimeout(100);
await geometry("table collapsed");

await browser.close();
await app.stop();
rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : "all ok");
process.exit(fails ? 1 : 0);
