// End-to-end: wide tables and code blocks. The page never scrolls sideways; a table or code block grows from the text
// column (where a narrow one keeps the column's left edge) into the margins, centred on the column, up to 1400px
// (tables) or 1000px (code), capped by the pane less 24px a side, and scrolls inside itself beyond that. Editing
// inside them still works: click-to-place, typing in a far-right cell after scrolling, End scrolls the caret into
// view, Up/Down, reveal of the raw table syntax, folding, remote cursors, author names.
// Usage: bun run build:client && bun test/e2e/wide-blocks.mjs   (screenshots in /tmp/opencode/wide-tables/)
// Needs playwright-core in /tmp/opencode/pw and the Playwright Chromium headless shell.
import "../local-storage.ts";
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { mkdirSync } from "node:fs";
import { startTarget } from "./target.mjs";

const SHOTS = "/tmp/opencode/wide-tables";
mkdirSync(SHOTS, { recursive: true });
// TARGET=workers runs it against wrangler dev (see target.mjs); the notebook is `WS` ("notes" on Bun), also in pages.
const T = await startTarget({ env: { QUIET_MS: "1500" } });
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TABLE_MAX = 1400;
const CODE_MAX = 1000;
const GAP = 24;

async function open(name, width = 1440, height = 900) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.addInitScript((ws) => (globalThis.WS = ws), WS);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[${name}] PAGEERROR`, e.message));
  page.on("console", (m) => m.type() === "error" && console.log(`[${name}] CONSOLE`, m.text()));
  await page.goto(`${base}/auth/dev?next=${T.appPath}`);
  await page.fill("input[name=name]", name);
  await page.click("form button[type=submit], form button");
  await page.waitForURL(/\/app\//, { timeout: 10000 });
  return page;
}

const cols = 30;
const wideTable = [
  "| " + Array.from({ length: cols }, (_, i) => `Column ${i + 1}`).join(" | ") + " |",
  "|" + "---|".repeat(cols),
  "| " + Array.from({ length: cols }, (_, i) => `r1c${i + 1}`).join(" | ") + " |",
  "| " + Array.from({ length: cols }, (_, i) => `r2c${i + 1}`).join(" | ") + " |",
].join("\n");
const mediumTable = [
  "| " + Array.from({ length: 9 }, (_, i) => `Heading ${i + 1}`).join(" | ") + " |",
  "|" + "---|".repeat(9),
  "| " + Array.from({ length: 9 }, (_, i) => `value-${i + 1}-xx`).join(" | ") + " |",
].join("\n");
const longUrl = "https://example.com/" + "averyveryverylongpathsegment".repeat(12) + "?q=" + "x".repeat(80);
const longWord = "Supercalifragilistic".repeat(15);
const mediumCode = "const medium = " + JSON.stringify("m".repeat(86)) + ";"; // ~105 chars: wider than the column, under 1000px
const longCode = "const long = " + JSON.stringify("L".repeat(240)) + ";";
const doc = [
  "# Wide blocks",
  "",
  "A paragraph before the tables.",
  "",
  "## Tables",
  "",
  "| A | B |",
  "|---|---|",
  "| narrow | table |",
  "",
  "Between.",
  "",
  wideTable,
  "",
  mediumTable,
  "",
  "## Code",
  "",
  "```js",
  "short();",
  "```",
  "",
  "```js",
  mediumCode,
  "```",
  "",
  "```js",
  "first();",
  longCode,
  "last();",
  "```",
  "",
  "## Text",
  "",
  "A long URL: " + longUrl,
  "",
  longWord,
  "",
  "The end.",
].join("\n");

