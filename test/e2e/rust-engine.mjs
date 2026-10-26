// End-to-end smoke of the Rust editor engine (?engine=rust) through the real server: rendering, typing, lists,
// Cmd-B, clicks past hidden markers, arrows, undo, IME, and a TS-engine user and a Rust-engine user converging.
// Usage: bun run build:client && bun test/e2e/rust-engine.mjs
// Needs playwright-core in /tmp/opencode/pw, the Playwright Chromium headless shell, and the wasm package in
// src/client/editor-rs/pkg (copied to dist by build:client).
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "np-rs-e2e-"));
process.env.STORAGE = "local";
process.env.ALLOW_DEV_LOGIN = "1";
process.env.ALLOWED_GITHUB_USERS = "*";
process.env.QUIET_MS = "1500";
process.env.PORT = "0";
const { startServer } = await import("../../src/server/index.ts");
const app = await startServer({ port: 0, quiet: true });
const base = `http://localhost:${app.server.port}`;

const browser = await chromium.launch({
  executablePath: "/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell",
});
let fails = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(ok ? "ok  " : "FAIL", name, ok ? "" : `\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
};

async function user(name, engine) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[${name}] PAGEERROR`, e.message));
  page.on("console", (m) => m.type() === "error" && !m.text().includes("401") && console.log(`[${name}] CONSOLE`, m.text()));
  await page.goto(base + "/?engine=" + engine);
  await page.fill("input[name=name]", name);
  await page.click("form button[type=submit], form button");
  await page.waitForURL(/\/r\//, { timeout: 10000 });
  await page.waitForSelector(".mde .ln", { timeout: 10000 });
  if (!page.url().includes("engine=")) {
    // the sign-in page may drop the query: open the note again with it (the choice is remembered)
    await page.goto(page.url() + (page.url().includes("?") ? "&" : "?") + "engine=" + engine);
    await page.waitForSelector(".mde .ln", { timeout: 10000 });
  }
  return page;
}

// the signed-out pages: the home page's example note and the read-only getting-started guide
{
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("[home] PAGEERROR", e.message));
  await page.goto(base + "/?engine=rust");
  await page.waitForSelector(".home-editor .mde .ln", { timeout: 10000 });
  const H = (fn) => page.evaluate(fn);
  check("home: example note uses the Rust engine", await H(() => document.querySelector(".home-editor .mde").dataset.engine ?? "ts"), "rust");
  await page.click(".home-editor .mde .ln-heading");
  await page.keyboard.press("End");
  await page.keyboard.type(" rocks");
  check("home: typing in the example note", await H(() => document.querySelector(".home-editor .mde").mdeView.engine.text().split("\n")[0]), "# Grimoire rocks");
  await page.goto(base + "/start");
  await page.waitForSelector(".start-doc .mde .ln", { timeout: 10000 });
  check("start: guide uses the Rust engine (remembered)", await H(() => document.querySelector(".start-doc .mde").dataset.engine ?? "ts"), "rust");
  const before = await H(() => document.querySelector(".start-doc .mde").mdeView.engine.text());
  await page.click(".start-doc .mde .ln-heading");
  await page.keyboard.type("zz");
  await page.keyboard.press("Enter");
  check("start: guide is read-only", await H(() => document.querySelector(".start-doc .mde").mdeView.engine.text()), before);
  await ctx.close();
}

const alice = await user("Alice", "rust");
const R = (fn, arg) => alice.evaluate(fn, arg);
const view = () => "document.querySelector('.mde').mdeView";
check("Alice's note uses the Rust engine", await R(() => document.querySelector(".mde")?.dataset.engine ?? "ts"), "rust");
check("renders the Welcome note (heading)", await R(() => !!document.querySelector(".mde .ln-heading.h1")), true);
const text = () => R(() => document.querySelector(".mde").mdeView.engine.text());
const sel = () => R(() => [document.querySelector(".mde").mdeView.sel.anchor, document.querySelector(".mde").mdeView.sel.head]);
const domSel = () =>
  R(() => {
    const v = document.querySelector(".mde").mdeView;
    const s = v.readDomSel();
    return s && [s.anchor, s.head];
  });
