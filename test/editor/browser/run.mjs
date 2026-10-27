import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";

// Usage: bun test/editor/browser/run.mjs            (a local document: harness.ts + the wasm pkg)
//        COLLAB=1 bun test/editor/browser/run.mjs   (the engine owning the shared doc, in-page room)
// Builds the harness into /tmp/opencode/edtest. Needs playwright-core and a Chromium headless shell (paths below).
const collab = !!process.env.COLLAB;
const dir = "/tmp/opencode/edtest";
{
  const src = new URL(".", import.meta.url).pathname;
  const root = new URL("../../../", import.meta.url).pathname;
  const out = await Bun.build({ entrypoints: [src + "harness.ts"], outdir: dir, target: "browser", naming: "harness.js" });
  if (!out.success) throw new AggregateError(out.logs, "harness build failed");
  const files = [src + "index.html", root + "src/client/editor-rs/editor.css", root + "src/client/editor-rs/pkg/editor_wasm.js", root + "src/client/editor-rs/pkg/editor_wasm_bg.wasm"];
  for (const f of files) await Bun.write(dir + "/" + f.split("/").pop(), Bun.file(f));
  // the code highlighter's wasm, where code.ts looks for it without a build hash
  await Bun.write(dir + "/dist/highlights/highlights.wasm", Bun.file(root + "node_modules/@pierre/highlights/dist/highlights.wasm"));
}
const server = Bun.serve({
  port: 0,
  idleTimeout: 255,
  fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === "/hang.png") return new Promise(() => {}); // an image that never loads
    const f = Bun.file(dir + (p === "/" ? "/index.html" : p));
    return new Response(f);
  },
});
console.log("mode:", collab ? "collab" : "local");
const base = `http://localhost:${server.port}/`;
const b = await chromium.launch({
  executablePath: "/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell",
});
const page = await b.newPage({ viewport: { width: 900, height: 700 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
page.on("console", (m) => m.type() === "error" && console.log("CONSOLE", m.text()));

let fails = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(ok ? "ok  " : "FAIL", name, ok ? "" : `\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
}
const T = (fn, arg) => page.evaluate(fn, arg);
const text = () => T(() => T.text());
const sel = () => T(() => [T.sel().anchor, T.sel().head]);
let nload = 0;
async function load(init, q = "") {
  await page.goto(base + "?n=" + nload++ + (collab ? "&collab" : "") + (q ? "&" + q.slice(1) : "") + "#" + encodeURIComponent(init));
  await page.waitForFunction(() => !!window.T);
}
async function caretTo(pos) {
  await T((p) => {
    T.view.root.focus();
    T.view.setSel({ anchor: p, head: p }, { dom: true });
  }, pos);
}

// --- typing & conversions
await load("");
check("engine under test", await T(() => document.querySelector(".mde").dataset.engine), "rust");
await page.click(".mde-content");
await page.keyboard.type("hello **world**");
check("type bold", await text(), "hello **world**");
check("caret after bold", await sel(), [15, 15]);
check("bold revealed", await T(() => [...document.querySelectorAll(".mk.rv")].length), 2);
await page.keyboard.type(" x");
check("bold collapsed after moving off", await T(() => [...document.querySelectorAll(".mk.rv")].length), 0);
await page.keyboard.press("Enter");
await page.keyboard.type("- a");
await page.keyboard.press("Enter");
await page.keyboard.type("b");
await page.keyboard.press("Enter");
await page.keyboard.press("Enter");
check("list continue + exit", await text(), "hello **world** x\n- a\n- b\n");
check("bullet glyph", await T(() => document.querySelectorAll(".tok-bullet").length), 2);
await page.keyboard.press("Control+z");
check("undo restores (one group after conversion)", await text(), "hello **world** x\n- ");

// --- conversion undo step
await load("");
await page.click(".mde-content");
await page.keyboard.type("ab");
await page.keyboard.press("Enter");
await page.keyboard.type("- ");
check("bullet conv", await T(() => document.querySelectorAll(".tok-bullet").length), 1);
await page.keyboard.press("Control+z");
check("undo conversion first: shared text unchanged", await text(), "ab\n- ");
check("undo conversion caret", await sel(), [5, 5]);
check("undo conversion shows the line literally", await T(() => document.querySelectorAll(".tok-bullet").length), 0);
check("other clients still render normally", await T(() => T.ytext2.toString()), "ab\n- ");
await page.keyboard.press("Control+z");
check("undo typing second", await text(), "");
await page.keyboard.press("Control+Shift+z");
check("redo typing", await text(), "ab\n- ");
await page.keyboard.press("Control+Shift+z");
check("redo conversion", await T(() => document.querySelectorAll(".tok-bullet").length), 1);

// literal state ends when the line is edited (conversion re-triggers)
await load("x\n");
await caretTo(2);
await page.keyboard.type("- ");
await page.keyboard.press("Control+z");
check("literal after undo", await T(() => document.querySelectorAll(".tok-bullet").length), 0);
await page.keyboard.type("y");
check("editing the literal line converts again", await T(() => document.querySelectorAll(".tok-bullet").length), 1);
check("text", await text(), "x\n- y");

// quote: first undo leaves a literal ">"
await load("x\n");
await caretTo(2);
await page.keyboard.type(">");
check("quote converts", await T(() => document.querySelectorAll(".tok-quote").length), 1);
await page.keyboard.press("Control+z");
check("quote undo -> literal >", await text(), "x\n>");
check("quote undo caret", await sel(), [3, 3]);

// --- remote insert exactly at the caret (and at doc end) doesn't move it
await load("abc");
await caretTo(3);
await T(() => T.ytext2.insert(3, "ZZ"));
check("remote insert at caret (doc end)", await sel(), [3, 3]);
await caretTo(1);
await T(() => T.ytext2.insert(1, "Q"));
check("remote insert at caret (mid)", await sel(), [1, 1]);

// --- double / triple click
await load("plain **bold** text\n- item two\nlast");
{
  const r = await T(() => { const rc = document.querySelector(".t.b").getBoundingClientRect(); return { x: rc.left + rc.width / 2, y: rc.top + rc.height / 2 }; });
  await page.mouse.click(r.x, r.y, { clickCount: 2 });
  await page.waitForTimeout(30);
  check("double-click selects word without markers", await sel(), [8, 12]);
  const r2 = await T(() => { const rc = document.querySelectorAll(".ln")[1].querySelector(".t").getBoundingClientRect(); return { x: rc.left + 5, y: rc.top + rc.height / 2 }; });
  await page.mouse.click(r2.x, r2.y, { clickCount: 3 });
  await page.waitForTimeout(30);
  check("triple-click selects the raw line incl. token and newline", await sel(), [20, 31]);
}

// --- click past the end of a line with collapsed closing markers
await load("a **bold**\nnext");
{
  const r = await T(() => { const rc = document.querySelectorAll(".ln")[0].getBoundingClientRect(); return { x: rc.right - 20, y: rc.top + rc.height / 2 }; });
  await page.mouse.click(r.x, r.y);
  await page.waitForTimeout(30);
  check("click past line end -> line end", await sel(), [10, 10]);
}

// --- multi-line paragraph element restyles the other line
await load("**hello\nworld");
await caretTo(13);
await page.keyboard.type("**");
check("closing ** restyles line 0", await T(() => !!document.querySelectorAll(".ln")[0].querySelector(".t.b")), true);
await page.keyboard.press("Backspace");
await page.keyboard.press("Backspace");
check("deleting it unstyles line 0", await T(() => [!!document.querySelectorAll(".ln")[0].querySelector(".t.b"), document.querySelectorAll(".ln")[0].querySelectorAll(".mk").length]), [false, 0]);
check("line 0 shows ** literally", await T(() => document.querySelectorAll(".ln")[0].textContent), "**hello");

// --- literal state: Enter keeps it; bullet->todo undo keeps the bullet; selection restored
await load("x\n");
await caretTo(2);
await page.keyboard.type("- ");
await page.keyboard.press("Control+z");
await page.keyboard.press("Enter");
check("enter at end of literal line keeps it literal", await T(() => document.querySelectorAll(".tok-bullet").length), 0);
check("enter inserted plain newline", await text(), "x\n- \n");
await load("x\n- ");
await caretTo(4);
await page.keyboard.type("[ ] ");
check("todo conversion", await T(() => document.querySelectorAll(".tok-todo").length), 1);
await page.keyboard.press("Control+z");
check("undo todo conversion keeps the bullet", await T(() => [document.querySelectorAll(".tok-todo").length, document.querySelectorAll(".tok-bullet").length]), [0, 1]);
check("undo todo conversion caret", await sel(), [8, 8]);
await page.keyboard.press("Control+Shift+z");
check("redo todo conversion", await T(() => document.querySelectorAll(".tok-todo").length), 1);

// --- a mark invalidated by a remote edit falls through to the real undo
await load("x\n");
await caretTo(2);
await page.keyboard.type("- ");
await T(() => T.ytext2.insert(4, "R"));
await page.keyboard.press("Control+z");
check("invalid mark skipped: real undo happened", await text(), "x\nR");

// --- ArrowUp from below a code block enters the closing fence
await load("```\ncode\n```\nafter");
await caretTo(16);
await page.keyboard.press("ArrowUp");
check("up onto closing fence", await T(() => { const h = T.sel().head; return h >= 9 && h <= 12; }), true);

// --- click past hidden trailing markers when the DOM caret is already there
await load("a **bold**\nnext");
await caretTo(8);
await T(() => T.view.root.blur());
{
  const r = await T(() => { const rc = document.querySelectorAll(".ln")[0].getBoundingClientRect(); return { x: rc.right - 20, y: rc.top + rc.height / 2 }; });
  await page.mouse.click(r.x, r.y);
  await page.waitForTimeout(30);
  check("click past hidden trailing chars", await sel(), [10, 10]);
}

// --- focus by click into an unfocused editor keeps the click's selection
await load("hello world here");
await caretTo(0);
await T(() => { T.view.setSel({ anchor: 0, head: 5 }, { dom: true }); T.view.root.blur(); });
{
  const r = await T(() => { const t = document.querySelector(".t"); const rg = document.createRange(); rg.setStart(t.firstChild, 8); rg.collapse(true); const rc = rg.getBoundingClientRect(); return { x: rc.left, y: rc.top + rc.height / 2 }; });
  await page.mouse.click(r.x, r.y);
  await page.waitForTimeout(30);
  check("click focus keeps click position", await sel(), [8, 8]);
}

// --- remote name labels: briefly after a move, and on hover
await load("first line\nsecond line");
await caretTo(0);
await T(() => T.setRemoteCursor(15, 15));
await page.waitForTimeout(60);
check("label shown after move", await T(() => document.querySelector(".rlabel").classList.contains("show")), true);
check("caret always visible", await T(() => !!document.querySelector(".rcaret")), true);
await page.waitForTimeout(2700);
check("label hidden after ~2s", await T(() => [document.querySelector(".rlabel").classList.contains("show"), getComputedStyle(document.querySelector(".rlabel")).opacity]), [false, "0"]);
check("caret still visible", await T(() => !!document.querySelector(".rcaret")), true);
{
  const r = await T(() => { const rc = document.querySelector(".rcaret").getBoundingClientRect(); return { x: rc.left + 1, y: rc.top + rc.height / 2 }; });
  await page.mouse.move(r.x, r.y);
  await page.waitForTimeout(30);
  check("label shown on hover", await T(() => document.querySelector(".rlabel").classList.contains("show")), true);
  await page.mouse.move(r.x + 200, r.y + 100);
  await page.waitForTimeout(30);
  check("label hidden after hover", await T(() => document.querySelector(".rlabel").classList.contains("show")), false);
}
await T(() => T.setRemoteCursor(3, 3));
await page.waitForTimeout(60);
check("label shown again after next move", await T(() => document.querySelector(".rlabel").classList.contains("show")), true);

// --- space-indented lists render as lists
await load("- a\n  - b\n    - c\n  plain");
check("space-indented bullets", await T(() => [...document.querySelectorAll(".ln")].map((l) => l.className.split(" ")[1] + ":" + l.querySelectorAll(".tok-indent").length)), ["ln-bullet:0", "ln-bullet:1", "ln-bullet:2", "ln-paragraph:0"]);
await caretTo(10); // text start of "    - c" line? line 2 starts at 10
await page.keyboard.press("End");
await page.keyboard.press("Home");
await page.keyboard.press("Home");
check("home to col 0 of space-indented item", await sel(), [10, 10]);
await page.keyboard.press("ArrowRight");
check("right steps one indent level", await sel(), [12, 12]);
await caretTo(16);
await page.keyboard.press("Shift+Tab");
check("shift-tab removes one space unit", await text(), "- a\n  - b\n  - c\n  plain");

// --- tables
{
  const doc = "before\n\n| Name | Qty |\n|:-----|----:|\n| **apple** | 3 |\n| pear | 12 |\n\nafter";
  await load(doc);
  await caretTo(0);
  const grid = () => T(() => {
    const rows = [...document.querySelectorAll(".ln-table")];
    return {
      rows: rows.length,
      display: getComputedStyle(rows[0]).display,
      // same column => same left edge in every visible row
      col2: rows.filter((r) => !r.classList.contains("ln-table-delim")).map((r) => Math.round(r.querySelectorAll(".tcell")[1].getBoundingClientRect().left)),
      pipeWidth: Math.round(rows[0].querySelector(".mk.tpipe").getBoundingClientRect().width),
      delimHeight: Math.round(rows[1].getBoundingClientRect().height),
      revealed: rows.filter((r) => r.classList.contains("rv")).length,
    };
  });
  const g = await grid();
  check("table rendered as rows", [g.rows, g.display], [4, "table-row"]);
  check("columns aligned across rows", new Set(g.col2).size, 1);
  check("pipes collapsed outside", g.pipeWidth, 0);
  check("delimiter row collapsed outside", g.delimHeight, 0);
  check("header bold", await T(() => Number(getComputedStyle(document.querySelector(".ln-table-head .tcell")).fontWeight) >= 600), true);
  check("right-aligned column", await T(() => document.querySelectorAll(".ln-table-row")[0].querySelectorAll(".tcell")[1].style.textAlign), "right");
  // clicking in a collapsed cell's padding lands in that cell's text
  {
    const r = await T(() => { const c = document.querySelectorAll(".ln-table-row")[1].querySelectorAll(".tcell")[1].getBoundingClientRect(); return { x: c.left + 3, y: c.top + c.height / 2 }; });
    await page.mouse.click(r.x, r.y);
    await page.waitForTimeout(40);
    const h = (await sel())[0];
    check("click in collapsed cell padding lands in that cell", h >= doc.indexOf("12") && h <= doc.indexOf("12") + 2, true);
  }
  // caret into the table reveals everything, grid kept
  const inCell = doc.indexOf("pear") + 2;
  await caretTo(inCell);
  const g2 = await grid();
  check("revealed inside", [g2.revealed, g2.pipeWidth > 0, g2.delimHeight > 5], [4, true, true]);
  check("grid kept while editing", new Set(g2.col2).size, 1);
  check("dom caret maps back inside a cell", await T(() => { const s = T.view.readDomSel(); return s && s.head; }), inCell);
  await page.keyboard.type("s");
  check("typing in a cell", await text(), doc.replace("pear", "pesar"));
  // Tab / Shift-Tab between cells
  await page.keyboard.press("Tab");
  check("tab to next cell", await sel(), [doc.indexOf("12") + 1, doc.indexOf("12") + 1]);
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  check("shift-tab across rows", await T(() => T.text().slice(T.sel().head, T.sel().head + 1)), "3");
  // Enter at the end of the last row: a new row; Enter on it again: exits
  await caretTo(doc.indexOf("| 12 |") + 6 + 1);
  await page.keyboard.press("Enter");
  check("enter adds a row", await text(), doc.replace("pear", "pesar").replace("| 12 |", "| 12 |\n| | |"));
  await page.keyboard.type("kiwi");
  await page.keyboard.press("Tab");
  await page.keyboard.type("7");
  check("typing in the new row", await text(), doc.replace("pear", "pesar").replace("| 12 |", "| 12 |\n| kiwi| 7|"));
  check("new row rendered as table row", await T(() => document.querySelectorAll(".ln-table-row").length), 3);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  check("enter on empty last row exits", await T(() => [document.querySelectorAll(".ln-table").length, T.text().includes("| kiwi| 7|\n\n\nafter")]), [5, true]);
  // Up/Down: from above into the table and through it
  await caretTo(0);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  const l = await T(() => { const t = T.text(); const h = T.sel().head; return t.slice(t.lastIndexOf("\n", h - 1) + 1, t.indexOf("\n", h)); });
  check("down from above enters the header row", l.startsWith("| Name"), true);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  const l2 = await T(() => { const t = T.text(); const h = T.sel().head; return t.slice(t.lastIndexOf("\n", h - 1) + 1, t.indexOf("\n", h)); });
  check("down through the delimiter row to the first body row", l2.startsWith("| **apple**"), true);
}

// --- table review fixes
{
  // (1) row insertion is its own undo step
  const doc = "| a | b |\n|---|---|\n| 1 | 2 |";
  await load(doc);
  await caretTo(doc.length - 2);
  await page.keyboard.type("x");
  await page.keyboard.press("Enter");
  await page.keyboard.type("y");
  await page.keyboard.press("Control+z");
  check("undo 1: typing in the new row", await text(), doc.replace("2 |", "2x |") + "\n| | |");
  await page.keyboard.press("Control+z");
  check("undo 2: the row insertion", await text(), doc.replace("2 |", "2x |"));
  await page.keyboard.press("Control+z");
  check("undo 3: the typing before", await text(), doc);

  // (5) click past the end of a cell's text that ends in hidden closing markers
  const d2 = "x\n\n| **bold** | b |\n|---|---|\n| 1 | 2 |";
  await load(d2);
  await caretTo(0);
  {
    const r = await T(() => { const c = document.querySelector(".ln-table-head .tcell"); const rc = c.getBoundingClientRect(); return { x: rc.right - 4, y: rc.top + rc.height / 2 }; });
    await page.mouse.click(r.x, r.y);
    await page.waitForTimeout(40);
    check("click past cell text lands after hidden closing markers", await sel(), [d2.indexOf("** |") + 2, d2.indexOf("** |") + 2]);
  }
  // (6) click to the right of the narrow table: last cell's text end (not after the trailing pipe)
  await caretTo(0);
  {
    const r = await T(() => { const rc = document.querySelectorAll(".ln-table-row")[0].getBoundingClientRect(); const root = document.querySelector(".mde-content").getBoundingClientRect(); return { x: Math.min(rc.right + 150, root.right - 30), y: rc.top + rc.height / 2 }; });
    await page.mouse.click(r.x, r.y);
    await page.waitForTimeout(40);
    check("click right of a collapsed table: last cell text end", await sel(), [d2.length - 2, d2.length - 2]);
  }
  // (7) Up into a header-only table goes to the header row
  const d3 = "| h1 | h2 |\n|---|---|\nbelow";
  // a non-table line after the delimiter row would be a body row (GFM): use a blank line
  const d3b = "| h1 | h2 |\n|---|---|\n\nbelow";
  await load(d3b);
  await caretTo(d3b.length);
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  const ln = await T(() => { const t = T.text(); const h = T.sel().head; return t.slice(t.lastIndexOf("\n", h - 1) + 1, t.indexOf("\n", h)); });
  check("up into a header-only table lands on the header", ln, "| h1 | h2 |");
  void d3;
  // (8) placeholder cells for short rows
  await load("| a | b | c |\n|---|---|---|\n| 1 |\n\nx");
  await caretTo(36);
  check("short row gets placeholder cells", await T(() => [document.querySelectorAll(".ln-table-row .tcell").length, document.querySelectorAll(".ln-table-row .tcell.tph").length]), [3, 2]);
  // (16) a11y
  check("roles and aria-hidden when collapsed", await T(() => [
    document.querySelector(".ln-table-head").getAttribute("role"),
    document.querySelector(".ln-table-head .tcell").getAttribute("role"),
    document.querySelector(".ln-table-row .tcell").getAttribute("role"),
    document.querySelector(".ln-table-delim").getAttribute("aria-hidden"),
    document.querySelector(".ln-table-head .mk.tpipe").getAttribute("aria-hidden"),
  ]), ["row", "columnheader", "cell", "true", "true"]);
  await caretTo(3);
  check("aria-hidden removed when revealed", await T(() => [document.querySelector(".ln-table-delim").hasAttribute("aria-hidden"), document.querySelector(".ln-table-head .mk.tpipe").hasAttribute("aria-hidden")]), [false, false]);
  // (12) wide tables don't overflow the page
  const wide = "| " + Array.from({ length: 12 }, (_, i) => "column" + i).join(" | ") + " |\n|" + "---|".repeat(12) + "\n| " + "averyveryverylongunbreakablewordthatgoesonandon | ".repeat(12);
  await load(wide);
  check("wide table: no page overflow", await T(() => document.documentElement.scrollWidth <= window.innerWidth), true);
}

// --- table layout: cells top-aligned within a row, short rows as tall as normal ones
{
  const md = "| Feature | Owner | Notes |\n|:--|:-:|--:|\n| Tables | Ana | a very long cell with lots of text that should wrap nicely inside the cell instead of overflowing the page width at all |\n| Short | Bo |\n\nafter";
  const layout = () => T(() => [...document.querySelectorAll(".ln-table")].filter((r) => !r.classList.contains("ln-table-delim")).map((r) => {
    const cells = [...r.querySelectorAll(".tcell")];
    return {
      h: r.getBoundingClientRect().height,
      textTops: cells.map((c) => c.querySelector(".t")).filter(Boolean).map((t) => t.getClientRects()[0].top),
      cellHeights: cells.map((c) => c.getBoundingClientRect().height),
      borders: cells.map((c) => getComputedStyle(c).borderBottomWidth + " " + getComputedStyle(c).borderBottomStyle),
      n: cells.length,
    };
  }));
  const verify = async (label) => {
    const rows = await layout();
    const spread = (xs) => Math.max(...xs) - Math.min(...xs);
    check(label + ": cell text tops equal within each row", rows.map((r) => spread(r.textTops) <= 1), [true, true, true]);
    check(label + ": cells fill their row", rows.map((r) => spread([...r.cellHeights, r.h]) <= 1), [true, true, true]);
    check(label + ": short row as tall as the single-line header row", Math.abs(rows[2].h - rows[0].h) <= 1, true);
    check(label + ": placeholder cell like a normal cell", [rows[2].n, new Set(rows[2].borders).size], [3, 1]);
  };
  await load(md);
  await caretTo(md.length);
  await verify("outside");
  await caretTo(md.indexOf("Ana"));
  await verify("revealed");
  await page.setViewportSize({ width: 390, height: 844 });
  await caretTo(md.length);
  await verify("phone outside");
  await caretTo(md.indexOf("Ana"));
  await verify("phone revealed");
  await page.setViewportSize({ width: 900, height: 700 });
}

// --- typing a table line by line turns into a grid when the delimiter row is typed
await load("");
await page.click(".mde-content");
await page.keyboard.type("| a | b |");
await page.keyboard.press("Enter");
await page.keyboard.type("|---|");
check("not a table yet", await T(() => document.querySelectorAll(".ln-table").length), 0);
await page.keyboard.type("---|");
check("table once the delimiter row is complete", await T(() => document.querySelectorAll(".ln-table").length), 2);
await page.keyboard.press("Enter");
await page.keyboard.type("x");
check("enter on the delimiter row starts a body row", await text(), "| a | b |\n|---|---|\n| x| |");

// --- hr: single caret stop
await load("a\n---\nb");
await caretTo(1);
await page.keyboard.press("ArrowRight");
check("right onto hr (stop after it)", await sel(), [5, 5]);
await page.keyboard.press("ArrowRight");
check("right past hr", await sel(), [6, 6]);
await page.keyboard.press("ArrowLeft");
await page.keyboard.press("ArrowLeft");
check("left over hr", await sel(), [1, 1]);
await caretTo(5);
await page.keyboard.press("Backspace");
check("backspace after hr leaves an empty line", await text(), "a\n\nb");
await load("---\nb");
await caretTo(3);
await page.keyboard.press("Backspace");
check("backspace on first-line hr", await text(), "\nb");

// --- chip with a javascript: URL is not opened
await load("[x](javascript:alert(1))");
check("js url not opened", await T(() => { let opened = 0; const o = window.open; window.open = () => { opened++; return null; }; const t = document.querySelector(".t.link"); t.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, detail: 1 })); t.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0, detail: 1 })); window.open = o; return opened; }), 0);

// --- remote color is validated
await load("abc");
await T(() => { T.aw2.setLocalStateField("user", { id: "b", name: "<b>x</b>", color: "red;background-image:url(x)", kind: "agent" }); T.setRemoteCursor(1, 1); });
await page.waitForTimeout(50);
check("invalid color replaced", await T(() => document.querySelector(".rcaret").style.background), "rgb(136, 136, 136)");
check("name as text", await T(() => document.querySelector(".rlabel").textContent), "<b>x</b>");

// --- arrows over tokens
await load("ab\n- item\n\t- nested");
await caretTo(5); // after "- "
await page.keyboard.press("ArrowLeft");
check("left over token to col0", await sel(), [3, 3]);
await page.keyboard.press("ArrowLeft");
check("left to prev line end", await sel(), [2, 2]);
await page.keyboard.press("ArrowRight");
await page.keyboard.press("ArrowRight");
check("right over token", await sel(), [5, 5]);
await page.keyboard.press("Backspace");
check("backspace removes token", await text(), "ab\nitem\n\t- nested");
await caretTo(13); // after "\t- " (line 2 starts at 8)
await page.keyboard.press("Home"); // linux: two-stage line start
check("home stage 1 (text start)", await sel(), [11, 11]);
await page.keyboard.press("Home");
check("home stage 2 (col 0)", await sel(), [8, 8]);

// --- DOM selection mapping round trip through native click
await load("plain **bold** text\nsecond line here");
const r = await T(() => {
  const t = document.querySelectorAll(".ln")[0].querySelector(".t.b");
  const rc = t.getBoundingClientRect();
  return { x: rc.right - 2, y: rc.top + rc.height / 2 };
});
await page.mouse.click(r.x, r.y);
await page.waitForTimeout(50);
check("click right half of last bold letter -> before closing **", await sel(), [12, 12]);

// --- up/down with goal x
await load("first line of text\nsh\nthird line of text");
await caretTo(10);
await page.keyboard.press("ArrowDown");
check("down clamps on short line", await sel(), [21, 21]);
await page.keyboard.press("ArrowDown");
check("down restores goal x", await sel(), [32, 32]);
await page.keyboard.press("ArrowUp");
await page.keyboard.press("ArrowUp");
check("up back", await sel(), [10, 10]);

// --- remote edit keeps caret
await load("hello world");
await caretTo(6);
await T(() => T.ytext2.insert(0, "XYZ "));
check("remote insert before caret shifts it", await sel(), [10, 10]);
check("dom caret follows", await T(() => {
  const s = getSelection();
  return T.view.readDomSel();
}), { anchor: 10, head: 10 });
await page.keyboard.type("!");
check("typing after remote", await T(() => T.ytext2.toString()), "XYZ hello !world");
await page.keyboard.press("Control+z");
check("undo doesn't undo remote", await text(), "XYZ hello world");

// --- remote cursor rendering, no reveal
await load("a **bold** b");
await caretTo(0);
await T(() => T.setRemoteCursor(5, 5));
await page.waitForTimeout(50);
check("remote caret drawn", await T(() => document.querySelectorAll(".rcaret").length), 1);
check("remote label", await T(() => document.querySelector(".rlabel")?.textContent), "Bob");
check("remote cursor doesn't reveal", await T(() => document.querySelectorAll(".mk.rv").length), 0);
await T(() => T.setRemoteCursor(0, 12));
await page.waitForTimeout(50);
check("remote selection drawn", await T(() => document.querySelectorAll(".rsel").length > 0), true);
check("local cursor published", await T(() => !!T.aw.getLocalState().cursor), true);

// --- todo click
await load("- [ ] task\nother");
await page.click(".mde-content .tok-todo .cb");
check("todo toggled", await text(), "- [x] task\nother");
check("caret at task start", await sel(), [6, 6]);
await page.click(".mde-content .tok-todo .cb");
check("todo untoggled", await text(), "- [ ] task\nother");

// --- ctrl-b
await load("hello world");
await caretTo(2);
await page.keyboard.press("Control+b");
check("ctrl-b word", await text(), "**hello** world");
check("ctrl-b caret", await sel(), [4, 4]);

// --- tab nest
await load("- a\n- b");
await caretTo(6);
await page.keyboard.press("Tab");
check("tab nests", await text(), "- a\n\t- b");
await page.keyboard.press("Shift+Tab");
check("shift-tab", await text(), "- a\n- b");

// --- paste
await load("x");
await caretTo(1);
await T(() => {
  const dt = new DataTransfer();
  dt.setData("text/plain", "\n# Head\n- item");
  T.view.root.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
});
check("paste", await text(), "x\n# Head\n- item");
check("paste blocks", await T(() => [...document.querySelectorAll(".ln")].map((l) => l.className.split(" ")[1])), ["ln-paragraph", "ln-heading", "ln-bullet"]);

// --- code block enter
await load("");
await page.click(".mde-content");
await page.keyboard.type("```");
await page.keyboard.press("Enter");
await page.keyboard.type("  code");
await page.keyboard.press("Enter");
await page.keyboard.type("x");
check("code block (auto-closed)", await text(), "```\n  code\nx\n```");
check("fence revealed", await T(() => document.querySelector(".ln-fence").classList.contains("rv")), true);

// --- shift-arrow selection + typing over
await load("abc def");
await caretTo(4);
await page.keyboard.press("Shift+ArrowRight");
await page.keyboard.press("Shift+ArrowRight");
check("shift extend", await sel(), [4, 6]);
await page.keyboard.type("Z");
check("type over selection", await text(), "abc Zf");

// --- word jump
await load("Alpha **bold words**");
await caretTo(0);
await page.keyboard.press("Control+ArrowRight");
await page.keyboard.press("Control+ArrowRight");
check("ctrl-right word jumps", await sel(), [12, 12]);

// --- readOnly
await load("abc", "?ro");
await page.click(".mde-content");
await page.keyboard.type("zz");
await page.keyboard.press("Enter");
check("readonly blocks edits", await text(), "abc");
{
  const doc = "- [ ] task **bold**\nsecond line";
  await load(doc, "?ro");
  await page.click(".mde-content .ln:nth-child(2)");
  await page.keyboard.press("Home");
  check("readonly: caret moves", await sel(), [20, 20]);
  for (const k of ["Backspace", "Delete", "Tab", "Control+b", "Control+x", "Control+z", "Shift+Enter"]) await page.keyboard.press(k);
  await page.click(".mde-content .tok-todo .cb");
  await T(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "pasted");
    T.view.root.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.keyboard.press("End");
  await (await page.context().newCDPSession(page)).send("Input.insertText", { text: "字" });
  check("readonly: keys, todo click, paste and IME don't edit", await text(), doc);
  check("readonly: DOM unchanged", await T(() => [...document.querySelectorAll(".ln")].map((l) => l.textContent)), ["task **bold**", "second line"]);
  await page.keyboard.press("Shift+Home");
  check("readonly: selecting works", await sel(), [doc.length, 20]);
  check("readonly: copy gives the raw text", await T(() => { const dt = new DataTransfer(); T.view.root.dispatchEvent(new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true })); return dt.getData("text/plain"); }), "second line");
  await T(() => T.ytext2.insert(0, "x"));
  check("readonly: remote edits show", await T(() => document.querySelector(".ln").textContent), "x- [ ] task **bold**");
}

// --- IME-ish composition (simulate via CDP)
await load("ab");
await caretTo(2);
const cdp = await page.context().newCDPSession(page);
await cdp.send("Input.imeSetComposition", { text: "ni", selectionStart: 2, selectionEnd: 2 });
await cdp.send("Input.imeSetComposition", { text: "你", selectionStart: 1, selectionEnd: 1 });
await cdp.send("Input.insertText", { text: "你" });
await page.waitForTimeout(30);
check("composition committed", await text(), "ab你");
check("composition dom consistent", await T(() => T.view.root.textContent), "ab你");
await page.keyboard.type("c");
check("type after composition", await text(), "ab你c");

// --- composition while remote edits arrive (before the caret on its line, on another line, after it)
await load("first\nhello world");
await caretTo(11);
await cdp.send("Input.imeSetComposition", { text: "n", selectionStart: 1, selectionEnd: 1 });
await T(() => T.ytext2.insert(6, "AB "));
await T(() => T.ytext2.insert(0, "top "));
await cdp.send("Input.imeSetComposition", { text: "ni", selectionStart: 2, selectionEnd: 2 });
await T(() => T.ytext2.insert(T.ytext2.length, "!"));
await cdp.send("Input.imeSetComposition", { text: "你", selectionStart: 1, selectionEnd: 1 });
await cdp.send("Input.insertText", { text: "你" });
await page.waitForTimeout(30);
check("composition with remote edits: committed at the mapped caret", await text(), "top first\nAB hello你 world!");
check("composition with remote edits: other client converges", await T(() => T.ytext2.toString()), "top first\nAB hello你 world!");
check("composition with remote edits: caret after the commit", await sel(), [19, 19]);
check("composition with remote edits: DOM matches", await T(() => [...document.querySelectorAll(".ln")].map((l) => l.textContent)), ["top first", "AB hello你 world!"]);
check("composition with remote edits: DOM caret", await T(() => { const s = T.view.readDomSel(); return s && [s.anchor, s.head]; }), [19, 19]);
await page.keyboard.type("c");
check("typing after it", await text(), "top first\nAB hello你c world!");
// a composition over a selection that a remote edit shifts: the selection is replaced where it moved to
await load("one two three");
await T(() => { T.view.root.focus(); T.view.setSel({ anchor: 4, head: 7 }, { dom: true }); });
await cdp.send("Input.imeSetComposition", { text: "z", selectionStart: 1, selectionEnd: 1 });
await T(() => T.ytext2.insert(0, "0 "));
await cdp.send("Input.insertText", { text: "字" });
await page.waitForTimeout(30);
check("composition over a selection with a remote edit before it", await text(), "0 one 字 three");

// a composition over a selection that is cancelled (nothing committed): the selection goes, as one undo step
await load("one two three");
await T(() => { T.view.root.focus(); T.view.setSel({ anchor: 4, head: 7 }, { dom: true }); });
await cdp.send("Input.imeSetComposition", { text: "z", selectionStart: 1, selectionEnd: 1 });
await cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
await page.waitForTimeout(30);
check("cancelled composition over a selection", await text(), "one  three");
check("cancelled composition: DOM matches", await T(() => T.view.root.textContent), "one  three");
await page.keyboard.type("x");
check("typing after a cancelled composition", await text(), "one x three");
await page.keyboard.press("Control+z");
await page.keyboard.press("Control+z");
check("undo after a cancelled composition", await text(), "one two three");

// --- spellcheck replacement (insertReplacementText with a target range), also inside hidden markers
await load("teh cat **wrod** end");
await caretTo(20);
const replace = (sel, word, by) => T(([sel, word, by]) => {
  const t = [...document.querySelectorAll(sel)].map((e) => e.firstChild).find((n) => n.data.includes(word));
  const i = t.data.indexOf(word);
  const dt = new DataTransfer();
  dt.setData("text/plain", by);
  const r = new StaticRange({ startContainer: t, startOffset: i, endContainer: t, endOffset: i + word.length });
  T.view.root.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertReplacementText", dataTransfer: dt, targetRanges: [r], bubbles: true, cancelable: true }));
}, [sel, word, by]);
await replace(".t", "teh", "the");
check("replacement text", await text(), "the cat **wrod** end");
check("caret after the replacement", await sel(), [3, 3]);
await caretTo(20);
await replace(".t.b", "wrod", "word");
check("replacement inside collapsed bold", await text(), "the cat **word** end");
await page.keyboard.press("Control+z");
check("undo the replacement", await text(), "the cat **wrod** end");

// --- up from heading lines
await load("## Head text\n\nafter\n");
await caretTo(3);
await page.keyboard.press("Enter");
await page.keyboard.press("ArrowUp");
check("up from heading to empty line above", await sel(), [0, 0]);
await load("x\n- item a\n- item b\n# Head");
await caretTo(25);
await page.keyboard.press("ArrowUp");
check("up from heading to item b line", (await sel())[0] > 13 && (await sel())[0] <= 19, true);
await page.keyboard.press("ArrowUp");
check("up to item a line", (await sel())[0] > 4 && (await sel())[0] <= 10, true);

// --- undo of deletion selects restored text
await load("first line here\n");
await caretTo(15);
await page.keyboard.type("ab");
for (let i = 0; i < 3; i++) await page.keyboard.press("Backspace");
await page.keyboard.press("Control+z");
check("undo deletion text", await text(), "first line here\n");
check("undo deletion selects restored", await sel(), [14, 15]);
await page.keyboard.press("Control+Shift+z");
check("redo after", await text(), "first line her\n");

// --- quote swallows the next space
await load("x\n");
await caretTo(2);
await page.keyboard.type("> q");
check("quote typing", await text(), "x\n> q");

// --- dom selection consistency at tricky spots
const domSel = () => T(() => { const s = T.view.readDomSel(); return s && [s.anchor, s.head]; });
await load("ab\n- item\n- ");
await caretTo(3);
check("col0 dom", await domSel(), [3, 3]);
await page.waitForTimeout(20);
check("col0 model kept", await sel(), [3, 3]);
await caretTo(12);
check("empty bullet dom", await domSel(), [12, 12]);
await page.keyboard.type("z");
check("type in empty bullet", await text(), "ab\n- item\n- z");
check("dom after", await domSel(), [13, 13]);
await caretTo(5);
await page.keyboard.press("Enter");
check("enter at item text start", await text(), "ab\n- \n- item\n- z");
check("enter at item text start caret", await sel(), [8, 8]);
check("dom after enter", await domSel(), [8, 8]);

// --- undo restores selection
await load("hello world");
await caretTo(5);
await page.keyboard.type("XX");
await caretTo(0);
await page.keyboard.press("Control+z");
check("undo text", await text(), "hello world");
check("undo caret", await sel(), [5, 5]);
await page.keyboard.press("Control+Shift+z");
check("redo caret", await sel(), [7, 7]);

// --- up/down through mixed content
await load("# Big heading here\n- bullet item text\n```\ncode line here\n```\nplain paragraph");
await caretTo(8);
const ys = [];
for (let i = 0; i < 4; i++) { await page.keyboard.press("ArrowDown"); ys.push((await sel())[0]); }
console.log("down positions", ys);
for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowUp");
check("up/down symmetric", await sel(), [8, 8]);

// --- copy gives raw markdown
await load("- a **b**");
await T(() => { T.view.root.focus(); T.view.setSel({ anchor: 0, head: 9 }, { dom: true }); });
check("copy raw", await T(() => { const dt = new DataTransfer(); T.view.root.dispatchEvent(new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true })); return dt.getData("text/plain"); }), "- a **b**");

