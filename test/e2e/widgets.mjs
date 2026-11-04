// End-to-end: inline widgets (`<session id="…" />`) in the web editor. A note with a session widget, an unknown tag and
// a tag in inline code: only the first is a chip; the caret steps over the chip and Backspace / Delete remove the whole
// tag; an agent writing with a session id and name gives the chip its title; a mock SessionInfoSource sets the busy
// states (the shimmer classes, the subagent count and its plural).
// Usage: bun run build:client, a server, then
//   BASE=http://localhost:8787 bun test/e2e/widgets.mjs                       (sign-in off: no account needed)
//   BASE=https://staging.example COOKIE=<np_session value> bun test/e2e/widgets.mjs
// Screenshots in $SHOTS (default /tmp/opencode/widgets/). Needs playwright-core in /tmp/opencode/pw and the
// Playwright Chromium headless shell.
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:8787";
const SHOTS = process.env.SHOTS ?? "/tmp/opencode/widgets";
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({
  executablePath: "/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell",
});
let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(ok ? "ok  " : "FAIL", name, ok ? "" : detail);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 }, deviceScaleFactor: 2 });
if (process.env.COOKIE) await ctx.addCookies([{ name: "np_session", value: process.env.COOKIE, url: BASE }]);
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
page.on("console", (m) => m.type() === "error" && console.log("CONSOLE", m.text()));
await page.goto(BASE + "/app");

const NOTE = [
  "# Session widgets",
  "",
  'Working with <session id="ses_x" /> on this.',
  "",
  "- Unknown tags stay text: <foo /> and <session /> (no id)",
  '- In code: `<session id="a" />` stays literal',
  "- Named by an agent: <session id='ses_named' /> here",
  "",
].join("\n");

const ws = await page.evaluate(async (note) => {
  const r = await fetch("/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Widget test" }) });
  const w = await r.json();
  const f = await fetch(`/api/workspace/${w.id}/files`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "Widgets.md", content: note }) });
  return { id: w.id, status: r.status, file: f.status };
}, NOTE);
check("workspace and note created", ws.status === 201 && (ws.file === 201 || ws.file === 200), JSON.stringify(ws));
console.log("workspace", ws.id);

await page.goto(`${BASE}/app/${ws.id}/Widgets.md`);
await page.waitForFunction(() => document.querySelector(".mde")?.textContent?.includes("Session widgets"), null, { timeout: 15000 });
await sleep(500);

const chips = () => page.evaluate(() => [...document.querySelectorAll(".mde .wchip")].map((c) => ({ id: c.dataset.id, f: c.dataset.f, t: c.dataset.t, title: c.querySelector(".wt")?.dataset.v, count: c.querySelector(".wc")?.dataset.v })));
let got = await chips();
check("two session chips (ses_x, ses_named)", got.length === 2 && got[0].id === "ses_x" && got[1].id === "ses_named", JSON.stringify(got));
check("without data a chip shows the id", got[0]?.title === "ses_x" && got[0]?.count === "", JSON.stringify(got[0]));
// what shows: visible text spans and chips (collapsed markers and a chip's source have no size)
const visible = await page.evaluate(() =>
  [...document.querySelectorAll(".mde .ln")]
    .map((ln) => [...ln.querySelectorAll(".t:not(.ws), .wchip")].map((e) => (e.classList.contains("wchip") ? `[chip ${e.dataset.id}]` : e.textContent)).join(""))
    .join("\n"),
);
check("<foo /> and <session /> stay literal", visible.includes("<foo />") && visible.includes("<session /> (no id)"), visible);
check("the tag in inline code stays literal", visible.includes('<session id="a" />'), visible);
check("chips' source isn't shown", visible.includes("Working with [chip ses_x] on this.") && !visible.includes('<session id="ses_x" />'), visible);
check("the source is in the DOM, collapsed", (await page.locator(".mde .mk.wsrc").first().evaluate((e) => getComputedStyle(e).fontSize)) === "0px");
check("no chip in the code span", (await page.locator(".mde .t.code .wchip, .mde .wchip + .t.code").count()) === 0);
await page.screenshot({ path: `${SHOTS}/1-chips.png`, clip: { x: 0, y: 0, width: 1100, height: 420 } });