const rv = () => R(() => document.querySelectorAll(".mde .mk.rv").length);
void view;

// clear the note and type
await alice.click(".mde .ln >> nth=0");
await alice.keyboard.press("Control+a");
await alice.keyboard.press("Backspace");
check("cleared", await text(), "");
await alice.keyboard.type("hello **world**");
check("type bold", await text(), "hello **world**");
check("caret after bold", await sel(), [15, 15]);
check("DOM selection matches", await domSel(), [15, 15]);
check("bold revealed", await rv(), 2);
await alice.keyboard.type(" x");
check("bold collapsed after moving off", await rv(), 0);

// Enter in a list
await alice.keyboard.press("Enter");
await alice.keyboard.type("- a");
await alice.keyboard.press("Enter");
await alice.keyboard.type("b");
check("list continues", await text(), "hello **world** x\n- a\n- b");
check("bullet glyphs", await R(() => document.querySelectorAll(".mde .tok-bullet").length), 2);
await alice.keyboard.press("Enter");
await alice.keyboard.press("Enter");
check("Enter on an empty item exits the list", await text(), "hello **world** x\n- a\n- b\n");

// Cmd-B (Ctrl-B here) on a selection, then undo
await alice.keyboard.type("bold me");
await alice.keyboard.press("Shift+ArrowLeft");
await alice.keyboard.press("Shift+ArrowLeft");
check("shift-arrows select", await sel(), [33, 31]);
await alice.keyboard.press("Control+b");
check("Ctrl-B wraps", await text(), "hello **world** x\n- a\n- b\nbold **me**");
check("inner text stays selected", await sel(), [35, 33]);
await alice.keyboard.press("Control+z");
check("undo", await text(), "hello **world** x\n- a\n- b\nbold me");

// click past the hidden closing markers at the end of the first line ("x" is plain: use a line ending in bold)
await alice.keyboard.press("Control+End");
await alice.keyboard.type(" **end**");
await alice.keyboard.press("Control+Home");
check("Ctrl-Home: document start", await sel(), [0, 0]);
const last = await R(() => {
  const ln = [...document.querySelectorAll(".mde .ln")].pop();
  const r = [...ln.querySelectorAll(".t")].pop().getBoundingClientRect();
  return { x: r.right + 40, y: r.top + r.height / 2 };
});
await alice.mouse.click(last.x, last.y);
const len = (await text()).length;
check("click right of hidden closing markers: line end", await sel(), [len, len]);
check("the clicked element reveals", await rv(), 2);
const mid = await R(() => {
  const t = document.querySelector(".mde .ln .t.b");
  const r = t.getBoundingClientRect();
  return { x: r.left + r.width * 0.6, y: r.top + r.height / 2 };
});
await alice.mouse.click(mid.x, mid.y);
const inBold = await sel();
check("click in bold text: caret in the word, DOM caret there too", [inBold[0] > 8 && inBold[0] < 13, inBold[0] === inBold[1], await domSel()], [true, true, inBold]);
await alice.mouse.dblclick(mid.x, mid.y);
check("double click selects the word without markers", await sel(), [8, 13]);

// arrows
await alice.keyboard.press("ArrowRight");
check("Right collapses the selection to its end", await sel(), [13, 13]);
await alice.keyboard.press("ArrowRight");
await alice.keyboard.press("ArrowRight");
check("Right steps over each revealed marker", await sel(), [15, 15]);
await alice.keyboard.press("ArrowDown");
const down = await sel();
check("Down goes to the next line", down[0] > 17 && down[0] <= 21, true);
await alice.keyboard.press("ArrowUp");
check("Up comes back to the first line", (await sel())[0] <= 17, true);
await alice.keyboard.press("End");
check("End (Home/End go to line edges off macOS)", await sel(), [17, 17]);