// --- select all + delete
await load("# a\n- b\nc **d**");
await page.click(".mde-content");
await page.keyboard.press("Control+a");
await page.waitForTimeout(20);
check("select all", await sel(), [0, 15]);
await page.keyboard.press("Backspace");
check("deleted all", await text(), "");
await page.keyboard.type("ok");
check("type after", await text(), "ok");

// --- wrapped paragraph up/down by visual line
const long = "word ".repeat(60).trim();
await load(long + "\nnext");
await caretTo(3);
await page.keyboard.press("ArrowDown");
const p1 = (await sel())[0];
check("down stays in wrapped para", p1 > 3 && p1 < long.length, true);
await page.keyboard.press("ArrowUp");
check("up back in wrapped para", await sel(), [3, 3]);

// --- perf: typing in a big doc
const big = Array.from({ length: 3000 }, (_, i) => (i % 5 === 0 ? "- item **" + i + "** text" : "line " + i + " with *some* text")).join("\n");
await load(big);
await caretTo(10);
const t0 = Date.now();
await page.keyboard.type("abcdefghij");
const dt = Date.now() - t0;
console.log("10 keystrokes in 3000-line doc:", dt, "ms");
check("big doc typed", (await text()).slice(0, 25), big.slice(0, 10) + "abcdefghij" + big.slice(10, 15));

