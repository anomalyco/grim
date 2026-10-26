import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";

// Differential test: the same random key sequences in the TS and the Rust engine, reporting the first step where
// text or selection differ. Run run.mjs once with each engine first (it builds both harnesses).
// Usage: bun test/editor/browser/diff.mjs [runs=40] [steps=14] [seed=1]   (COLLAB=1: the Rust engine in collab mode)
const [runs = 40, steps = 14, seed0 = 1] = process.argv.slice(2).map(Number);
const dirs = { ts: "/tmp/opencode/edtest", rs: "/tmp/opencode/edtest-rs" };
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const u = new URL(req.url);
    const [, which, ...rest] = u.pathname.split("/");
    const p = rest.join("/");
    return new Response(Bun.file(dirs[which] + "/" + (p || "index.html")));
  },
});
const base = `http://localhost:${server.port}/`;
const b = await chromium.launch({
  executablePath: "/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell",
});
const pages = {};
for (const k of ["ts", "rs"]) {
  pages[k] = await b.newPage({ viewport: { width: 900, height: 700 } });
  pages[k].on("pageerror", (e) => console.log(k, "PAGEERROR", e.message));
  // MAC=1: both editors take their macOS key paths (only keys both handle on keydown: Mac deletion shortcuts
  // reach the TS editor as beforeinput intents that headless Linux Chrome doesn't produce)
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
    await p.goto(base + k + "/?n=" + run + (k === "rs" && process.env.COLLAB ? "&collab" : "") + "#" + encodeURIComponent(doc));
    await p.waitForFunction(() => !!window.T);
    // folding is the Rust engine's alone (view state, no TS counterpart): no fold shortcuts in `actions`, and no
    // gutter chevron for random clicks to hit
    if (k === "rs") await p.addStyleTag({ content: ".mde .ln.fold-able > .tok-heading::before { display: none; }" });
    await p.evaluate((c) => { T.view.root.focus(); T.view.setSel({ anchor: c, head: c }, { dom: true }); }, caret);
  }
  if (run === 0) console.log("engines:", await pages.ts.evaluate(() => document.querySelector(".mde").dataset.engine ?? "ts"), await pages.rs.evaluate(() => document.querySelector(".mde").dataset.engine));
  const s0 = [await state(pages.ts), await state(pages.rs)];
  const done = [];
  if (JSON.stringify(s0[0]) !== JSON.stringify(s0[1])) {
    // programmatic carets inside hidden syntax snap differently (TS: after it, Rust: before it); not reachable by
    // user input. Start both from the TS engine's choice.
    if (process.env.VERBOSE) console.log(`run ${run}: initial caret snaps differently`, JSON.stringify(doc), caret, JSON.stringify(s0));
    await pages.rs.evaluate((c) => T.view.setSel({ anchor: c, head: c }, { dom: true }), s0[0][1]);
  }
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
    const [a, c] = [await state(pages.ts), await state(pages.rs)];
    if (JSON.stringify(a) !== JSON.stringify(c)) {
      console.log(`run ${run}: doc ${JSON.stringify(doc)} caret ${caret} keys ${JSON.stringify(done)}\n  ts ${JSON.stringify(a)}\n  rs ${JSON.stringify(c)}`);
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
