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

/** The names in the margin: [line index, name as shown]. */
const marks = (page) => page.evaluate(() => [...document.querySelectorAll(".mde-authors .mde-author")].map((e) => [Number(e.dataset.line), e.textContent]));
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

// Git blame: Alice wrote everything; a note with one author shows no names at all
await bob.waitForFunction(() => !!document.querySelector(".mde")?.mdeView?.collab?.blame, null, { timeout: 5000 });
await sleep(300);
let got = await marks(bob);
check("one author (Git blame: all Alice): no names", got.length === 0, JSON.stringify(got));

// Bob types on line 3: a second author, so names appear (his own guess at once): Alice on the first paragraph,
// Bob on his, and Alice's code line again (it differs from the last name shown)
const three = [[2, "Alice"], [3, "Bob"], [6, "Alice"]];
await typeAt(bob, 3, " (Bob was here)");
got = await waitMarks(bob, three, 1000);
check("Bob's first keystroke makes the names appear for him at once", JSON.stringify(got) === JSON.stringify(three), JSON.stringify(got));
got = await waitMarks(alice, three);
check("…and for Alice", JSON.stringify(got) === JSON.stringify(three), JSON.stringify(got));

/** Where the names sit: their left edges against the editor pane's, and their baselines against their lines'. */
const placement = (page) =>
  page.evaluate(() => {
    const pane = document.querySelector(".doc-body").getBoundingClientRect();
    const sidebar = document.querySelector(".sidebar")?.getBoundingClientRect();
    const content = document.querySelector(".mde .mde-content");
    const textLeft = content.getBoundingClientRect().left + parseFloat(getComputedStyle(content).paddingLeft);
    const baseline = (box) => {
      const probe = document.createElement("span");
      probe.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
      box.appendChild(probe);
      const y = probe.getBoundingClientRect().bottom;
      probe.remove();
      return y;
    };
    const lines = document.querySelectorAll(".mde .mde-content > .ln");
    return [...document.querySelectorAll(".mde-authors .mde-author")].map((el) => {
      const r = el.getBoundingClientRect();
      const nm = el.querySelector(".nm");
      const nameBase = baseline(el);
      // (the line is re-rendered from the engine after the probe: the editor repairs DOM it didn't make)
      const lineBox = lines[Number(el.dataset.line)].querySelector(".tcell") ?? lines[Number(el.dataset.line)];
      const lineBase = baseline(lineBox);
      return {
        left: Math.round(r.left - pane.left),
        sidebarGap: sidebar && sidebar.width ? Math.round(r.left - sidebar.right) : null,
        fitsMargin: nm.getBoundingClientRect().right <= textLeft && r.right <= textLeft,
        baselineOff: Math.round((nameBase - lineBase) * 10) / 10,
        size: getComputedStyle(nm).fontSize,
        dots: el.querySelectorAll(".dot").length,
      };
    });
  });
let place = await placement(bob);
check(
  "names at the pane's left edge + 16px (the sidebar's right edge), clear of the text, 11px, no dots",
  place.length === 3 && place.every((p) => p.left === 16 && p.sidebarGap === 16 && p.fitsMargin && p.size === "11px" && p.dots === 0),
  JSON.stringify(place),
);
check("each name on its line's baseline (paragraphs and code)", place.every((p) => Math.abs(p.baselineOff) <= 1), JSON.stringify(place));
await sleep(300);

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
// no author colours anywhere: every name in the same muted grey, nothing coloured inside
const colours = await alice.evaluate(() => [...document.querySelectorAll(".mde-authors .mde-author")].map((e) => [getComputedStyle(e).color, e.querySelectorAll("[style]").length]));
check("all names in the same muted grey, no coloured parts", colours.length === 4 && colours.every(([c, styled]) => c === "rgb(154, 154, 161)" && styled === 0), JSON.stringify(colours));
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

// a sidebar collapsed out of the way: names start at the window's left edge + 16px
await bob.setViewportSize({ width: 1400, height: 820 });
await bob.evaluate(() => {
  // (what the phone layout does: the sidebar leaves the grid)
  document.querySelector(".app").style.gridTemplateColumns = "minmax(0, 1fr) auto";
  document.querySelector(".sidebar").style.display = "none";
});
await sleep(600);
place = await bob.evaluate(() => [...document.querySelectorAll(".mde-authors .mde-author")].map((e) => Math.round(e.getBoundingClientRect().left)));
check("sidebar collapsed: names at the window's left edge + 16px", place.length === 4 && place.every((x) => x === 16), JSON.stringify(place));
await bob.screenshot({ path: `${SHOTS}/no-sidebar.png` });

