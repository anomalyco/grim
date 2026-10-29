// End-to-end: the first load shows exactly two things: the HTML's splash (from the first frame), then the complete
// app in one frame (sidebar with the tree, header, the note's text), never a part of it (a tree without a note, a
// header without a sidebar, an empty state or a "Loading…" before the data). Sampled every animation frame from
// before the page parses, on a slowed-down network: a signed-out guest (/app, and the demo), a signed-in person
// (/app → their workspace's last note) and a direct note URL. Also: switching workspaces keeps the old view until
// the new one is complete, and a slow request shows the app after the cap (3 s) with quiet placeholders.
// The owner's recording (staging, 2026-10-28): homepage → "View the notes" → the demo went through a "Loading…" page,
// a sidebar saying "No workspace", "No workspaces yet." + "New workspace", the tree without the note, "Connecting…",
// the note without its image, then the image pushing the text down. That flow is the first case here.
// Prints the time to the full app (performance mark "grimoire:app") per case.
// Usage: bun run build:client && bun test/e2e/first-load.mjs
//        BASE_URL=https://staging.grimnotes.app bun test/e2e/first-load.mjs   (read-only: only the guest cases)
// Needs playwright-core in /tmp/opencode/pw and the Playwright Chromium headless shell.
import "../local-storage.ts";
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { startTarget } from "./target.mjs";

// against a deployed server only the guest cases run (nothing is written there)
const remote = process.env.BASE_URL?.replace(/\/$/, "");
const T = remote ? null : await startTarget();
const base = remote ?? T.base;
const WS = T?.ws;

const browser = await chromium.launch({
  executablePath: "/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell",
});
let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(ok ? "ok  " : "FAIL", name, ok ? "" : detail);
};

// Each frame: "splash" while the HTML's splash covers the page; "app" when the whole first view is there; else
// what's partial about it. Also the first text line's box (a layout jump after the reveal would move it).
const SAMPLER = `(() => {
  const out = (window.__phases = []);
  let last = "";
  const q = (s) => document.querySelector(s);
  const shown = (el) => !!el && !el.hidden && el.getClientRects().length > 0;
  function phase() {
    if (!document.body) return "no-body";
    if (q("#splash")) return "splash";
    const missing = [];
    if (!shown(q(".sidebar"))) missing.push("no sidebar");
    const title = q(".ws-switcher .ws-title")?.textContent ?? "";
    if (!title || title === "No workspace") missing.push("switcher: " + title);
    if (!document.querySelector(".sb-tree [role=treeitem]")) missing.push("no tree rows");
    if (!document.querySelector(".sb-tree .file-row.active")) missing.push("no open row");
    if (q(".sb-tree .tree-note, .sb-tree .sb-empty")) missing.push("tree note: " + q(".sb-tree .tree-note, .sb-tree .sb-empty").textContent);
    if (!shown(q(".doc-header")) || !q(".breadcrumb .crumb-file")) missing.push("no header");
    if (!q(".doc-body .mde .ln")) missing.push("no note text");
    if (q(".doc-body .note-pending")) missing.push("note pending");
    if (q(".empty-state")) missing.push("empty state: " + q(".empty-state").textContent.slice(0, 40));
    if (!shown(q(".sb-account"))) missing.push("no account row");
    if (q(".fatal")) missing.push("fatal");
    if (/Connecting/.test(q(".save-status")?.textContent ?? "")) missing.push("Connecting…");
    if (q(".doc-body .imgbox.loading img:not([height])")) missing.push("an image without its box");
    return missing.length ? "partial: " + missing.join(", ") : "app";
  }
  const tick = () => {
    const p = phase();
    // the first and the last text line (an image arriving late would move the last one)
    const lns = p === "app" ? document.querySelectorAll(".doc-body .mde .ln") : [];
    const at = (el) => { const r = el.getBoundingClientRect(); return Math.round(r.left) + "," + Math.round(r.top) + "," + Math.round(r.width); };
    const box = lns.length ? at(lns[0]) + " " + at(lns[lns.length - 1]) + " n" + lns.length : "";
    const key = p + "|" + box;
    if (key !== last) {
      last = key;
      out.push({ t: Math.round(performance.now()), phase: p, box });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;

async function newPage(storageState) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, storageState });
  await ctx.addInitScript(SAMPLER);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  // a real network's round trips, so the requests' order would show
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 40, downloadThroughput: 20e6 / 8, uploadThroughput: 5e6 / 8 });
  return { ctx, page };
}

const times = [];

/** Cold-load `path` (or run `go` on a fresh page) and check the two phases; resolves once the live editor took over. */
async function firstLoad(name, path, storageState, go) {
  const { ctx, page } = await newPage(storageState);
  if (go) await go(page);
  else await page.goto(base + path, { waitUntil: "commit" });
  // done: the live editor (after the read-only first view, if there was one) and its images, and two more frames
  await page.waitForFunction(() => !document.querySelector("#splash") && !!document.querySelector(".doc-body .editor-host:not(.preview) .mde .ln") && !document.querySelector(".doc-body .imgbox.loading"), null, { polling: "raf", timeout: 15000 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const phases = await page.evaluate(() => window.__phases);
  const mark = await page.evaluate(() => Math.round(performance.getEntriesByName("grimoire:app")[0]?.startTime ?? -1));
  const seq = phases.map((p) => p.phase).filter((p, i, a) => p !== "no-body" && p !== a[i - 1]);
  check(`${name}: splash, then the complete app (nothing in between)`, JSON.stringify(seq) === JSON.stringify(["splash", "app"]), JSON.stringify(phases));
  check(`${name}: the splash is on the first frame`, phases.find((p) => p.phase !== "no-body")?.phase === "splash", JSON.stringify(phases.slice(0, 3)));
  const boxes = new Set(phases.filter((p) => p.phase === "app").map((p) => p.box));
  check(`${name}: the note's text doesn't move once shown (read-only first view → live editor)`, boxes.size === 1, JSON.stringify([...boxes]));
  times.push(`${name}: full app at ${mark} ms`);
  return { ctx, page };
}

// ---- signed out ----
{
  // the homepage's "View the notes": a full page load of /app/demo
  const { ctx } = await firstLoad("homepage → View the notes → the demo", null, undefined, async (page) => {
    await page.goto(base + "/");
    await page.click(".home-cta a.btn-cta");
    await page.waitForURL(/\/app\/demo/, { waitUntil: "commit" });
  });
  await ctx.close();
}
{
  const { ctx } = await firstLoad("guest /app", "/app");
  await ctx.close();
}
{
  const { ctx } = await firstLoad("guest, the demo", "/app/demo");
  await ctx.close();
}

if (remote) {
  for (const t of times) console.log("time:", t);
  await browser.close();
  console.log(fails ? `${fails} FAILED` : "all ok");
  process.exit(fails ? 1 : 0);
}

// ---- signed in: an account with a few notes and a second workspace ----
const seed = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const sp = await seed.newPage();
await sp.goto(`${base}/auth/dev?next=${encodeURIComponent(`/app/${WS}/Welcome.md`)}`);
await sp.fill("input[name=name]", "Alice");
await sp.click("form button[type=submit]");
await sp.waitForSelector(".editor-host:not(.preview) .mde .ln", { timeout: 10000 });
const post = (url, body) => sp.evaluate(([url, body]) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()), [url, body]);
for (const n of ["Ideas", "Plans", "Journal/Monday"]) await post(`/api/repos/${WS}/files`, { path: `${n}.md`, content: `# ${n}\n\nSome text for ${n}, with *emphasis* and **bold**.\n` });
const other = await post("/api/workspaces", { title: "Second" });
await post(`/api/repos/${other.id}/files`, { path: "Other.md", content: "# Other\n\nIn the second workspace.\n" });
// /app reopens the last note: Ideas
await sp.goto(`${base}/app/${WS}/Ideas.md`);
await sp.waitForSelector(".editor-host:not(.preview) .mde .ln", { timeout: 10000 });
const state = await seed.storageState({ indexedDB: false });
await seed.close();