// caret: steps over the chip; Backspace after it removes the whole tag
const view = (fn, arg) => page.evaluate(fn, arg);
const text = () => view(() => document.querySelector(".mde").mdeView.engine.text());
const sel = () => view(() => document.querySelector(".mde").mdeView.sel);
const t0 = await text();
const from = t0.indexOf('<session id="ses_x" />');
const to = from + '<session id="ses_x" />'.length;
await page.click(".mde .ln >> nth=2");
await view(([f]) => {
  const v = document.querySelector(".mde").mdeView;
  v.focus();
  v.setSel({ anchor: f, head: f });
}, [from]);
await page.keyboard.press("ArrowRight");
let s = await sel();
check("ArrowRight before the chip jumps past it", s.head === to && s.anchor === to, JSON.stringify(s));
await page.keyboard.press("ArrowLeft");
s = await sel();
check("ArrowLeft after it jumps back before it", s.head === from, JSON.stringify(s));
await page.keyboard.press("ArrowRight");
await page.keyboard.press("Shift+ArrowLeft");
s = await sel();
check("Shift+ArrowLeft selects the whole tag", s.anchor === to && s.head === from, JSON.stringify(s));
check("the chip is drawn selected", (await page.locator(".mde .wchip.insel").count()) === 1);
await page.screenshot({ path: `${SHOTS}/2-selected.png`, clip: { x: 0, y: 0, width: 1100, height: 420 } });
// a click on the chip puts the caret at its nearer edge
const box = await page.locator(".mde .wchip >> nth=0").boundingBox();
await page.mouse.click(box.x + 4, box.y + box.height / 2);
s = await sel();
check("a click on the chip's left half: caret before it", s.head === from && s.anchor === from, JSON.stringify(s));
await page.mouse.click(box.x + box.width - 4, box.y + box.height / 2);
s = await sel();
check("a click on its right half: caret after it", s.head === to && s.anchor === to, JSON.stringify(s));
// the engine's own position from a hit test inside the tag would be snapped too: put the caret inside by hand
await view(([p]) => document.querySelector(".mde").mdeView.setSel({ anchor: p, head: p }), [from + 5]);
s = await sel();
check("a caret set inside the tag moves to an edge", s.head === from || s.head === to, JSON.stringify(s));
await view(([t]) => document.querySelector(".mde").mdeView.setSel({ anchor: t, head: t }), [to]);
await page.keyboard.press("Backspace");
let t1 = await text();
check("Backspace after the chip deletes the whole tag", t1 === t0.slice(0, from) + t0.slice(to), JSON.stringify(t1.split("\n")[2]));
check("its chip is gone", (await chips()).length === 1);
await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
t1 = await text();
check("undo brings it back", t1 === t0 && (await chips()).length === 2, JSON.stringify(t1.split("\n")[2]));
await view(([f]) => document.querySelector(".mde").mdeView.setSel({ anchor: f, head: f }), [from]);
await page.keyboard.press("Delete");
t1 = await text();
check("Delete before the chip deletes the whole tag", t1 === t0.slice(0, from) + t0.slice(to), JSON.stringify(t1.split("\n")[2]));
await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
check("undo again", (await text()) === t0);

// typing a tag makes a chip once it's complete
await view(() => {
  const v = document.querySelector(".mde").mdeView;
  const end = v.engine.text().length;
  v.setSel({ anchor: end, head: end });
});
await page.keyboard.type('Typed <session id="ses_typed" />');
got = await chips();
check("a typed tag becomes a chip", got.some((c) => c.id === "ses_typed"), JSON.stringify(got));
s = await sel();
check("the caret is after the typed chip", s.head === (await text()).length, JSON.stringify(s));