// --- images
{
  const svg = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#8ab"/></svg>');
  const img = `![pic](data:image/svg+xml,${svg})`;
  const doc = `first line here\n${img}\nlast line here`;
  const end = 16 + img.length;
  await load(doc);
  await page.waitForFunction(() => document.querySelector(".imgbox img")?.complete);
  check("image line renders an <img>", await T(() => [document.querySelectorAll(".ln-img img").length, document.querySelector(".ln-img img").naturalWidth]), [1, 400]);
  check("image line collapsed: source hidden", await T(() => [document.querySelector(".ln-img").classList.contains("img-rv"), document.querySelector(".ln-img").getBoundingClientRect().height < 230]), [false, true]);
  check("image is non-editable decoration", await T(() => document.querySelector(".imgs").contentEditable), "false");
  await caretTo(3);
  await page.keyboard.press("ArrowDown");
  check("down onto the image line: end of its source", await sel(), [end, end]);
  check("caret on it reveals the source above the image", await T(() => [document.querySelector(".ln-img").classList.contains("img-rv"), document.querySelectorAll(".ln-img .mk.rv").length, !!document.querySelector(".ln-img img")]), [true, 3, true]);
  await page.keyboard.press("ArrowDown");
  const below = (await sel())[0];
  check("down past the image to the next line", below > end && below <= doc.length, true);
  await page.keyboard.press("ArrowUp");
  check("up back onto the image line", await sel(), [end, end]);
  // the revealed source wraps (a long data: URL): Up steps through its visual lines first
  for (let i = 0; i < 10 && (await sel())[0] >= 16; i++) await page.keyboard.press("ArrowUp");
  check("up again: back where it started", await sel(), [3, 3]);
  check("collapsed again", await T(() => document.querySelector(".ln-img").classList.contains("img-rv")), false);
  // a click on the image: caret at the end of its source; the DOM selection agrees
  const r = await T(() => { const rc = document.querySelector(".imgbox img").getBoundingClientRect(); return { x: rc.left + rc.width / 2, y: rc.top + rc.height / 2 }; });
  await page.mouse.click(r.x, r.y);
  await page.waitForTimeout(30);
  check("click on the image: caret at the end of the token", await sel(), [end, end]);
  check("DOM selection maps to the same place", await T(() => { const s = T.view.readDomSel(); return [s.anchor, s.head]; }), [end, end]);
  await page.keyboard.press("Shift+ArrowLeft");
  check("selection still works after the click", await sel(), [end, end - 1]);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type("!");
  check("typing after the click goes after the token", await text(), doc.slice(0, end) + "!" + doc.slice(end));
  await page.keyboard.press("Control+z");
  // remote cursor on the (collapsed) image line still draws
  await caretTo(3);
  await T((p) => T.setRemoteCursor(p, p), end);
  await page.waitForTimeout(50);
  check("remote caret on an image line", await T(() => { const c = document.querySelector(".rcaret"); return !!c && c.getBoundingClientRect().height > 5; }), true);
  await T(() => T.setRemoteCursor(0, 40));
  await page.waitForTimeout(50);
  check("remote selection across an image line", await T(() => document.querySelectorAll(".rsel").length > 0), true);
}
{
  const svg = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#8ab"/></svg>');
  const img = `![pic](data:image/svg+xml,${svg})`;
  const words = "lorem ipsum dolor sit amet ".repeat(12);
  const mid = `text ${img} after`;
  const doc = `${img}\n${mid}\n${words}${img}\nnext line here`;
  const midFrom = img.length + 1;
  const paraFrom = midFrom + mid.length + 1;
  const paraTo = paraFrom + words.length + img.length;
  await load(doc);
  await page.waitForFunction(() => [...document.querySelectorAll(".imgbox img")].every((i) => i.complete));
  const boxCenter = (i) => T((i) => { const rc = document.querySelectorAll(".imgbox img")[i].getBoundingClientRect(); return { x: rc.left + rc.width / 2, y: rc.top + rc.height / 2 }; }, i);

  // re-rendering a line keeps its loaded <img>
  await T(() => document.querySelectorAll(".imgbox img").forEach((i) => (i._mark = 1)));
  await caretTo(midFrom + 2);
  await page.keyboard.type("xy");
  check("typing on a line with an image keeps the same <img>", await T(() => { const i = document.querySelectorAll(".ln")[1].querySelector("img"); return [i._mark, i.complete, i.closest(".imgbox").className]; }), [1, true, "imgbox"]);
  await page.keyboard.press("Control+z");
  check("undo restores the text", await text(), doc);

  // double and triple click on a collapsed image: the first click reveals the source and shifts the layout
  let c = await boxCenter(0);
  await page.mouse.dblclick(c.x, c.y);
  check("double click on an image selects its source", await sel(), [0, img.length]);
  await caretTo(doc.length);
  await page.waitForTimeout(20);
  c = await boxCenter(0);
  await page.mouse.click(c.x, c.y, { clickCount: 3 });
  check("triple click on an image selects its line", await sel(), [0, img.length + 1]);

  // a click right of the text before a collapsed image (that isn't the whole line) stays before the image
  await caretTo(doc.length);
  await T((t) => T.ytext.insert(T.ytext.length, "\nhello " + t), img);
  await page.waitForTimeout(20);
  const helloFrom = doc.length + 1;
  const hr = await T(() => { const l = [...document.querySelectorAll(".ln")].at(-1); const r = l.firstChild.getBoundingClientRect(); return { x: r.right, y: r.top + r.height / 2, w: l.getBoundingClientRect().right }; });
  await page.mouse.click(Math.min(hr.x + 200, hr.w - 5), hr.y);
  await page.waitForTimeout(30);
  check("click past text before a collapsed image: not after the image's source", (await sel())[0] <= helloFrom + 6, true);
  await T(() => { const i = T.ytext.toString().lastIndexOf("\nhello "); T.ytext.delete(i, T.ytext.length - i); });
  check("cleanup", await text(), doc);

  // a wrapped paragraph ending in a collapsed image: the caret at its end is on its last visual line
  await caretTo(0);
  const tops = await T(([a, b, c]) => [T.view.caretRect(a).top, T.view.caretRect(b).top, T.view.caretRect(c).top], [paraFrom + words.length - 1, paraTo, paraFrom]);
  check("paragraph wraps", tops[2] < tops[0], true);
  check("caret at the end of an image paragraph: on the last visual line", Math.round(tops[1]), Math.round(tops[0]));
  await caretTo(paraTo + 2);
  await page.keyboard.press("ArrowUp");
  // visual line top of p relative to the paragraph's last one (moving may scroll)
  const rel = (p) => T(([p, last]) => Math.round(T.view.caretRect(p).top - T.view.caretRect(last).top), [p, paraFrom + words.length - 1]);
  const up1 = (await sel())[0];
  check("up from the next line: onto the paragraph's last visual line", up1 >= paraFrom && up1 <= paraTo && (await rel(up1)) === 0, true);
  await page.keyboard.press("ArrowUp");
  const lineH = await T(() => parseFloat(getComputedStyle(document.querySelectorAll(".ln")[2]).lineHeight));
  check("up again: the visual line above, none skipped", await rel((await sel())[0]), -Math.round(lineH));
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  check("down from the last visual line: over the image to the next line", (await sel())[0] > paraTo, true);

  // a remote selection of just a collapsed image highlights the image
  await caretTo(0);
  await T(([a, b]) => T.setRemoteCursor(a, b), [midFrom + 5, midFrom + 5 + img.length]);
  await page.waitForTimeout(50);
  check("remote selection of a collapsed image", await T(() => { const b = document.querySelectorAll(".ln")[1].querySelector(".imgbox").getBoundingClientRect(); return [...document.querySelectorAll(".rsel")].some((s) => { const r = s.getBoundingClientRect(); return Math.abs(r.top - b.top) < 2 && Math.abs(r.height - b.height) < 2; }); }), true);
}
{
  // broken images: placeholder with the alt text, no rebuild loop
  await load("![nothing here](https://127.0.0.1:9/x.png)\n![bad](javascript:alert(1))\ntext ![mid](nope.png) after");
  await page.waitForFunction(() => document.querySelectorAll(".imgbox.broken").length === 3, null, { timeout: 5000 }).catch(() => {});
  check("broken images show the placeholder", await T(() => [...document.querySelectorAll(".imgbox.broken .img-missing")].map((e) => e.textContent)), ["Image not found: nothing here", "Image not found: bad", "Image not found: mid"]);
  check("no <img> for unsafe URLs", await T(() => document.querySelectorAll(".ln")[1].querySelector("img")), null);
  await T(() => (document.querySelector(".ln")._mark = 1));
  await page.waitForTimeout(200);
  check("failed loads don't rebuild the line", await T(() => document.querySelector(".ln")._mark), 1);
  check("mid-text image: a normal line, split around the image", await T(() => { const l = document.querySelectorAll(".ln")[2]; return [l.classList.contains("ln-img"), [...l.children].map((c) => c.className)]; }), [false, ["part", "imgs", "part"]]);
}
{
  // an image in the middle of a line splits it there: "this is", the image, then "a line" on its own row
  const svg = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#8ab"/></svg>');
  const img = `![x](data:image/svg+xml,${svg})`;
  const line = `this is ${img} a line`;
  const doc = `first\n${line}\nlast`;
  const from = 6;
  const imgFrom = from + 8;
  const imgTo = imgFrom + img.length;
  const lineTo = from + line.length;
  await load(doc);
  await page.waitForFunction(() => [...document.querySelectorAll(".imgbox img")].every((i) => i.complete));
  await caretTo(0);
  // boxes: the first row's text, the image, the second row's text (client px)
  const geo = () => T(() => {
    const l = document.querySelectorAll(".ln")[1];
    const [p0, p1] = l.querySelectorAll(".part");
    const tr = (el) => { const r = document.createRange(); r.selectNodeContents(el); const rs = [...r.getClientRects()].filter((x) => x.width > 0.5 && x.height > 1); return { left: Math.min(...rs.map((x) => x.left)), right: Math.max(...rs.map((x) => x.right)), top: Math.min(...rs.map((x) => x.top)), bottom: Math.max(...rs.map((x) => x.bottom)) }; };
    const i = l.querySelector(".imgbox img").getBoundingClientRect();
    return { t0: tr(p0), img: { left: i.left, top: i.top, bottom: i.bottom, right: i.right }, t1: tr(p1.querySelector(".t:not(.ws)")), nextTop: document.querySelectorAll(".ln")[2].getBoundingClientRect().top };
  });
  let g = await geo();
  check("split: text, then the image below it, then the text after below that", [g.t0.bottom <= g.img.top, g.img.bottom <= g.t1.top, g.t1.bottom <= g.nextTop], [true, true, true]);
  check("split: the image and the row after it start at the text's left edge (no indent from the space)", [Math.round(g.img.left - g.t0.left), Math.round(g.t1.left - g.t0.left)], [0, 0]);
  check("split: the first row is just 'this is'", Math.round(g.t0.right - g.t0.left) < 70, true);
  // carets: after the space at the second row's start; the image's end on the first row
  const cr = (p) => T((p) => { const r = T.view.caretRect(p); return { left: r.left, top: r.top, bottom: r.bottom }; }, p);
  let c = await cr(imgTo + 1);
  check("caret after the image's space: start of the second row", [Math.round(c.left - g.t1.left), c.top >= g.img.bottom], [0, true]);
  c = await cr(imgFrom - 1);
  check("caret before the space before the image: first row", c.bottom <= g.img.top + 1, true);
  // clicks: the second row's left edge, right of the first row, the image
  await page.mouse.click(g.t1.left + 1, (g.t1.top + g.t1.bottom) / 2);
  check("click at the second row's start: after the space", await sel(), [imgTo + 1, imgTo + 1]);
  await page.mouse.click(g.t0.right + 150, (g.t0.top + g.t0.bottom) / 2);
  check("click right of the first row: before the image's source", (await sel())[0] <= imgFrom, true);
  await caretTo(0);
  g = await geo();
  await page.mouse.click(g.img.left + 30, (g.img.top + g.img.bottom) / 2);
  check("click on the image: end of its source", await sel(), [imgTo, imgTo]);
  g = await geo();
  check("revealed: the source shows in the first part, the image right after it", await T(() => document.querySelectorAll(".ln")[1].querySelectorAll(".part")[0].querySelectorAll(".mk.rv").length > 0), true);
  c = await cr(imgTo);
  check("revealed: the caret at the source's end is above the image, the text after below it", [c.bottom <= g.img.top + 1, g.img.bottom <= g.t1.top], [true, true]);
  // Up/Down: from the first row over the image to the text after it, and back
  await caretTo(from + 2);
  await page.keyboard.press("ArrowDown");
  const down = (await sel())[0];
  check("down from the first row: over the image onto the text after it", down > imgTo && down <= lineTo, true);
  await page.keyboard.press("ArrowUp");
  check("up from the text after: back onto the first row", await sel(), [from + 2, from + 2]);
  await caretTo(doc.length);
  await page.keyboard.press("ArrowUp");
  const up = (await sel())[0];
  check("up from the next line: onto the text after the image", up > imgTo && up <= lineTo, true);
  await caretTo(imgTo + 3);
  await page.keyboard.press("ArrowDown");
  check("down from the text after the image: the next line", (await sel())[0] > lineTo, true);
  // a selection across the image: Shift-Down from the first row
  await caretTo(from + 2);
  await page.keyboard.press("Shift+ArrowDown");
  const s = await sel();
  check("shift-down across the image", s[0] === from + 2 && s[1] > imgTo, true);
  // typing at the second row's start, then undo
  await caretTo(imgTo + 1);
  await page.keyboard.type("Z");
  check("typing at the second row's start", await text(), doc.slice(0, imgTo + 1) + "Z" + doc.slice(imgTo + 1));
  g = await geo();
  check("typed text stays on the second row", Math.round(g.t1.left - g.t0.left), 0);
  await page.keyboard.press("Control+z");
  check("undo", await text(), doc);
  // IME composition at the second row's start
  await caretTo(imgTo + 1);
  const ime = await page.context().newCDPSession(page);
  await ime.send("Input.imeSetComposition", { text: "ni", selectionStart: 2, selectionEnd: 2 });
  g = await geo();
  check("composition at the second row's start shows there", [g.t1.top >= g.img.bottom, await T(() => document.querySelectorAll(".ln")[1].querySelectorAll(".part")[1].textContent.includes("ni"))], [true, true]);
  await ime.send("Input.insertText", { text: "你" });
  check("composition committed after the image", await text(), doc.slice(0, imgTo + 1) + "你" + doc.slice(imgTo + 1));
  await page.keyboard.press("Control+z");
  check("undo composition", await text(), doc);
  // remote cursors follow the split
  await caretTo(0);
  g = await geo();
  await T((p) => T.setRemoteCursor(p, p), imgTo + 3);
  await page.waitForTimeout(50);
  const rc = await T(() => { const r = document.querySelector(".rcaret")?.getBoundingClientRect(); return r ? { top: r.top, bottom: r.bottom } : null; });
  check("remote caret after the image: on the second row", !!rc && rc.top >= g.img.bottom - 1, true);
  await T(([a, b]) => T.setRemoteCursor(a, b), [from + 1, imgTo + 4]);
  await page.waitForTimeout(50);
  const rs = await T(() => [...document.querySelectorAll(".rsel")].map((e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }));
  check("remote selection across the image: rows above and below it and the image", [rs.some((r) => r.bottom <= g.img.top + 1), rs.some((r) => r.top >= g.img.bottom - 1), rs.some((r) => Math.abs(r.top - g.img.top) < 2)], [true, true, true]);
  // an image starting a line: no empty row above it; Down from the line above lands on the caption
  await load(`first\n${img} caption\nlast`);
  await page.waitForFunction(() => [...document.querySelectorAll(".imgbox img")].every((i) => i.complete));
  await caretTo(0);
  const st = await T(() => { const l = document.querySelectorAll(".ln")[1]; return { line: l.getBoundingClientRect().top, img: l.querySelector(".imgbox img").getBoundingClientRect().top, cls: l.children[0].className }; });
  check("image starting a line: no row above it", [st.cls, Math.round(st.img - st.line) <= 8], ["part nil", true]);
  await page.keyboard.press("ArrowDown");
  check("down onto a line starting with an image: its caption", (await sel())[0] > 6 + img.length, true);
}