// IME composition (committed text replaces the composed DOM)
const cdp = await alice.context().newCDPSession(alice);
await cdp.send("Input.imeSetComposition", { text: "に", selectionStart: 1, selectionEnd: 1 });
await cdp.send("Input.imeSetComposition", { text: "にほ", selectionStart: 2, selectionEnd: 2 });
check("composing: engine text unchanged", await text(), "hello **world** x\n- a\n- b\nbold me **end**");
await cdp.send("Input.insertText", { text: "日本" });
check("IME commit", await text(), "hello **world** x日本\n- a\n- b\nbold me **end**");
check("caret after the commit", await sel(), [19, 19]);
check("DOM matches the engine after IME", await R(() => document.querySelector(".mde .ln").textContent), "hello **world** x日本");
await alice.keyboard.type("!");
check("typing after IME", await text(), "hello **world** x日本!\n- a\n- b\nbold me **end**");

// a TS-engine user joins; both type at once and converge
const bob = await user("Bob", "ts");
check("Bob's note uses the TS engine", await bob.evaluate(() => document.querySelector(".mde")?.dataset.engine ?? "ts"), "ts");
await bob.waitForFunction(() => document.querySelector(".mde")?.textContent?.includes("日本!"), null, { timeout: 5000 }).then(
  () => check("Bob sees Alice's text", true, true),
  () => check("Bob sees Alice's text", false, true),
);
await bob.click(".mde .ln >> nth=3");
await bob.keyboard.press("End");
await alice.click(".mde .ln >> nth=1");
await alice.keyboard.press("End");
await Promise.all([alice.keyboard.type(" alice was here", { delay: 15 }), bob.keyboard.type(" bob too", { delay: 20 })]);
await new Promise((r) => setTimeout(r, 800));
const lines = (p) => p.evaluate(() => [...document.querySelectorAll(".mde .ln")].map((l) => l.textContent).join("\n"));
const [la, lb] = [await lines(alice), await lines(bob)];
check("documents converge", la, lb);
check("both edits are there", la.includes("alice was here") && la.includes("bob too"), true);
check("Alice's engine text matches the DOM-visible edits", (await text()).includes("- a alice was here") && (await text()).includes("bold me **end** bob too"), true);
const cursorSeen = await alice
  .waitForFunction(() => document.querySelectorAll(".mde .rcaret").length > 0, null, { timeout: 3000 })
  .then(() => true, () => false);
check("Alice sees Bob's cursor", cursorSeen, true);
const bobSeen = await bob
  .waitForFunction(() => document.querySelectorAll(".mde .rcaret").length > 0, null, { timeout: 3000 })
  .then(() => true, () => false);
check("Bob sees Alice's cursor", bobSeen, true);

// Bob's edits land in Alice's engine with her caret kept
await alice.keyboard.press("Control+Home");
await alice.keyboard.press("ArrowRight");
await alice.keyboard.press("ArrowRight");
await bob.keyboard.press("Control+Home");
await bob.keyboard.type("Top ");
await alice.waitForFunction(() => document.querySelector(".mde").mdeView.engine.text().startsWith("Top "), null, { timeout: 3000 }).catch(() => {});
check("remote insert before the caret moves it", await sel(), [6, 6]);
check("DOM caret follows", await domSel(), [6, 6]);