// an agent session writing to the note: its title is known (line authors / presence)
const agent = async (command) => {
  const r = await fetch(`${BASE}/app/${ws.id}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agent-name": "Claude", ...(process.env.AGENT_TOKEN ? { authorization: `Bearer ${process.env.AGENT_TOKEN}` } : {}) },
    body: JSON.stringify({ command, session_id: "ses_named", session_name: "Fix the flaky login test in the auth service and its retries" }),
  });
  return r.json();
};
await agent("cat Widgets.md > /dev/null");
const w = await agent("printf '\\nWritten by the agent session.\\n' >> Widgets.md");
check("the agent wrote", w.exitCode === 0, JSON.stringify(w));
await page.waitForFunction(() => document.querySelector('.mde .wchip[data-id="ses_named"]')?.classList.contains("known"), null, { timeout: 10000 }).catch(() => {});
got = await chips();
const named = got.find((c) => c.id === "ses_named");
check("the agent's session title shows (cut with …)", named?.title?.startsWith("Fix the flaky login test") && named.title.endsWith("…"), JSON.stringify(named));
await page.screenshot({ path: `${SHOTS}/3-known-title.png`, clip: { x: 0, y: 0, width: 1100, height: 460 } });

// a mock source: busy states
const mock = (info) =>
  view((info) => {
    const listeners = new Set();
    window.grimWidgets.setSessionSource({
      get: (id) => (id === "ses_x" ? { id, ...info } : undefined),
      subscribe: (l) => (listeners.add(l), () => listeners.delete(l)),
    });
  }, info);
const state = () =>
  view(() => {
    const c = document.querySelector('.mde .wchip[data-id="ses_x"]');
    return { title: c.querySelector(".wt").dataset.v, count: c.querySelector(".wc").dataset.v, titleBusy: c.querySelector(".wt").classList.contains("busy"), countBusy: c.querySelector(".wc").classList.contains("busy"), anim: getComputedStyle(c.querySelector(".wt")).animationName, clip: getComputedStyle(c.querySelector(".wt")).backgroundClip };
  });
await mock({ title: "Refactor the sync engine", busy: true, subagents: 3, subagentsBusy: true });
let st = await state();
check("busy session: title shimmers", st.titleBusy && st.anim === "mde-shimmer" && st.clip === "text", JSON.stringify(st));
check("busy subagents: count shimmers, plural", st.countBusy && st.count === " · 3 subagents", JSON.stringify(st));
await page.screenshot({ path: `${SHOTS}/4-busy.png`, clip: { x: 0, y: 0, width: 1100, height: 460 } });
for (const ms of [0, 450, 900]) {
  await sleep(ms ? 450 : 0);
  await page.locator('.mde .wchip[data-id="ses_x"]').screenshot({ path: `${SHOTS}/4-busy-chip-${ms}ms.png` });
}
await mock({ title: "Refactor the sync engine", busy: false, subagents: 1, subagentsBusy: true });
st = await state();
check("idle session, busy subagent: only the count shimmers, singular", !st.titleBusy && st.countBusy && st.count === " · 1 subagent", JSON.stringify(st));
await page.screenshot({ path: `${SHOTS}/5-subagent-busy.png`, clip: { x: 0, y: 0, width: 1100, height: 460 } });
await mock({ title: "Refactor the sync engine", busy: false, subagents: 0 });
st = await state();
check("no subagents: no count, no shimmer", !st.titleBusy && !st.countBusy && st.count === "", JSON.stringify(st));
await page.emulateMedia({ reducedMotion: "reduce" });
await mock({ title: "Refactor the sync engine", busy: true, subagents: 2, subagentsBusy: true });
st = await state();
check("reduced motion: busy without animation", st.titleBusy && st.anim === "none", JSON.stringify(st));
await page.screenshot({ path: `${SHOTS}/6-reduced-motion.png`, clip: { x: 0, y: 0, width: 1100, height: 460 } });
await page.emulateMedia({ reducedMotion: "no-preference" });
await view(() => window.grimWidgets.setSessionSource(null));
st = await state();
check("back to Grim's source: the id again", st.title === "ses_x" && !st.titleBusy, JSON.stringify(st));

// read-only (a guest page or history preview uses the same renderer): a fresh page, the chip is there
const ro = await ctx.newPage();
await ro.goto(`${BASE}/app/${ws.id}/Widgets.md`);
await ro.waitForSelector(".mde .wchip", { timeout: 15000 });
check("a reload draws the chips", (await ro.locator(".mde .wchip").count()) >= 2);
await ro.close();

if (process.env.KEEP !== "1") {
  const del = await page.evaluate(async (id) => (await fetch(`/api/workspace/${id}`, { method: "DELETE" })).status, ws.id);
  console.log("workspace removed:", del);
}
await browser.close();
console.log(fails ? `${fails} FAILED` : "all ok");
process.exit(fails ? 1 : 0);