/** Geometry of everything the checks look at. */
const measure = (page) =>
  page.evaluate(() => {
    const root = document.querySelector(".mde-content");
    const cs = getComputedStyle(root);
    const rr = root.getBoundingClientRect();
    const textL = rr.left + parseFloat(cs.paddingLeft);
    const textR = rr.right - parseFloat(cs.paddingRight);
    const pane = document.querySelector(".mde");
    const pr = pane.getBoundingClientRect();
    const blocks = [...root.querySelectorAll(":scope > .mde-blk")].map((b) => {
      const r = b.getBoundingClientRect();
      const first = b.firstElementChild;
      return {
        kind: b.classList.contains("mde-blk-table") ? "table" : "code",
        text: first.textContent.slice(0, 24),
        left: r.left,
        right: r.right,
        width: r.width,
        sw: b.scrollWidth,
        cw: b.clientWidth,
        lines: b.children.length,
        lineWidths: [...b.children].map((c) => c.getBoundingClientRect().width),
        rowWidth: first.getBoundingClientRect().width,
      };
    });
    const se = document.scrollingElement;
    // every scroller on the page other than the blocks: none may scroll sideways
    // (and the panes, whose overflow-x: hidden is only a safety net: their content must fit them; .mde-content isn't
    // one: blocks reach past it into the margins)
    const sideways = [...document.querySelectorAll("*")]
      .filter((el) => !el.classList.contains("mde-blk") && el.scrollWidth > el.clientWidth + 1 && (/auto|scroll/.test(getComputedStyle(el).overflowX) || el.matches(".doc-body, .mde, .editor-host, .app, #app")))
      .map((el) => `${el.tagName}.${el.className} ${el.scrollWidth}>${el.clientWidth}`);
    const lines = [...root.getElementsByClassName("ln")].filter((d) => !d.closest(".mde-blk") && d.getBoundingClientRect().right > textR + 1).map((d) => d.textContent.slice(0, 30));
    return {
      textL,
      textR,
      textW: textR - textL,
      paneL: pr.left,
      paneR: pr.left + pane.clientWidth,
      blocks,
      page: { sw: se.scrollWidth, cw: se.clientWidth, bodySw: document.body.scrollWidth, bodyCw: document.body.clientWidth },
      sideways,
      linesPastColumn: lines,
    };
  });

const near = (a, b, d = 1.5) => Math.abs(a - b) <= d;

function checkLayout(tag, m) {
  const room = Math.max(m.textW, 2 * Math.min((m.textL + m.textR) / 2 - m.paneL, m.paneR - (m.textL + m.textR) / 2) - 2 * GAP);
  check(`${tag}: no page scroll (${m.page.sw} ≤ ${m.page.cw})`, m.page.sw <= m.page.cw && m.page.bodySw <= m.page.bodyCw, JSON.stringify(m.page));
  check(`${tag}: nothing else scrolls sideways`, m.sideways.length === 0, JSON.stringify(m.sideways));
  check(`${tag}: no line outside the blocks runs past the text column`, m.linesPastColumn.length === 0, JSON.stringify(m.linesPastColumn));
  const mid = (m.textL + m.textR) / 2;
  for (const b of m.blocks) {
    const cap = Math.min(b.kind === "table" ? TABLE_MAX : CODE_MAX, room);
    const ok = b.left >= m.paneL - 0.5 && b.right <= m.paneR + 0.5 && b.width <= Math.max(cap, m.textW) + 1 && b.width >= m.textW - 1;
    const placed = b.width <= m.textW + 1 ? near(b.left, m.textL) : near((b.left + b.right) / 2, mid);
    check(`${tag}: ${b.kind} "${b.text}" ${Math.round(b.width)}px within [column, cap ${Math.round(cap)}], inside the pane, ${b.width <= m.textW + 1 ? "on the column" : "centred on it"}`, ok && placed, JSON.stringify({ b, textL: m.textL, textW: m.textW, mid, cap }));
  }
}

const alice = await open("Alice");
const created = await alice.evaluate(async (content) => {
  const r = await fetch(`/api/workspace/${WS}/files`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "Wide.md", content }) });
  return r.status;
}, doc);
check("note created", created === 201 || created === 200, String(created));
await alice.goto(`${base}/app/${WS}/Wide.md`);
await alice.waitForFunction(() => document.querySelector(".mde")?.textContent?.includes("The end."), null, { timeout: 10000 });
await sleep(800);