// Alice composes (IME) at the end of the first line while Bob types before her on the same line
{
  const line0 = (await text()).split("\n")[0];
  await alice.keyboard.press("End");
  await cdp.send("Input.imeSetComposition", { text: "に", selectionStart: 1, selectionEnd: 1 });
  await bob.keyboard.type("Bob ");
  await alice.waitForFunction(() => document.querySelector(".mde").mdeView.engine.text().startsWith("Top Bob "), null, { timeout: 3000 }).catch(() => {});
  await cdp.send("Input.imeSetComposition", { text: "にほ", selectionStart: 2, selectionEnd: 2 });
  await cdp.send("Input.insertText", { text: "日本" });
  const want = "Top Bob " + line0.slice(4) + "日本";
  check("IME during remote typing: committed at the end of the line", (await text()).split("\n")[0], want);
  check("IME during remote typing: caret after the commit", await sel(), [want.length, want.length]);
  check("IME during remote typing: Alice's DOM", await R(() => document.querySelector(".mde .ln").textContent.replace(/\*\*/g, "")), want.replace(/\*\*/g, ""));
  await bob.waitForFunction((w) => document.querySelector(".mde .ln").textContent.replace(/\*\*/g, "") === w, want.replace(/\*\*/g, ""), { timeout: 3000 }).then(
    () => check("IME during remote typing: Bob converges", true, true),
    () => check("IME during remote typing: Bob converges", false, true),
  );
}

// a richer document: both engines draw the same lines; checkbox, image and table clicks
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#c33"/></svg>').toString("base64");
const rich = [
  "# Rich",
  "- [ ] task one",
  "1. first",
  "> quote with [a link](https://example.com)",
  "```js",
  "let x = 1;",
  "```",
  "| a | b |",
  "|---|--:|",
  "| 1 | 22 |",
  "",
  `![pic](data:image/svg+xml;base64,${svg})`,
  "tail ==hl== `code` \\*esc\\*",
].join("\n");
await R((md) => {
  const v = document.querySelector(".mde").mdeView;
  v.focus();
  v.apply(v.engine.set_selection(0, v.engine.text().length));
  v.apply(v.engine.paste(md));
}, rich);
check("paste", await text(), rich);
await bob.waitForFunction(() => document.querySelector(".mde .ln-table"), null, { timeout: 5000 }).catch(() => {});
const shape = (p) =>
  p.evaluate(() =>
    [...document.querySelectorAll(".mde .ln")].map((l) =>
      [...l.classList].filter((c) => !["active", "rv", "img-rv"].includes(c)).join(" ") + "|" + l.textContent,
    ),
  );
check("both engines draw the same lines", await shape(alice), await shape(bob));
await alice.click(".mde .tok-todo");
check("checkbox click toggles the todo", (await text()).split("\n")[1], "- [x] task one");
await bob.waitForFunction(() => document.querySelector(".mde .ln-todo.checked"), null, { timeout: 3000 }).then(
  () => check("Bob sees the checked todo", true, true),
  () => check("Bob sees the checked todo", false, true),
);
await alice.waitForFunction(() => [...document.querySelectorAll(".mde .imgbox img")].some((i) => i.complete && i.naturalWidth > 0), null, { timeout: 3000 }).catch(() => {});
const imgBox = await R(() => {
  const r = document.querySelector(".mde .imgbox img").getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, h: r.height };
});
check("image is drawn", imgBox.h > 20, true);
await alice.mouse.click(imgBox.x, imgBox.y);
const imgLine = (await text()).split("\n").slice(0, 12).join("\n").length;
check("click on the image: caret after its source", await sel(), [imgLine, imgLine]);
const cell = await R(() => {
  const c = [...document.querySelectorAll(".mde .ln-table-row .tcell")][1];
  const r = c.getBoundingClientRect();
  return { x: r.right - 3, y: r.top + r.height / 2 };
});
await alice.mouse.click(cell.x, cell.y);
const rowStart = rich.indexOf("| 1 | 22 |");
const s = await sel();
check("click in a table cell lands in that cell's text", s[0] >= rowStart + 6 && s[0] <= rowStart + 8, true);

await alice.screenshot({ path: "/tmp/opencode/rs-e2e-alice.png" });
await browser.close();
await app.stop();
rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