// --- Phase A review (docs/rust-engine/review-A.md)
// CRLF: "\r" stays in the shared text; local and remote offsets after it stay right
await load("a\r\n- b\r\nc");
check("crlf: text kept as is", await text(), "a\r\n- b\r\nc");
check("crlf: lines", await T(() => document.querySelectorAll(".ln").length), 3);
await caretTo(10);
await page.keyboard.type("X");
check("crlf: typing at the end", await text(), "a\r\n- b\r\ncX");
await T(() => T.ytext2.insert(7, "Y"));
check("crlf: remote edit after a \\r", await text(), "a\r\n- b\rY\ncX");
check("crlf: caret mapped", await sel(), [11, 11]);
await page.keyboard.type("Z");
check("crlf: both converge", await T(() => [T.text(), T.ytext2.toString()]), ["a\r\n- b\rY\ncXZ", "a\r\n- b\rY\ncXZ"]);

// a click past hidden closing markers, then a 1px pointer move while the button is down: still the click's caret
await load("a **bold**\nnext");
{
  // just right of the "d": the raw hit there is before the hidden "**"
  const r = await T(() => { const rc = document.querySelector(".t.b").getBoundingClientRect(); return { x: rc.right + 1, y: rc.top + rc.height / 2 }; });
  await page.mouse.click(r.x, r.y);
  await page.waitForTimeout(30);
  const plain = await sel();
  await caretTo(13);
  await page.mouse.move(r.x, r.y);
  await page.mouse.down();
  await page.mouse.move(r.x + 1, r.y);
  await page.waitForTimeout(40);
  await page.mouse.up();
  check("click + 1px jitter next to hidden markers: the click's caret", await sel(), plain);
  check("(that caret)", plain, [8, 8]);
}
// a double click, then a 1px move with the button down: the word stays selected
await load("plain **bold** text");
{
  const r = await T(() => { const rc = document.querySelector(".t.b").getBoundingClientRect(); return { x: rc.left + rc.width / 2, y: rc.top + rc.height / 2 }; });
  await page.mouse.move(r.x, r.y);
  await page.mouse.down({ clickCount: 1 });
  await page.mouse.up({ clickCount: 1 });
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.move(r.x + 1, r.y);
  await page.waitForTimeout(40);
  await page.mouse.up({ clickCount: 2 });
  check("double click + 1px jitter keeps the word", await sel(), [8, 12]);
}