let m = await measure(alice);
check("tables and code blocks are in blocks: 3 tables, 3 code blocks", m.blocks.filter((b) => b.kind === "table").length === 3 && m.blocks.filter((b) => b.kind === "code").length === 3, JSON.stringify(m.blocks.map((b) => [b.kind, b.text, b.lines])));
checkLayout("1440", m);
const [narrow, wide, medium] = m.blocks.filter((b) => b.kind === "table");
const [shortCode, medCode, longC] = m.blocks.filter((b) => b.kind === "code");
console.log("     text column", Math.round(m.textW), "px; blocks:", m.blocks.map((b) => `${b.kind} ${Math.round(b.width)}${b.sw > b.cw ? " (scrolls)" : ""}`).join(", "));
check("narrow table: the column's width, its left edge on the column, its natural width inside, no scroll", near(narrow.width, m.textW) && near(narrow.left, m.textL) && narrow.rowWidth < m.textW - 100 && narrow.sw <= narrow.cw, JSON.stringify(narrow));
check("30-column table: wider than the column, as wide as the pane allows, scrolls inside itself", wide.width > m.textW + 100 && wide.sw > wide.cw + 100, JSON.stringify(wide));
check("medium table: breaks out to its natural width without scrolling", medium.width > m.textW + 20 && medium.sw <= medium.cw, JSON.stringify(medium));
check("short code block: the column's width, on the column", near(shortCode.width, m.textW) && near(shortCode.left, m.textL) && shortCode.sw <= shortCode.cw, JSON.stringify(shortCode));
check("medium code block: breaks out without scrolling, under the code cap", medCode.width > m.textW + 20 && medCode.width < CODE_MAX && medCode.sw <= medCode.cw, JSON.stringify(medCode));
check("long code block: capped (code < table), scrolls inside itself", longC.width <= CODE_MAX + 1 && longC.width < wide.width && longC.sw > longC.cw, JSON.stringify(longC));
check("long code block: every line (and its background) spans the scrolled width", longC.lineWidths.every((w) => near(w, longC.sw)), JSON.stringify(longC.lineWidths));
await alice.screenshot({ path: `${SHOTS}/1440-top.png` });
await alice.evaluate(() => [...document.querySelectorAll(".mde-blk-code")][2].scrollIntoView({ block: "center" }));
await sleep(200);
await alice.screenshot({ path: `${SHOTS}/1440-code.png` });

// a wide window: tables reach their own cap, code its smaller one
await alice.setViewportSize({ width: 1920, height: 1000 });
await sleep(500);
m = await measure(alice);
checkLayout("1920", m);
{
  const [, w] = m.blocks.filter((b) => b.kind === "table");
  const [, , c] = m.blocks.filter((b) => b.kind === "code");
  check(`1920: the 30-column table at the 1400px cap (${Math.round(w.width)})`, near(w.width, TABLE_MAX), JSON.stringify(w));
  check(`1920: the long code block at the 1000px cap (${Math.round(c.width)})`, near(c.width, CODE_MAX), JSON.stringify(c));
}
await alice.evaluate(() => document.querySelector(".mde-content").scrollIntoView({ block: "start" }));
await alice.screenshot({ path: `${SHOTS}/1920.png` });
await alice.setViewportSize({ width: 1440, height: 900 });
await sleep(400);

