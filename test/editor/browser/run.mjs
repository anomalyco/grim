import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";

// Usage: bun build test/editor/browser/harness.ts --outdir /tmp/opencode/edtest --target browser && cp test/editor/browser/index.html src/client/editor/editor.css /tmp/opencode/edtest/ && bun test/editor/browser/run.mjs
// Needs playwright-core and a Chromium headless shell (paths below).
const dir = "/tmp/opencode/edtest";
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const p = new URL(req.url).pathname;
    const f = Bun.file(dir + (p === "/" ? "/index.html" : p));
    return new Response(f);
  },
});
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
  await page.goto(base + "?n=" + nload++ + (q ? "&" + q.slice(1) : "") + "#" + encodeURIComponent(init));
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

// screenshot
await load("# Heading One\nSome **bold**, *italic*, ~~strike~~, ==highlight==, `code` and a [link](https://example.com) #tag.\n## Lists\n- bullet one\n\t- nested bullet\n- [ ] todo item\n- [x] done item\n1. first\n2. second\n> a quote line\n---\n```js\nconst x = 1;\n```\nlast paragraph");
await T(() => T.setRemoteCursor(20, 30));
await caretTo(19);
await page.waitForTimeout(100);
await page.screenshot({ path: "/tmp/opencode/edtest/shot.png" });

console.log(fails ? `${fails} FAILED` : "ALL OK");
await b.close();
server.stop();
