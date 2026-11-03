// End-to-end: undo gives a line back to its previous author, and review mode. An agent writes a line; Alice types
// into it (hers); Ctrl/Cmd+Z (the agent's again: margin name, and no commit for the original text); redo (hers);
// typing it back as it was (the agent's); undone after a save (the commit putting it back is the agent's). Review
// mode (the header's toggle): only Alice's own edits since it was turned on are tinted; an agent's edit or rewrite
// isn't; undo ends a highlight; a reload keeps it; off clears it; on again starts fresh.
// Usage: bun run build:client && bun test/e2e/review.mjs   (screenshots in /tmp/opencode/review/)
// Needs playwright-core in /tmp/opencode/pw and the Playwright Chromium headless shell.
import "../local-storage.ts";
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { mkdirSync } from "node:fs";
import { startTarget } from "./target.mjs";

const SHOTS = process.env.SHOTS || "/tmp/opencode/review";
mkdirSync(SHOTS, { recursive: true });
const T = await startTarget({ env: { QUIET_MS: "1500" } });
const base = T.base;
let WS = T.ws;
const NOTE = "Undo.md";

const browser = await chromium.launch({
  executablePath: "/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell",
});
let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(ok ? "ok  " : "FAIL", name, ok ? "" : detail);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MOD = "Control";

const ctx = await browser.newContext({ viewport: { width: 1400, height: 820 } });
await ctx.addInitScript((ws) => (globalThis.WS = ws), WS);
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
page.on("console", (m) => m.type() === "error" && console.log("CONSOLE", m.text()));
await page.goto(`${base}/auth/dev?next=${T.appPath}`);
await page.fill("input[name=name]", "Alice");
await page.click("form button[type=submit], form button");
await page.waitForURL(/\/app\//, { timeout: 10000 });
// a workspace of Alice's own (Bun's default notebook may not exist)
WS = await page.evaluate(async () => (await (await fetch("/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Review" }) })).json()).id);
const created = await page.evaluate(async ([ws, note]) => {
  const r = await fetch(`/api/workspace/${ws}/files`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: note, content: "# Undo test\n\nAlice's first line\n" }) });
  return r.status;
}, [WS, NOTE]);
check("note created", created === 201 || created === 200, String(created));
await T.save(WS, NOTE);

/** An agent's command on the workspace URL. */
async function agent(command) {
  const r = await fetch(`${base}/app/${WS}`, { method: "POST", body: command });
  const out = r.ok ? await r.json() : null;
  if (!out || out.exitCode !== 0) throw new Error(`agent \`${command}\`: ${JSON.stringify(out)}`);
}
// (two lines, so one stays the agent's and the margin keeps two authors)
await agent(`printf "The agent's line.\\nThe agent's second line.\\n" >> ${NOTE}`);
await T.save(WS, NOTE);

await page.goto(`${base}/app/${WS}/${NOTE}`);
await page.waitForFunction(() => document.querySelector(".mde")?.textContent?.includes("The agent's line."), null, { timeout: 10000 });
await page.waitForFunction(() => !!document.querySelector(".mde")?.mdeView?.collab?.blame, null, { timeout: 5000 });

const marks = () => page.evaluate(() => [...document.querySelectorAll(".mde-authors .mde-author")].map((e) => [Number(e.dataset.line), e.textContent]));
const lineOf = (text) => page.evaluate((t) => [...document.querySelectorAll(".mde .mde-content .ln")].findIndex((l) => l.textContent.includes(t)), text);
/** The author the page has for the line holding `text` (as the margin labels it; the margin shows a name only where it changes). */
const nameAt = (text) =>
  page.evaluate((t) => {
    const i = [...document.querySelectorAll(".mde .mde-content .ln")].findIndex((l) => l.textContent.includes(t));
    const g = document.querySelector(".mde").mdeView.authors;
    const a = g.authors[g.values[i]];
    return a ? (a.kind === "agent" ? a.sessionName || "Agent" : a.name) : null;
  }, text);