// editing in the wide table: scroll it right, click into the last cell of row 2, type
const wideBlk = alice.locator(".mde-blk-table >> nth=1");
await wideBlk.evaluate((b) => {
  b.scrollIntoView({ block: "center" });
  b.scrollLeft = b.scrollWidth;
});
await sleep(200);
const lastCell = wideBlk.locator(".ln >> nth=3").locator(".tcell:not(.tph) >> nth=29");
const lc = await lastCell.boundingBox();
const bb = await wideBlk.boundingBox();
check("after scrolling, the far-right cell is in the block's view", lc && lc.x >= bb.x && lc.x + lc.width <= bb.x + bb.width + 1, JSON.stringify({ lc, bb }));
// a click just right of the cell's text: the caret at the end of "r2c30"
const tb = await lastCell.locator(".t").first().boundingBox();
await alice.mouse.click(tb.x + tb.width - 1, tb.y + tb.height / 2);
await sleep(150);
await alice.keyboard.type("XYZ");
await sleep(300);
let text = await alice.evaluate(() => document.querySelector(".mde").mdeView.doc.text);
check("typing in the far-right cell after scrolling lands there", text.includes("| r2c30XYZ |"), text.split("\n").find((l) => l.includes("r2c30")));
let st = await wideBlk.evaluate((b) => ({ left: b.scrollLeft, max: b.scrollWidth - b.clientWidth, caret: (() => { const r = document.getSelection().getRangeAt(0).getBoundingClientRect(); const br = b.getBoundingClientRect(); return [r.left, br.left, br.left + b.clientWidth]; })() }));
check("…the block stays scrolled to the caret, which is in its view", st.left > 0 && st.caret[0] >= st.caret[1] && st.caret[0] <= st.caret[2], JSON.stringify(st));
check("…the page still doesn't scroll sideways", (await measure(alice)).page.sw <= (await measure(alice)).page.cw);
const rv = await wideBlk.evaluate((b) => [...b.children].map((l) => l.classList.contains("rv")));
check("caret in the table: its rows reveal the raw syntax", rv.every(Boolean), JSON.stringify(rv));
const pipes = await wideBlk.evaluate((b) => getComputedStyle(b.querySelector(".mk.tbl")).display);
check("…the pipes show", pipes === "inline", pipes);
await alice.screenshot({ path: `${SHOTS}/edit-far-right.png` });

// keyboard: Home goes back to the start of the row and the block scrolls back; End scrolls to the end again
await alice.keyboard.press("Home");
await sleep(150);
st = await wideBlk.evaluate((b) => b.scrollLeft);
check("Home: the block scrolls back to the row's start", st < 40, String(st));
await alice.keyboard.press("End");
await sleep(150);
st = await wideBlk.evaluate((b) => ({ left: b.scrollLeft, max: b.scrollWidth - b.clientWidth }));
await alice.keyboard.press("ArrowLeft");
await alice.keyboard.press("ArrowLeft");
check("End: the block scrolls to the caret at the row's end", st.left > st.max - 60, JSON.stringify(st));
// Up / Down between rows keep working
const lineOf = () => alice.evaluate(() => { const v = document.querySelector(".mde").mdeView; return v.doc.lines.findIndex((l) => l.from <= v.sel.head && v.sel.head <= l.to); });
const l0 = await lineOf();
await alice.keyboard.press("ArrowUp");
await sleep(100);
const l1 = await lineOf();
check("Up from row 2 goes to row 1", l1 === l0 - 1, `${l0} -> ${l1}`);
await alice.keyboard.press("ArrowDown");
await alice.keyboard.press("ArrowDown");
await sleep(100);
check("Down twice leaves the table for the line after it", (await lineOf()) === l0 + 1, String(await lineOf()));
// undo the typing
for (let i = 0; i < 3; i++) await alice.keyboard.press("Control+z");
await sleep(200);
text = await alice.evaluate(() => document.querySelector(".mde").mdeView.doc.text);
check("undo takes the typing back out", text === doc, text.split("\n").find((l) => l.includes("r2c30")));