// a press with detail 2 and no first click there (synthetic double clicks): the word under it
await load("alpha beta gamma");
await caretTo(0);
{
  const r = await T(() => { const t = document.querySelector(".t").firstChild; const rg = document.createRange(); rg.setStart(t, 12); rg.setEnd(t, 14); const rc = rg.getBoundingClientRect(); return { x: rc.left + rc.width / 2, y: rc.top + rc.height / 2 }; });
  await page.mouse.move(r.x, r.y);
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
  check("detail-2 press without a first click: the word under it", await sel(), [11, 16]);
}

// Down on the last line / Up on the first: to the document's end / start, without scrolling the page
await load(Array.from({ length: 60 }, (_, i) => "line " + i).join("\n"));
{
  const len = (await text()).length;
  await caretTo(len - 2);
  await page.keyboard.press("ArrowRight"); // scrolls the caret into view
  await page.waitForTimeout(30);
  const before = await T(() => [document.scrollingElement.scrollTop, ...[...document.querySelectorAll("*")].filter((e) => e.scrollTop > 0).map((e) => e.scrollTop)]);
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(30);
  check("down on the last line: document end", await sel(), [len, len]);
  check("down on the last line: no scroll", await T(() => [document.scrollingElement.scrollTop, ...[...document.querySelectorAll("*")].filter((e) => e.scrollTop > 0).map((e) => e.scrollTop)]), before);
}