{
  const { ctx } = await firstLoad("signed in /app (last note)", "/app", state);
  await ctx.close();
}
{
  const { ctx, page } = await firstLoad("signed in, a direct note URL", `/app/${WS}/Plans.md`, state);

  // ---- switching workspaces: the old view stays until the new one is complete ----
  await page.evaluate(() => (window.__phases.length = 0));
  await page.click(".ws-switcher");
  await page.click(`.ws-menu .menu-item:has(.menu-label:text-is("Second"))`);
  await page.waitForFunction(() => document.querySelector(".breadcrumb .crumb-repo")?.textContent === "Second" && !!document.querySelector(".doc-body .mde .ln"), null, { polling: "raf", timeout: 10000 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const during = (await page.evaluate(() => window.__phases)).map((p) => p.phase);
  check("switching workspaces: never a partial view", during.every((p) => p === "app"), JSON.stringify(during));
  await ctx.close();
}

// ---- a slow tree: after the cap the app shows with a quiet placeholder, then fills in ----
{
  const { ctx, page } = await newPage(state);
  let release;
  const held = new Promise((r) => (release = r));
  await page.route(/\/api\/repos\/[^/]+\/tree$/, async (route) => {
    await held;
    await route.continue();
  });
  await page.goto(`${base}/app/${WS}/Plans.md`, { waitUntil: "commit" });
  await page.waitForFunction(() => !document.querySelector("#splash"), null, { polling: "raf", timeout: 10000 });
  const at = await page.evaluate(() => Math.round(performance.getEntriesByName("grimoire:app")[0]?.startTime ?? -1));
  check("a slow tree: the app shows at the cap (~3 s)", at >= 2900 && at < 4000, String(at));
  const tree = await page.evaluate(() => ({ text: document.querySelector(".sb-tree")?.textContent ?? null, busy: !!document.querySelector(".sb-tree [aria-busy=true]"), note: !!document.querySelector(".doc-body .mde .ln") }));
  check("…the tree a quiet, empty placeholder; the note shows", tree.text === "" && tree.busy && tree.note, JSON.stringify(tree));
  release();
  check("…and the tree fills in when it arrives", await page.waitForSelector(".sb-tree .file-row.active", { timeout: 10000 }).then(() => true, () => false));
  await ctx.close();
}

for (const t of times) console.log("time:", t);
await browser.close();
await T.stop();
console.log(fails ? `${fails} FAILED` : "all ok");
process.exit(fails ? 1 : 0);