// click-to-place in the medium table: a click on a cell's text puts the caret in that cell
const medBlk = alice.locator(".mde-blk-table >> nth=2");
const cell = medBlk.locator(".ln >> nth=2").locator(".tcell:not(.tph) >> nth=4");
const cb = await cell.boundingBox();
await alice.mouse.click(cb.x + 3, cb.y + cb.height / 2);
await sleep(150);
const at = await alice.evaluate(() => { const v = document.querySelector(".mde").mdeView; return v.doc.text.slice(v.sel.head - 3, v.sel.head + 10); });
check("click-to-place in a broken-out table cell", at.includes("value-5"), JSON.stringify(at));
// selection across blocks: a click in the paragraph above, Shift+click in the medium table
const para = await alice.locator(".mde .ln >> nth=2").boundingBox();
await alice.mouse.click(para.x + 20, para.y + para.height / 2);
await alice.keyboard.down("Shift");
await alice.mouse.click(cb.x + 3, cb.y + cb.height / 2);
await alice.keyboard.up("Shift");
await sleep(150);
const sel = await alice.evaluate(() => { const v = document.querySelector(".mde").mdeView; return v.doc.text.slice(Math.min(v.sel.anchor, v.sel.head), Math.max(v.sel.anchor, v.sel.head)); });
check("Shift+click selects across the tables", sel.includes("| narrow | table |") && sel.includes("r2c30") && sel.includes("value-4"), JSON.stringify(sel.slice(0, 60)));
const selRects = await alice.evaluate(() => document.querySelector(".mde").mdeView.rangeRects(...(() => { const v = document.querySelector(".mde").mdeView; return [Math.min(v.sel.anchor, v.sel.head), Math.max(v.sel.anchor, v.sel.head)]; })()).length);
check("…its highlight rects exist (clipped to the scrolled blocks)", selRects > 5, String(selRects));
await alice.keyboard.press("ArrowRight");

// typing a new table row grows the table in place (the block and its scroll stay)
await wideBlk.evaluate((b) => { b.scrollLeft = 300; b.__mark = 1; });
const r2 = wideBlk.locator(".ln >> nth=3").locator(".tcell:not(.tph) >> nth=5");
const r2b = await r2.boundingBox();
await alice.mouse.click(r2b.x + 4, r2b.y + r2b.height / 2);
await alice.keyboard.press("End");
await alice.keyboard.press("Enter");
await alice.keyboard.type("| new | row |");
await sleep(300);
const grown = await alice.evaluate(() => { const b = [...document.querySelectorAll(".mde-blk-table")][1]; return { same: b.__mark === 1, rows: b.children.length, last: b.lastElementChild.textContent }; });
check("a new row joins the same table block (the element is kept)", grown.same && grown.rows === 5 && grown.last.includes("new"), JSON.stringify(grown));
for (let i = 0; i < 2; i++) await alice.keyboard.press("Control+z");
await sleep(200);
text = await alice.evaluate(() => document.querySelector(".mde").mdeView.doc.text);
check("…and undo removes it again", text === doc, text.length - doc.length);
const blocks2 = await alice.evaluate(() => document.querySelectorAll(".mde-content > .mde-blk").length);
check("…six blocks again", blocks2 === 6, String(blocks2));

// splitting a table with a blank line makes two blocks; joining them back makes one
await alice.evaluate(() => {
  const v = document.querySelector(".mde").mdeView;
  const i = v.doc.text.indexOf("| r1c1 ");
  v.root.focus();
  v.setSel({ anchor: i - 1, head: i - 1 });
});
await alice.keyboard.press("Enter");
await sleep(200);
const split = await alice.evaluate(() => document.querySelectorAll(".mde-content > .mde-blk-table").length);
check("a blank line inside a table: the rows after it leave its block", split >= 3, String(split));
await alice.keyboard.press("Control+z");
await sleep(200);
const joined = await alice.evaluate(() => ({ n: document.querySelectorAll(".mde-content > .mde-blk-table").length, rows: [...document.querySelectorAll(".mde-blk-table")].map((b) => b.children.length) }));
check("…undo: one block again", joined.n === 3 && joined.rows.join() === "3,4,3", JSON.stringify(joined));