// a press on a link with no mouseup (the focus went elsewhere): a later focus restores the editor's selection
await load("see [link](https://example.com) end");
await caretTo(2);
check("link mousedown without mouseup: focus restores the selection", await T(() => {
  const o = window.open;
  window.open = () => null;
  document.querySelector(".t.link").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, detail: 1 }));
  // (the button was released elsewhere)
  document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 1, clientY: 1, buttons: 0 }));
  window.open = o;
  T.view.root.blur();
  document.getSelection().removeAllRanges();
  T.view.root.focus();
  const s = T.view.readDomSel();
  return s && [s.anchor, s.head];
}), [2, 2]);
await page.mouse.up();

// an image that hasn't loaded yet: Up/Down and clicks still reach its (collapsed, image-only) line
await load("first line\nlast line");
{
  // inserted after the page loaded (the page's load event would wait for it)
  await T((src) => T.ytext2.insert(11, `![pic](${src})\n`), base + "hang.png");
  const end = 11 + `![pic](${base}hang.png)`.length;
  check("image still loading (no size yet)", await T(() => { const b = document.querySelector(".imgbox"); return [b.classList.contains("loading"), b.getBoundingClientRect().height]; }), [true, 0]);
  await caretTo(3);
  await page.keyboard.press("ArrowDown");
  check("down onto a loading image line: end of its source", await sel(), [end, end]);
  await caretTo(end + 3);
  await page.keyboard.press("ArrowUp");
  check("up onto a loading image line: end of its source", await sel(), [end, end]);
  await caretTo(9);
  await page.keyboard.press("ArrowDown");
  check("down onto a loading image line from the line's end", await sel(), [end, end]);
  await caretTo(end + 9);
  await page.keyboard.press("ArrowUp");
  check("up onto a loading image line from the line's end", await sel(), [end, end]);
  const r = await T(() => { const rc = document.querySelector(".imgs").getBoundingClientRect(); return { x: rc.left + 3, y: rc.top + rc.height / 2 }; });
  await page.mouse.click(r.x, r.y);
  await page.waitForTimeout(30);
  check("click on a loading image: end of its source", await sel(), [end, end]);
}

// spellcheck replacement runs no typing rules: one edit, one undo step
await load("teh cat");
await caretTo(7);
await replace(".t", "teh", "- x");
check("replacement with list syntax: plain text edit", await text(), "- x cat");
await page.keyboard.press("Control+z");
check("replacement undone in one step", await text(), "teh cat");

// --- collapsible heading sections
{
  const FD = "# A\na1\n## B\nb1\n# C\nc1";
  // per line: F folded heading, f foldable heading, h hidden, - other
  const folds = () => T(() => [...T.view.root.children].map((d) => (d.classList.contains("fold-hidden") ? "h" : d.classList.contains("folded") ? "F" : d.classList.contains("fold-able") ? "f" : "-")).join(""));
  const lineOf = () => T(() => { const p = T.sel().head; return T.view.doc.lines.findIndex((l) => l.from <= p && p <= l.to); });
  const chevron = (li) => T((i) => { const r = T.view.root.children[i].querySelector(".tok-heading").getBoundingClientRect(); return { x: r.left - 9, y: r.top + 10 }; }, li);
  const pill = (li) => T((i) => { const ln = T.view.root.children[i]; const rs = [...ln.children].filter((c) => c.tagName !== "BR").pop().getClientRects(); const r = rs[rs.length - 1]; return { x: r.right + 14, y: (r.top + r.bottom) / 2 }; }, li);
  const chevronShown = (li) => T((i) => getComputedStyle(T.view.root.children[i].querySelector(".tok-heading"), "::before").opacity, li);

  await load(FD);
  check("fold: foldable headings", await folds(), "f-f-f-");
  await caretTo(13);
  check("fold: chevron hidden off the line", await chevronShown(2), "0");
  await page.hover(".ln.h2");
  await page.waitForTimeout(200);
  check("fold: chevron shows on hover", await chevronShown(2), "1");
  let c = await chevron(0);
  await page.mouse.click(c.x, c.y);
  check("fold: chevron click folds the section (nested heading too)", await folds(), "Fhhhf-");
  check("fold: the text is unchanged", await text(), FD);
  check("fold: a caret in the section moves to the heading's end", await sel(), [3, 3]);
  check("fold: hidden lines take no space", await T(() => { const k = T.view.root.children; return [k[1].getBoundingClientRect().height, Math.round(k[4].getBoundingClientRect().top - k[0].getBoundingClientRect().bottom)]; }), [0, 0]);
  await page.mouse.move(600, 600);
  await page.waitForTimeout(200);
  check("fold: chevron stays while folded", await chevronShown(0), "1");
  check("fold: undo has nothing to undo", (await T(() => T.view.engine.undo().edits ?? null)), null);

  // arrows skip the folded section
  await caretTo(3);
  await page.keyboard.press("ArrowRight");
  check("fold: Right at the heading end goes past the section", await sel(), [15, 15]);
  await page.keyboard.press("ArrowLeft");
  check("fold: Left comes back to the heading end", await sel(), [3, 3]);
  await page.keyboard.press("ArrowDown");
  check("fold: Down from the folded heading: the line after the section", await lineOf(), 4);
  await page.keyboard.press("ArrowUp");
  check("fold: Up back onto the folded heading", await lineOf(), 0);
  await caretTo(3);
  await page.keyboard.press("Shift+ArrowRight");
  check("fold: Shift-Right selects the hidden text", await sel(), [3, 15]);

  // typing / Enter at the end of a folded heading
  await caretTo(3);
  await page.keyboard.type("x");
  check("fold: typing at the end types into the heading", await text(), "# Ax\na1\n## B\nb1\n# C\nc1");
  check("fold: still folded", await folds(), "Fhhhf-");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Enter");
  check("fold: Enter starts a heading after the folded section", await text(), "# A\na1\n## B\nb1\n# \n# C\nc1");
  check("fold: caret in the new heading", await sel(), [17, 17]);
  check("fold: section stays folded", await folds(), "Fhhh-f-");
  await page.keyboard.press("Control+z");
  check("fold: undo the new heading", await text(), FD);

  // a selection across the fold deletes the hidden text with it
  await T(() => T.view.setSel({ anchor: 0, head: 15 }));
  await page.keyboard.press("Backspace");
  check("fold: delete across the fold", await text(), "# C\nc1");
  check("fold: the fold went with its heading", await folds(), "f-");
  await page.keyboard.press("Control+z");
  check("fold: undo brings the section back unfolded", [await text(), await folds()], [FD, "f-f-f-"]);

  // keyboard: Cmd-' (Ctrl here) toggles, Cmd-Option-[ / ] fold outwards / unfold, with Shift all
  await caretTo(13);
  await page.keyboard.press("Control+'");
  check("fold: Cmd-' folds the section around the caret", [await folds(), await sel()], ["f-Fhf-", [11, 11]]);
  await page.keyboard.press("Control+Alt+BracketLeft");
  check("fold: Cmd-Option-[ folds the next section out", [await folds(), await sel()], ["Fhhhf-", [3, 3]]);
  await page.keyboard.press("Control+Alt+BracketRight");
  check("fold: Cmd-Option-] unfolds", await folds(), "f-Fhf-");
  await page.keyboard.press("Control+Alt+Shift+BracketLeft");
  check("fold: fold all", await folds(), "FhhhFh");
  await page.keyboard.press("Control+Alt+Shift+BracketRight");
  check("fold: unfold all", await folds(), "f-f-f-");
  await page.keyboard.press("Control+'");
  check("fold: Cmd-' on a heading folds it", await folds(), "Fhhhf-");
  c = await pill(0);
  await page.mouse.click(c.x, c.y);
  check("fold: the … pill unfolds", await folds(), "f-f-f-");
  check("fold: the pill click keeps the caret", await sel(), [3, 3]);

  // select all keeps folds, copy gives all the markdown
  await caretTo(18);
  await page.keyboard.press("Control+Alt+BracketLeft");
  await page.keyboard.press("Control+a");
  check("fold: select all includes the folded text", [await sel(), await folds()], [[0, 21], "f-f-Fh"]);
  check("fold: copy is the whole markdown", await T(() => T.view.engine.copy()), FD);

  // remote edits: inside the fold it stays; the heading deleted, the fold goes
  await load(FD);
  await caretTo(3);
  await page.keyboard.press("Control+'");
  await T(() => T.ytext2.insert(13, "zz"));
  await page.waitForTimeout(30);
  check("fold: remote edit inside a fold", [await text(), await folds(), await sel()], ["# A\na1\n## B\nbzz1\n# C\nc1", "Fhhhf-", [3, 3]]);
  await T(() => T.ytext2.delete(0, 4));
  await page.waitForTimeout(30);
  check("fold: remote deletion of the heading line removes the fold", await folds(), "-f-f-");
  // a remote edit that pulls the caret's line into a folded section unfolds it
  await load(FD);
  await caretTo(20);
  c = await chevron(0);
  await page.mouse.click(c.x, c.y);
  check("fold: folding elsewhere keeps the caret", [await folds(), await sel()], ["Fhhhf-", [20, 20]]);
  await T(() => T.ytext2.delete(15, 2));
  await page.waitForTimeout(30);
  check("fold: caret pulled into the section unfolds it", [await text(), await folds()], ["# A\na1\n## B\nb1\nC\nc1", "f-f---"]);
  // undo putting the caret back into folded text unfolds it
  await load(FD);
  await caretTo(14);
  await page.keyboard.type("x");
  c = await chevron(0);
  await page.mouse.click(c.x, c.y);
  check("fold: folded with the caret inside", [await folds(), await sel()], ["Fhhhf-", [3, 3]]);
  await page.keyboard.press("Control+z");
  check("fold: undo into folded text unfolds", [await text(), await folds(), await lineOf()], [FD, "f-f-f-", 3]);
  // a remote cursor inside a folded section shows on the folded heading
  await load(FD);
  await caretTo(3);
  await page.keyboard.press("Control+'");
  await T(() => T.setRemoteCursor(13, 13));
  await page.waitForTimeout(150);
  check("fold: remote cursor in a folded section drawn on its heading", await T(() => {
    const c = document.querySelector(".rcaret")?.getBoundingClientRect();
    const h = T.view.root.children[0].getBoundingClientRect();
    return !!c && c.height > 0 && c.top >= h.top - 1 && c.bottom <= h.bottom + 1;
  }), true);

  // persisted per note (heading text + occurrence), restored on reload
  await load(FD, "?folds");
  await caretTo(9);
  await page.keyboard.press("Control+'");
  await page.waitForTimeout(400);
  await load("intro\n" + FD, "?folds");
  check("fold: restored after a reload (edits elsewhere)", await folds(), "-f-Fhf-");
  await caretTo(0);
  await page.keyboard.press("Control+Alt+Shift+BracketRight");
  await page.waitForTimeout(400);
  await load(FD, "?folds");
  check("fold: unfolding is persisted too", await folds(), "f-f-f-");

  // screenshots: unfolded with the chevron on hover, folded
  const shot = "# Project notes\nWhat this is about, in a sentence or two.\n## Ideas\n- a quieter sidebar\n- folding sections\n### Later\n- maybe tables\n## Done\n- [x] the Rust engine\n- [x] collab in wasm\n## Links\nsee [the plan](https://example.com)";
  await load(shot);
  await caretTo(shot.indexOf("folding"));
  await page.hover(".ln.h2");
  await page.waitForTimeout(250);
  await page.screenshot({ path: "/tmp/opencode/fold/web-unfolded-hover.png" });
  await T(() => T.view.foldCommand("foldAll"));
  await T(() => T.view.toggleFold(0));
  await page.mouse.move(800, 650);
  await caretTo(shot.indexOf("\n## Done"));
  await page.waitForTimeout(250);
  await page.screenshot({ path: "/tmp/opencode/fold/web-folded.png" });
  await T(() => T.view.toggleFold(2));
  await page.waitForTimeout(250);
  await page.screenshot({ path: "/tmp/opencode/fold/web-folded-partly.png" });
}

