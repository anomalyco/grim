import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";

// Usage: bun test/editor/browser/run.mjs            (Rust engine, the default: harness-rs.ts + the wasm pkg)
//        COLLAB=1 bun test/editor/browser/run.mjs   (the Rust engine owning the shared doc, in-page room)
//        ENGINE=ts bun test/editor/browser/run.mjs  (the TS engine, kept as the fallback)
// Builds the harness into /tmp/opencode/edtest[-rs]. Needs playwright-core and a Chromium headless shell (paths below).
const rust = process.env.ENGINE !== "ts";
const collab = rust && !!process.env.COLLAB;
const dir = rust ? "/tmp/opencode/edtest-rs" : "/tmp/opencode/edtest";
{
  const src = new URL(".", import.meta.url).pathname;
  const root = new URL("../../../", import.meta.url).pathname;
  const out = await Bun.build({ entrypoints: [src + (rust ? "harness-rs.ts" : "harness.ts")], outdir: dir, target: "browser", naming: "harness.js" });
  if (!out.success) throw new AggregateError(out.logs, "harness build failed");
  const files = [src + "index.html", root + "src/client/editor/editor.css"];
  if (rust) files.push(root + "src/client/editor-rs/pkg/editor_wasm.js", root + "src/client/editor-rs/pkg/editor_wasm_bg.wasm");
  for (const f of files) await Bun.write(dir + "/" + f.split("/").pop(), Bun.file(f));
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
console.log("engine:", rust ? (collab ? "rust (collab)" : "rust") : "ts");
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
check("engine under test", await T(() => document.querySelector(".mde").dataset.engine ?? "ts"), rust ? "rust" : "ts");
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
check("js url not opened", await T(() => { let opened = 0; const o = window.open; window.open = () => { opened++; return null; }; const chip = document.querySelector(".chip"); chip.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 })); window.open = o; return opened; }), 0);

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
  check("mid-text image: a normal line with the image below", await T(() => { const l = document.querySelectorAll(".ln")[2]; return [l.classList.contains("ln-img"), !!l.querySelector(".imgs")]; }), [false, true]);
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

// a press with detail 2 and no first click there (synthetic double clicks): the word under it (Rust engine;
// the TS editor uses its last click position)
await load("alpha beta gamma");
await caretTo(0);
{
  const r = await T(() => { const t = document.querySelector(".t").firstChild; const rg = document.createRange(); rg.setStart(t, 12); rg.setEnd(t, 14); const rc = rg.getBoundingClientRect(); return { x: rc.left + rc.width / 2, y: rc.top + rc.height / 2 }; });
  await page.mouse.move(r.x, r.y);
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
  if (rust) check("detail-2 press without a first click: the word under it", await sel(), [11, 16]);
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
  // (the TS engine probes through the bottom padding and scrolls)
  if (rust) check("down on the last line: no scroll", await T(() => [document.scrollingElement.scrollTop, ...[...document.querySelectorAll("*")].filter((e) => e.scrollTop > 0).map((e) => e.scrollTop)]), before);
}

// a link chip opened with the button down (window.open takes the focus, no mouseup): a later focus restores
// the editor's selection (Rust shell; the TS editor keeps the browser's focus caret)
await load("see [link](https://example.com) end");
await caretTo(2);
if (rust) check("chip mousedown without mouseup: focus restores the selection", await T(() => {
  const o = window.open;
  window.open = () => null;
  document.querySelector(".chip").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, detail: 1 }));
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

// screenshot
await load("# Heading One\nSome **bold**, *italic*, ~~strike~~, ==highlight==, `code` and a [link](https://example.com) #tag.\n## Lists\n- bullet one\n\t- nested bullet\n- [ ] todo item\n- [x] done item\n1. first\n2. second\n> a quote line\n---\n```js\nconst x = 1;\n```\nlast paragraph");
await T(() => T.setRemoteCursor(20, 30));
await caretTo(19);
await page.waitForTimeout(100);
await page.screenshot({ path: "/tmp/opencode/edtest/shot.png" });

console.log(fails ? `${fails} FAILED` : "ALL OK");
await b.close();
server.stop();