// folding a section hides its tables; unfolding brings them back as they were
await alice.evaluate(() => document.querySelector(".mde").mdeView.foldCommand("foldAll"));
await sleep(200);
const folded = await alice.evaluate(() => [...document.querySelectorAll(".mde-blk")].map((b) => Math.round(b.getBoundingClientRect().height)));
check("fold all: the blocks take no space", folded.every((h) => h === 0), JSON.stringify(folded));
check("…and nothing scrolls sideways", (await measure(alice)).page.sw <= (await measure(alice)).page.cw);
await alice.evaluate(() => document.querySelector(".mde").mdeView.foldCommand("unfoldAll"));
await sleep(200);
m = await measure(alice);
check("unfold all: the blocks are back", m.blocks.length === 6 && m.blocks.every((b) => b.width > 0), JSON.stringify(m.blocks.map((b) => b.width)));

// another person's caret in the far-right cell: shown where the block shows it, hidden when scrolled out of view
const bob = await open("Bob");
await bob.goto(`${base}/app/${WS}/Wide.md`);
await bob.waitForFunction(() => document.querySelector(".mde")?.textContent?.includes("The end."), null, { timeout: 10000 });
await sleep(500);
await bob.evaluate(() => {
  const v = document.querySelector(".mde").mdeView;
  const i = v.doc.text.indexOf("r2c30") + 5;
  v.root.focus();
  v.setSel({ anchor: i, head: i });
});
await bob.keyboard.type("!");
await sleep(1200);
await wideBlk.evaluate((b) => { b.scrollIntoView({ block: "center" }); b.scrollLeft = 0; });
await sleep(400);
let rc = await alice.evaluate(() => document.querySelectorAll(".mde-cursors .rcaret").length);
check("Bob's caret, scrolled out of the table's view, isn't drawn over the margin", rc === 0, String(rc));
await wideBlk.evaluate((b) => { b.scrollLeft = b.scrollWidth; });
await sleep(400);
rc = await alice.evaluate(() => {
  const c = document.querySelector(".mde-cursors .rcaret");
  const b = [...document.querySelectorAll(".mde-blk-table")][1];
  if (!c) return null;
  const r = c.getBoundingClientRect();
  const br = b.getBoundingClientRect();
  return { x: r.left, l: br.left, r: br.left + b.clientWidth, y: r.top, top: br.top, bottom: br.bottom };
});
check("…scrolled into view: drawn in the cell", rc && rc.x >= rc.l - 2 && rc.x <= rc.r + 2 && rc.y >= rc.top && rc.y <= rc.bottom, JSON.stringify(rc));
await alice.screenshot({ path: `${SHOTS}/remote-caret.png` });

// author names (two authors now): never over a block that grew into the margin
const names = await alice.evaluate(() => {
  const root = document.querySelector(".mde-content");
  const lines = root.getElementsByClassName("ln");
  return [...document.querySelectorAll(".mde-authors .mde-author")].map((e) => {
    const div = lines[Number(e.dataset.line)];
    const b = div?.parentElement?.classList.contains("mde-blk") ? div.parentElement.getBoundingClientRect() : null;
    return { line: Number(e.dataset.line), right: e.firstElementChild.getBoundingClientRect().right, blockLeft: b ? b.left : null };
  });
});
check("author names stay clear of broken-out blocks", names.length > 0 && names.every((n) => n.blockLeft === null || n.right <= n.blockLeft), JSON.stringify(names));

// narrower windows: still no page scroll, blocks inside the pane
for (const w of [1100, 800, 400]) {
  await alice.setViewportSize({ width: w, height: 800 });
  await sleep(500);
  m = await measure(alice);
  checkLayout(String(w), m);
  const t = m.blocks.filter((b) => b.kind === "table")[1];
  check(`${w}: the 30-column table still scrolls inside itself`, t.sw > t.cw, JSON.stringify(t));
  await alice.evaluate(() => document.querySelector(".mde-content").scrollIntoView({ block: "start" }));
  await alice.screenshot({ path: `${SHOTS}/w${w}.png` });
  await alice.evaluate(() => [...document.querySelectorAll(".mde-blk-code")][2].scrollIntoView({ block: "center" }));
  await alice.screenshot({ path: `${SHOTS}/w${w}-code.png` });
}

await browser.close();
await T.stop();
console.log(fails ? `${fails} FAILED` : "all ok");
process.exit(fails ? 1 : 0);