// --- code highlighting (fenced blocks with a language; src/client/editor-rs/code.ts)
{
  const hk = () => page.waitForFunction(() => !!document.querySelector(".ln.in-code [class*=hk]"), null, { timeout: 5000 });
  // the computed style of the span holding the start of `s` in line `li` (a view line index, or the first line
  // starting with that text)
  const style = (li, s) =>
    T(([li, s]) => {
      if (typeof li === "string") li = T.view.doc.lines.findIndex((l) => T.view.doc.text.slice(l.from, l.to).startsWith(li));
      const { from, to } = T.view.doc.lines[li] ?? {};
      const at = T.view.doc.text.slice(from, to).indexOf(s);
      const el = [...(T.view.root.children[li]?.querySelectorAll(".t") ?? [])].find((e) => +e.dataset.f <= at && at < +e.dataset.t);
      if (at < 0 || !el) return null;
      const cs = getComputedStyle(el);
      return [cs.color, cs.fontStyle];
    }, [li, s]);
  const lineBg = (li) => T((li) => getComputedStyle(T.view.root.children[li]).backgroundColor, li);
  const spans = (li) =>
    T((li) => {
      if (typeof li === "string") li = T.view.doc.lines.findIndex((l) => T.view.doc.text.slice(l.from, l.to).startsWith(li));
      return [...T.view.root.children[li].querySelectorAll("[data-f]")].map((e) => [e.dataset.f, e.dataset.t, e.className]);
    }, li);
  // every raw position of lines [a, b): caret written to the DOM reads back the same (raw <-> DOM mapping)
  const roundTrip = (a, b) =>
    T(([a, b]) => {
      T.view.root.focus();
      const bad = [];
      for (let li = a; li < b; li++) {
        const { from, to } = T.view.doc.lines[li];
        if (T.view.root.children[li].textContent !== T.view.doc.text.slice(from, to)) bad.push(["text", li]);
        for (let p = from; p <= to; p++) {
          T.view.setSel({ anchor: p, head: p });
          const s = T.view.readDomSel();
          if (!s || s.head !== p) bad.push([p, s && s.head]);
        }
      }
      return bad;
    }, [a, b]);
  const KW = "rgb(41, 109, 154)"; // keyword #296d9a
  const STR = "rgb(63, 125, 78)"; // string #3f7d4e
  const CMT = "rgb(122, 123, 130)"; // comment #7a7b82
  const CODE_BG = "rgb(241, 241, 242)";
  const doc = "intro\n```ts\nconst a = 1; // note\nlet s = f(a);\n```\n```diff\n--- a/x\n+++ b/x\n-old line\n+new line\n context\n```\n```foo\nconst plain = 1;\n```\nend";
  await load(doc);
  await hk();
  check("hl: ts keyword", await style(2, "const "), [KW, "normal"]);
  check("hl: ts comment (italic)", await style(2, "// note"), [CMT, "italic"]);
  check("hl: text unchanged", await T(() => T.view.root.children[2].textContent), "const a = 1; // note");
  check("hl: diff - line background", await lineBg(8), "rgb(247, 239, 229)");
  check("hl: diff + line background", await lineBg(9), "rgb(233, 243, 236)");
  check("hl: diff context line keeps the code background", await lineBg(10), CODE_BG);
  check("hl: diff ---/+++ headers tinted too", [await lineBg(6), await lineBg(7)], ["rgb(247, 239, 229)", "rgb(233, 243, 236)"]);
  check("hl: diff + text", await style(9, "new line"), ["rgb(63, 125, 78)", "normal"]);
  check("hl: unknown language stays plain", await spans(13), [["0", "16", "t"]]);
  check("hl: fence lines unchanged", await spans(1), [["0", "5", "mk fence"]]);
  check("hl: raw <-> DOM mapping", await roundTrip(0, 16), []);
  // a line that is just "+" (only punctuation) counts as added
  await caretTo(doc.indexOf(" context") + 8);
  await page.keyboard.press("Enter");
  await page.keyboard.type("+");
  check("hl: bare + line tinted", [(await text()).includes(" context\n+\n```"), await lineBg(11)], [true, "rgb(233, 243, 236)"]);
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  check("hl: bare + line removed again", await text(), doc);
  // typing inside a block updates its highlighting; lines of other blocks keep their divs
  await T(() => (T.view.root.children[7].__mark = 1));
  const at = doc.indexOf("1; //");
  await caretTo(at);
  await page.keyboard.type('"x" + ');
  check("hl: typed text", (await text()).slice(at - 4, at + 8), 'a = "x" + 1;');
  check("hl: typed string coloured", await style(2, '"x"'), [STR, "normal"]);
  check("hl: caret after typing", await sel(), [at + 6, at + 6]);
  check("hl: other block's lines not redrawn", await T(() => T.view.root.children[7].__mark), 1);
  // starting a block comment re-colours the lines after it
  await caretTo(doc.indexOf("let s") + 6);
  await page.keyboard.type("/* ");
  check("hl: comment opened spans the next line", [await style(3, "s = f(a);"), await style(2, "const ")], [[CMT, "italic"], [KW, "normal"]]);
  await page.keyboard.press("Control+z");
  check("hl: undo restores highlighting", [await text(), await style(3, "let ")], [doc.replace("1; //", '"x" + 1; //'), [KW, "normal"]]);
  check("hl: mapping after edits", await roundTrip(0, 16), []);
  // remote edit inside the block
  await T((p) => T.ytext2.insert(p, "// "), doc.indexOf("let s") + 6);
  await page.waitForTimeout(50);
  check("hl: remote edit recoloured", await style(3, "// "), [CMT, "italic"]);
  // paste a new ts line
  await caretTo(doc.indexOf("```\n```diff") + 6);
  await T(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "\nconst p = true;");
    T.view.root.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  check("hl: pasted line highlighted", await style(4, "const "), [KW, "normal"]);
  // changing the language word
  await T(() => {
    const t = T.ytext2.toString();
    const i = t.indexOf("```foo") + 3;
    T.ytext2.delete(i, 3);
    T.ytext2.insert(i, "JS title=\"x\"");
  });
  await page.waitForTimeout(50);
  check("hl: ```JS title=\"x\" highlights", await style("const plain", "const "), [KW, "normal"]);
  await T(() => {
    const t = T.ytext2.toString();
    const i = t.indexOf("```JS") + 3;
    T.ytext2.delete(i, 2);
  });
  await page.waitForTimeout(50);
  check("hl: removing the language makes it plain", await spans("const plain"), [["0", "16", "t"]]);

  // the highlighter only loads for a supported language
  await load("```foo\nx\n```\n```\ny\n```");
  await page.waitForTimeout(300);
  check(
    "hl: no highlighter for unknown languages",
    await T(() => [performance.getEntriesByType("resource").some((r) => r.name.includes("highlights.wasm")), !!document.querySelector("style[data-code-theme]")]),
    [false, false],
  );
  // the highlighter can't load: code stays plain, no errors
  await page.route("**/highlights.wasm", (r) => r.abort());
  const errs = [];
  const onErr = (e) => errs.push(e.message);
  page.on("pageerror", onErr);
  await load("```ts\nconst a = 1;\n```\nb");
  await page.waitForTimeout(300);
  await caretTo(11);
  await page.keyboard.type("x");
  check("hl: wasm failing: plain, editable, no errors", [await spans(1), await text(), errs], [[["0", "13", "t"]], "```ts\nconstx a = 1;\n```\nb", []]);
  page.off("pageerror", onErr);
  await page.unroute("**/highlights.wasm");
  // read-only
  await load("```rs\nfn main() {}\n```", "?ro");
  await hk();
  check("hl: read-only note highlighted", await style(1, "fn "), [KW, "normal"]);
  // folding: a section with a code block, folded and unfolded
  await load("# A\n```py\ndef f(): pass\n```\n# B");
  await hk();
  await T(() => T.view.toggleFold(0));
  await T(() => T.view.toggleFold(0));
  check("hl: after fold/unfold", await style(2, "def "), [KW, "normal"]);

  // perf: typing in a 500-line block
  const lines = Array.from({ length: 500 }, (_, i) => `  const v${i} = compute(${i}, "str", { a: ${i} }); // c ${i}`);
  const bigCode = "# Perf\n```ts\n" + lines.join("\n") + "\n```\nafter";
  await load(bigCode);
  await hk();
  await caretTo(bigCode.indexOf("v250 ") + 4);
  const n = 30;
  const tk = Date.now();
  for (let i = 0; i < n; i++) await page.keyboard.type("x");
  const per = (Date.now() - tk) / n;
  const inPage = await T(() => {
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) T.view.apply(T.view.engine.insert_text("y"));
    return (performance.now() - t0) / 50;
  });
  console.log(`code block typing (500 lines): ${per.toFixed(1)} ms/key (playwright), ${inPage.toFixed(2)} ms/key in page`);
  check("hl: big block typed and highlighted", [(await text()).includes("v250" + "x".repeat(n) + "y".repeat(50) + " "), await style(252, "const ")], [true, [KW, "normal"]]);
  check("hl: big block keystroke < 16 ms in page", inPage < 16, true);
}

