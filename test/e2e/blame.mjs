// End-to-end: line authors in the editor's margin. Two people (and a guest) type on different lines and see each
// other's names; a name isn't repeated on following lines by the same author (code lines included); headings show
// none; the Authors toggle hides them (remembered); a narrow window hides them; the demo folder shows Git blame.
// Usage: bun run build:client && bun test/e2e/blame.mjs   (screenshots in /tmp/opencode/blame/)
// Needs playwright-core in /tmp/opencode/pw and the Playwright Chromium headless shell.
import "../local-storage.ts";
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHOTS = "/tmp/opencode/blame";
mkdirSync(SHOTS, { recursive: true });
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "np-e2e-blame-"));
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(name, path) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 820 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[${name ?? "guest"}] PAGEERROR`, e.message));
  page.on("console", (m) => m.type() === "error" && console.log(`[${name ?? "guest"}] CONSOLE`, m.text()));
  if (name) {
    await page.goto(base + "/auth/dev?next=/app");
    await page.fill("input[name=name]", name);
    await page.click("form button[type=submit], form button");
    await page.waitForURL(/\/app\//, { timeout: 10000 });
  }
  if (path) await page.goto(base + path);
  await page.waitForSelector(".mde .ln", { timeout: 10000 });
  return page;
}

/** The names in the margin: [line index, full name]. */
const marks = (page) => page.evaluate(() => [...document.querySelectorAll(".mde-authors .mde-author")].map((e) => [Number(e.dataset.line), e.title]));
async function waitMarks(page, want, ms = 5000) {
  const end = Date.now() + ms;
  let got;
  while (Date.now() < end) {
    got = await marks(page);
    if (JSON.stringify(got) === JSON.stringify(want)) return got;
    await sleep(100);
  }
  return got;
}
async function typeAt(page, line, text) {
  await page.click(`.mde .ln >> nth=${line}`);
  await page.keyboard.press("End");
  await page.keyboard.type(text);
}

const alice = await open("Alice");
const created = await alice.evaluate(async () => {
  const r = await fetch("/api/repos/notes/files", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "Blame.md", content: "# Blame test\n\nSeed paragraph one\nSeed paragraph two\n\n```\ncode a\n```\n" }),
  });
  return r.status;
});
check("note created (committed by Alice)", created === 201 || created === 200, String(created));
await alice.goto(`${base}/app/notes/Blame.md`);
await alice.waitForFunction(() => document.querySelector(".mde")?.textContent?.includes("Seed paragraph two"), null, { timeout: 10000 });
const bob = await open("Bob", "/app/notes/Blame.md");
await bob.waitForFunction(() => document.querySelector(".mde")?.textContent?.includes("Seed paragraph two"), null, { timeout: 10000 });

// Git blame: Alice wrote everything; her name shows once, on the first paragraph (not on the heading or the code)
let got = await waitMarks(bob, [[2, "Alice"]]);
check("Git blame: Alice's name once, on the first text line (heading, same-author lines and code skipped)", JSON.stringify(got) === JSON.stringify([[2, "Alice"]]), JSON.stringify(got));
const look = await bob.evaluate(() => {
  const el = document.querySelector(".mde-authors .mde-author");
  const text = document.querySelector(".mde .mde-content").getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return { right: r.right, textLeft: text.left + parseFloat(getComputedStyle(document.querySelector(".mde .mde-content")).paddingLeft), dot: !!el.querySelector(".dot"), size: getComputedStyle(el).fontSize };
});
check("the name sits in the left margin, small, with a colour dot", look.right <= look.textLeft && look.dot && look.size === "11px", JSON.stringify(look));

// Bob types on line 3: everyone sees his name there; Alice's above stays, and her code line now differs from the
// last name shown, so it shows hers again
const three = [[2, "Alice"], [3, "Bob"], [6, "Alice"]];
await typeAt(bob, 3, " (Bob was here)");
got = await waitMarks(bob, three, 1000);
check("Bob sees his own name at once", JSON.stringify(got) === JSON.stringify(three), JSON.stringify(got));
got = await waitMarks(alice, three);
check("Alice sees Bob's name on his line", JSON.stringify(got) === JSON.stringify(three), JSON.stringify(got));

// Bob edits the code line too: still Bob since his last shown name (empty line and fence in between) → not repeated
await typeAt(bob, 6, " // bob");
await sleep(1600);
got = await waitMarks(alice, [[2, "Alice"], [3, "Bob"]]);
check("Bob's code line doesn't repeat his name", JSON.stringify(got) === JSON.stringify([[2, "Alice"], [3, "Bob"]]), JSON.stringify(got));

// Bob edits the heading: headings never show a name
await typeAt(bob, 0, " (by Bob)");
await sleep(1600);
got = await waitMarks(alice, [[2, "Alice"], [3, "Bob"]]);
check("a heading Bob edited shows no name", JSON.stringify(got) === JSON.stringify([[2, "Alice"], [3, "Bob"]]), JSON.stringify(got));

// Alice edits the code line: now it shows her (different from the last shown, Bob)
await typeAt(alice, 6, " /* alice */");
got = await waitMarks(bob, [[2, "Alice"], [3, "Bob"], [6, "Alice"]]);
check("a code line shows its author when it changes", JSON.stringify(got) === JSON.stringify([[2, "Alice"], [3, "Bob"], [6, "Alice"]]), JSON.stringify(got));

// a guest adds a paragraph at the end
const guest = await open(null, "/app/notes/Blame.md");
await guest.waitForFunction(() => document.querySelector(".mde")?.textContent?.includes("alice"), null, { timeout: 10000 });
const guestName = await guest.evaluate(() => JSON.parse(localStorage.getItem("grimoire.anon.v1")).name);
await guest.click(".mde .ln >> nth=8");
await guest.keyboard.type("A guest's line");
got = await waitMarks(alice, [[2, "Alice"], [3, "Bob"], [6, "Alice"], [8, guestName]]);
check("a guest's line shows the guest's name", JSON.stringify(got) === JSON.stringify([[2, "Alice"], [3, "Bob"], [6, "Alice"], [8, guestName]]), JSON.stringify(got));
await alice.screenshot({ path: `${SHOTS}/margin-alice.png` });
await bob.screenshot({ path: `${SHOTS}/margin-bob.png` });
await alice.hover(".mde-authors .mde-author >> nth=1");
await sleep(200);
await alice.screenshot({ path: `${SHOTS}/margin-hover.png`, clip: { x: 0, y: 0, width: 1400, height: 420 } });

// Enter at the end of Alice's paragraph and typing there: Alice's own new line follows hers (no repeat), and
// the names below move down with their lines at once
await alice.click(".mde .ln >> nth=2");
await alice.keyboard.press("End");
await alice.keyboard.press("Enter");
await alice.keyboard.type("Alice's second paragraph");
got = await marks(alice);
check("own new line: no repeated name, the rest moved down at once", JSON.stringify(got) === JSON.stringify([[2, "Alice"], [4, "Bob"], [7, "Alice"], [9, guestName]]), JSON.stringify(got));
got = await waitMarks(bob, [[2, "Alice"], [4, "Bob"], [7, "Alice"], [9, guestName]]);
check("…and the same for Bob", JSON.stringify(got) === JSON.stringify([[2, "Alice"], [4, "Bob"], [7, "Alice"], [9, guestName]]), JSON.stringify(got));

// the toggle hides them, remembered after a reload
const btn = await bob.$(".authors-btn");
check("an Authors toggle next to History, on", !!btn && (await btn.getAttribute("aria-pressed")) === "true");
await bob.click(".authors-btn");
const hidden = await bob.evaluate(() => getComputedStyle(document.querySelector(".mde-authors")).display === "none" && document.querySelector(".authors-btn").getAttribute("aria-pressed") === "false");
check("toggled off: the names are hidden", hidden);
await bob.screenshot({ path: `${SHOTS}/toggle-off.png` });
await bob.reload();
await bob.waitForSelector(".mde .ln", { timeout: 10000 });
await sleep(800);
check("still off after a reload", await bob.evaluate(() => getComputedStyle(document.querySelector(".mde-authors")).display === "none"));
await bob.click(".authors-btn");
got = await waitMarks(bob, [[2, "Alice"], [4, "Bob"], [7, "Alice"], [9, guestName]]);
check("on again", got.length === 4, JSON.stringify(got));

// too narrow for the margin: hidden
await bob.setViewportSize({ width: 760, height: 820 });
await sleep(500);
got = await marks(bob);
check("a narrow window shows no names", got.length === 0, JSON.stringify(got));
await bob.screenshot({ path: `${SHOTS}/narrow.png` });

// the demo folder (memory store): Git blame of its seed, for a guest
await guest.goto(`${base}/app/demo`);
await guest.waitForSelector(".mde .ln", { timeout: 10000 });
got = await waitMarks(guest, null, 4000);
check("demo note: names from its Git history", got.length >= 1 && got.every(([, n]) => n === "Grimoire"), JSON.stringify(got));
await guest.screenshot({ path: `${SHOTS}/demo.png` });

await browser.close();
await app.stop();
rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : "all ok");
process.exit(fails ? 1 : 0);
