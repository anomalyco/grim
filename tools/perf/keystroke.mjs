import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { bigDoc } from "./bigdoc.mjs";

// Per-keystroke cost of typing into a 3000-line mixed document (tools/perf/bigdoc.mjs), TS engine vs Rust engine,
// in headless Chromium, at the top / middle / bottom of the document.
// Usage: bun tools/perf/keystroke.mjs [ts|rust ...]   (default: both)
// Per keystroke (median over N keys): total = keydown until the editor's handlers are done (all synchronous work),
// engine = the wasm calls (Rust only; serializing the patch into JS objects happens inside them; `core`/`ser`
// split them when the pkg has Engine.profile()), shell = total - engine, split into the shell's own JS and the
// browser's work when the DOM selection is set: style+layout, then Chromium's selection sync (it walks the
// whole editable, so it grows with the document's DOM size, with any editor).

const N = 40;
const engines = process.argv.slice(2).length ? process.argv.slice(2) : ["ts", "rust"];
const root = new URL("../../", import.meta.url).pathname;
const text = bigDoc();
const lines = text.split("\n");
const lineEnd = (i) => lines.slice(0, i + 1).join("\n").length;

const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="editor.css">
<style>body{margin:0;font-family:system-ui} #ed{height:600px;overflow:auto}</style></head><body><div id="ed"></div>
<script>const x = new XMLHttpRequest(); x.open("GET", "doc.md", false); x.send(); window.INIT = x.responseText;</script>
<script type="module" src="harness.js"></script></body></html>`;

async function build(engine) {
  const dir = `/tmp/opencode/perf-${engine}`;
  const src = root + "test/editor/browser/" + (engine === "rust" ? "harness-rs.ts" : "harness.ts");
  const out = await Bun.build({ entrypoints: [src], outdir: dir, target: "browser", naming: "harness.js", minify: !process.env.CPUPROF });
  if (!out.success) throw new AggregateError(out.logs, "harness build failed");
  await Bun.write(dir + "/index.html", html);
  await Bun.write(dir + "/doc.md", text);
  await Bun.write(dir + "/editor.css", Bun.file(root + "src/client/editor/editor.css"));
  if (engine === "rust") {
    for (const f of ["editor_wasm.js", "editor_wasm_bg.wasm"]) await Bun.write(dir + "/" + f, Bun.file((process.env.PKG ?? root + "src/client/editor-rs/pkg/") + f));
  }
  return dir;
}

const b = await chromium.launch({
  executablePath: "/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell",
});
const results = [];
for (const engine of engines) {
  const dir = await build(engine);
  const server = Bun.serve({ port: 0, fetch: (req) => new Response(Bun.file(dir + (new URL(req.url).pathname === "/" ? "/index.html" : new URL(req.url).pathname))) });
  const page = await b.newPage({ viewport: { width: 900, height: 700 } });
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  const tLoad = Date.now();
  await page.goto(`http://localhost:${server.port}/`);
  await page.waitForFunction(() => !!window.T);
  const loadMs = Date.now() - tLoad;
  const load = await page.evaluate(() => {
    const nav = performance.getEntriesByType("resource").find((e) => e.name.endsWith(".wasm"));
    return nav ? { wasmFetch: nav.duration, wasmBytes: nav.encodedBodySize } : null;
  });
  await page.evaluate(() => {
    const P = (window.P = { cur: null, all: [] });
    const v = T.view;
    const eng = v.engine;
    if (eng && T.view.constructor.name !== "EditorView") {
      for (const m of ["insert_text", "key", "set_selection"]) {
        const f = eng[m];
        if (typeof f !== "function") continue;
        eng[m] = function (...a) {
          const t = performance.now();
          const r = f.apply(this, a);
          if (P.cur) {
            P.cur.engine += performance.now() - t;
            if (typeof eng.profile === "function") {
              const pr = eng.profile();
              if (pr) {
                P.cur.core += pr[0];
                P.cur.ser += pr[1];
                P.cur.edit += pr[2];
                P.cur.render += pr[3];
                P.cur.diff += pr[4];
                P.cur.conv += pr[5];
              }
            }
          }
          return r;
        };
      }
      if (typeof eng.set_profiling === "function") eng.set_profiling(true);
    }
    // the browser's part of setting the DOM selection: style+layout (forced first), then the selection sync
    // (Chromium walks the whole editable on a selection change during user input)
    const sbe = Selection.prototype.setBaseAndExtent;
    Selection.prototype.setBaseAndExtent = function (...a) {
      if (!P.cur) return sbe.apply(this, a);
      let t = performance.now();
      void v.root.offsetHeight;
      P.cur.lay += performance.now() - t;
      t = performance.now();
      sbe.apply(this, a);
      P.cur.sel += performance.now() - t;
    };
    window.addEventListener("keydown", () => (P.cur = { t0: performance.now(), engine: 0, core: 0, ser: 0, edit: 0, render: 0, diff: 0, conv: 0, lay: 0, sel: 0 }), true);
    // the keystroke's work ends after the root's keydown handler (keys the engine handles) or its beforeinput
    // handler (text input), whichever comes last
    window.addEventListener("keydown", () => P.cur && (P.cur.end = performance.now()));
    window.addEventListener("beforeinput", () => P.cur && (P.cur.end = performance.now()));
    window.addEventListener("keyup", () => {
      const c = P.cur;
      if (!c || !c.end) return;
      c.total = c.end - c.t0;
      P.all.push(c);
      P.cur = null;
    });
  });
  for (const [where, line, keys] of [["top", 1], ["middle", 1501], ["bottom", 2971], ["top Enter/Backspace", 1, ["Enter", "Backspace"]]]) {
    const pos = lineEnd(line) - 1;
    await page.evaluate((p) => {
      T.view.root.focus();
      T.view.setSel({ anchor: p, head: p }, { dom: true });
      P.all = [];
    }, pos);
    const cdp = process.env.CPUPROF && where === "top" ? await page.context().newCDPSession(page) : null;
    if (cdp) {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.setSamplingInterval", { interval: 50 });
      await cdp.send("Profiler.start");
    }
    for (let i = 0; i < N; i++) {
      if (keys) await page.keyboard.press(keys[i % 2]);
      else await page.keyboard.type(i % 2 ? "b" : "a");
    }
    if (cdp) printProfile((await cdp.send("Profiler.stop")).profile);
    const all = await page.evaluate(() => P.all);
    const med = (k) => {
      const s = all.map((x) => x[k] ?? 0).sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    };
    const r = { engine, where, n: all.length, total: med("total"), eng: med("engine"), core: med("core"), ser: med("ser"), lay: med("lay"), sel: med("sel"), edit: med("edit"), render: med("render"), diff: med("diff"), conv: med("conv") };
    r.shell = r.total - r.eng;
    r.js = r.shell - r.lay - r.sel;
    results.push(r);
    const ok = (await page.evaluate(() => T.text())).length === text.length + N * results.filter((x) => x.engine === engine && !x.where.includes("Enter")).length;
    console.log(
      `${engine.padEnd(4)} ${where.padEnd(19)} total ${r.total.toFixed(2).padStart(6)} ms  engine ${r.eng.toFixed(2).padStart(6)}` +
        (r.core || r.ser ? ` (core ${r.core.toFixed(2)} = edit ${r.edit.toFixed(2)} + render ${r.render.toFixed(2)} + diff ${r.diff.toFixed(2)} + conv ${r.conv.toFixed(2)}; ser ${r.ser.toFixed(2)})` : "") +
        `  shell ${r.shell.toFixed(2).padStart(6)} (js ${r.js.toFixed(2)}, browser: style+layout ${r.lay.toFixed(2)}, selection sync ${r.sel.toFixed(2)})  (n=${r.n}${ok ? "" : ", TEXT MISMATCH"})`,
    );
  }
  console.log(`${engine} load: page ready in ${loadMs} ms` + (load ? `, wasm fetch ${load.wasmFetch.toFixed(1)} ms (${load.wasmBytes} bytes)` : ""));
  if (engine === "rust") {
    const t = await page.evaluate(async () => {
      const bytes = await (await fetch("editor_wasm_bg.wasm")).arrayBuffer();
      let t0 = performance.now();
      await WebAssembly.compile(bytes);
      const compile = performance.now() - t0;
      const E = T.view.engine.constructor;
      const text = T.text();
      t0 = performance.now();
      const e = new E(text);
      const ctor = performance.now() - t0;
      t0 = performance.now();
      e.render_all();
      const render = performance.now() - t0;
      e.free();
      return { compile, ctor, render };
    });
    console.log(`rust: wasm compile ${t.compile.toFixed(1)} ms; 3000-line doc: Engine construction (parse) ${t.ctor.toFixed(1)} ms, render_all ${t.render.toFixed(1)} ms`);
  }
  await page.close();
  server.stop(true);
}
await b.close();

/** CPUPROF=1: self time by function over the "top" run (idle and program excluded), top 30. */
function printProfile(prof) {
  const self = new Map();
  const byId = new Map(prof.nodes.map((n) => [n.id, n]));
  const dt = prof.timeDeltas;
  prof.samples.forEach((id, i) => {
    const n = byId.get(id);
    const f = n.callFrame;
    const name = `${f.functionName || "(anon)"} ${f.url.split("/").pop()}:${f.lineNumber + 1}`;
    self.set(name, (self.get(name) ?? 0) + (dt[i] ?? 0) / 1000);
  });
  const rows = [...self].filter(([k]) => !/^\((idle|program)\)/.test(k)).sort((a, b) => b[1] - a[1]);
  const tot = rows.reduce((a, r) => a + r[1], 0);
  console.log(`  cpu profile (self ms over ${N} keys, total ${tot.toFixed(0)}):`);
  for (const [k, v] of rows.slice(0, 30)) console.log(`   ${v.toFixed(1).padStart(7)}  ${k}`);
}