// --- links: a click on a collapsed link opens it (caret untouched); the caret walks through it without revealing it;
// only the pencil expands it, its URL then ordinary editable text
{
  const stub = () => T(() => { window.__opened = []; window.open = (...a) => { window.__opened.push(a); return null; }; });
  const opened = () => T(() => window.__opened.map((a) => a[0]));
  const center = (sel, i = 0) => T(([s, i]) => { const r = document.querySelectorAll(s)[i].getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }, [sel, i]);
  const revealed = () => T(() => document.querySelectorAll(".mk.link.rv").length);
  const doc = "see [the plan](https://example.com/x) end\nsecond line";
  await load(doc);
  await stub();
  await caretTo(2);
  let [x, y] = await center(".t.link");
  await page.mouse.move(x, y);
  check("link: pointer cursor and the URL as tooltip over a collapsed link", await T(() => [getComputedStyle(T.view.root).cursor, T.view.root.title]), ["pointer", "https://example.com/x"]);
  await page.mouse.click(x, y);
  check("link: click opens it in a new tab", await T(() => window.__opened), [["https://example.com/x", "_blank", "noopener,noreferrer"]]);
  check("link: click leaves caret and source alone", [await sel(), await revealed(), await text()], [[2, 2], 0, doc]);
  await page.waitForTimeout(600);
  await stub();
  await page.mouse.dblclick(x, y);
  check("link: double click opens once, caret unchanged", [await opened(), await sel()], [["https://example.com/x"], [2, 2]]);
  // arrows step through its text like plain text: never into its brackets or URL, never revealing it
  await caretTo(3);
  const walk = [];
  let shown = 0;
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("ArrowRight");
    walk.push((await sel())[0]);
    shown += await revealed();
  }
  check("link: ArrowRight through a collapsed link doesn't reveal it", [walk, shown], [[4, 6, 7, 8, 9, 10, 11, 12, 37, 38], 0]);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  check("link: ArrowLeft back into its text", [await sel(), await revealed()], [[12, 12], 0]);
  await page.keyboard.type("!");
  check("link: typing in a collapsed link's text", [await text(), await revealed()], ["see [the pla!n](https://example.com/x) end\nsecond line", 0]);
  await page.keyboard.press("Backspace");
  check("link: and deleting", await text(), doc);
  await page.mouse.move(x + 200, y);
  check("link: off the link, the text cursor again", await T(() => [getComputedStyle(T.view.root).cursor, T.view.root.title]), ["auto", ""]);
  // drag starting on the link selects
  await stub();
  // (past the line's end; the link doesn't reveal as the selection crosses it)
  const [ex, ey] = await T(() => { const r = [...document.querySelectorAll(".t")].find((e) => e.textContent === " end").getBoundingClientRect(); return [r.right + 300, r.y + r.height / 2]; });
  [x, y] = await T(() => { const r = document.querySelector(".t.link").getBoundingClientRect(); return [r.x + 3, r.y + r.height / 2]; });
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 20, y, { steps: 3 });
  await page.mouse.move(ex, ey, { steps: 5 });
  await page.mouse.up();
  const ds = await sel();
  check("link: drag from the link selects, nothing opens, nothing reveals", [ds[0] >= 4 && ds[0] <= 6, ds[1], await opened(), await revealed()], [true, 41, [], 0]);
  // shift-click extends
  await caretTo(2);
  [x, y] = await center(".t.link");
  await page.keyboard.down("Shift");
  await page.mouse.click(x, y);
  await page.keyboard.up("Shift");
  const ss = await sel();
  check("link: shift-click extends the selection, nothing opens", [ss[0], ss[1] > 5 && ss[1] < 13, await opened()], [2, true, []]);
  // the pencil expands it, caret at the end of the link text
  await caretTo(2);
  check("link: pencil drawn after the text", await T(() => { const c = document.querySelector(".chip"); return [!!c.querySelector("svg"), c.getBoundingClientRect().left >= document.querySelector(".t.link").getBoundingClientRect().right - 1]; }), [true, true]);
  [x, y] = await center(".chip");
  await page.mouse.move(x, y);
  check("link: pencil darker on hover", await T(() => getComputedStyle(document.querySelector(".chip")).color), "rgb(29, 30, 34)");
  await page.mouse.click(x, y);
  check("link: pencil expands, caret at the end of the link text", [await sel(), await revealed(), await opened(), await T(() => T.view.hasFocus())], [[13, 13], 4, [], true]);
  check("link: expanded: its URL is text in the marker colour, no pencil", await T(() => {
    const u = document.querySelector(".mk.url");
    const mid = [...document.querySelectorAll(".mk.link")].find((e) => e.textContent === "](");
    return [getComputedStyle(document.querySelector(".chip")).display, u.textContent, u.getBoundingClientRect().width > 50, getComputedStyle(u).color === getComputedStyle(mid).color, getComputedStyle(u).textDecorationLine];
  }), ["none", "https://example.com/x", true, true, "none"]);
  check("link: expanded: plain cursor", await T(() => getComputedStyle(T.view.root).cursor), "auto");
  // ArrowRight goes on into the URL
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
  check("link: ArrowRight moves into the URL", [await sel(), await revealed()], [[16, 16], 4]);
  // a click inside the URL places the caret there (after its last character)
  [x, y] = await T(() => { const r = document.querySelector(".mk.url").getBoundingClientRect(); return [r.right - 2, r.y + r.height / 2]; });
  await page.mouse.click(x, y);
  check("link: click inside the URL places the caret", [await sel(), await opened(), await revealed()], [[36, 36], [], 4]);
  await page.keyboard.type("y");
  check("link: typing changes the URL", [await text(), await revealed()], ["see [the plan](https://example.com/xy) end\nsecond line", 4]);
  // clicks in a revealed link edit
  [x, y] = await T(() => { const r = document.querySelector(".t.link").getBoundingClientRect(); return [r.x + 2, r.y + r.height / 2]; });
  await page.mouse.click(x, y);
  check("link: click in a revealed link places the caret", [await sel(), await opened()], [[5, 5], []]);
  await page.keyboard.type("Z");
  check("link: typing in it edits", await text(), "see [Zthe plan](https://example.com/xy) end\nsecond line");
  await page.keyboard.press("ArrowDown");
  check("link: collapses again once the caret leaves", [await revealed(), await T(() => getComputedStyle(document.querySelector(".chip")).display)], [0, "inline-block"]);
  // a click on it now opens the new URL
  await page.waitForTimeout(600);
  [x, y] = await center(".t.link");
  await page.mouse.click(x, y);
  check("link: the collapsed link opens its new URL", await opened(), ["https://example.com/xy"]);
  await stub();
  // Ctrl-Enter (Cmd-Enter on a Mac) in a link opens it
  await caretTo(8);
  await page.keyboard.press("Control+Enter");
  check("link: Ctrl-Enter in a link opens it", [await opened(), await text()], [["https://example.com/xy"], "see [Zthe plan](https://example.com/xy) end\nsecond line"]);
  // unsafe: nothing
  await load("a [x](javascript:alert(1)) b");
  await stub();
  [x, y] = await center(".t.link");
  await page.mouse.click(x, y);
  check("link: javascript: never opens", [await opened(), await sel()], [[], [0, 0]]);
  // #heading: scrolls there, caret at the heading's start
  const filler = Array.from({ length: 60 }, (_, i) => "line " + i).join("\n");
  await load("[jump](#second-part)\n" + filler + "\n## Second part\nafter");
  await stub();
  await caretTo(30);
  [x, y] = await center(".t.link");
  await page.mouse.click(x, y);
  const hpos = (await text()).indexOf("## Second part") + 3;
  check("link: #heading puts the caret at the heading", await sel(), [hpos, hpos]);
  check("link: #heading scrolled into view", await T(() => { const r = [...document.querySelectorAll(".ln-heading")].pop().getBoundingClientRect(); return r.top >= -1 && r.bottom <= innerHeight; }), true);
  // a linked image: a click on the image opens the link; its pencil (after the image) expands it
  const svg = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#4a7"/></svg>');
  await load(`[![pic](data:image/svg+xml,${svg})](https://example.com/img)\nnext`);
  await stub();
  await caretTo((await text()).length);
  await page.waitForFunction(() => document.querySelector(".imgbox img")?.dataset.state === "ok");
  [x, y] = await center(".imgbox");
  await page.mouse.move(x, y);
  check("linked image: pointer cursor", await T(() => getComputedStyle(document.querySelector(".imgbox")).cursor), "pointer");
  await page.mouse.click(x, y);
  check("linked image: click opens the link", [await opened(), await sel()], [["https://example.com/img"], [(await text()).length, (await text()).length]]);
  check("linked image: pencil after the image", await T(() => { const c = document.querySelector(".img-chip"); const r = c.getBoundingClientRect(); return r.width > 4 && r.left >= document.querySelector(".imgbox").getBoundingClientRect().right - 1; }), true);
  [x, y] = await center(".img-chip");
  await page.mouse.click(x, y);
  const pend = (await text()).indexOf("](https");
  check("linked image: pencil reveals the link", [await sel(), await T(() => document.querySelector(".ln").classList.contains("img-rv")), await T(() => getComputedStyle(document.querySelector(".img-chip")).display)], [[pend, pend], true, "none"]);
}
// read-only: links open, no pencil
if (!collab) {
  await load("see [the plan](https://example.com/x) end", "?ro");
  await T(() => { window.__opened = []; window.open = (...a) => { window.__opened.push(a); return null; }; });
  check("read-only: no pencil", await T(() => getComputedStyle(document.querySelector(".chip svg")).display), "none");
  const [x, y] = await T(() => { const r = document.querySelector(".t.link").getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
  await page.mouse.click(x, y);
  check("read-only: a click opens the link", await T(() => window.__opened.map((a) => a[0])), ["https://example.com/x"]);
}

// screenshot
await load("# Heading One\nSome **bold**, *italic*, ~~strike~~, ==highlight==, `code` and a [link](https://example.com) #tag.\n## Lists\n- bullet one\n\t- nested bullet\n- [ ] todo item\n- [x] done item\n1. first\n2. second\n> a quote line\n---\n```js\nconst x = 1;\n```\nlast paragraph");
await T(() => T.setRemoteCursor(20, 30));
await caretTo(19);
await page.waitForTimeout(100);
await page.screenshot({ path: "/tmp/opencode/edtest/shot.png" });

console.log(fails ? `${fails} FAILED` : "ALL OK");
await b.close();
server.stop();