// back to one author: Bob's only line is deleted, so the names go away (for him at once, then for Alice)
const solo = await alice.evaluate(() =>
  fetch("/api/repos/notes/files", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "Solo.md", content: "Alone one\nAlone two" }) }).then((r) => r.status),
);
check("second note created by Alice", solo === 201 || solo === 200, String(solo));
await alice.goto(`${base}/app/notes/Solo.md`);
await bob.goto(`${base}/app/notes/Solo.md`);
for (const p of [alice, bob]) await p.waitForFunction(() => document.querySelector(".mde")?.textContent?.includes("Alone two") && !!document.querySelector(".mde")?.mdeView?.collab?.blame, null, { timeout: 10000 });
check("Solo note (one author): no names", (await marks(alice)).length === 0 && (await marks(bob)).length === 0);
await bob.click(".mde .ln >> nth=1");
await bob.keyboard.press("End");
await bob.keyboard.press("Enter");
await bob.keyboard.type("Bob's line");
got = await waitMarks(alice, [[0, "Alice"], [2, "Bob"]]);
check("a second author: names appear", JSON.stringify(got) === JSON.stringify([[0, "Alice"], [2, "Bob"]]), JSON.stringify(got));
await bob.keyboard.press("Shift+Home");
await bob.keyboard.press("Backspace");
await bob.keyboard.press("Backspace");
check("Bob's line deleted: his names go at once", (await waitMarks(bob, [], 1000)).length === 0);
got = await waitMarks(alice, []);
check("…and for Alice, after the room's next message", got.length === 0, JSON.stringify(got));
check("the text is Alice's again", (await alice.evaluate(() => document.querySelector(".mde").mdeView.doc.text)) === "Alone one\nAlone two");

// names are never cut: a long name shows whole where it fits, and not at all where it doesn't
const longName = "Bartholomew Montgomery-Smythe";
const barth = await open(longName, "/app/notes/Solo.md");
await barth.waitForFunction(() => document.querySelector(".mde")?.textContent?.includes("Alone two"), null, { timeout: 10000 });
await bob.click(".mde .ln >> nth=1");
await bob.keyboard.press("End");
await bob.keyboard.press("Enter");
await bob.keyboard.type("Bob again");
await sleep(300);
await barth.click(".mde .ln >> nth=2");
await barth.keyboard.press("End");
await barth.keyboard.press("Enter");
await barth.keyboard.type("A line by someone with a long name");
const full = [[0, "Alice"], [2, "Bob"], [3, longName]];
got = await waitMarks(alice, full);
check("a long name shows whole (no ellipsis, no clipping, no tooltip)", JSON.stringify(got) === JSON.stringify(full), JSON.stringify(got));
const whole = await alice.evaluate(() =>
  [...document.querySelectorAll(".mde-authors .mde-author")].map((e) => {
    const cs = getComputedStyle(e);
    return { text: e.textContent, title: e.getAttribute("title"), clipped: e.scrollWidth > e.clientWidth + 1, overflow: cs.overflow, ellipsis: cs.textOverflow, maxWidth: cs.maxWidth };
  }),
);
check("…rendered in full: no title, no overflow clipping, no text-overflow, no max width", whole.every((w) => !w.text.includes("…") && w.title === null && !w.clipped && w.overflow === "visible" && w.ellipsis === "clip" && w.maxWidth === "none"), JSON.stringify(whole));
await alice.screenshot({ path: `${SHOTS}/long-name.png` });
// a margin of about 60px: the short names still show, the long one is hidden (not cut)
await alice.setViewportSize({ width: 1110, height: 820 });
got = await waitMarks(alice, [[0, "Alice"], [2, "Bob"]], 3000);
check("a narrower window: short names stay, the long name is hidden rather than cut", JSON.stringify(got) === JSON.stringify([[0, "Alice"], [2, "Bob"]]), JSON.stringify(got));
const fits = await alice.evaluate(() => {
  const c = document.querySelector(".mde .mde-content");
  const textLeft = c.getBoundingClientRect().left + parseFloat(getComputedStyle(c).paddingLeft);
  return [...document.querySelectorAll(".mde-authors .nm")].every((n) => n.getBoundingClientRect().right <= textLeft);
});
check("…and the names shown end before the text column", fits);
await alice.screenshot({ path: `${SHOTS}/narrower-long-hidden.png` });
await alice.setViewportSize({ width: 1400, height: 820 });

// the demo folder (memory store): its seed has one author in Git, so no names until someone else edits
await guest.goto(`${base}/app/demo`);
await guest.waitForFunction(() => !!document.querySelector(".mde")?.mdeView?.collab?.blame, null, { timeout: 10000 });
await sleep(300);
got = await marks(guest);
check("demo note (one author in its history): no names", got.length === 0, JSON.stringify(got));
await guest.click(".mde .ln >> nth=2");
await guest.keyboard.press("End");
await guest.keyboard.type(" (a guest was here)");
got = await waitMarks(guest, null, 1500);
check("…until the guest types: Grimoire's and the guest's names", got.some(([, n]) => n === "Grimoire") && got.some(([, n]) => n === guestName), JSON.stringify(got));
await guest.screenshot({ path: `${SHOTS}/demo.png` });

await browser.close();
await app.stop();
rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : "all ok");
process.exit(fails ? 1 : 0);