async function waitName(text, want, ms = 4000) {
  const end = Date.now() + ms;
  let got;
  while (Date.now() < end) {
    got = await nameAt(text);
    if (got === want) return got;
    await sleep(50);
  }
  return got;
}
/** Over `ms`, the names a line showed (sampled): to catch a flicker. */
async function namesOver(text, ms) {
  const seen = new Set();
  const end = Date.now() + ms;
  while (Date.now() < end) {
    seen.add(await nameAt(text));
    await sleep(40);
  }
  return [...seen];
}
async function endOf(text) {
  await page.click(`.mde .ln >> nth=${await lineOf(text)}`);
  await page.keyboard.press("End");
}
const commits = async () => (await T.history(WS, NOTE, 50)).length;

// ---- undo gives the line back
check("agent's line: the agent's (Git blame)", (await waitName("The agent's line.", "Agent")) === "Agent", JSON.stringify(await marks()));
const before = await commits();
await endOf("The agent's line.");
await page.keyboard.type(" Alice adds");
check("typing into it: Alice's at once", (await waitName("Alice adds", "Alice", 500)) === "Alice", JSON.stringify(await marks()));
await page.screenshot({ path: `${SHOTS}/1-typed.png` });
await page.keyboard.press(`${MOD}+z`);
check("undo: the agent's at once", (await waitName("The agent's line.", "Agent", 300)) === "Agent", JSON.stringify(await marks()));
const after = await namesOver("The agent's line.", 2200);
check("…and stays the agent's after the server's next message (no flicker)", JSON.stringify(after) === JSON.stringify(["Agent"]), JSON.stringify(after));
await page.screenshot({ path: `${SHOTS}/2-undone.png` });
await sleep(1500);
check("the delayed save after the undo makes no commit", (await commits()) === before, `${before} → ${await commits()}`);
await page.keyboard.press(`${MOD}+Shift+z`);
check("redo: Alice's again", (await waitName("Alice adds", "Alice", 500)) === "Alice", JSON.stringify(await marks()));
await page.keyboard.press(`${MOD}+z`);
await waitName("The agent's line.", "Agent", 500);

// typed back as it was
await endOf("The agent's line.");
await page.keyboard.type(" xy");
check("typed in: Alice's", (await waitName("xy", "Alice", 500)) === "Alice");
await page.keyboard.press("Backspace");
await page.keyboard.press("Backspace");
await page.keyboard.press("Backspace");
check("typed back to the agent's text: the agent's", (await waitName("The agent's line.", "Agent", 300)) === "Agent", JSON.stringify(await marks()));
check("…and stays (server agrees)", JSON.stringify(await namesOver("The agent's line.", 1800)) === JSON.stringify(["Agent"]));

// saved with Alice's words, then undone: the agent's commit
await endOf("The agent's line.");
await page.keyboard.type(" saved");
await sleep(2600);
const saved = await commits();
check("Alice's words saved", saved === before + 1, `${before} → ${saved}`);
await page.keyboard.press(`${MOD}+z`);
await sleep(2600);
const hist = await T.history(WS, NOTE, 5);
console.log("     last commit:", JSON.stringify(hist[0]));
check("undo after a save: one more commit, the agent's (Git blame stays the agent's)", hist.length === saved + 1 && /agents\.grimoire/i.test(JSON.stringify(hist[0])), JSON.stringify(hist[0]));
check("…and the line is still the agent's", (await waitName("The agent's line.", "Agent", 1500)) === "Agent", JSON.stringify(await marks()));

// ---- review mode
const tinted = () =>
  page.evaluate(() => {
    const lines = [...document.querySelectorAll(".mde .mde-content .ln")];
    const tints = [...document.querySelectorAll(".mde-tints .mde-tint")].map((t) => t.getBoundingClientRect());
    return lines.map((l, i) => [i, l.getBoundingClientRect()]).filter(([, r]) => tints.some((t) => r.top + 2 >= t.top && r.bottom - 2 <= t.bottom)).map(([i]) => lines[i].textContent);
  });
