import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";

// Differential test: the same random key sequences in a plain engine (a local document) and a collab engine (the
// engine owning a shared document, yrs, against the in-page room), reporting the first step where text or
// selection differ: the collab store must behave exactly like the plain one. Run run.mjs first (it builds the
// harness). Usage: bun test/editor/browser/diff.mjs [runs=40] [steps=14] [seed=1]   (CLICKS=1, MAC=1; replay with
// DOC=… CARET=… KEYS='[…]')
const [runs = 40, steps = 14, seed0 = 1] = process.argv.slice(2).map(Number);
const dir = "/tmp/opencode/edtest";
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const p = new URL(req.url).pathname.slice(1);
    return new Response(Bun.file(dir + "/" + (p || "index.html")));
  },
});
const base = `http://localhost:${server.port}/`;
const b = await chromium.launch({
  executablePath: "/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell",
});
const pages = {};
for (const k of ["local", "collab"]) {
  pages[k] = await b.newPage({ viewport: { width: 900, height: 700 } });
  pages[k].on("pageerror", (e) => console.log(k, "PAGEERROR", e.message));
  // MAC=1: both editors take their macOS key paths
  if (process.env.MAC) await pages[k].addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" }));
}

const docs = [
  "plain text here\nsecond line",
  "# Heading\n- item one\n- item **two**\n\t- nested\nend",
  "- [ ] todo\n- [x] done\n1. first\n2. second",
  "> quote line\n> more\n\npara *it* `code`",
  "```\ncode\n```\nafter",
  "a **bold** and ==hl== [link](https://x.y)\n---\nz",
  "| a | b |\n|---|---|\n| 1 | 2 |\n\nx",
  "",
];
const actions = [
  ..."ab *-#>`[]| x".split("").map((c) => ["type", c]),
  ...["Enter", "Backspace", "Delete", "Tab", "Shift+Tab", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Shift+ArrowLeft", "Shift+ArrowRight", "Shift+ArrowDown", "Shift+Enter"].map((k) => ["press", k]),
  ...(process.env.MAC
    ? ["Meta+z", "Meta+Shift+z", "Meta+b", "Meta+i", "Meta+u", "Meta+a", "Meta+ArrowLeft", "Meta+ArrowRight", "Meta+Shift+ArrowLeft", "Meta+ArrowUp", "Meta+ArrowDown", "Alt+ArrowLeft", "Alt+ArrowRight", "Alt+Shift+ArrowRight", "Alt+ArrowUp", "Alt+ArrowDown"]
    : ["Home", "End", "Control+z", "Control+Shift+z", "Control+b", "Control+i", "Control+Backspace", "Control+ArrowLeft", "Control+ArrowRight"]
  ).map((k) => ["press", k]),
  ...(process.env.CLICKS ? [["click", 1], ["click", 1], ["click", 2], ["click", 3], ["click", 1]] : []),
];
let rng = seed0;
// mulberry32
function rand(n) {
  rng = (rng + 0x6d2b79f5) | 0;
  let t = Math.imul(rng ^ (rng >>> 15), 1 | rng);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return (((t ^ (t >>> 14)) >>> 0) % n);
}
const state = (p) => p.evaluate(() => [T.text(), T.sel().anchor, T.sel().head]);

let diffs = 0;
for (let run = 0; run < runs; run++) {
  const doc = process.env.DOC ?? docs[rand(docs.length)];
  const caret = process.env.CARET ? Number(process.env.CARET) : rand(doc.length + 1);
  for (const [k, p] of Object.entries(pages)) {
    await p.goto(base + "?n=" + run + (k === "collab" ? "&collab" : "") + "#" + encodeURIComponent(doc));
    await p.waitForFunction(() => !!window.T);
    await p.evaluate((c) => { T.view.root.focus(); T.view.setSel({ anchor: c, head: c }, { dom: true }); }, caret);
  }
  if (run === 0) console.log("collab:", await pages.local.evaluate(() => !!T.view.collab), await pages.collab.evaluate(() => !!T.view.collab));
  const done = [];
  const replay = process.env.KEYS ? JSON.parse(process.env.KEYS) : null;
  for (let i = 0; i < (replay ? replay.length : steps); i++) {
    const [kind, arg] = replay ? (replay[i].startsWith("click ") ? ["click", replay[i].slice(6).split(",").map(Number)] : [replay[i].length === 1 ? "type" : "press", replay[i]]) : actions[rand(actions.length)];
    if (kind === "click") {
      const at = Array.isArray(arg) ? arg : [rand(600), rand(260), arg];
      done.push("click " + at.join(","));
      for (const p of Object.values(pages)) {
        const o = await p.evaluate(() => { const r = T.view.root.getBoundingClientRect(); return [r.left, r.top]; });
        await p.mouse.click(o[0] + at[0], o[1] + at[1], { clickCount: at[2] });
        await p.waitForTimeout(20);
      }
    } else {
      done.push(arg);
      for (const p of Object.values(pages)) await (kind === "type" ? p.keyboard.type(arg) : p.keyboard.press(arg));
    }
    const [a, c] = [await state(pages.local), await state(pages.collab)];
    if (JSON.stringify(a) !== JSON.stringify(c)) {
      console.log(`run ${run}: doc ${JSON.stringify(doc)} caret ${caret} keys ${JSON.stringify(done)}\n  local  ${JSON.stringify(a)}\n  collab ${JSON.stringify(c)}`);
      diffs++;
      break;
    }
    if (replay) console.log(JSON.stringify(arg), JSON.stringify(a));
    if (i === steps - 1 && process.env.VERBOSE) console.log(run, JSON.stringify(doc), JSON.stringify(done), JSON.stringify(a));
  }
}
console.log(diffs ? `${diffs} of ${runs} runs differ` : "no differences");
await b.close();
server.stop();
