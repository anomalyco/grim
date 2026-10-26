// The doodle's ink layer in a real browser: redraws put every dot back exactly, and a fading stroke repaints only
// its own box. Usage: bun test/e2e/doodle-ink.mjs (needs playwright-core in /tmp/opencode/pw, like home-doodle.mjs).
import { chromium } from "/tmp/opencode/pw/node_modules/playwright-core/index.mjs";
import { DOODLE } from "../../src/shared/doodle.ts";

const built = await Bun.build({ entrypoints: [new URL("../../src/client/doodle/ink.ts", import.meta.url).pathname], target: "browser", format: "iife" });
const code = (await built.outputs[0].text()).replace(/^\(\(\) => \{/, "").replace(/\}\)\(\);\s*$/, "") + "\nwindow.InkLayer = InkLayer;";
const browser = await chromium.launch({ executablePath: "/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell" });
const page = await browser.newPage();
await page.setContent("<body></body>");
await page.addScriptTag({ content: code });
const r = await page.evaluate(([LIFE, FADE]) => {
  const ink = new InkLayer();
  document.body.append(ink.canvas);
  ink.resize(600, 400);
  const now = performance.now();
  const line = (x0, y0, x1, y1) => Array.from({ length: 41 }, (_, i) => [x0 + ((x1 - x0) * i) / 40, y0 + ((y1 - y0) * i) / 40, 0.7]).flat();
  ink.add("a", "#296d9a", 2.2, now).p = line(-200, 50, 200, 150);
  ink.add("b", "#4f7d4a", 2.2, now - (LIFE - FADE / 2)).p = line(-200, 150, 200, 50); // half way through its fade, crossing a
  ink.add("c", "#c08a2e", 2.2, now).p = line(-250, 300, 250, 320);
  ink.flush(now + 1);
  const ctx = ink.canvas.getContext("2d");
  const px = () => ctx.getImageData(0, 0, 600, 400).data;
  const sum = (d, y0, y1) => {
    let s = 0;
    for (let y = y0; y < y1; y++) for (let x = 0; x < 600; x++) s += d[(y * 600 + x) * 4 + 3];
    return s;
  };
  const d0 = px();
  ink.redraw();
  const d1 = px();
  let diff = 0;
  for (let i = 0; i < d0.length; i++) if (d0[i] !== d1[i]) diff++;
  ink.flush(now + FADE / 4 + 600);
  const d2 = px();
  ink.flush(now + FADE + 1200);
  const d3 = px();
  return { diff, b: [sum(d1, 40, 160), sum(d2, 40, 160), sum(d3, 40, 160)], c: [sum(d1, 290, 330), sum(d2, 290, 330), sum(d3, 290, 330)], gone: !ink.strokes.has("b") };
}, [DOODLE.strokeLifeMs, DOODLE.fadeMs]);
await browser.close();

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(ok ? "ok  " : "FAIL", name, ok ? "" : detail);
};
check("a redraw is pixel-identical", r.diff === 0, `${r.diff} bytes differ`);
check("a fading stroke gets lighter", r.b[1] < r.b[0] * 0.95 && r.b[2] < r.b[1], JSON.stringify(r.b));
check("strokes away from it aren't touched", r.c[0] === r.c[1] && r.c[1] === r.c[2], JSON.stringify(r.c));
check("an expired stroke is dropped", r.gone);
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