async function waitTinted(want, ms = 3000) {
  const end = Date.now() + ms;
  let got;
  while (Date.now() < end) {
    got = await tinted();
    if (JSON.stringify(got) === JSON.stringify(want)) return got;
    await sleep(60);
  }
  return got;
}
const toggle = () => page.evaluate(() => {
  const b = document.querySelector(".review-toggle");
  return b && !b.hidden ? { on: b.getAttribute("aria-pressed") === "true", label: b.textContent } : null;
});
check("no tint without review mode, though an agent made lines and Alice edited", (await tinted()).length === 0, JSON.stringify(await tinted()));
check("the review toggle is in the header, off", JSON.stringify(await toggle()) === JSON.stringify({ on: false, label: "Review" }), JSON.stringify(await toggle()));
await page.click(".review-toggle");
check("on: no highlights yet", (await waitTinted([], 500)).length === 0 && (await toggle()).on === true);
await endOf("Alice's first line");
await page.keyboard.type(" (edited)");
await page.keyboard.press("Enter");
await page.keyboard.type("A new line by Alice");
let got = await waitTinted(["Alice's first line (edited)", "A new line by Alice"], 800);
check("Alice's edits are highlighted at once", JSON.stringify(got) === JSON.stringify(["Alice's first line (edited)", "A new line by Alice"]), JSON.stringify(got));
check("the toggle counts them", (await toggle()).label === "Review · 2 edits", JSON.stringify(await toggle()));
await page.screenshot({ path: `${SHOTS}/3-review.png` });
await agent(`echo "Another agent line." >> ${NOTE}`);
await page.waitForFunction(() => document.querySelector(".mde")?.textContent?.includes("Another agent line."), null, { timeout: 5000 });
await sleep(1500);
got = await tinted();
check("an agent's edit elsewhere isn't highlighted", JSON.stringify(got) === JSON.stringify(["Alice's first line (edited)", "A new line by Alice"]), JSON.stringify(got));
await agent(`sed -i 's/A new line by Alice/The agent rewrote this/' ${NOTE}`);
got = await waitTinted(["Alice's first line (edited)"], 3000);
check("an agent rewrites one of Alice's lines: its highlight goes", JSON.stringify(got) === JSON.stringify(["Alice's first line (edited)"]), JSON.stringify(got));
await endOf("Alice's first line (edited)");
await page.keyboard.type("!");
await page.keyboard.press("Backspace");
for (let i = 0; i < " (edited)".length; i++) await page.keyboard.press("Backspace");
got = await waitTinted([], 800);
check("typed back to the baseline: no highlight", got.length === 0, JSON.stringify(got));
await endOf("Alice's first line");
await page.keyboard.type(" again");
await waitTinted(["Alice's first line again"], 800);
await page.keyboard.press(`${MOD}+z`);
got = await waitTinted([], 800);
check("undo of Alice's edit: its highlight goes", got.length === 0, JSON.stringify(got));
await page.keyboard.press(`${MOD}+Shift+z`);
got = await waitTinted(["Alice's first line again"], 800);
check("redo: highlighted again", JSON.stringify(got) === JSON.stringify(["Alice's first line again"]), JSON.stringify(got));
await sleep(2500);
await page.reload();
await page.waitForFunction(() => !!document.querySelector(".mde")?.mdeView?.collab?.blame, null, { timeout: 10000 });
got = await waitTinted(["Alice's first line again"], 4000);
check("a reload keeps review mode and its highlights", JSON.stringify(got) === JSON.stringify(["Alice's first line again"]) && (await toggle()).on, JSON.stringify([got, await toggle()]));
await page.screenshot({ path: `${SHOTS}/4-reloaded.png` });
await page.keyboard.press(`${MOD}+Alt+r`);
got = await waitTinted([], 800);
check("off (the shortcut): no highlights", got.length === 0 && (await toggle()).on === false, JSON.stringify([got, await toggle()]));
await page.click(".review-toggle");
got = await waitTinted([], 500);
check("on again: nothing until Alice edits", got.length === 0 && (await toggle()).on === true, JSON.stringify(got));
await endOf("Another agent line.");
await page.keyboard.type(" Alice was here");
got = await waitTinted(["Another agent line. Alice was here"], 800);
check("…then her new edit only", JSON.stringify(got) === JSON.stringify(["Another agent line. Alice was here"]), JSON.stringify(got));
await page.screenshot({ path: `${SHOTS}/5-fresh.png` });
await page.click(".review-toggle");

await browser.close();
await T.stop();
console.log(fails ? `${fails} failed` : "all ok");
process.exit(fails ? 1 : 0);
